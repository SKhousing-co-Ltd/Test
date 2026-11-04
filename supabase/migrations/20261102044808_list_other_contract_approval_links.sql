create or replace function public.list_other_contract_approval_links(p_lease_contract_id uuid)
returns table (
  appsuite_record_id uuid,
  app_id varchar,
  data_id varchar,
  ringi_number varchar,
  workflow_type varchar,
  approval_status varchar,
  tenant_name text,
  property_name text,
  source_updated_at timestamptz,
  linked_lease_contract_id uuid,
  linked_tenant_name text,
  linked_property_name text,
  linked_unit_label text,
  link_roles text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_account_is_active() then
    raise exception 'Active account required';
  end if;
  if not exists (
    select 1 from public.lease_contract contract
    where contract.lease_contract_id = p_lease_contract_id
  ) then
    raise exception 'Lease contract not found';
  end if;

  return query
  with target_properties as (
    select distinct unit.property_id
    from public.lease_contract_unit contract_unit
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
    where contract_unit.lease_contract_id = p_lease_contract_id
  ), linked_rows as (
    select record.appsuite_record_id, record.app_id::varchar, record.data_id::varchar,
           record.ringi_number::varchar, record.workflow_type::varchar,
           record.approval_status::varchar, record.tenant_name::text,
           coalesce(nullif(record.property_name, ''), public.appsuite_contract_property(record.raw_payload))::text as property_name,
           record.source_updated_at::timestamptz, link.lease_contract_id as linked_lease_contract_id,
           tenant.tenant_name::text as linked_tenant_name,
           asset.asset_name::text as linked_property_name,
           string_agg(distinct nullif(concat_ws(' ', unit.floor_label, unit.unit_code, unit.unit_name), ''), ', ' order by nullif(concat_ws(' ', unit.floor_label, unit.unit_code, unit.unit_name), '')) as linked_unit_label,
           string_agg(distinct link.link_role::text, ', ' order by link.link_role::text) as link_roles
    from public.workflow_contract_link link
    join public.lease_contract linked_contract on linked_contract.lease_contract_id = link.lease_contract_id
    join public.tenant_master tenant on tenant.tenant_id = linked_contract.tenant_id
    join public.lease_contract_unit linked_unit on linked_unit.lease_contract_id = linked_contract.lease_contract_id
    join public.unit_master unit on unit.unit_id = linked_unit.unit_id
    join public.asset_master asset on asset.asset_id = unit.property_id
    join target_properties target on target.property_id = unit.property_id
    join public.appsuite_record record on record.appsuite_record_id = link.appsuite_record_id
    join public.appsuite_application application on application.app_id = record.app_id
      and application.business_domain = 'lease_contract'
      and application.processing_type in ('contract_create', 'contract_update', 'contract_terminate')
    where link.lease_contract_id <> p_lease_contract_id
      and record.is_present
    group by record.appsuite_record_id, record.app_id, record.data_id, record.ringi_number,
             record.workflow_type, record.approval_status, record.tenant_name, record.property_name,
             record.raw_payload, record.source_updated_at, link.lease_contract_id,
             tenant.tenant_name, asset.asset_name
  )
  select linked_rows.appsuite_record_id, linked_rows.app_id, linked_rows.data_id,
         linked_rows.ringi_number, linked_rows.workflow_type, linked_rows.approval_status,
         linked_rows.tenant_name, linked_rows.property_name, linked_rows.source_updated_at,
         linked_rows.linked_lease_contract_id, linked_rows.linked_tenant_name,
         linked_rows.linked_property_name, linked_rows.linked_unit_label, linked_rows.link_roles
  from linked_rows
  order by linked_rows.source_updated_at desc nulls last, linked_rows.ringi_number nulls last;
end;
$$;

revoke all on function public.list_other_contract_approval_links(uuid) from public, anon;
grant execute on function public.list_other_contract_approval_links(uuid) to authenticated;
comment on function public.list_other_contract_approval_links(uuid) is
  'Returns lease approval records already linked to a different contract in the same property as the requested contract, for read-only reference.';
