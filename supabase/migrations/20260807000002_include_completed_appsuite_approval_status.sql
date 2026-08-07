-- AppSuite exposes its completed approval route as "完了". Treat that source
-- value as a final approval in the workflow, without changing synced data.
create or replace function public.reconcile_appsuite_contract_workflow(p_appsuite_record_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  active_match_count integer;
  is_completed boolean;
begin
  select record.workflow_completed_at is not null into is_completed
    from public.appsuite_record as record
   where record.appsuite_record_id = p_appsuite_record_id;
  if not found or not is_completed then return; end if;

  select count(distinct contract.lease_contract_id) into active_match_count
    from public.appsuite_record as record
    join public.tenant_master as tenant
      on public.normalize_contract_workflow_key(tenant.tenant_name) = public.normalize_contract_workflow_key(record.tenant_name)
    join public.lease_contract as contract on contract.tenant_id = tenant.tenant_id and contract.contract_status = 'active'
    join public.lease_contract_unit as contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
    join public.unit_master as unit on unit.unit_id = contract_unit.unit_id
    join public.asset_master as asset
      on asset.asset_id = unit.property_id
     and public.normalize_contract_workflow_key(asset.asset_name) = public.normalize_contract_workflow_key(record.property_name)
   where record.appsuite_record_id = p_appsuite_record_id
     and record.is_present
     and record.approval_status in ('社長決裁済', '完了')
     and record.workflow_processed_at is null;

  if active_match_count = 1 then
    update public.appsuite_record
       set workflow_processed_at = now(), workflow_processed_reason = 'active_contract_completed'
     where appsuite_record_id = p_appsuite_record_id and workflow_processed_at is null;
  end if;
end;
$$;

create or replace function public.reconcile_appsuite_contract_workflow_for_contract(p_lease_contract_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  workflow_record_id uuid;
begin
  for workflow_record_id in
    select record.appsuite_record_id
      from public.appsuite_record as record
     where record.is_present
       and record.approval_status in ('社長決裁済', '完了')
       and record.workflow_completed_at is not null
       and record.workflow_processed_at is null
       and exists (
         select 1
           from public.lease_contract as contract
           join public.tenant_master as tenant on tenant.tenant_id = contract.tenant_id
           join public.lease_contract_unit as contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
           join public.unit_master as unit on unit.unit_id = contract_unit.unit_id
           join public.asset_master as asset on asset.asset_id = unit.property_id
          where contract.lease_contract_id = p_lease_contract_id
            and public.normalize_contract_workflow_key(asset.asset_name) = public.normalize_contract_workflow_key(record.property_name)
            and public.normalize_contract_workflow_key(tenant.tenant_name) = public.normalize_contract_workflow_key(record.tenant_name)
       )
  loop
    perform public.reconcile_appsuite_contract_workflow(workflow_record_id);
  end loop;
end;
$$;

create or replace function public.list_contract_workflow_queue()
returns table (
  appsuite_record_id uuid, app_id varchar, data_id varchar, ringi_number varchar, workflow_type varchar,
  property_name text, tenant_name text, approved_at timestamptz, source_updated_at timestamptz,
  workflow_completed_at timestamptz, workflow_completed_by uuid, match_status varchar, active_contract_count integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  return query
  with active_matches as (
    select record.appsuite_record_id, coalesce(matches.active_contract_count, 0)::integer as active_contract_count
      from public.appsuite_record as record
      left join lateral (
        select count(distinct contract.lease_contract_id)::integer as active_contract_count
          from public.tenant_master as tenant
          join public.lease_contract as contract on contract.tenant_id = tenant.tenant_id and contract.contract_status = 'active'
          join public.lease_contract_unit as contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
          join public.unit_master as unit on unit.unit_id = contract_unit.unit_id
          join public.asset_master as asset on asset.asset_id = unit.property_id
         where public.normalize_contract_workflow_key(tenant.tenant_name) = public.normalize_contract_workflow_key(record.tenant_name)
           and public.normalize_contract_workflow_key(asset.asset_name) = public.normalize_contract_workflow_key(record.property_name)
      ) as matches on true
  )
  select record.appsuite_record_id::uuid, record.app_id::varchar, record.data_id::varchar, record.ringi_number::varchar,
    record.workflow_type::varchar, record.property_name::text, record.tenant_name::text,
    coalesce(record.source_updated_at, record.source_created_at)::timestamptz, record.source_updated_at::timestamptz,
    record.workflow_completed_at::timestamptz, record.workflow_completed_by::uuid,
    (case when matches.active_contract_count = 0 then 'not_reflected'
      when matches.active_contract_count = 1 and record.workflow_completed_at is null then 'waiting_completion'
      when matches.active_contract_count = 1 then 'ready_to_process' else 'ambiguous' end)::varchar,
    matches.active_contract_count::integer
  from public.appsuite_record as record
  join active_matches as matches on matches.appsuite_record_id = record.appsuite_record_id
  where record.is_present and record.approval_status in ('社長決裁済', '完了') and record.workflow_processed_at is null
  order by coalesce(record.source_updated_at, record.source_created_at) desc nulls last, record.created_at desc;
end;
$$;

create or replace function public.complete_contract_workflow(p_appsuite_record_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.user_profiles
     where user_id = auth.uid() and account_status = 'active' and role in ('admin', 'manager', 'staff')
  ) then raise exception 'Contract workflow management permission required'; end if;
  update public.appsuite_record
     set workflow_completed_at = coalesce(workflow_completed_at, now()), workflow_completed_by = coalesce(workflow_completed_by, auth.uid())
   where appsuite_record_id = p_appsuite_record_id
     and is_present and approval_status in ('社長決裁済', '完了') and workflow_processed_at is null;
  if not found then raise exception 'Workflow item is unavailable or already processed'; end if;
  perform public.reconcile_appsuite_contract_workflow(p_appsuite_record_id);
end;
$$;

revoke all on function public.reconcile_appsuite_contract_workflow(uuid) from public;
revoke all on function public.reconcile_appsuite_contract_workflow_for_contract(uuid) from public;
revoke all on function public.list_contract_workflow_queue() from public;
revoke all on function public.complete_contract_workflow(uuid) from public;
grant execute on function public.list_contract_workflow_queue() to authenticated;
grant execute on function public.complete_contract_workflow(uuid) to authenticated;
