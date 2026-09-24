-- 過去レントロールの時点スナップショット。
-- 現在の契約マスタとは分離し、過去時点の収支・入居状況を保持する。
create table if not exists public.rent_roll_snapshot_batch (
  rent_roll_snapshot_batch_id uuid primary key default gen_random_uuid(),
  as_of_date date not null,
  source_file_name text not null,
  source_file_updated_at timestamptz,
  imported_at timestamptz not null default now(),
  status text not null default 'loaded',
  row_count integer not null default 0,
  notes text,
  constraint ck_rent_roll_snapshot_batch_status check (status in ('loaded', 'review', 'approved')),
  constraint uq_rent_roll_snapshot_batch_source unique (as_of_date, source_file_name)
);

create table if not exists public.rent_roll_snapshot_row (
  rent_roll_snapshot_row_id uuid primary key default gen_random_uuid(),
  rent_roll_snapshot_batch_id uuid not null references public.rent_roll_snapshot_batch on delete cascade,
  source_sheet_name text not null,
  source_row_number integer,
  property_name text not null,
  property_id uuid references public.asset_master(asset_id),
  wing_code text,
  floor_label text,
  unit_code text,
  unit_type text,
  tenant_name text,
  source_status text,
  occupancy_status text not null,
  area_sqm numeric,
  area_tsubo numeric,
  monthly_rent_amount numeric,
  monthly_common_charge_amount numeric,
  monthly_parking_amount numeric,
  other_monthly_amount numeric,
  deposit_amount numeric,
  security_deposit_amount numeric,
  key_money_amount numeric,
  renewal_fee_amount numeric,
  contract_start_date date,
  contract_end_date date,
  review_flags text,
  raw_payload jsonb,
  constraint ck_rent_roll_snapshot_row_occupancy check (occupancy_status in ('occupied', 'vacant')),
  constraint ck_rent_roll_snapshot_row_amounts check (
    coalesce(monthly_rent_amount, 0) >= 0 and
    coalesce(monthly_common_charge_amount, 0) >= 0 and
    coalesce(monthly_parking_amount, 0) >= 0 and
    coalesce(other_monthly_amount, 0) >= 0
  )
);

create index if not exists ix_rent_roll_snapshot_batch_date
  on public.rent_roll_snapshot_batch (as_of_date);
create index if not exists ix_rent_roll_snapshot_row_batch
  on public.rent_roll_snapshot_row (rent_roll_snapshot_batch_id);
create index if not exists ix_rent_roll_snapshot_row_property_date
  on public.rent_roll_snapshot_row (property_id, rent_roll_snapshot_batch_id);

alter table public.rent_roll_snapshot_batch enable row level security;
alter table public.rent_roll_snapshot_row enable row level security;

grant select on public.rent_roll_snapshot_batch, public.rent_roll_snapshot_row to authenticated;

drop policy if exists "authenticated users read rent roll snapshot batches" on public.rent_roll_snapshot_batch;
create policy "authenticated users read rent roll snapshot batches"
  on public.rent_roll_snapshot_batch for select to authenticated using (true);

drop policy if exists "authenticated users read rent roll snapshot rows" on public.rent_roll_snapshot_row;
create policy "authenticated users read rent roll snapshot rows"
  on public.rent_roll_snapshot_row for select to authenticated using (true);
