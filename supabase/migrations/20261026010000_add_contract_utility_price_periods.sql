alter table public.lease_contract_unit_utility_price
  add column if not exists billing_month_prices jsonb not null default '[]'::jsonb
  check (jsonb_typeof(billing_month_prices) = 'array');

alter table public.lease_contract_unit_category_price
  add column if not exists billing_month_prices jsonb not null default '[]'::jsonb
  check (jsonb_typeof(billing_month_prices) = 'array');

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
  v_periods jsonb;
begin
  if not public.current_account_is_active()
     or not (public.current_account_role() = 'admin' or public.current_account_is_accounting_department()) then
    raise exception '公共料金の単価・基本料を更新する権限がありません';
  end if;
  select unit.property_id into v_property_id
  from public.lease_contract_unit contract_unit
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  where contract_unit.lease_contract_unit_id = p_lease_contract_unit_id;
  if v_property_id is null then raise exception '契約区画が見つかりません'; end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_prices, '[]'::jsonb)) price
    left join public.asset_billing_line_item item on item.asset_billing_line_item_id = (price ->> 'asset_billing_line_item_id')::uuid
    where item.asset_id is distinct from v_property_id
  ) then raise exception '明細項目がこの物件のものではありません'; end if;

  for v_periods in
    select coalesce(price -> 'billing_month_prices', '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_prices, '[]'::jsonb) || coalesce(p_category_prices, '[]'::jsonb)) price
  loop
    if jsonb_typeof(v_periods) <> 'array' or exists (
      select 1 from jsonb_array_elements(v_periods) period
      where coalesce(period ->> 'start_month', '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
         or coalesce(period ->> 'end_month', '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
         or (period ->> 'start_month') > (period ->> 'end_month')
         or coalesce(period ->> 'unit_price', '') !~ '^[0-9]+(\.[0-9]+)?$'
    ) then raise exception '請求月別単価の期間または単価が不正です'; end if;
    if exists (
      select 1
      from jsonb_array_elements(v_periods) with ordinality left_period(value, position)
      join jsonb_array_elements(v_periods) with ordinality right_period(value, position)
        on left_period.position < right_period.position
       and left_period.value ->> 'start_month' <= right_period.value ->> 'end_month'
       and right_period.value ->> 'start_month' <= left_period.value ->> 'end_month'
    ) then raise exception '請求月別単価の期間が重複しています'; end if;
  end loop;

  delete from public.lease_contract_unit_utility_price where lease_contract_unit_id = p_lease_contract_unit_id;
  insert into public.lease_contract_unit_utility_price
    (lease_contract_unit_id, asset_billing_line_item_id, unit_price, tax_mode, monthly_unit_prices, billing_month_prices)
  select p_lease_contract_unit_id, (price ->> 'asset_billing_line_item_id')::uuid, (price ->> 'unit_price')::numeric,
         coalesce(price ->> 'tax_mode', 'exclusive'), '{}'::jsonb, coalesce(price -> 'billing_month_prices', '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_prices, '[]'::jsonb)) price;
  delete from public.lease_contract_unit_category_price where lease_contract_unit_id = p_lease_contract_unit_id;
  insert into public.lease_contract_unit_category_price
    (lease_contract_unit_id, category, unit_price, tax_mode, monthly_unit_prices, billing_month_prices)
  select p_lease_contract_unit_id, price ->> 'category', (price ->> 'unit_price')::numeric,
         coalesce(price ->> 'tax_mode', 'exclusive'), '{}'::jsonb, coalesce(price -> 'billing_month_prices', '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_category_prices, '[]'::jsonb)) price;
  delete from public.lease_contract_unit_basic_charge where lease_contract_unit_id = p_lease_contract_unit_id;
  insert into public.lease_contract_unit_basic_charge (lease_contract_unit_id, category, amount, tax_mode)
  select p_lease_contract_unit_id, charge ->> 'category', (charge ->> 'amount')::numeric, coalesce(charge ->> 'tax_mode', 'exclusive')
  from jsonb_array_elements(coalesce(p_basic_charges, '[]'::jsonb)) charge;
end;
$$;

revoke all on function public.save_lease_contract_unit_utility_terms(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_lease_contract_unit_utility_terms(uuid, jsonb, jsonb, jsonb) to authenticated;

comment on column public.lease_contract_unit_utility_price.billing_month_prices is '請求月の開始・終了で指定する契約単価の期間配列';
comment on column public.lease_contract_unit_category_price.billing_month_prices is '請求月の開始・終了で指定する契約単価の期間配列';
