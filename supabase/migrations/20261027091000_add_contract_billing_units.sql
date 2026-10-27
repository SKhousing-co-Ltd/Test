-- A lease may group its physical units into billing units used by utility billing.
create table if not exists public.lease_contract_billing_unit (
  lease_contract_billing_unit_id uuid primary key default gen_random_uuid(),
  lease_contract_id uuid not null references public.lease_contract(lease_contract_id) on delete cascade,
  billing_unit_name varchar(100) not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lease_contract_id, billing_unit_name)
);

create table if not exists public.lease_contract_billing_unit_member (
  lease_contract_billing_unit_id uuid not null references public.lease_contract_billing_unit(lease_contract_billing_unit_id) on delete cascade,
  lease_contract_unit_id uuid not null references public.lease_contract_unit(lease_contract_unit_id) on delete cascade,
  primary key (lease_contract_billing_unit_id, lease_contract_unit_id),
  unique (lease_contract_unit_id)
);

create table if not exists public.lease_contract_billing_unit_utility_price (
  lease_contract_billing_unit_id uuid not null references public.lease_contract_billing_unit(lease_contract_billing_unit_id) on delete cascade,
  asset_billing_line_item_id uuid not null references public.asset_billing_line_item(asset_billing_line_item_id) on delete cascade,
  unit_price numeric not null check (unit_price >= 0),
  tax_mode varchar(20) not null default 'exclusive' check (tax_mode in ('exclusive', 'inclusive')),
  billing_month_prices jsonb not null default '[]'::jsonb,
  primary key (lease_contract_billing_unit_id, asset_billing_line_item_id)
);

create table if not exists public.lease_contract_billing_unit_category_price (
  lease_contract_billing_unit_id uuid not null references public.lease_contract_billing_unit(lease_contract_billing_unit_id) on delete cascade,
  category varchar(20) not null check (category in ('electric', 'water', 'gas')),
  unit_price numeric not null check (unit_price >= 0),
  tax_mode varchar(20) not null default 'exclusive' check (tax_mode in ('exclusive', 'inclusive')),
  billing_month_prices jsonb not null default '[]'::jsonb,
  primary key (lease_contract_billing_unit_id, category)
);

create table if not exists public.lease_contract_billing_unit_basic_charge (
  lease_contract_billing_unit_id uuid not null references public.lease_contract_billing_unit(lease_contract_billing_unit_id) on delete cascade,
  category varchar(20) not null check (category in ('electric', 'water', 'gas')),
  amount numeric not null check (amount >= 0),
  tax_mode varchar(20) not null default 'exclusive' check (tax_mode in ('exclusive', 'inclusive')),
  primary key (lease_contract_billing_unit_id, category)
);

alter table public.asset_meter_unit_assignment
  add column if not exists lease_contract_billing_unit_id uuid
  references public.lease_contract_billing_unit(lease_contract_billing_unit_id) on delete set null;

alter table public.asset_meter_unit_assignment alter column unit_id drop not null;

alter table public.asset_meter_unit_assignment
  add constraint asset_meter_assignment_exactly_one_target
  check ((unit_id is not null)::integer + (lease_contract_billing_unit_id is not null)::integer = 1) not valid;
alter table public.asset_meter_unit_assignment validate constraint asset_meter_assignment_exactly_one_target;

create index if not exists ix_contract_billing_unit_contract
  on public.lease_contract_billing_unit(lease_contract_id, sort_order);
create index if not exists ix_meter_assignment_billing_unit
  on public.asset_meter_unit_assignment(lease_contract_billing_unit_id)
  where lease_contract_billing_unit_id is not null;

alter table public.lease_contract_billing_unit enable row level security;
alter table public.lease_contract_billing_unit_member enable row level security;
alter table public.lease_contract_billing_unit_utility_price enable row level security;
alter table public.lease_contract_billing_unit_category_price enable row level security;
alter table public.lease_contract_billing_unit_basic_charge enable row level security;

create policy "active users manage contract billing units" on public.lease_contract_billing_unit
  for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage contract billing unit members" on public.lease_contract_billing_unit_member
  for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage contract billing unit prices" on public.lease_contract_billing_unit_utility_price
  for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage contract billing unit category prices" on public.lease_contract_billing_unit_category_price
  for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage contract billing unit basic charges" on public.lease_contract_billing_unit_basic_charge
  for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());

