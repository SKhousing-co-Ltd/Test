begin;

do $$
declare
  setter_definition text;
begin
  select pg_get_functiondef(
    'public.set_parking_fee_history_base(uuid,text,uuid,numeric,date,uuid,uuid,text,text,integer)'::regprocedure
  ) into setter_definition;

  if position('内部駐車料合計' in setter_definition) > 0
     or position('gross_main_rent' in setter_definition) > 0
     or position('other_fee_total' in setter_definition) > 0 then
    raise exception 'internal parking fees must not be capped by the main contract rent';
  end if;
end;
$$;

rollback;
