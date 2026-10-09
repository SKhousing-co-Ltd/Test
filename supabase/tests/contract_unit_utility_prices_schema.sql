do $$
declare
  v_col text;
begin
  foreach v_col in array array['billing_content','show_unit_price_in_rent_roll','default_unit_price','default_tax_mode'] loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'asset_billing_line_item' and column_name = v_col) then
      raise exception 'asset_billing_line_item.% column is missing', v_col;
    end if;
  end loop;
  if to_regclass('public.lease_contract_unit_utility_price') is null or to_regclass('public.lease_contract_unit_basic_charge') is null then
    raise exception 'contract unit utility price tables are missing';
  end if;
  if has_table_privilege('authenticated', 'public.lease_contract_unit_utility_price', 'INSERT') and exists (
    select 1 from pg_policies where tablename = 'lease_contract_unit_utility_price' and cmd in ('INSERT', 'ALL')
  ) then
    raise exception 'contract unit utility prices must be written through the RPC only';
  end if;
  if to_regprocedure('public.save_lease_contract_unit_utility_terms(uuid,jsonb,jsonb)') is null then
    raise exception 'save_lease_contract_unit_utility_terms() function is missing';
  end if;
  if has_function_privilege('anon', 'public.save_lease_contract_unit_utility_terms(uuid,jsonb,jsonb)', 'EXECUTE') then
    raise exception 'Anonymous users must not execute save_lease_contract_unit_utility_terms';
  end if;
  if pg_get_functiondef('public.save_lease_contract_unit_utility_terms(uuid,jsonb,jsonb)'::regprocedure) !~ 'current_account_is_accounting_department' then
    raise exception 'save_lease_contract_unit_utility_terms must check accounting department membership';
  end if;
end $$;
