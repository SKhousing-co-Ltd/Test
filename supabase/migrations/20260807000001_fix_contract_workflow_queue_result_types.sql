-- Keep the PL/pgSQL return query types identical to the declared RPC result.
-- PostgreSQL does not implicitly coerce the CASE expression from text to varchar
-- when returning a table from a PL/pgSQL function.
create or replace function public.list_contract_workflow_queue()
returns table (
  appsuite_record_id uuid,
  app_id varchar,
  data_id varchar,
  ringi_number varchar,
  workflow_type varchar,
  property_name text,
  tenant_name text,
  approved_at timestamptz,
  source_updated_at timestamptz,
  workflow_completed_at timestamptz,
  workflow_completed_by uuid,
  match_status varchar,
  active_contract_count integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_account_is_active() then
    raise exception 'Active account required';
  end if;

  return query
  with active_matches as (
    select
      record.appsuite_record_id,
      coalesce(matches.active_contract_count, 0)::integer as active_contract_count
    from public.appsuite_record as record
    left join lateral (
      select count(distinct contract.lease_contract_id)::integer as active_contract_count
        from public.tenant_master as tenant
        join public.lease_contract as contract
          on contract.tenant_id = tenant.tenant_id
         and contract.contract_status = 'active'
        join public.lease_contract_unit as contract_unit
          on contract_unit.lease_contract_id = contract.lease_contract_id
        join public.unit_master as unit
          on unit.unit_id = contract_unit.unit_id
        join public.asset_master as asset
          on asset.asset_id = unit.property_id
       where public.normalize_contract_workflow_key(tenant.tenant_name) = public.normalize_contract_workflow_key(record.tenant_name)
         and public.normalize_contract_workflow_key(asset.asset_name) = public.normalize_contract_workflow_key(record.property_name)
    ) as matches on true
  )
  select
    record.appsuite_record_id::uuid,
    record.app_id::varchar,
    record.data_id::varchar,
    record.ringi_number::varchar,
    record.workflow_type::varchar,
    record.property_name::text,
    record.tenant_name::text,
    coalesce(record.source_updated_at, record.source_created_at)::timestamptz,
    record.source_updated_at::timestamptz,
    record.workflow_completed_at::timestamptz,
    record.workflow_completed_by::uuid,
    (case
      when matches.active_contract_count = 0 then 'not_reflected'
      when matches.active_contract_count = 1 and record.workflow_completed_at is null then 'waiting_completion'
      when matches.active_contract_count = 1 then 'ready_to_process'
      else 'ambiguous'
    end)::varchar,
    matches.active_contract_count::integer
  from public.appsuite_record as record
  join active_matches as matches on matches.appsuite_record_id = record.appsuite_record_id
  where record.is_present
    and record.approval_status = '社長決裁済'
    and record.workflow_processed_at is null
  order by coalesce(record.source_updated_at, record.source_created_at) desc nulls last, record.created_at desc;
end;
$$;

revoke all on function public.list_contract_workflow_queue() from public;
grant execute on function public.list_contract_workflow_queue() to authenticated;
