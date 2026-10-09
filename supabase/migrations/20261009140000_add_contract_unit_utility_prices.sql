-- 公共料金の単価・基本料を契約区画で持つ。
--   明細項目：請求内容（レントロールの単価列の見出し）・レントロールに単価を載せるか・既定単価・既定の税区分
--   契約区画×明細項目の単価（税抜/税込、月によって変わる単価は月ごとの例外として持つ）
--   契約区画×分類（電気・水道・ガス）の基本料（税抜/税込）
-- 検針設定の小分類の既定単価（asset_meter_sub_item.default_unit_price）はアプリから使わなくなる。
-- mainのアプリが読んでいるため、列の削除はこのブランチのマージ後に行う。

alter table public.asset_billing_line_item
  add column if not exists billing_content varchar(100),
  add column if not exists show_unit_price_in_rent_roll boolean not null default false,
  add column if not exists default_unit_price numeric(14, 4) check (default_unit_price is null or default_unit_price >= 0),
  add column if not exists default_tax_mode text not null default 'exclusive' check (default_tax_mode in ('exclusive', 'inclusive'));

comment on column public.asset_billing_line_item.billing_content is '請求内容（電灯・空調など）。レントロールの単価列の見出しに使う';
comment on column public.asset_billing_line_item.show_unit_price_in_rent_roll is 'この明細項目の契約単価をレントロールに表示するか';
comment on column public.asset_billing_line_item.default_unit_price is '既定単価。契約区画に単価が無いときに使う';
comment on column public.asset_billing_line_item.default_tax_mode is '既定単価の税区分（exclusive=税抜、inclusive=税込）';

create table if not exists public.lease_contract_unit_utility_price (
  lease_contract_unit_id uuid not null references public.lease_contract_unit(lease_contract_unit_id) on delete cascade,
  asset_billing_line_item_id uuid not null references public.asset_billing_line_item(asset_billing_line_item_id) on delete cascade,
  unit_price numeric(14, 4) not null check (unit_price >= 0),
  tax_mode text not null default 'exclusive' check (tax_mode in ('exclusive', 'inclusive')),
  -- 検針月によって単価が変わる契約の、例外の月の単価です（{"7": 32.5, "8": 32.5}）。
  monthly_unit_prices jsonb not null default '{}'::jsonb check (jsonb_typeof(monthly_unit_prices) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (lease_contract_unit_id, asset_billing_line_item_id)
);

create table if not exists public.lease_contract_unit_basic_charge (
  lease_contract_unit_id uuid not null references public.lease_contract_unit(lease_contract_unit_id) on delete cascade,
  category text not null check (category in ('electric', 'water', 'gas')),
  amount numeric(14, 2) not null check (amount >= 0),
  tax_mode text not null default 'exclusive' check (tax_mode in ('exclusive', 'inclusive')),
  updated_at timestamptz not null default now(),
  primary key (lease_contract_unit_id, category)
);

comment on table public.lease_contract_unit_utility_price is '契約区画ごとの公共料金の単価（明細項目単位）。小分類が固定単価のときに検針データの計算で使う';
comment on table public.lease_contract_unit_basic_charge is '契約区画ごとの公共料金の基本料（分類単位）';

alter table public.lease_contract_unit_utility_price enable row level security;
alter table public.lease_contract_unit_basic_charge enable row level security;
drop policy if exists "active users read contract unit utility prices" on public.lease_contract_unit_utility_price;
create policy "active users read contract unit utility prices" on public.lease_contract_unit_utility_price for select to authenticated using (public.current_account_is_active());
drop policy if exists "active users read contract unit basic charges" on public.lease_contract_unit_basic_charge;
create policy "active users read contract unit basic charges" on public.lease_contract_unit_basic_charge for select to authenticated using (public.current_account_is_active());
grant select on public.lease_contract_unit_utility_price, public.lease_contract_unit_basic_charge to authenticated;

-- 契約区画の単価・基本料をまとめて置き換える。総務経理部所属者とadminロールのみ実行できる。
--   p_prices: [{"asset_billing_line_item_id": "...", "unit_price": 30.5, "tax_mode": "exclusive", "monthly_unit_prices": {"7": 32}}]
--   p_basic_charges: [{"category": "electric", "amount": 5000, "tax_mode": "exclusive"}]
create or replace function public.save_lease_contract_unit_utility_terms(
  p_lease_contract_unit_id uuid,
  p_prices jsonb,
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

  delete from public.lease_contract_unit_basic_charge where lease_contract_unit_id = p_lease_contract_unit_id;
  insert into public.lease_contract_unit_basic_charge (lease_contract_unit_id, category, amount, tax_mode)
  select p_lease_contract_unit_id, charge ->> 'category', (charge ->> 'amount')::numeric, coalesce(charge ->> 'tax_mode', 'exclusive')
  from jsonb_array_elements(coalesce(p_basic_charges, '[]'::jsonb)) charge;
end;
$$;

revoke all on function public.save_lease_contract_unit_utility_terms(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.save_lease_contract_unit_utility_terms(uuid, jsonb, jsonb) to authenticated;
comment on function public.save_lease_contract_unit_utility_terms(uuid, jsonb, jsonb) is '契約区画の公共料金の単価・基本料を置き換える。総務経理部所属者とadminロールのみ実行できる。';
