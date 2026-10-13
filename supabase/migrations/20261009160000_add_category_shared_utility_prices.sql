-- 公共料金の単価を、分類（電気・水道・ガス）で共通にできるようにする。
--   物件×分類の設定：単価の持ち方（line_item=明細項目ごと、category=分類で共通）と、分類共通の既定単価・税区分
--   契約区画×分類の単価：分類で共通にした分類の単価（税抜/税込・検針月による単価）
-- 分類で共通にしても請求書の明細は明細項目（電灯・空調など）ごとに分かれ、単価だけが同じになる。

create table if not exists public.asset_utility_price_setting (
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  category text not null check (category in ('electric', 'water', 'gas')),
  price_scope text not null default 'line_item' check (price_scope in ('line_item', 'category')),
  default_unit_price numeric(14, 4) check (default_unit_price is null or default_unit_price >= 0),
  default_tax_mode text not null default 'exclusive' check (default_tax_mode in ('exclusive', 'inclusive')),
  updated_at timestamptz not null default now(),
  primary key (asset_id, category)
);
comment on table public.asset_utility_price_setting is '物件の分類（電気・水道・ガス）ごとの単価の持ち方と、分類で共通にしたときの既定単価';

alter table public.asset_utility_price_setting enable row level security;
drop policy if exists "active users manage asset utility price settings" on public.asset_utility_price_setting;
create policy "active users manage asset utility price settings" on public.asset_utility_price_setting for all to authenticated
  using (public.current_account_is_active()) with check (public.current_account_is_active());
grant select, insert, update, delete on public.asset_utility_price_setting to authenticated;

create table if not exists public.lease_contract_unit_category_price (
  lease_contract_unit_id uuid not null references public.lease_contract_unit(lease_contract_unit_id) on delete cascade,
  category text not null check (category in ('electric', 'water', 'gas')),
  unit_price numeric(14, 4) not null check (unit_price >= 0),
  tax_mode text not null default 'exclusive' check (tax_mode in ('exclusive', 'inclusive')),
  monthly_unit_prices jsonb not null default '{}'::jsonb check (jsonb_typeof(monthly_unit_prices) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (lease_contract_unit_id, category)
);
comment on table public.lease_contract_unit_category_price is '契約区画ごとの公共料金の単価（分類で共通にした分類）';

alter table public.lease_contract_unit_category_price enable row level security;
drop policy if exists "active users read contract unit category prices" on public.lease_contract_unit_category_price;
create policy "active users read contract unit category prices" on public.lease_contract_unit_category_price for select to authenticated using (public.current_account_is_active());
grant select on public.lease_contract_unit_category_price to authenticated;

drop function if exists public.save_lease_contract_unit_utility_terms(uuid, jsonb, jsonb);

-- 契約区画の単価（明細項目ごと・分類共通）・基本料をまとめて置き換える。総務経理部所属者とadminロールのみ実行できる。
--   p_category_prices: [{"category": "electric", "unit_price": 30, "tax_mode": "exclusive", "monthly_unit_prices": {"7": 32}}]
create or replace function public.save_lease_contract_unit_utility_terms(
  p_lease_contract_unit_id uuid,
  p_prices jsonb,
  p_category_prices jsonb,
  p_basic_charges jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_property_id uuid;
begin
  if not public.current_account_is_active()
     or not (public.current_account_role() = 'admin' or public.current_account_is_accounting_department()) then
    raise exception '公共料金の単価・基本料を更新する権限がありません';
  end if;

  select unit.property_id into v_property_id
  from public.lease_contract_unit contract_unit
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  where contract_unit.lease_contract_unit_id = p_lease_contract_unit_id;
  if v_property_id is null then
    raise exception '契約区画が見つかりません';
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_prices, '[]'::jsonb)) price
    left join public.asset_billing_line_item item on item.asset_billing_line_item_id = (price ->> 'asset_billing_line_item_id')::uuid
    where item.asset_id is distinct from v_property_id
  ) then
    raise exception '明細項目がこの物件のものではありません';
  end if;

  delete from public.lease_contract_unit_utility_price where lease_contract_unit_id = p_lease_contract_unit_id;
  insert into public.lease_contract_unit_utility_price (lease_contract_unit_id, asset_billing_line_item_id, unit_price, tax_mode, monthly_unit_prices)
  select p_lease_contract_unit_id, (price ->> 'asset_billing_line_item_id')::uuid, (price ->> 'unit_price')::numeric,
         coalesce(price ->> 'tax_mode', 'exclusive'), coalesce(price -> 'monthly_unit_prices', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_prices, '[]'::jsonb)) price;

  delete from public.lease_contract_unit_category_price where lease_contract_unit_id = p_lease_contract_unit_id;
  insert into public.lease_contract_unit_category_price (lease_contract_unit_id, category, unit_price, tax_mode, monthly_unit_prices)
  select p_lease_contract_unit_id, price ->> 'category', (price ->> 'unit_price')::numeric,
         coalesce(price ->> 'tax_mode', 'exclusive'), coalesce(price -> 'monthly_unit_prices', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_category_prices, '[]'::jsonb)) price;

  delete from public.lease_contract_unit_basic_charge where lease_contract_unit_id = p_lease_contract_unit_id;
  insert into public.lease_contract_unit_basic_charge (lease_contract_unit_id, category, amount, tax_mode)
  select p_lease_contract_unit_id, charge ->> 'category', (charge ->> 'amount')::numeric, coalesce(charge ->> 'tax_mode', 'exclusive')
  from jsonb_array_elements(coalesce(p_basic_charges, '[]'::jsonb)) charge;
end;
$$;

revoke all on function public.save_lease_contract_unit_utility_terms(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_lease_contract_unit_utility_terms(uuid, jsonb, jsonb, jsonb) to authenticated;
comment on function public.save_lease_contract_unit_utility_terms(uuid, jsonb, jsonb, jsonb) is '契約区画の公共料金の単価（明細項目ごと・分類共通）・基本料を置き換える。総務経理部所属者とadminロールのみ実行できる。';
