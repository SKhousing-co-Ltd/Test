-- 区画ベースの賃貸借契約管理
-- 既存の property_master を物件の親マスタとして利用する。

create extension if not exists pgcrypto;

create table if not exists public.building_wing_master (
  building_wing_id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.property_master (property_id) on delete cascade,
  wing_code varchar(50) not null,
  wing_name varchar(100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_building_wing_master_property_wing unique (property_id, wing_code)
);

create table if not exists public.unit_master (
  unit_id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.property_master (property_id) on delete cascade,
  building_wing_id uuid references public.building_wing_master (building_wing_id) on delete restrict,
  unit_code varchar(100) not null,
  unit_name varchar(150),
  floor_label varchar(50),
  unit_type varchar(30) not null default 'office',
  rentable_area_sqm numeric(12, 2),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_unit_master_type check (unit_type in ('office', 'retail', 'residential', 'storage', 'parking', 'equipment', 'other')),
  constraint ck_unit_master_area_nonnegative check (rentable_area_sqm is null or rentable_area_sqm >= 0)
);

create unique index if not exists uq_unit_master_without_wing
  on public.unit_master (property_id, unit_code)
  where building_wing_id is null;

create unique index if not exists uq_unit_master_with_wing
  on public.unit_master (property_id, building_wing_id, unit_code)
  where building_wing_id is not null;

create table if not exists public.tenant_master (
  tenant_id uuid primary key default gen_random_uuid(),
  external_tenant_code varchar(100),
  tenant_name varchar(200) not null,
  normalized_tenant_name varchar(200) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_tenant_master_normalized_name unique (normalized_tenant_name)
);

create unique index if not exists uq_tenant_master_external_code
  on public.tenant_master (external_tenant_code)
  where external_tenant_code is not null;

create table if not exists public.lease_contract (
  lease_contract_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant_master (tenant_id) on delete restrict,
  contract_status varchar(20) not null default 'active',
  contract_type varchar(50),
  contract_start_date date,
  contract_end_date date,
  renewal_terms text,
  payment_terms text,
  notes text,
  source_system varchar(50),
  source_record_key varchar(200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_lease_contract_status check (contract_status in ('draft', 'active', 'terminated', 'expired')),
  constraint ck_lease_contract_dates check (contract_end_date is null or contract_start_date is null or contract_end_date >= contract_start_date),
  constraint uq_lease_contract_source_record unique (source_system, source_record_key)
);

create table if not exists public.lease_contract_unit (
  lease_contract_unit_id uuid primary key default gen_random_uuid(),
  lease_contract_id uuid not null references public.lease_contract (lease_contract_id) on delete cascade,
  unit_id uuid not null references public.unit_master (unit_id) on delete restrict,
  leased_area_sqm numeric(12, 2),
  monthly_rent_amount numeric(14, 0),
  monthly_common_charge_amount numeric(14, 0),
  monthly_total_amount numeric(14, 0) generated always as (coalesce(monthly_rent_amount, 0) + coalesce(monthly_common_charge_amount, 0)) stored,
  deposit_amount numeric(14, 0),
  security_deposit_amount numeric(14, 0),
  key_money_amount numeric(14, 0),
  renewal_fee_amount numeric(14, 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_lease_contract_unit unique (lease_contract_id, unit_id),
  constraint ck_lease_contract_unit_amounts_nonnegative check (
    (leased_area_sqm is null or leased_area_sqm >= 0)
    and (monthly_rent_amount is null or monthly_rent_amount >= 0)
    and (monthly_common_charge_amount is null or monthly_common_charge_amount >= 0)
    and (deposit_amount is null or deposit_amount >= 0)
    and (security_deposit_amount is null or security_deposit_amount >= 0)
    and (key_money_amount is null or key_money_amount >= 0)
    and (renewal_fee_amount is null or renewal_fee_amount >= 0)
  )
);

create table if not exists public.rent_roll_import_issue (
  rent_roll_import_issue_id uuid primary key default gen_random_uuid(),
  source_file_name varchar(255) not null,
  source_sheet_name varchar(100) not null,
  source_row_number integer,
  issue_type varchar(50) not null,
  message text not null,
  source_payload jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  constraint ck_rent_roll_import_issue_row check (source_row_number is null or source_row_number > 0)
);

create index if not exists ix_unit_master_property on public.unit_master (property_id);
create index if not exists ix_lease_contract_tenant on public.lease_contract (tenant_id);
create index if not exists ix_lease_contract_status_dates on public.lease_contract (contract_status, contract_start_date, contract_end_date);
create index if not exists ix_lease_contract_unit_unit on public.lease_contract_unit (unit_id);
create index if not exists ix_rent_roll_import_issue_open on public.rent_roll_import_issue (source_file_name, source_sheet_name)
  where resolved_at is null;

create or replace view public.unit_current_lease_status
with (security_invoker = true)
as
select
  unit.unit_id,
  unit.property_id,
  unit.building_wing_id,
  unit.unit_code,
  unit.floor_label,
  unit.unit_type,
  exists (
    select 1
    from public.lease_contract_unit as contract_unit
    join public.lease_contract as contract on contract.lease_contract_id = contract_unit.lease_contract_id
    where contract_unit.unit_id = unit.unit_id
      and contract.contract_status = 'active'
      and (contract.contract_start_date is null or contract.contract_start_date <= current_date)
      and (contract.contract_end_date is null or contract.contract_end_date >= current_date)
  ) as is_occupied
from public.unit_master as unit;

comment on table public.building_wing_master is '物件内の棟・館を管理するマスタ。棟がない物件では unit_master.building_wing_id を NULL にする。';
comment on table public.unit_master is '貸室、店舗、倉庫、ATM等を含む区画マスタ。';
comment on table public.tenant_master is 'テナントマスタ。external_tenant_code は既存レントロールのコードを保持する。';
comment on table public.lease_contract is 'テナントとの契約履歴。';
comment on table public.lease_contract_unit is '契約と区画の対応、および区画別の賃料等。';
comment on table public.rent_roll_import_issue is '初期レントロール取込時に自動判定できなかった行の確認一覧。';

alter table public.building_wing_master enable row level security;
alter table public.unit_master enable row level security;
alter table public.tenant_master enable row level security;
alter table public.lease_contract enable row level security;
alter table public.lease_contract_unit enable row level security;
alter table public.rent_roll_import_issue enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.building_wing_master, public.unit_master,
  public.tenant_master, public.lease_contract, public.lease_contract_unit,
  public.rent_roll_import_issue to authenticated;
grant select on public.unit_current_lease_status to authenticated;

create policy "authenticated employees can manage building wings"
  on public.building_wing_master for all to authenticated using (true) with check (true);
create policy "authenticated employees can manage units"
  on public.unit_master for all to authenticated using (true) with check (true);
create policy "authenticated employees can manage tenants"
  on public.tenant_master for all to authenticated using (true) with check (true);
create policy "authenticated employees can manage lease contracts"
  on public.lease_contract for all to authenticated using (true) with check (true);
create policy "authenticated employees can manage lease contract units"
  on public.lease_contract_unit for all to authenticated using (true) with check (true);
create policy "authenticated employees can manage rent roll import issues"
  on public.rent_roll_import_issue for all to authenticated using (true) with check (true);
