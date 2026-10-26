update public.lease_contract_unit_utility_price
set billing_month_prices = coalesce((
  select jsonb_agg(jsonb_build_object(
    'start_month', right(period ->> 'start_month', 2)::integer,
    'end_month', right(period ->> 'end_month', 2)::integer,
    'unit_price', (period ->> 'unit_price')::numeric
  ) order by position)
  from jsonb_array_elements(billing_month_prices) with ordinality periods(period, position)
), '[]'::jsonb)
where jsonb_array_length(billing_month_prices) > 0;

update public.lease_contract_unit_category_price
set billing_month_prices = coalesce((
  select jsonb_agg(jsonb_build_object(
    'start_month', right(period ->> 'start_month', 2)::integer,
    'end_month', right(period ->> 'end_month', 2)::integer,
    'unit_price', (period ->> 'unit_price')::numeric
  ) order by position)
  from jsonb_array_elements(billing_month_prices) with ordinality periods(period, position)
), '[]'::jsonb)
where jsonb_array_length(billing_month_prices) > 0;

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
      where coalesce(period ->> 'start_month', '') !~ '^([1-9]|1[0-2])$'
         or coalesce(period ->> 'end_month', '') !~ '^([1-9]|1[0-2])$'
         or coalesce(period ->> 'unit_price', '') !~ '^[0-9]+(\.[0-9]+)?$'
    ) then raise exception '請求月別単価の月または単価が不正です'; end if;
    if exists (
      select 1
      from jsonb_array_elements(v_periods) with ordinality left_period(value, position)
      join jsonb_array_elements(v_periods) with ordinality right_period(value, position)
        on left_period.position < right_period.position
       and exists (
         select 1 from generate_series(1, 12) month_number
         where (case
           when (left_period.value ->> 'start_month')::integer <= (left_period.value ->> 'end_month')::integer
             then month_number between (left_period.value ->> 'start_month')::integer and (left_period.value ->> 'end_month')::integer
           else month_number >= (left_period.value ->> 'start_month')::integer or month_number <= (left_period.value ->> 'end_month')::integer
         end)
         and (case
           when (right_period.value ->> 'start_month')::integer <= (right_period.value ->> 'end_month')::integer
             then month_number between (right_period.value ->> 'start_month')::integer and (right_period.value ->> 'end_month')::integer
           else month_number >= (right_period.value ->> 'start_month')::integer or month_number <= (right_period.value ->> 'end_month')::integer
         end)
       )
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

comment on column public.lease_contract_unit_utility_price.billing_month_prices is '毎年繰り返す請求月の開始月・終了月・契約単価の配列';
comment on column public.lease_contract_unit_category_price.billing_month_prices is '毎年繰り返す請求月の開始月・終了月・契約単価の配列';
