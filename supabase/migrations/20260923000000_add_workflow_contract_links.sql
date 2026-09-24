create table if not exists public.workflow_contract_link (
  workflow_contract_link_id uuid primary key default gen_random_uuid(),
  appsuite_record_id uuid not null references public.appsuite_record(appsuite_record_id) on delete cascade,
  lease_contract_id uuid not null references public.lease_contract(lease_contract_id) on delete restrict,
  link_role varchar(20) not null default 'primary',
  effective_date date,
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users(id) on delete set null,
  link_source varchar(30) not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_workflow_contract_link_role check (link_role in ('primary', 'source', 'target', 'related')),
  constraint ck_workflow_contract_link_source check (link_source in ('manual', 'import', 'recheck')),
  constraint uq_workflow_contract_link_record_contract unique (appsuite_record_id, lease_contract_id)
);

create index if not exists ix_workflow_contract_link_record
  on public.workflow_contract_link(appsuite_record_id, link_role);
create index if not exists ix_workflow_contract_link_contract
  on public.workflow_contract_link(lease_contract_id, effective_date desc);

create table if not exists public.workflow_contract_match_audit (
  workflow_contract_match_audit_id uuid primary key default gen_random_uuid(),
  appsuite_record_id uuid not null references public.appsuite_record(appsuite_record_id) on delete cascade,
  rule_version varchar(50) not null,
  suggested_lease_contract_id uuid references public.lease_contract(lease_contract_id) on delete set null,
  suggestion_level varchar(20) not null,
  candidate_contract_ids jsonb not null default '[]'::jsonb,
  match_reasons jsonb not null default '[]'::jsonb,
  confirmed_lease_contract_id uuid references public.lease_contract(lease_contract_id) on delete set null,
  evaluated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users(id) on delete set null,
  constraint ck_workflow_contract_match_level check (suggestion_level in ('Strong', 'Multiple', 'Weak', 'None')),
  constraint ck_workflow_contract_match_candidates check (jsonb_typeof(candidate_contract_ids) = 'array'),
  constraint ck_workflow_contract_match_reasons check (jsonb_typeof(match_reasons) = 'array')
);

create index if not exists ix_workflow_contract_match_audit_record
  on public.workflow_contract_match_audit(appsuite_record_id, evaluated_at desc);

alter table public.workflow_contract_link enable row level security;
alter table public.workflow_contract_match_audit enable row level security;

grant select on public.workflow_contract_link, public.workflow_contract_match_audit to authenticated;
grant select, insert, update on public.workflow_contract_link to authenticated;
grant select, insert, update on public.workflow_contract_match_audit to authenticated;

drop policy if exists "active users read workflow contract links" on public.workflow_contract_link;
create policy "active users read workflow contract links"
  on public.workflow_contract_link for select to authenticated
  using (public.current_account_is_active());

drop policy if exists "active users read workflow contract match audits" on public.workflow_contract_match_audit;
create policy "active users read workflow contract match audits"
  on public.workflow_contract_match_audit for select to authenticated
  using (public.current_account_is_active());

drop trigger if exists set_workflow_contract_link_updated_at on public.workflow_contract_link;
create trigger set_workflow_contract_link_updated_at
  before update on public.workflow_contract_link
  for each row execute procedure public.set_updated_at();

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
    nullif(v_record.raw_payload ->> 'effective_date', '')::date,
    nullif(v_record.raw_payload ->> '契約開始日', '')::date,
    nullif(v_record.raw_payload ->> '変更日', '')::date,
    nullif(v_record.raw_payload ->> '解約日', '')::date
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
        jsonb_build_object('rule', 'effective_date', 'matched', v_effective_date is not null and (contract.contract_start_date is null or contract.contract_start_date <= v_effective_date) and (contract.contract_end_date is null or contract.contract_end_date >= v_effective_date), 'message', case when v_effective_date is null then '効力日要確認' else '契約期間一致' end)
      ) as match_reasons
    from public.lease_contract contract
    join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
    join public.lease_contract_unit contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
    join public.property_master property on property.property_id = unit.property_id
    where (nullif(v_record.property_name, '') is null or property.property_name = v_record.property_name)
      and (nullif(v_record.tenant_name, '') is null or tenant.tenant_name = v_record.tenant_name)
  ), ranked as (
    select candidates.*, count(*) over () as total_count,
           max(match_count) over () as max_match_count
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

create or replace function public.confirm_workflow_contract_link(
  p_appsuite_record_id uuid,
  p_lease_contract_id uuid,
  p_link_role varchar default 'primary',
  p_effective_date date default null
)
returns public.workflow_contract_link
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record public.appsuite_record;
  v_link public.workflow_contract_link;
  v_request_id uuid;
begin
  if not public.current_account_is_active() or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception 'Active operator account required';
  end if;
  if p_link_role not in ('primary', 'source', 'target', 'related') then
    raise exception 'Invalid link role';
  end if;
  select * into v_record from public.appsuite_record where appsuite_record_id = p_appsuite_record_id;
  if not found then raise exception 'AppSuite record not found'; end if;
  if not exists (select 1 from public.lease_contract where lease_contract_id = p_lease_contract_id) then
    raise exception 'Lease contract not found';
  end if;

  insert into public.workflow_contract_link (
    appsuite_record_id, lease_contract_id, link_role, effective_date,
    confirmed_at, confirmed_by, link_source
  ) values (
    p_appsuite_record_id, p_lease_contract_id, p_link_role, p_effective_date,
    now(), auth.uid(), 'manual'
  )
  on conflict (appsuite_record_id, lease_contract_id) do update set
    link_role = excluded.link_role,
    effective_date = excluded.effective_date,
    confirmed_at = excluded.confirmed_at,
    confirmed_by = excluded.confirmed_by,
    link_source = 'manual'
  returning * into v_link;

  update public.workflow_contract_match_audit
     set confirmed_lease_contract_id = p_lease_contract_id,
         confirmed_at = now(),
         confirmed_by = auth.uid()
   where workflow_contract_match_audit_id = (
     select workflow_contract_match_audit_id
       from public.workflow_contract_match_audit
      where appsuite_record_id = p_appsuite_record_id
      order by evaluated_at desc
      limit 1
   );

  select change_request_id into v_request_id
    from public.change_request
   where source_type = 'desknets'
     and source_record_key = concat(v_record.app_id, ':', v_record.data_id)
     and request_type = (select processing_type from public.appsuite_application where app_id = v_record.app_id)
     and status not in ('applied', 'excluded')
   order by created_at desc
   limit 1;
  if v_request_id is not null then
    update public.change_request
       set proposed_payload = proposed_payload || jsonb_build_object(
         'workflow_contract_link', jsonb_build_object(
           'lease_contract_id', p_lease_contract_id,
           'link_role', p_link_role,
           'effective_date', p_effective_date,
           'confirmed_at', now()
         )
       )
     where change_request_id = v_request_id;
  end if;
  return v_link;
end;
$$;

revoke all on function public.confirm_workflow_contract_link(uuid, uuid, varchar, date) from public, anon;
grant execute on function public.confirm_workflow_contract_link(uuid, uuid, varchar, date) to authenticated;
