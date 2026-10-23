create table if not exists public.utility_tariff_version (
  utility_tariff_version_id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  tariff_kind varchar(50) not null,
  tariff_name varchar(200) not null,
  effective_from date not null,
  effective_to date,
  tax_rate numeric(6, 5) not null default 0.10,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (asset_id, tariff_kind, effective_from),
  check (effective_to is null or effective_to >= effective_from)
);

create table if not exists public.utility_tariff_tier (
  utility_tariff_tier_id uuid primary key default gen_random_uuid(),
  utility_tariff_version_id uuid not null references public.utility_tariff_version(utility_tariff_version_id) on delete cascade,
  component varchar(20) not null check (component in ('water', 'sewer')),
  min_usage integer not null check (min_usage >= 0),
  max_usage integer,
  rate numeric(12, 4) not null check (rate >= 0),
  deduction numeric(12, 0) not null,
  sort_order integer not null,
  unique (utility_tariff_version_id, component, sort_order),
  check (max_usage is null or max_usage >= min_usage)
);

alter table public.utility_tariff_version enable row level security;
alter table public.utility_tariff_tier enable row level security;
grant select, insert, update, delete on public.utility_tariff_version, public.utility_tariff_tier to authenticated;
create policy "active users manage utility tariff versions" on public.utility_tariff_version for all to authenticated
  using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage utility tariff tiers" on public.utility_tariff_tier for all to authenticated
  using (public.current_account_is_active()) with check (public.current_account_is_active());

with versions as (
  insert into public.utility_tariff_version (asset_id, tariff_kind, tariff_name, effective_from, tax_rate)
  select asset_id, 'osaka_general_water', '大阪市・一般用・1か月', date '2019-11-01', 0.10
  from public.asset_master
  on conflict (asset_id, tariff_kind, effective_from) do update set tariff_name = excluded.tariff_name
  returning utility_tariff_version_id
), tiers(component, min_usage, max_usage, rate, deduction, sort_order) as (
  values
    ('water',0,10,10,-850,1),('water',11,20,97,20,2),('water',21,30,124,560,3),('water',31,50,168,1880,4),
    ('water',51,100,230,4980,5),('water',101,200,293,11280,6),('water',201,1000,342,21080,7),('water',1001,null,358,37080,8),
    ('sewer',0,10,0,-550,1),('sewer',11,20,61,60,2),('sewer',21,30,83,500,3),('sewer',31,50,103,1100,4),
    ('sewer',51,100,119,1900,5),('sewer',101,200,136,3600,6),('sewer',201,500,159,8200,7),('sewer',501,1000,180,18700,8),
    ('sewer',1001,5000,215,53700,9),('sewer',5001,null,234,148700,10)
)
insert into public.utility_tariff_tier (utility_tariff_version_id, component, min_usage, max_usage, rate, deduction, sort_order)
select versions.utility_tariff_version_id, tiers.component, tiers.min_usage, tiers.max_usage, tiers.rate, tiers.deduction, tiers.sort_order
from versions cross join tiers
on conflict (utility_tariff_version_id, component, sort_order) do nothing;

create or replace function public.save_next_utility_tariff_version(
  p_asset_id uuid,
  p_billing_month date,
  p_tariff_name text,
  p_tax_rate numeric,
  p_tiers jsonb
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_effective_from date := (date_trunc('month', p_billing_month) + interval '1 month')::date;
  v_version_id uuid;
  v_next_from date;
begin
  if auth.uid() is null or not public.current_account_is_active() then raise exception '料金表を編集する権限がありません'; end if;
  if jsonb_array_length(p_tiers) = 0 then raise exception '料金表の段階を入力してください'; end if;

  insert into public.utility_tariff_version (asset_id, tariff_kind, tariff_name, effective_from, tax_rate)
  values (p_asset_id, 'osaka_general_water', p_tariff_name, v_effective_from, p_tax_rate)
  on conflict (asset_id, tariff_kind, effective_from) do update
    set tariff_name = excluded.tariff_name, tax_rate = excluded.tax_rate, updated_at = now()
  returning utility_tariff_version_id into v_version_id;

  delete from public.utility_tariff_tier where utility_tariff_version_id = v_version_id;
  insert into public.utility_tariff_tier (utility_tariff_version_id, component, min_usage, max_usage, rate, deduction, sort_order)
  select v_version_id, row->>'component', (row->>'min_usage')::integer,
    nullif(row->>'max_usage', '')::integer, (row->>'rate')::numeric,
    (row->>'deduction')::numeric, (row->>'sort_order')::integer
  from jsonb_array_elements(p_tiers) row;

  update public.utility_tariff_version set effective_to = v_effective_from - 1, updated_at = now()
  where asset_id = p_asset_id and tariff_kind = 'osaka_general_water'
    and effective_from < v_effective_from
    and (effective_to is null or effective_to >= v_effective_from);
  select min(effective_from) into v_next_from from public.utility_tariff_version
  where asset_id = p_asset_id and tariff_kind = 'osaka_general_water' and effective_from > v_effective_from;
  update public.utility_tariff_version set effective_to = case when v_next_from is null then null else v_next_from - 1 end
  where utility_tariff_version_id = v_version_id;
  return v_version_id;
end;
$$;
revoke all on function public.save_next_utility_tariff_version(uuid, date, text, numeric, jsonb) from public, anon;
grant execute on function public.save_next_utility_tariff_version(uuid, date, text, numeric, jsonb) to authenticated;
