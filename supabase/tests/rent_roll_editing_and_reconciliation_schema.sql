begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'rent_roll_import_row'
      and column_name = 'source_monthly_parking_amount'
  ) then raise exception 'source_monthly_parking_amount does not exist'; end if;

  if to_regprocedure('public.apply_rent_roll_contract_edit(uuid,integer,integer,jsonb,jsonb,text,date)') is null then
    raise exception 'apply_rent_roll_contract_edit does not exist';
  end if;
  if to_regprocedure('public.match_rent_roll_import_batch(uuid)') is null then
    raise exception 'match_rent_roll_import_batch does not exist';
  end if;
  if to_regprocedure('public.rent_roll_reconciliation_report(uuid,uuid)') is null then
    raise exception 'rent_roll_reconciliation_report does not exist';
  end if;

  if exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name in ('apply_rent_roll_contract_edit', 'match_rent_roll_import_batch', 'rent_roll_reconciliation_report')
      and grantee in ('anon', 'PUBLIC')
  ) then raise exception 'rent-roll RPC is executable by anon or PUBLIC'; end if;

  if not exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public' and routine_name = 'rent_roll_reconciliation_report'
      and grantee = 'authenticated' and privilege_type = 'EXECUTE'
  ) then raise exception 'authenticated cannot execute reconciliation report'; end if;
end;
$$;

rollback;
