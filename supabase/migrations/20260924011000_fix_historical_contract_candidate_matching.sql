create or replace function public.list_workflow_historical_contract_candidates(p_appsuite_record_id uuid)
returns table (
  historical_contract_key text,
  snapshot_date date,
  snapshot_count integer,
  property_name text,
  unit_code text,
  floor_label text,
  unit_type text,
  tenant_name text,
  period_start date,
  period_end date,
  monthly_rent_amount numeric,
  monthly_common_charge_amount numeric,
  match_level text,
  match_reasons jsonb,
  source_rows jsonb
)
language sql
security invoker
set search_path = public
as $$
  with request_context as (
    select
      ar.property_name,
      ar.tenant_name,
      coalesce(ar.raw_payload -> '号室' ->> 'val', ar.raw_payload -> '区画' ->> 'val', ar.raw_payload -> 'unit_code' ->> 'val') as unit_code,
      nullif(coalesce(ar.raw_payload -> '入居開始日' ->> 'val', ar.raw_payload -> '契約開始日' ->> 'val'), '')::date as effective_date,
      coalesce(ar.raw_payload -> '契約者' ->> 'val', ar.raw_payload -> '入居者' ->> 'val') as payload_tenant,
      ar.raw_payload -> '申請の要件' ->> 'val' as application_requirement
    from public.appsuite_record ar
    where ar.appsuite_record_id = p_appsuite_record_id
  ), source as (
    select
      b.as_of_date as snapshot_date,
      r.property_name,
      nullif(trim(r.unit_code), '') as unit_code,
      nullif(trim(r.floor_label), '') as floor_label,
      nullif(trim(r.unit_type), '') as unit_type,
      nullif(trim(r.tenant_name), '') as tenant_name,
      r.monthly_rent_amount,
      r.monthly_common_charge_amount,
      r.rent_roll_snapshot_row_id,
      b.source_file_name,
      r.source_sheet_name,
      r.source_row_number,
      c.property_name as request_property_name,
      coalesce(c.tenant_name, c.payload_tenant) as request_tenant_name,
      c.unit_code as request_unit_code,
      c.effective_date,
      c.application_requirement
    from public.rent_roll_snapshot_row r
    join public.rent_roll_snapshot_batch b on b.rent_roll_snapshot_batch_id = r.rent_roll_snapshot_batch_id
    cross join request_context c
    where r.occupancy_status = 'occupied'
      and (c.property_name is null or c.property_name = r.property_name or c.application_requirement ilike '%' || r.property_name || '%')
      and (coalesce(c.tenant_name, c.payload_tenant) is null or coalesce(c.tenant_name, c.payload_tenant) = r.tenant_name or c.application_requirement ilike '%' || r.tenant_name || '%')
      and (c.unit_code is null or c.unit_code = r.unit_code)
  ), grouped as (
    select
      md5(concat_ws('|', property_name, unit_code, tenant_name, unit_type,
        coalesce(monthly_rent_amount::text, ''), coalesce(monthly_common_charge_amount::text, ''))) as historical_contract_key,
      min(snapshot_date) as period_start,
      max(snapshot_date) as period_end,
      count(*)::integer as snapshot_count,
      max(snapshot_date) as snapshot_date,
      max(property_name) as property_name,
      max(unit_code) as unit_code,
      max(floor_label) as floor_label,
      max(unit_type) as unit_type,
      max(tenant_name) as tenant_name,
      max(monthly_rent_amount) as monthly_rent_amount,
      max(monthly_common_charge_amount) as monthly_common_charge_amount,
      jsonb_agg(jsonb_build_object('row_id', rent_roll_snapshot_row_id, 'date', snapshot_date, 'file_name', source_file_name, 'sheet_name', source_sheet_name, 'row_number', source_row_number) order by snapshot_date) as source_rows,
      bool_or(request_property_name is not null and (request_property_name = property_name or application_requirement ilike '%' || property_name || '%')) as property_matched,
      bool_or(request_tenant_name is not null and (request_tenant_name = tenant_name or application_requirement ilike '%' || tenant_name || '%')) as tenant_matched,
      bool_or(request_unit_code is not null and request_unit_code = unit_code) as unit_matched
    from source
    group by md5(concat_ws('|', property_name, unit_code, tenant_name, unit_type,
      coalesce(monthly_rent_amount::text, ''), coalesce(monthly_common_charge_amount::text, '')))
  )
  select
    historical_contract_key, snapshot_date, snapshot_count, property_name, unit_code,
    floor_label, unit_type, tenant_name, period_start, period_end,
    monthly_rent_amount, monthly_common_charge_amount,
    case when property_matched and tenant_matched and unit_matched and snapshot_count >= 3 then 'Strong'
         when property_matched and (tenant_matched or unit_matched) then 'Multiple'
         else 'Weak' end,
    jsonb_build_array(
      jsonb_build_object('rule', 'property', 'matched', property_matched, 'message', '物件'),
      jsonb_build_object('rule', 'tenant', 'matched', tenant_matched, 'message', 'テナント'),
      jsonb_build_object('rule', 'unit', 'matched', unit_matched, 'message', '区画'),
      jsonb_build_object('rule', 'snapshot_count', 'matched', snapshot_count >= 2, 'message', '複数月の継続記録')
    ),
    source_rows
  from grouped
  order by snapshot_count desc, period_end desc nulls last;
$$;
