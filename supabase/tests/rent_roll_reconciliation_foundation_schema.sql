begin;

do $$
begin
  if to_regclass('public.rent_roll_import_batch') is null then
    raise exception 'rent_roll_import_batch does not exist';
  end if;
  if to_regclass('public.rent_roll_import_row') is null then
    raise exception 'rent_roll_import_row does not exist';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'lease_contract' and column_name = 'row_version'
  ) then
    raise exception 'lease_contract.row_version does not exist';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'lease_contract_unit' and column_name = 'row_version'
  ) then
    raise exception 'lease_contract_unit.row_version does not exist';
  end if;
  if not exists (
    select 1 from pg_proc
    where oid = 'public.contract_detail_for_audit(uuid,date)'::regprocedure
      and not prosecdef
  ) then
    raise exception 'contract_detail_for_audit must exist as SECURITY INVOKER';
  end if;
  if has_function_privilege('anon', 'public.contract_detail_for_audit(uuid,date)', 'execute') then
    raise exception 'anon must not execute contract_detail_for_audit';
  end if;
  if not has_function_privilege('authenticated', 'public.contract_detail_for_audit(uuid,date)', 'execute') then
    raise exception 'authenticated must execute contract_detail_for_audit';
  end if;
  if position('parking_fee_deduction_amount' in pg_get_functiondef('public.rent_roll_list_at_date(uuid,date)'::regprocedure)) > 0 then
    raise exception 'rent_roll_list_at_date must not subtract parking fees from room rent';
  end if;
  if position('monthly_parking_amount' in pg_get_functiondef('public.rent_roll_list_at_date(uuid,date)'::regprocedure)) = 0 then
    raise exception 'rent_roll_list_at_date must return parking fees independently';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.rent_roll_import_batch'::regclass) then
    raise exception 'RLS is not enabled on rent_roll_import_batch';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.rent_roll_import_row'::regclass) then
    raise exception 'RLS is not enabled on rent_roll_import_row';
  end if;
  if (
    select count(*) from pg_policies
    where schemaname = 'public'
      and policyname in ('audit users read rent roll import batches', 'audit users read rent roll import rows')
      and tablename in ('rent_roll_import_batch', 'rent_roll_import_row')
  ) <> 2 then
    raise exception 'Audit read policies are missing';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'lease_contract'
      and policyname = 'authenticated employees can manage lease contracts'
  ) then
    raise exception 'legacy unrestricted lease_contract policy still exists';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'lease_contract_unit'
      and policyname = 'authenticated employees can manage lease contract units'
  ) then
    raise exception 'legacy unrestricted lease_contract_unit policy still exists';
  end if;
  if (
    select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'lease_contract'
      and policyname in (
        'active users read lease contracts', 'managers insert lease contracts',
        'managers update lease contracts', 'managers delete lease contracts'
      )
  ) <> 4 then
    raise exception 'Expected four separated lease_contract policies';
  end if;
  if not exists (
    select 1 from information_schema.triggers
    where trigger_schema = 'public' and event_object_table = 'lease_contract'
      and trigger_name = 'bump_lease_contract_row_version'
  ) then
    raise exception 'lease_contract row_version trigger does not exist';
  end if;
end $$;

rollback;
