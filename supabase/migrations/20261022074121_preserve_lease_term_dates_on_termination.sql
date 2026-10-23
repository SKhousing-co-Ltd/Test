create or replace function public.complete_appsuite_termination_workflow(p_appsuite_record_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workflow public.appsuite_termination_workflow;
  v_selection jsonb;
  v_contract public.lease_contract;
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

    select * into v_contract
      from public.lease_contract
     where lease_contract_id = v_contract_id
     for update;
    if not found then raise exception '対象契約が見つかりません'; end if;

    if v_workflow.target_scope = 'contract' then
      if v_contract.contract_start_date is not null
         and v_contract.contract_start_date > v_workflow.termination_date then
        raise exception '解約日は契約開始日以降にしてください';
      end if;

      if v_contract.contract_type = 'parking'
         or v_contract.lease_term_type is null then
        update public.lease_contract
           set contract_end_date = v_workflow.termination_date, updated_at = now()
         where lease_contract_id = v_contract_id;
      elsif v_contract.lease_term_type = 'ordinary' then
        update public.lease_contract
           set actual_end_date = v_workflow.termination_date, updated_at = now()
         where lease_contract_id = v_contract_id;
      elsif v_contract.lease_term_type = 'fixed_term' then
        update public.lease_contract
           set actual_end_date = case
                 when v_workflow.termination_date < contract_end_date then v_workflow.termination_date
                 else null
               end,
               updated_at = now()
         where lease_contract_id = v_contract_id;
      end if;
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
