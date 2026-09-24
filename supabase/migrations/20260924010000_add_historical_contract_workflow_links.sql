-- Historical contract candidates are derived from rent-roll snapshots and are
-- intentionally kept separate from lease_contract / lease_contract_unit.
create table if not exists public.workflow_historical_contract_link (
  workflow_historical_contract_link_id uuid primary key default gen_random_uuid(),
  appsuite_record_id uuid not null references public.appsuite_record(appsuite_record_id) on delete cascade,
  historical_contract_key text not null,
  snapshot_date date not null,
  property_name text not null,
  unit_code text,
  tenant_name text,
  link_role varchar(20) not null default 'primary',
  operation_kind varchar(40) not null,
  confirmed_at timestamptz not null default now(),
  confirmed_by uuid references auth.users(id) on delete set null,
  notes text,
  constraint ck_workflow_historical_link_role check (link_role in ('primary', 'related')),
  constraint ck_workflow_historical_link_operation check (operation_kind in ('contract_create', 'contract_update', 'contract_terminate', 'contract_cancellation_review')),
  constraint uq_workflow_historical_link unique (appsuite_record_id, historical_contract_key)
);

create index if not exists ix_workflow_historical_link_record
  on public.workflow_historical_contract_link(appsuite_record_id, snapshot_date desc);

alter table public.workflow_historical_contract_link enable row level security;
grant select, insert, update on public.workflow_historical_contract_link to authenticated;

drop policy if exists "active users read historical workflow links" on public.workflow_historical_contract_link;
create policy "active users read historical workflow links"
  on public.workflow_historical_contract_link for select to authenticated
  using (public.current_account_is_active());

drop policy if exists "active operators write historical workflow links" on public.workflow_historical_contract_link;
create policy "active operators write historical workflow links"
  on public.workflow_historical_contract_link for insert to authenticated
  with check (public.current_account_is_active() and public.current_account_role() in ('admin', 'manager', 'staff'));

drop policy if exists "active operators update historical workflow links" on public.workflow_historical_contract_link;
create policy "active operators update historical workflow links"
  on public.workflow_historical_contract_link for update to authenticated
  using (public.current_account_is_active() and public.current_account_role() in ('admin', 'manager', 'staff'))
  with check (public.current_account_is_active() and public.current_account_role() in ('admin', 'manager', 'staff'));

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
  with source as (
    select
      b.as_of_date as snapshot_date,
      r.property_name,
      nullif(trim(r.unit_code), '') as unit_code,
      nullif(trim(r.floor_label), '') as floor_label,
      nullif(trim(r.unit_type), '') as unit_type,
      nullif(trim(r.tenant_name), '') as tenant_name,
      r.contract_start_date,
      r.contract_end_date,
      r.monthly_rent_amount,
      r.monthly_common_charge_amount,
      r.rent_roll_snapshot_row_id,
      b.source_file_name,
      r.source_sheet_name,
      r.source_row_number,
      cr.source_payload,
      cr.proposed_payload
    from public.rent_roll_snapshot_row r
    join public.rent_roll_snapshot_batch b on b.rent_roll_snapshot_batch_id = r.rent_roll_snapshot_batch_id
    join public.change_request cr on cr.source_appsuite_record_id = p_appsuite_record_id
    where r.occupancy_status = 'occupied'
  ), grouped as (
    select
      md5(concat_ws('|', property_name, unit_code, tenant_name, unit_type,
        coalesce(monthly_rent_amount::text, ''), coalesce(monthly_common_charge_amount::text, ''))) as historical_contract_key,
      min(snapshot_date) as period_start,
      max(snapshot_date) as period_end,
      count(*)::integer as snapshot_count,
      min(snapshot_date) as snapshot_date,
      max(property_name) as property_name,
      max(unit_code) as unit_code,
      max(floor_label) as floor_label,
      max(unit_type) as unit_type,
      max(tenant_name) as tenant_name,
      max(monthly_rent_amount) as monthly_rent_amount,
      max(monthly_common_charge_amount) as monthly_common_charge_amount,
      jsonb_agg(jsonb_build_object('row_id', rent_roll_snapshot_row_id, 'date', snapshot_date, 'file_name', source_file_name, 'sheet_name', source_sheet_name, 'row_number', source_row_number) order by snapshot_date) as source_rows,
      max(source_payload ->> '物件名') as request_property_name,
      max(source_payload ->> 'テナント名') as request_tenant_name,
      max(proposed_payload ->> 'unit_code') as request_unit_code
    from source
    group by md5(concat_ws('|', property_name, unit_code, tenant_name, unit_type,
      coalesce(monthly_rent_amount::text, ''), coalesce(monthly_common_charge_amount::text, '')))
  )
  select
    historical_contract_key, snapshot_date, snapshot_count, property_name, unit_code,
    floor_label, unit_type, tenant_name, period_start, period_end,
    monthly_rent_amount, monthly_common_charge_amount,
    case when snapshot_count >= 3 then 'Strong' when snapshot_count = 2 then 'Multiple' else 'Weak' end,
    jsonb_build_array(
      jsonb_build_object('rule', 'property', 'matched', request_property_name is null or request_property_name = property_name, 'message', '物件'),
      jsonb_build_object('rule', 'tenant', 'matched', request_tenant_name is null or request_tenant_name = tenant_name, 'message', 'テナント'),
      jsonb_build_object('rule', 'unit', 'matched', request_unit_code is null or request_unit_code = unit_code, 'message', '区画'),
      jsonb_build_object('rule', 'snapshot_count', 'matched', snapshot_count >= 2, 'message', '複数月の継続記録')
    ),
    source_rows
  from grouped
  order by snapshot_count desc, period_end desc nulls last;
$$;

revoke all on function public.list_workflow_historical_contract_candidates(uuid) from public, anon;
grant execute on function public.list_workflow_historical_contract_candidates(uuid) to authenticated;

create or replace function public.confirm_workflow_historical_contract_link(
  p_appsuite_record_id uuid,
  p_historical_contract_key text,
  p_snapshot_date date,
  p_property_name text,
  p_unit_code text,
  p_tenant_name text,
  p_operation_kind varchar,
  p_notes text default null
)
returns public.workflow_historical_contract_link
language plpgsql
security invoker
set search_path = public
as $$
declare v_link public.workflow_historical_contract_link;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception 'Active operator account required';
  end if;
  insert into public.workflow_historical_contract_link (
    appsuite_record_id, historical_contract_key, snapshot_date, property_name,
    unit_code, tenant_name, operation_kind, confirmed_by, notes
  ) values (
    p_appsuite_record_id, p_historical_contract_key, p_snapshot_date, p_property_name,
    p_unit_code, p_tenant_name, p_operation_kind, auth.uid(), p_notes
  )
  on conflict (appsuite_record_id, historical_contract_key) do update set
    snapshot_date = excluded.snapshot_date,
    property_name = excluded.property_name,
    unit_code = excluded.unit_code,
    tenant_name = excluded.tenant_name,
    operation_kind = excluded.operation_kind,
    confirmed_at = now(),
    confirmed_by = auth.uid(),
    notes = excluded.notes
  returning * into v_link;
  return v_link;
end;
$$;

revoke all on function public.confirm_workflow_historical_contract_link(uuid, text, date, text, text, text, varchar, text) from public, anon;
grant execute on function public.confirm_workflow_historical_contract_link(uuid, text, date, text, text, text, varchar, text) to authenticated;
