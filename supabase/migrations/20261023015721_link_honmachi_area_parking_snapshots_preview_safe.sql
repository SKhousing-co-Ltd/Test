create table if not exists public.rent_roll_snapshot_parking_allocation (
  rent_roll_snapshot_row_id uuid not null
    references public.rent_roll_snapshot_row(rent_roll_snapshot_row_id) on delete cascade,
  unit_id uuid not null
    references public.unit_master(unit_id) on delete restrict,
  allocated_monthly_parking_amount numeric not null
    check (allocated_monthly_parking_amount >= 0),
  mapping_basis text not null default 'user_confirmed',
  created_at timestamptz not null default now(),
  primary key (rent_roll_snapshot_row_id, unit_id)
);

comment on table public.rent_roll_snapshot_parking_allocation is
  'レントロールの駐車場集約スナップショットを当時の駐車枠と月額配賦額に対応付ける。元スナップショット行は変更しない。';
comment on column public.rent_roll_snapshot_parking_allocation.allocated_monthly_parking_amount is
  '集約行の月額駐車料のうち当該区画に配賦される額。';
comment on column public.rent_roll_snapshot_parking_allocation.mapping_basis is
  '対応付けの根拠。';

create index if not exists ix_rent_roll_snapshot_parking_allocation_unit
  on public.rent_roll_snapshot_parking_allocation(unit_id, rent_roll_snapshot_row_id);

alter table public.rent_roll_snapshot_parking_allocation enable row level security;
revoke all on table public.rent_roll_snapshot_parking_allocation from public, anon;
grant select on table public.rent_roll_snapshot_parking_allocation to authenticated;

drop policy if exists rent_roll_snapshot_parking_allocation_select
  on public.rent_roll_snapshot_parking_allocation;
create policy rent_roll_snapshot_parking_allocation_select
  on public.rent_roll_snapshot_parking_allocation for select to authenticated
  using (true);

do $migration$
declare
  v_property_id uuid;
  early_snapshot_count integer;
  ten_space_snapshot_count integer;
  four_space_snapshot_count integer;
  ten_space_count integer;
  four_space_count integer;
  source_snapshot_count integer;
begin
  if not exists (
    select 1
      from public.asset_master asset
     where asset.asset_name = '三共本町ビル'
  ) then
    raise notice 'Skipping 本町ビル parking snapshot allocation: property is absent in this database.';
    return;
  end if;

  select asset.asset_id into strict v_property_id
    from public.asset_master asset
   where asset.asset_name = '三共本町ビル';

  select count(*) into early_snapshot_count
    from public.rent_roll_snapshot_row snapshot
    join public.rent_roll_snapshot_batch batch using (rent_roll_snapshot_batch_id)
   where snapshot.property_id = v_property_id
     and snapshot.unit_code = '外部駐車場'
     and snapshot.tenant_name ilike '%エリア・パーキング%'
     and batch.as_of_date between date '2025-05-01' and date '2025-07-31'
     and coalesce(snapshot.monthly_parking_amount, 0) = 0;

  select count(*) into ten_space_snapshot_count
    from public.rent_roll_snapshot_row snapshot
    join public.rent_roll_snapshot_batch batch using (rent_roll_snapshot_batch_id)
   where snapshot.property_id = v_property_id
     and snapshot.unit_code = '外部駐車場'
     and snapshot.tenant_name ilike '%エリア・パーキング%'
     and batch.as_of_date between date '2025-08-01' and date '2025-12-31'
     and snapshot.monthly_parking_amount = 280000;

  select count(*) into four_space_snapshot_count
    from public.rent_roll_snapshot_row snapshot
    join public.rent_roll_snapshot_batch batch using (rent_roll_snapshot_batch_id)
   where snapshot.property_id = v_property_id
     and snapshot.unit_code = '外部駐車場'
     and snapshot.tenant_name ilike '%エリア・パーキング%'
     and batch.as_of_date >= date '2026-01-01'
     and snapshot.monthly_parking_amount = 112000;

  select count(*) into ten_space_count
    from public.unit_master unit
   where unit.property_id = v_property_id
     and unit.unit_code in (
       'PK-MAIN-201', 'PK-MAIN-202', 'PK-MAIN-203', 'PK-MAIN-204',
       'PK-MAIN-208', 'PK-MAIN-302', 'PK-MAIN-303', 'PK-MAIN-304', 'PK-MAIN-306',
       'PK-MAIN-310'
     );

  select count(*) into four_space_count
    from public.unit_master unit
   where unit.property_id = v_property_id
     and unit.unit_code in ('PK-MAIN-201', 'PK-MAIN-203', 'PK-MAIN-303', 'PK-MAIN-310');

  select count(*) into source_snapshot_count
    from public.rent_roll_snapshot_row snapshot
    join public.rent_roll_snapshot_batch batch using (rent_roll_snapshot_batch_id)
   where snapshot.property_id = v_property_id
     and snapshot.unit_code = '外部駐車場'
     and snapshot.tenant_name ilike '%エリア・パーキング%'
     and batch.as_of_date between date '2025-05-01' and date '2026-09-30';

  if source_snapshot_count = 0 and ten_space_count = 0 and four_space_count = 0 then
    raise notice 'Skipping 本町ビル parking snapshot allocation: source snapshots and target units are absent in this database.';
    return;
  end if;

  if ten_space_count <> 10
     or early_snapshot_count <> 6
     or ten_space_snapshot_count <> 10
     or four_space_snapshot_count <> 17
     or four_space_count <> 4 then
    raise exception 'Snapshot/unit verification failed (listed units %, zero-fee snapshots %, 10-space snapshots %, 4-space snapshots %, current units %)',
      ten_space_count, early_snapshot_count, ten_space_snapshot_count, four_space_snapshot_count, four_space_count;
  end if;
