create or replace function public.complete_appsuite_termination_workflow(p_appsuite_record_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workflow public.appsuite_termination_workflow;
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

  perform 1 from public.lease_contract where lease_contract_id = v_workflow.lease_contract_id for update;
  if not found then raise exception '対象契約が見つかりません'; end if;

  if v_workflow.target_scope = 'contract' then
    update public.lease_contract
       set contract_end_date = v_workflow.termination_date, updated_at = now()
     where lease_contract_id = v_workflow.lease_contract_id;
  else
    update public.lease_contract_unit
       set lease_end_date = v_workflow.termination_date, updated_at = now()
     where lease_contract_id = v_workflow.lease_contract_id
       and lease_contract_unit_id = any(v_workflow.lease_contract_unit_ids);
    if not found then raise exception '解約対象区画が見つかりません'; end if;
  end if;

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
    jsonb_build_object('lease_contract_id', v_workflow.lease_contract_id,
      'termination_date', v_workflow.termination_date, 'target_scope', v_workflow.target_scope,
      'lease_contract_unit_ids', to_jsonb(v_workflow.lease_contract_unit_ids)), auth.uid()
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
      and workflow.lease_contract_id = contract.lease_contract_id
      and (workflow.target_scope = 'contract'
        or nullif(source_row ->> 'lease_contract_unit_id', '')::uuid = any(workflow.lease_contract_unit_ids))
  ) termination on true;
$$;

revoke all on function public.rent_roll_list_with_terms_at_date(uuid, date) from public, anon;
grant execute on function public.rent_roll_list_with_terms_at_date(uuid, date) to authenticated;
