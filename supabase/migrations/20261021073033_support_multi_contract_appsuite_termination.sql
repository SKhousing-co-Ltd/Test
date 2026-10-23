alter table public.appsuite_termination_workflow
  add column if not exists contract_selections jsonb not null default '[]'::jsonb;

update public.appsuite_termination_workflow
   set contract_selections = jsonb_build_array(jsonb_build_object(
     'lease_contract_id', lease_contract_id,
     'lease_contract_unit_ids', to_jsonb(lease_contract_unit_ids)
   ))
 where contract_selections = '[]'::jsonb;

create or replace function public.complete_appsuite_termination_request_multi(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_contract_selections jsonb,
  p_termination_date date,
  p_target_scope varchar
)
returns public.change_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.change_request;
  v_record public.appsuite_record;
  v_previous_status varchar(20);
  v_selection jsonb;
  v_first_contract_id uuid;
  v_first_unit_ids uuid[];
  v_contract_id uuid;
  v_unit_ids uuid[];
  v_selection_count bigint;
  v_distinct_contract_count bigint;
begin
  if not public.current_account_is_active()
     or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception 'Active operator account required';
  end if;
  if p_termination_date is null then raise exception '解約日を入力してください'; end if;
  if p_target_scope not in ('contract', 'unit', 'parking') then raise exception 'Invalid termination scope'; end if;
  if jsonb_typeof(p_contract_selections) is distinct from 'array' then
    raise exception '契約の選択内容を確認してください';
  end if;
  if jsonb_array_length(p_contract_selections) = 0 then
    raise exception '紐づける契約を1件以上選択してください';
  end if;

  select count(*), count(distinct nullif(selection.value ->> 'lease_contract_id', ''))
    into v_selection_count, v_distinct_contract_count
    from jsonb_array_elements(p_contract_selections) selection(value);
  if v_selection_count <> v_distinct_contract_count
     or exists (
       select 1 from jsonb_array_elements(p_contract_selections) selection(value)
        where nullif(selection.value ->> 'lease_contract_id', '') is null
     ) then
    raise exception '契約の選択内容を確認してください';
  end if;

  if exists (
    select unit_selection.value
      from jsonb_array_elements(p_contract_selections) contract_selection(value)
      cross join lateral jsonb_array_elements_text(coalesce(contract_selection.value -> 'lease_contract_unit_ids', '[]'::jsonb)) unit_selection(value)
     group by unit_selection.value having count(*) > 1
  ) then raise exception '同じ区画が複数の契約に指定されています'; end if;

  select * into v_request
    from public.change_request
   where change_request_id = p_change_request_id
     and request_type = 'contract_terminate'
     and row_version = p_expected_row_version
     and status in ('open', 'in_review', 'on_hold', 'resolved')
   for update;
  if not found then raise exception '最新の解約依頼が見つかりません'; end if;
  v_previous_status := v_request.status;

  select * into v_record
    from public.appsuite_record
   where appsuite_record_id = v_request.source_appsuite_record_id
   for update;
  if not found or not v_record.is_present or v_record.is_cancelled then
    raise exception '有効なAppSuite解約稟議が見つかりません';
  end if;
  if exists (select 1 from public.appsuite_termination_workflow where appsuite_record_id = v_record.appsuite_record_id and status = 'in_progress') then
    raise exception 'この解約稟議は既に契約業務フローで処理中です';
  end if;

  for v_selection in
    select selection.value from jsonb_array_elements(p_contract_selections) with ordinality selection(value, ordinal)
    order by selection.ordinal
  loop
    v_contract_id := nullif(v_selection ->> 'lease_contract_id', '')::uuid;
    if jsonb_typeof(coalesce(v_selection -> 'lease_contract_unit_ids', '[]'::jsonb)) is distinct from 'array' then
      raise exception '契約ごとの対象区画を確認してください';
    end if;
    select coalesce(array_agg(unit_value::uuid order by ordinal), '{}'::uuid[])
      into v_unit_ids
      from jsonb_array_elements_text(coalesce(v_selection -> 'lease_contract_unit_ids', '[]'::jsonb))
        with ordinality selected_unit(unit_value, ordinal);

    perform 1 from public.lease_contract where lease_contract_id = v_contract_id for update;
    if not found then raise exception '対象契約が見つかりません'; end if;

    if p_target_scope = 'contract' then
      if cardinality(v_unit_ids) <> 0 then raise exception '契約全体の解約では区画を個別選択できません'; end if;
      if exists (select 1 from public.lease_contract where lease_contract_id = v_contract_id
        and contract_start_date is not null and contract_start_date > p_termination_date) then
        raise exception '解約日は契約開始日以降にしてください';
      end if;
      perform public.confirm_workflow_contract_link(
        v_record.appsuite_record_id, v_contract_id, 'primary', p_termination_date, null, 'contract'
      );
    else
      if cardinality(v_unit_ids) = 0 then raise exception '契約ごとに解約対象区画を1件以上選択してください'; end if;
      if exists (
        select 1
          from unnest(v_unit_ids) selected(unit_id)
          left join public.lease_contract_unit contract_unit
            on contract_unit.lease_contract_unit_id = selected.unit_id
           and contract_unit.lease_contract_id = v_contract_id
          left join public.lease_contract contract on contract.lease_contract_id = v_contract_id
          left join public.unit_master unit on unit.unit_id = contract_unit.unit_id
         where contract_unit.lease_contract_unit_id is null
            or p_termination_date < coalesce(contract_unit.lease_start_date, contract.contract_start_date, p_termination_date)
            or (p_target_scope = 'parking' and unit.unit_type is distinct from 'parking')
      ) then raise exception '選択した区画、種別または解約日を確認してください'; end if;
      perform public.confirm_workflow_contract_links(
        v_record.appsuite_record_id, v_contract_id, v_unit_ids,
        'primary', p_termination_date, p_target_scope
      );
    end if;

    if v_first_contract_id is null then
      v_first_contract_id := v_contract_id;
      v_first_unit_ids := v_unit_ids;
    end if;
  end loop;

  insert into public.appsuite_termination_workflow (
    appsuite_record_id, change_request_id, lease_contract_id, termination_date,
    target_scope, lease_contract_unit_ids, contract_selections, started_by
  ) values (
    v_record.appsuite_record_id, v_request.change_request_id, v_first_contract_id,
    p_termination_date, p_target_scope, coalesce(v_first_unit_ids, '{}'::uuid[]),
    p_contract_selections, auth.uid()
  );

  update public.change_request_item
     set validation_status = 'valid', validation_message = null
   where change_request_id = p_change_request_id and entity_type = 'other';

  update public.change_request
     set status = 'applied', applied_at = now(), applied_by = auth.uid(),
         resolved_at = coalesce(resolved_at, now()), resolved_by = coalesce(resolved_by, auth.uid()),
         lease_contract_id = v_first_contract_id,
         proposed_payload = coalesce(proposed_payload, '{}'::jsonb) || jsonb_build_object(
           'termination', jsonb_build_object(
             'lease_contract_id', v_first_contract_id,
             'lease_contract_ids', (select jsonb_agg(nullif(selection.value ->> 'lease_contract_id', '')::uuid)
               from jsonb_array_elements(p_contract_selections) selection(value)),
             'contract_selections', p_contract_selections,
             'termination_date', p_termination_date,
             'target_scope', p_target_scope,
             'lease_contract_unit_ids', to_jsonb(coalesce(v_first_unit_ids, '{}'::uuid[])),
             'workflow_status', 'in_progress'
           )
         )
   where change_request_id = p_change_request_id returning * into v_request;

  update public.appsuite_record
     set workflow_completed_at = coalesce(workflow_completed_at, now()),
         workflow_completed_by = coalesce(workflow_completed_by, auth.uid()),
         workflow_processed_at = coalesce(workflow_processed_at, now()),
         workflow_processed_reason = 'termination_handoff'
   where appsuite_record_id = v_record.appsuite_record_id;

  insert into public.change_request_action_log
    (change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (
    p_change_request_id, 'applied', v_previous_status, 'applied',
    jsonb_build_object('handoff', 'contract_workflow', 'contract_selections', p_contract_selections,
      'termination_date', p_termination_date, 'target_scope', p_target_scope), auth.uid()
  );
  return v_request;
end;
$$;

revoke all on function public.complete_appsuite_termination_request_multi(uuid, integer, jsonb, date, varchar) from public, anon;
grant execute on function public.complete_appsuite_termination_request_multi(uuid, integer, jsonb, date, varchar) to authenticated;

create or replace function public.complete_appsuite_termination_workflow(p_appsuite_record_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workflow public.appsuite_termination_workflow;
  v_selection jsonb;
  v_contract_id uuid;
  v_unit_ids uuid[];
  v_updated_count integer;
begin
  if not public.current_account_is_active()
     or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception 'Active operator account required';
  end if;

  select * into v_workflow
    from public.appsuite_termination_workflow
   where appsuite_record_id = p_appsuite_record_id and status = 'in_progress'
   for update;
  if not found then raise exception '契約業務フローで処理中の解約案件が見つかりません'; end if;

  for v_selection in
    select selection.value
      from jsonb_array_elements(coalesce(nullif(v_workflow.contract_selections, '[]'::jsonb),
        jsonb_build_array(jsonb_build_object('lease_contract_id', v_workflow.lease_contract_id,
          'lease_contract_unit_ids', to_jsonb(v_workflow.lease_contract_unit_ids))))) selection(value)
  loop
    v_contract_id := nullif(v_selection ->> 'lease_contract_id', '')::uuid;
    select coalesce(array_agg(unit_value::uuid order by ordinal), '{}'::uuid[])
      into v_unit_ids
      from jsonb_array_elements_text(coalesce(v_selection -> 'lease_contract_unit_ids', '[]'::jsonb))
        with ordinality selected_unit(unit_value, ordinal);

    perform 1 from public.lease_contract where lease_contract_id = v_contract_id for update;
    if not found then raise exception '対象契約が見つかりません'; end if;

    if v_workflow.target_scope = 'contract' then
      if exists (select 1 from public.lease_contract where lease_contract_id = v_contract_id
        and contract_start_date is not null and contract_start_date > v_workflow.termination_date) then
        raise exception '解約日は契約開始日以降にしてください';
      end if;
      update public.lease_contract
         set contract_end_date = v_workflow.termination_date, updated_at = now()
       where lease_contract_id = v_contract_id;
    else
      if cardinality(v_unit_ids) = 0 then raise exception '解約対象区画が見つかりません'; end if;
      if exists (
        select 1
          from unnest(v_unit_ids) selected(unit_id)
          left join public.lease_contract_unit contract_unit
            on contract_unit.lease_contract_unit_id = selected.unit_id
           and contract_unit.lease_contract_id = v_contract_id
          left join public.lease_contract contract on contract.lease_contract_id = v_contract_id
          left join public.unit_master unit on unit.unit_id = contract_unit.unit_id
         where contract_unit.lease_contract_unit_id is null
            or v_workflow.termination_date < coalesce(contract_unit.lease_start_date, contract.contract_start_date, v_workflow.termination_date)
            or (v_workflow.target_scope = 'parking' and unit.unit_type is distinct from 'parking')
      ) then raise exception '選択した区画、種別または解約日を確認してください'; end if;
      update public.lease_contract_unit
         set lease_end_date = v_workflow.termination_date, updated_at = now()
       where lease_contract_id = v_contract_id
         and lease_contract_unit_id = any(v_unit_ids);
      get diagnostics v_updated_count = row_count;
      if v_updated_count <> cardinality(v_unit_ids) then raise exception '解約対象区画が見つかりません'; end if;
    end if;
  end loop;

  update public.appsuite_termination_workflow
     set status = 'completed', completed_at = now(), completed_by = auth.uid(), updated_at = now()
   where appsuite_record_id = p_appsuite_record_id;

  update public.change_request
     set proposed_payload = jsonb_set(coalesce(proposed_payload, '{}'::jsonb), '{termination,workflow_status}', '"completed"'::jsonb, true),
         updated_at = now(), updated_by = auth.uid()
   where change_request_id = v_workflow.change_request_id;

  update public.appsuite_record
     set workflow_processed_reason = 'termination_completed'
   where appsuite_record_id = p_appsuite_record_id;

  insert into public.change_request_action_log
    (change_request_id, action_type, previous_status, next_status, details, performed_by)
  values (
    v_workflow.change_request_id, 'termination_reflected', 'in_progress', 'completed',
    jsonb_build_object('contract_selections', v_workflow.contract_selections,
      'termination_date', v_workflow.termination_date, 'target_scope', v_workflow.target_scope), auth.uid()
  );
end;
$$;

revoke all on function public.complete_appsuite_termination_workflow(uuid) from public, anon;
grant execute on function public.complete_appsuite_termination_workflow(uuid) to authenticated;

create or replace function public.rent_roll_list_with_terms_at_date(
  p_property_id uuid,
  p_as_of_date date
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    source_row || jsonb_build_object(
      'lease_term_type', contract.lease_term_type,
      'renewal_due_date', contract.renewal_due_date,
      'actual_end_date', contract.actual_end_date,
      'renewed_from_contract_id', contract.renewed_from_contract_id,
      'incoming_contracts', case when p_as_of_date < current_date then '[]'::jsonb else coalesce(incoming.items, '[]'::jsonb) end,
      'pending_terminations', case when p_as_of_date < current_date then '[]'::jsonb else coalesce(termination.items, '[]'::jsonb) end
    ) order by source_row ->> 'floor_label', source_row ->> 'unit_code'
  ), '[]'::jsonb)
  from jsonb_array_elements(public.rent_roll_list_at_date(p_property_id, p_as_of_date)) source_row
  left join public.lease_contract contract
    on contract.lease_contract_id = nullif(source_row ->> 'lease_contract_id', '')::uuid
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'lease_contract_id', future_contract.lease_contract_id,
      'lease_contract_unit_id', future_unit.lease_contract_unit_id,
      'contract_start_date', future_contract.contract_start_date,
      'tenant_name', future_tenant.tenant_name,
      'monthly_total_amount', coalesce(future_unit.monthly_rent_amount, 0) + coalesce(future_unit.monthly_common_charge_amount, 0)
    ) order by future_contract.contract_start_date, future_contract.created_at) as items
    from public.lease_contract_unit future_unit
    join public.lease_contract future_contract on future_contract.lease_contract_id = future_unit.lease_contract_id
    join public.tenant_master future_tenant on future_tenant.tenant_id = future_contract.tenant_id
    where future_unit.unit_id = nullif(source_row ->> 'unit_id', '')::uuid
      and future_contract.contract_status in ('scheduled', 'draft')
      and future_contract.contract_start_date is not null
      and future_contract.contract_start_date > p_as_of_date
  ) incoming on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'appsuite_record_id', workflow.appsuite_record_id,
      'termination_date', workflow.termination_date,
      'target_scope', workflow.target_scope
    ) order by workflow.started_at desc) as items
    from public.appsuite_termination_workflow workflow
    where workflow.status = 'in_progress'
      and exists (
        select 1
          from jsonb_array_elements(coalesce(nullif(workflow.contract_selections, '[]'::jsonb),
            jsonb_build_array(jsonb_build_object('lease_contract_id', workflow.lease_contract_id,
              'lease_contract_unit_ids', to_jsonb(workflow.lease_contract_unit_ids))))) selection(value)
         where nullif(selection.value ->> 'lease_contract_id', '')::uuid = contract.lease_contract_id
           and (workflow.target_scope = 'contract' or exists (
             select 1
               from jsonb_array_elements_text(coalesce(selection.value -> 'lease_contract_unit_ids', '[]'::jsonb)) selected_unit(value)
              where selected_unit.value::uuid = nullif(source_row ->> 'lease_contract_unit_id', '')::uuid
           ))
      )
  ) termination on true;
$$;

revoke all on function public.rent_roll_list_with_terms_at_date(uuid, date) from public, anon;
grant execute on function public.rent_roll_list_with_terms_at_date(uuid, date) to authenticated;
