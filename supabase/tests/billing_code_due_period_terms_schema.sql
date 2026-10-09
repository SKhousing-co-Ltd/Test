do $$
declare
  v_col text;
begin
  foreach v_col in array array['due_month_offset','due_day_of_month','due_holiday_adjustment','period_month_offset','is_annual_billing','annual_billing_month','annual_start_offset'] loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'billing_code' and column_name = v_col) then
      raise exception 'billing_code.% column is missing', v_col;
    end if;
  end loop;
  if exists (select 1 from public.billing_code where is_annual_billing and (annual_billing_month is null or annual_start_offset is null)) then
    raise exception 'annual billing codes need billing month and start offset';
  end if;
  if to_regprocedure('public.update_billing_code_terms(uuid,smallint,smallint,text,smallint,boolean,smallint,smallint)') is null then
    raise exception 'update_billing_code_terms() function is missing';
  end if;
  if has_function_privilege('anon', 'public.update_billing_code_terms(uuid,smallint,smallint,text,smallint,boolean,smallint,smallint)', 'EXECUTE') then
    raise exception 'Anonymous users must not execute update_billing_code_terms';
  end if;
  if pg_get_functiondef('public.update_billing_code_terms(uuid,smallint,smallint,text,smallint,boolean,smallint,smallint)'::regprocedure) !~ 'current_account_is_accounting_department' then
    raise exception 'update_billing_code_terms must check accounting department membership';
  end if;
end $$;
