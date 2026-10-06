-- 検針データのメーターを、テナントではなく区画（unit_master）に紐づけます。
-- 請求先は、請求月ごとにレントロールからその区画の入居テナントを求めて決めます。
-- あわせて、指針入力・中間検針（月途中の入退去）・メーター交換を扱えるようにします。

-- 1. 小分類ごとの入力方式です。usage：使用量を入力／reading：指針を入力して差分を使用量にする
alter table public.asset_meter_sub_item
  add column if not exists input_mode varchar(10) not null default 'usage';
alter table public.asset_meter_sub_item drop constraint if exists ck_asset_meter_sub_item_input_mode;
alter table public.asset_meter_sub_item
  add constraint ck_asset_meter_sub_item_input_mode check (input_mode in ('usage', 'reading'));
comment on column public.asset_meter_sub_item.input_mode is '検針値の入力方式（usage：使用量／reading：指針）';

-- 2. メーターと区画の紐づけです。区画の分割などに備え、適用期間つきの履歴で持ちます。
create table if not exists public.asset_meter_unit_assignment (
  asset_meter_unit_assignment_id uuid primary key default gen_random_uuid(),
  asset_meter_id uuid not null references public.asset_meter(asset_meter_id) on delete cascade,
  unit_id uuid not null references public.unit_master(unit_id) on delete restrict,
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_asset_meter_unit_assignment_start unique (asset_meter_id, effective_from),
  constraint ck_asset_meter_unit_assignment_dates check (effective_to is null or effective_to >= effective_from)
);
create index if not exists ix_asset_meter_unit_assignment_meter on public.asset_meter_unit_assignment(asset_meter_id, effective_from desc);
comment on table public.asset_meter_unit_assignment is 'メーターを設置している区画の履歴。1900-01-01 は「当初から」を表す';

comment on column public.asset_meter.meter_reading_contract_id is '旧：割当先の契約行。区画での紐づけ（asset_meter_unit_assignment）へ移行済みで、画面からは更新しない';