grant select, insert, update, delete on public.lease_contract_billing_unit to authenticated;
grant select, insert, update, delete on public.lease_contract_billing_unit_member to authenticated;
grant select, insert, update, delete on public.lease_contract_billing_unit_utility_price to authenticated;
grant select, insert, update, delete on public.lease_contract_billing_unit_category_price to authenticated;
grant select, insert, update, delete on public.lease_contract_billing_unit_basic_charge to authenticated;

comment on table public.lease_contract_billing_unit is '契約内の物理区画を請求上まとめる請求区画';
comment on table public.lease_contract_billing_unit_member is '請求区画を構成する契約区画';
comment on column public.asset_meter_unit_assignment.lease_contract_billing_unit_id is '契約で請求区画を分ける場合のメーター割当先';

create or replace function public.create_kanameter_meter_for_billing_unit(
  p_asset_id uuid, p_asset_meter_sub_item_id uuid, p_meter_code text, p_lease_contract_billing_unit_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_meter_id uuid;
begin
  if not public.current_account_is_active() then raise exception 'KANAMETERを利用する権限がありません'; end if;
  if nullif(trim(p_meter_code), '') is null then raise exception 'メーター番号を入力してください'; end if;
  if not exists (select 1 from public.asset_meter_sub_item where asset_meter_sub_item_id = p_asset_meter_sub_item_id and asset_id = p_asset_id) then raise exception '小分類が対象ビルのものではありません'; end if;
  if not exists (
    select 1 from public.lease_contract_billing_unit b
    join public.lease_contract_billing_unit_member bm using (lease_contract_billing_unit_id)
    join public.lease_contract_unit cu using (lease_contract_unit_id)
    join public.unit_master u on u.unit_id = cu.unit_id
    where b.lease_contract_billing_unit_id = p_lease_contract_billing_unit_id and u.property_id = p_asset_id
  ) then raise exception '請求区画が対象ビルのものではありません'; end if;
  insert into public.asset_meter (asset_id, asset_meter_sub_item_id, meter_code, is_active)
  values (p_asset_id, p_asset_meter_sub_item_id, trim(p_meter_code), true) returning asset_meter_id into v_meter_id;
  insert into public.asset_meter_unit_assignment (asset_meter_id, unit_id, lease_contract_billing_unit_id, effective_from)
  values (v_meter_id, null, p_lease_contract_billing_unit_id, date '1900-01-01');
  return v_meter_id;
end $$;

create or replace function public.assign_kanameter_meter_billing_unit_from(
  p_asset_meter_id uuid, p_lease_contract_billing_unit_id uuid, p_effective_from date
) returns void language plpgsql security definer set search_path = public as $$
declare v_asset_id uuid;
begin
  if not public.current_account_is_active() then raise exception 'KANAMETERを利用する権限がありません'; end if;
  select asset_id into v_asset_id from public.asset_meter where asset_meter_id = p_asset_meter_id;
  if v_asset_id is null then raise exception 'メーターが見つかりません'; end if;
  if not exists (
    select 1 from public.lease_contract_billing_unit_member bm
    join public.lease_contract_unit cu using (lease_contract_unit_id)
    join public.unit_master u on u.unit_id = cu.unit_id
    where bm.lease_contract_billing_unit_id = p_lease_contract_billing_unit_id and u.property_id = v_asset_id
  ) then raise exception '請求区画が対象ビルのものではありません'; end if;
  update public.asset_meter_unit_assignment set effective_to = p_effective_from - 1, updated_at = now()
  where asset_meter_id = p_asset_meter_id and effective_from < p_effective_from and (effective_to is null or effective_to >= p_effective_from);
  insert into public.asset_meter_unit_assignment (asset_meter_id, unit_id, lease_contract_billing_unit_id, effective_from, effective_to)
  values (p_asset_meter_id, null, p_lease_contract_billing_unit_id, p_effective_from, null)
  on conflict (asset_meter_id, effective_from) do update
  set unit_id = null, lease_contract_billing_unit_id = excluded.lease_contract_billing_unit_id, effective_to = null, updated_at = now();
end $$;

revoke all on function public.create_kanameter_meter_for_billing_unit(uuid, uuid, text, uuid) from public, anon;
revoke all on function public.assign_kanameter_meter_billing_unit_from(uuid, uuid, date) from public, anon;
grant execute on function public.create_kanameter_meter_for_billing_unit(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.assign_kanameter_meter_billing_unit_from(uuid, uuid, date) to authenticated;