end;
$migration$;

with property as (
  select asset_id
    from public.asset_master
   where asset_name = '三共本町ビル'
),
legacy_units as (
  select unit.unit_id
    from public.unit_master unit
    join property on property.asset_id = unit.property_id
   where unit.unit_code in (
     'PK-MAIN-201', 'PK-MAIN-202', 'PK-MAIN-203', 'PK-MAIN-204',
     'PK-MAIN-208', 'PK-MAIN-302', 'PK-MAIN-303', 'PK-MAIN-304',
     'PK-MAIN-306', 'PK-MAIN-310'
   )
),
current_units as (
  select unit.unit_id
    from public.unit_master unit
    join property on property.asset_id = unit.property_id
   where unit.unit_code in ('PK-MAIN-201', 'PK-MAIN-203', 'PK-MAIN-303', 'PK-MAIN-310')
),
source_rows as (
  select snapshot.rent_roll_snapshot_row_id,
         snapshot.monthly_parking_amount,
         batch.as_of_date,
         case
           when batch.as_of_date between date '2025-05-01' and date '2025-12-31' then 'ten_units'
           else 'current_units'
         end as unit_set,
         case
           when batch.as_of_date between date '2025-05-01' and date '2025-07-31' then 0::numeric
           when batch.as_of_date between date '2025-08-01' and date '2025-12-31' then 28000::numeric
           else 28000::numeric
         end as per_unit_amount
    from public.rent_roll_snapshot_row snapshot
    join public.rent_roll_snapshot_batch batch using (rent_roll_snapshot_batch_id)
    join property on property.asset_id = snapshot.property_id
   where snapshot.unit_code = '外部駐車場'
     and snapshot.tenant_name ilike '%エリア・パーキング%'
     and batch.as_of_date between date '2025-05-01' and date '2026-09-30'
),
allocations as (
  select source.rent_roll_snapshot_row_id, unit.unit_id,
         source.per_unit_amount as allocated_monthly_parking_amount,
         'user_confirmed_unit_count_and_amount'::text as mapping_basis
    from source_rows source
    cross join lateral (
      select legacy.unit_id from legacy_units legacy where source.unit_set = 'ten_units'
      union all
      select current.unit_id from current_units current where source.unit_set = 'current_units'
    ) unit
)
insert into public.rent_roll_snapshot_parking_allocation (
  rent_roll_snapshot_row_id,
  unit_id,
  allocated_monthly_parking_amount,
  mapping_basis
)
select rent_roll_snapshot_row_id, unit_id, allocated_monthly_parking_amount, mapping_basis
  from allocations
on conflict (rent_roll_snapshot_row_id, unit_id) do update
  set allocated_monthly_parking_amount = excluded.allocated_monthly_parking_amount,
      mapping_basis = excluded.mapping_basis;