-- 3. データ分割しているテナントの、分割行ごとの区画です。未設定の区画は1行目で計算します。
create table if not exists public.meter_reading_contract_unit (
  meter_reading_contract_id uuid not null references public.meter_reading_contract(meter_reading_contract_id) on delete cascade,
  unit_id uuid not null references public.unit_master(unit_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (meter_reading_contract_id, unit_id)
);

-- 4. 月次の検針値に、指針とメーター交換を持たせます。usage_amount は引き続き月の使用量（全体）です。
alter table public.meter_reading_entry
  add column if not exists previous_reading numeric(14, 3),
  add column if not exists current_reading numeric(14, 3),
  add column if not exists previous_reading_manual boolean not null default false,
  add column if not exists exchange_removed_reading numeric(14, 3),
  add column if not exists exchange_installed_reading numeric(14, 3);
comment on column public.meter_reading_entry.previous_reading is '前月指針。手入力でなければ前月の当月指針を使う';
comment on column public.meter_reading_entry.previous_reading_manual is '前月指針を手入力したか';
comment on column public.meter_reading_entry.exchange_removed_reading is 'メーター交換時の旧メーター撤去時指針';
comment on column public.meter_reading_entry.exchange_installed_reading is 'メーター交換時の新メーター設置時指針';

-- 5. 中間検針です。区切りの日と、その日の指針（指針入力）または区切りまでの使用量（使用量入力）を持ちます。
create table if not exists public.meter_reading_break (
  asset_id uuid not null,
  billing_month date not null,
  asset_meter_id uuid not null references public.asset_meter(asset_meter_id) on delete cascade,
  break_date date not null,
  reading numeric(14, 3),
  usage_amount numeric(14, 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (asset_id, billing_month, asset_meter_id, break_date),
  foreign key (asset_id, billing_month) references public.meter_reading_month(asset_id, billing_month) on delete cascade
);
comment on table public.meter_reading_break is '中間検針。区切りの日までを前の区間、翌日からを次の区間として請求先を決める';

alter table public.asset_meter_unit_assignment enable row level security;
alter table public.meter_reading_contract_unit enable row level security;
alter table public.meter_reading_break enable row level security;

grant select, insert, update, delete on
  public.asset_meter_unit_assignment,
  public.meter_reading_contract_unit,
  public.meter_reading_break
to authenticated;

drop policy if exists "active users manage meter unit assignments" on public.asset_meter_unit_assignment;
create policy "active users manage meter unit assignments" on public.asset_meter_unit_assignment for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
drop policy if exists "active users manage meter reading contract units" on public.meter_reading_contract_unit;
create policy "active users manage meter reading contract units" on public.meter_reading_contract_unit for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
drop policy if exists "active users manage meter reading breaks" on public.meter_reading_break;
create policy "active users manage meter reading breaks" on public.meter_reading_break for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());

-- 6. 期間中の日ごとの入居状況です。区間ごとの請求先と、基本料の日割りに使います。
--    レントロールと同じ判定（lease_contract_unit_snapshot_at_date）を日ごとに使います。
create or replace function public.meter_unit_occupancy(p_property_id uuid, p_from date, p_to date)
returns table (occupancy_date date, unit_id uuid, unit_type text, tenant_id uuid, tenant_name text)
language sql
stable
security invoker
set search_path = ''
as $$
  select day.value::date, snapshot.unit_id, unit.unit_type::text, snapshot.tenant_id, snapshot.tenant_name
  from generate_series(p_from::timestamp, least(p_to, p_from + 120)::timestamp, interval '1 day') as day(value)
  cross join lateral public.lease_contract_unit_snapshot_at_date(p_property_id, day.value::date) snapshot
  join public.unit_master unit on unit.unit_id = snapshot.unit_id
  where snapshot.tenant_id is not null;
$$;
revoke all on function public.meter_unit_occupancy(uuid, date, date) from public, anon;
grant execute on function public.meter_unit_occupancy(uuid, date, date) to authenticated;
comment on function public.meter_unit_occupancy(uuid, date, date) is '期間中の日ごとに、区画の入居テナントを返す（最大121日）';

-- 7. 既存の割り当てを区画へ移します。
--    割当テナントが借りている貸室が1つならその区画、複数ならメーター識別（階）と区画の階が一致する1つを選びます。
--    決められないメーターは未割当のまま残し、画面で区画を選んでもらいます。
with meter_source as (
  select meter.asset_meter_id, meter.asset_id, coalesce(meter.meter_label, '') as meter_label, contract.tenant_id
  from public.asset_meter meter
  join public.meter_reading_contract contract on contract.meter_reading_contract_id = meter.meter_reading_contract_id
  where not exists (select 1 from public.asset_meter_unit_assignment existing where existing.asset_meter_id = meter.asset_meter_id)
),
asset_dates as (
  select distinct asset_id, current_date as as_of from meter_source
  union
  select month.asset_id, max(month.billing_month) from public.meter_reading_month month
  where month.asset_id in (select asset_id from meter_source) group by month.asset_id
),
tenant_units as (
  select distinct dates.asset_id, snapshot.tenant_id, snapshot.unit_id,
    upper(regexp_replace(translate(coalesce(unit.floor_label, ''), '０１２３４５６７８９ＢＦｂｆ', '0123456789BFbf'), '[^0-9A-Za-z]', '', 'g')) as floor_key
  from asset_dates dates
  cross join lateral public.lease_contract_unit_snapshot_at_date(dates.asset_id, dates.as_of) snapshot
  join public.unit_master unit on unit.unit_id = snapshot.unit_id
  where unit.unit_type in ('office', 'residential', 'warehouse')
),
candidates as (
  select source.asset_meter_id, units.unit_id,
    count(*) over (partition by source.asset_meter_id) as all_count,
    count(*) filter (where units.floor_key <> '' and units.floor_key = source.meter_label) over (partition by source.asset_meter_id) as floor_count,
    (units.floor_key <> '' and units.floor_key = source.meter_label) as floor_match
  from meter_source source
  join tenant_units units on units.asset_id = source.asset_id and units.tenant_id = source.tenant_id
)
insert into public.asset_meter_unit_assignment (asset_meter_id, unit_id, effective_from)
select distinct on (asset_meter_id) asset_meter_id, unit_id, date '1900-01-01'
from candidates
where all_count = 1 or (floor_count = 1 and floor_match)
order by asset_meter_id, floor_match desc;

-- 分割行を持つテナントは、各行に割り当てていたメーターの区画を、その行の区画にします（1つの行にだけ出てくる区画に限る）。
with row_units as (
  select distinct contract.tenant_id, contract.asset_id, contract.meter_reading_contract_id, assignment.unit_id
  from public.asset_meter meter
  join public.meter_reading_contract contract on contract.meter_reading_contract_id = meter.meter_reading_contract_id
  join public.asset_meter_unit_assignment assignment on assignment.asset_meter_id = meter.asset_meter_id
  where (select count(*) from public.meter_reading_contract other where other.asset_id = contract.asset_id and other.tenant_id = contract.tenant_id) > 1
),
unique_units as (
  select *, count(*) over (partition by asset_id, tenant_id, unit_id) as row_count from row_units
)
insert into public.meter_reading_contract_unit (meter_reading_contract_id, unit_id)
select meter_reading_contract_id, unit_id from unique_units where row_count = 1
on conflict do nothing;
