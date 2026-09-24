-- AppSuite date fields may be stored as either a scalar or {"val": "YYYY-MM-DD"}.
-- Normalize both shapes before casting to date in the contract candidate RPC.
create or replace function public.list_workflow_contract_candidates(p_appsuite_record_id uuid)
returns table (
  lease_contract_id uuid,
  tenant_id uuid,
  tenant_name text,
  property_id uuid,
  property_name text,
  lease_contract_unit_id uuid,
  unit_id uuid,
  unit_code text,
  floor_label text,
  contract_start_date date,
  contract_end_date date,
  suggestion_level text,
  match_reasons jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record public.appsuite_record;
  v_application public.appsuite_application;
  v_effective_date date;
begin
  if not public.current_account_is_active() then
    raise exception 'Active account required';
  end if;

  select * into v_record
    from public.appsuite_record
   where appsuite_record_id = p_appsuite_record_id;
  if not found then raise exception 'AppSuite record not found'; end if;

  select * into v_application
    from public.appsuite_application
   where app_id = v_record.app_id;
  if not found or v_application.business_domain <> 'lease_contract'
     or v_application.processing_type not in ('contract_create', 'contract_update', 'contract_terminate') then
    raise exception 'AppSuite record is not a classified lease contract workflow';
  end if;

  v_effective_date := coalesce(
    nullif(case when jsonb_typeof(v_record.raw_payload -> 'effective_date') = 'object'
      then v_record.raw_payload -> 'effective_date' ->> 'val'
      else v_record.raw_payload ->> 'effective_date' end, '')::date,
    nullif(case when jsonb_typeof(v_record.raw_payload -> '螂醍ｴ・幕蟋区律') = 'object'
      then v_record.raw_payload -> '螂醍ｴ・幕蟋区律' ->> 'val'
      else v_record.raw_payload ->> '螂醍ｴ・幕蟋区律' end, '')::date,
    nullif(case when jsonb_typeof(v_record.raw_payload -> '螟画峩譌･') = 'object'
      then v_record.raw_payload -> '螟画峩譌･' ->> 'val'
      else v_record.raw_payload ->> '螟画峩譌･' end, '')::date,
    nullif(case when jsonb_typeof(v_record.raw_payload -> '隗｣邏・律') = 'object'
      then v_record.raw_payload -> '隗｣邏・律' ->> 'val'
      else v_record.raw_payload ->> '隗｣邏・律' end, '')::date
  );

  return query
  with candidates as (
    select
      contract.lease_contract_id,
      tenant.tenant_id,
      tenant.tenant_name::text,
      property.property_id,
      property.property_name::text,
      contract_unit.lease_contract_unit_id,
      unit.unit_id,
      unit.unit_code::text,
      unit.floor_label::text,
      contract.contract_start_date,
      contract.contract_end_date,
      (
        (case when nullif(v_record.property_name, '') is not null and property.property_name = v_record.property_name then 1 else 0 end) +
        (case when nullif(v_record.tenant_name, '') is not null and tenant.tenant_name = v_record.tenant_name then 1 else 0 end) +
        (case when v_effective_date is not null and (contract.contract_start_date is null or contract.contract_start_date <= v_effective_date) and (contract.contract_end_date is null or contract.contract_end_date >= v_effective_date) then 1 else 0 end)
      ) as match_count,
      jsonb_build_array(
        jsonb_build_object('rule', 'building', 'matched', nullif(v_record.property_name, '') is not null and property.property_name = v_record.property_name, 'message', 'ビル一致'),
        jsonb_build_object('rule', 'tenant', 'matched', nullif(v_record.tenant_name, '') is not null and tenant.tenant_name = v_record.tenant_name, 'message', 'テナント一致'),
        jsonb_build_object('rule', 'effective_date', 'matched', v_effective_date is not null and (contract.contract_start_date is null or contract.contract_start_date <= v_effective_date) and (contract.contract_end_date is null or contract.contract_end_date >= v_effective_date), 'message', case when v_effective_date is null then '有効日未確認' else '契約期間一致' end)
      ) as match_reasons
    from public.lease_contract contract
    join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
    join public.lease_contract_unit contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
    join public.property_master property on property.property_id = unit.property_id
    where (nullif(v_record.property_name, '') is null or property.property_name = v_record.property_name)
      and (nullif(v_record.tenant_name, '') is null or tenant.tenant_name = v_record.tenant_name)
  ), ranked as (
    select candidates.*, count(*) over () as total_count
      from candidates
  )
  select ranked.lease_contract_id, ranked.tenant_id, ranked.tenant_name,
         ranked.property_id, ranked.property_name, ranked.lease_contract_unit_id,
         ranked.unit_id, ranked.unit_code, ranked.floor_label,
         ranked.contract_start_date, ranked.contract_end_date,
         case when ranked.total_count > 1 then 'Multiple'
              when ranked.match_count >= 3 then 'Strong'
              when ranked.match_count > 0 then 'Weak'
              else 'None' end,
         ranked.match_reasons
    from ranked
   order by ranked.match_count desc, ranked.contract_start_date desc nulls last;
end;
$$;

revoke all on function public.list_workflow_contract_candidates(uuid) from public, anon;
grant execute on function public.list_workflow_contract_candidates(uuid) to authenticated;
