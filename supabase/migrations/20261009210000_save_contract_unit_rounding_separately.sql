-- 小数点以下の処理は、契約情報の請求条件の欄で即時保存する。公共料金の保存とは切り離す。

drop function if exists public.save_lease_contract_unit_utility_terms(uuid, jsonb, jsonb, jsonb, text);

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

-- 契約区画の公共料金の小数点以下の処理を更新する。総務経理部所属者とadminロールのみ実行できる。
create or replace function public.update_lease_contract_unit_amount_rounding(
  p_lease_contract_unit_id uuid,
  p_amount_rounding_mode text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_account_is_active()
     or not (public.current_account_role() = 'admin' or public.current_account_is_accounting_department()) then
    raise exception '小数点以下の処理を更新する権限がありません';
  end if;
  if p_amount_rounding_mode is null or p_amount_rounding_mode not in ('floor', 'round', 'ceil') then
    raise exception '小数点以下の処理が不正です';
  end if;
  update public.lease_contract_unit
  set utility_amount_rounding_mode = p_amount_rounding_mode
  where lease_contract_unit_id = p_lease_contract_unit_id;
  if not found then
    raise exception '契約区画が見つかりません';
  end if;
end;
$$;

revoke all on function public.update_lease_contract_unit_amount_rounding(uuid, text) from public, anon;
grant execute on function public.update_lease_contract_unit_amount_rounding(uuid, text) to authenticated;
comment on function public.update_lease_contract_unit_amount_rounding(uuid, text) is '契約区画の公共料金の小数点以下の処理を更新する。総務経理部所属者とadminロールのみ実行できる。';
