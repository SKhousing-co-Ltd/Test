create or replace function public.link_and_complete_contract_workflow(
  p_appsuite_record_id uuid,
  p_lease_contract_id uuid,
  p_lease_contract_unit_ids uuid[] default '{}',
  p_effective_date date default null
)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception 'Active operator account required';
  end if;
  if not exists (select 1 from public.appsuite_record record join public.appsuite_application application on application.app_id = record.app_id
    where record.appsuite_record_id = p_appsuite_record_id and application.business_domain = 'lease_contract'
      and record.is_present and record.workflow_processed_at is null) then
    raise exception 'Workflow item is unavailable or already processed';
  end if;
  if not exists (select 1 from public.lease_contract where lease_contract_id = p_lease_contract_id) then
    raise exception 'Lease contract not found';
  end if;
  if coalesce(array_length(p_lease_contract_unit_ids, 1), 0) > 0 and exists (
    select 1 from unnest(p_lease_contract_unit_ids) selected_unit
    where not exists (select 1 from public.lease_contract_unit unit
      where unit.lease_contract_unit_id = selected_unit and unit.lease_contract_id = p_lease_contract_id)) then
    raise exception 'Selected contract units must belong to the selected contract';
  end if;
  if coalesce(array_length(p_lease_contract_unit_ids, 1), 0) > 0 then
    perform public.confirm_workflow_contract_links(p_appsuite_record_id, p_lease_contract_id, p_lease_contract_unit_ids, 'primary', p_effective_date, 'unit');
  else
    perform public.confirm_workflow_contract_link(p_appsuite_record_id, p_lease_contract_id, 'primary', p_effective_date);
  end if;
  update public.appsuite_record
     set workflow_completed_at = coalesce(workflow_completed_at, now()),
         workflow_completed_by = coalesce(workflow_completed_by, auth.uid()),
         workflow_processed_at = coalesce(workflow_processed_at, now()),
         workflow_processed_reason = 'manual_contract_link'
   where appsuite_record_id = p_appsuite_record_id;
end;
$$;
revoke all on function public.link_and_complete_contract_workflow(uuid, uuid, uuid[], date) from public, anon;
grant execute on function public.link_and_complete_contract_workflow(uuid, uuid, uuid[], date) to authenticated;
