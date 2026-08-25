begin;

do $$
begin
  if to_regclass('public.parking_fee_history') is null then
    raise exception 'parking_fee_history does not exist';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'parking_import_row'
      and column_name = 'monthly_parking_fee'
  ) then
    raise exception 'parking_import_row.monthly_parking_fee does not exist';
  end if;
  if not exists (
    select 1 from pg_proc
    where oid = 'public.rent_roll_list_at_date(uuid,date)'::regprocedure
  ) then
    raise exception 'rent_roll_list_at_date does not exist';
  end if;
  if not exists (
    select 1 from pg_proc
    where oid = 'public.set_parking_fee_history(uuid,text,uuid,numeric,date,uuid,uuid,text,text,integer)'::regprocedure
  ) then
    raise exception 'set_parking_fee_history does not exist';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.parking_fee_history'::regclass) then
    raise exception 'RLS is not enabled on parking_fee_history';
  end if;
  if (
    select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'parking_fee_history'
  ) <> 4 then
    raise exception 'Expected four parking fee RLS policies';
  end if;
end $$;

rollback;
