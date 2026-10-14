create or replace function public.list_contract_unit_merge_candidates(p_target_lease_contract_id uuid)
returns table (
  lease_contract_unit_id uuid, source_lease_contract_id uuid, unit_code text,
  unit_name text, floor_label text, unit_type text, lease_start_date date,
  lease_end_date date, contract_start_date date, contract_end_date date
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  if not exists (select 1 from public.lease_contract where lease_contract_id = p_target_lease_contract_id) then raise exception 'Lease contract not found'; end if;

  return query
  with target as (
    select contract.tenant_id, unit.property_id
      from public.lease_contract contract
      join public.lease_contract_unit contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
      join public.unit_master unit on unit.unit_id = contract_unit.unit_id
     where contract.lease_contract_id = p_target_lease_contract_id
     group by contract.tenant_id, unit.property_id
  )
  select contract_unit.lease_contract_unit_id, contract.lease_contract_id,
         unit.unit_code::text, unit.unit_name::text, unit.floor_label::text, unit.unit_type::text,
         contract_unit.lease_start_date, contract_unit.lease_end_date,
         contract.contract_start_date, contract.contract_end_date
    from public.lease_contract contract
    join public.lease_contract_unit contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
    join target on target.tenant_id = contract.tenant_id and target.property_id = unit.property_id
   where contract.lease_contract_id <> p_target_lease_contract_id
     and contract.contract_status in ('draft', 'scheduled', 'active')
     and unit.unit_type not in ('parking', 'bicycle_parking')
     and not exists (
       select 1 from public.lease_contract_unit existing
        where existing.lease_contract_id = p_target_lease_contract_id and existing.unit_id = contract_unit.unit_id
     )
   order by unit.floor_label nulls last, unit.unit_code;
end;
$$;

create or replace function public.merge_contract_unit_into_contract(
  p_target_lease_contract_id uuid,
  p_source_lease_contract_unit_id uuid
)
returns void language plpgsql security definer set search_path = public as $$
declare
  source_unit public.lease_contract_unit;
  source_contract_id uuid;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager') then raise exception 'Manager account required'; end if;
  select * into source_unit from public.lease_contract_unit where lease_contract_unit_id = p_source_lease_contract_unit_id for update;
  if not found then raise exception 'Source contract unit not found'; end if;
  source_contract_id := source_unit.lease_contract_id;
  if source_contract_id = p_target_lease_contract_id then raise exception 'Contract unit is already in the target contract'; end if;
  if not exists (select 1 from public.list_contract_unit_merge_candidates(p_target_lease_contract_id) candidate where candidate.lease_contract_unit_id = p_source_lease_contract_unit_id) then
    raise exception 'Only a unit for the same tenant and property can be merged';
  end if;

  delete from public.workflow_contract_link source_link
   where source_link.lease_contract_id = source_contract_id
     and exists (
       select 1 from public.workflow_contract_link target_link
        where target_link.appsuite_record_id = source_link.appsuite_record_id
          and target_link.lease_contract_id = p_target_lease_contract_id
          and coalesce(target_link.lease_contract_unit_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = coalesce(source_link.lease_contract_unit_id, '00000000-0000-0000-0000-000000000000'::uuid)
     );
  update public.workflow_contract_link set lease_contract_id = p_target_lease_contract_id
   where lease_contract_id = source_contract_id and lease_contract_unit_id = p_source_lease_contract_unit_id;
  update public.lease_contract_unit set lease_contract_id = p_target_lease_contract_id, updated_at = now()
   where lease_contract_unit_id = p_source_lease_contract_unit_id;

  if not exists (select 1 from public.lease_contract_unit where lease_contract_id = source_contract_id) then
    update public.parking_contract_detail set main_lease_contract_id = p_target_lease_contract_id, updated_at = now()
     where main_lease_contract_id = source_contract_id;
  end if;
end;
$$;

create or replace function public.withdraw_contract_workflow(p_appsuite_record_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then raise exception 'Active operator account required'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Withdrawal reason is required'; end if;
  if not exists (
    select 1 from public.appsuite_record record
    join public.appsuite_application application on application.app_id = record.app_id
    where record.appsuite_record_id = p_appsuite_record_id
      and application.business_domain = 'lease_contract'
      and record.is_present and record.workflow_processed_at is null
  ) then raise exception 'Workflow item is unavailable or already processed'; end if;
  if exists (select 1 from public.workflow_contract_link where appsuite_record_id = p_appsuite_record_id) then
    raise exception 'A linked approval must be cancelled through the approval cancellation workflow';
  end if;

  update public.appsuite_record
     set is_cancelled = true, cancelled_at = now(), cancelled_by = auth.uid(),
         cancellation_reason = btrim(p_reason), workflow_processed_at = now(),
         workflow_processed_reason = 'manual_withdrawal'
   where appsuite_record_id = p_appsuite_record_id;
  update public.change_request set status = 'excluded', resolved_at = now(), resolved_by = auth.uid()
   where source_appsuite_record_id = p_appsuite_record_id
     and status in ('draft', 'open', 'in_review', 'on_hold', 'resolved');
end;
$$;

revoke all on function public.list_contract_unit_merge_candidates(uuid), public.merge_contract_unit_into_contract(uuid, uuid), public.withdraw_contract_workflow(uuid, text) from public, anon;
grant execute on function public.list_contract_unit_merge_candidates(uuid), public.merge_contract_unit_into_contract(uuid, uuid), public.withdraw_contract_workflow(uuid, text) to authenticated;
comment on function public.merge_contract_unit_into_contract(uuid, uuid) is '同じテナント・同じ物件の別契約区画を対象契約へ移し、同一契約の複数区画として扱う。';
comment on function public.withdraw_contract_workflow(uuid, text) is '未処理・未紐づけの決裁済み稟議を取下げ扱いにして契約業務フローから除外する。';
