begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'billing_code' and column_name = 'billing_due_date_pattern_id'
  ) then
    raise exception 'billing_code.billing_due_date_pattern_id column is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'billing_code' and column_name = 'billing_period_pattern_id'
  ) then
    raise exception 'billing_code.billing_period_pattern_id column is missing';
  end if;
  if to_regprocedure('public.current_account_department_id()') is null then
    raise exception 'current_account_department_id() function is missing';
  end if;
  if to_regprocedure('public.current_account_is_accounting_department()') is null then
    raise exception 'current_account_is_accounting_department() function is missing';
  end if;
  if to_regprocedure('public.update_billing_code_billing_terms(uuid,uuid,uuid)') is null then
    raise exception 'update_billing_code_billing_terms() function is missing';
  end if;
  if has_function_privilege('anon', 'public.update_billing_code_billing_terms(uuid,uuid,uuid)', 'EXECUTE') then
    raise exception 'Anonymous users must not execute update_billing_code_billing_terms';
  end if;
  if not has_function_privilege('authenticated', 'public.update_billing_code_billing_terms(uuid,uuid,uuid)', 'EXECUTE') then
    raise exception 'Authenticated users need update_billing_code_billing_terms RPC access';
  end if;
  if pg_get_functiondef('public.update_billing_code_billing_terms(uuid,uuid,uuid)'::regprocedure) !~ 'current_account_is_accounting_department' then
    raise exception 'update_billing_code_billing_terms must check accounting department membership';
  end if;
end;
$$;

rollback;
