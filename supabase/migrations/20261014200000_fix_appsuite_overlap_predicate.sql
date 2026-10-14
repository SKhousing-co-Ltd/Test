-- AppSuite新規契約の区画重複判定で、区画終了日・実終了日を優先する。
do $$
declare
  v_definition text;
  v_old text := $sql$daterange(coalesce(existing_contract.contract_start_date, '-infinity'::date), coalesce(existing_contract.contract_end_date, 'infinity'::date), '[]')$sql$;
  v_new text := $sql$daterange(coalesce(existing_unit.lease_start_date, existing_contract.contract_start_date, '-infinity'::date), coalesce(existing_unit.lease_end_date, existing_contract.actual_end_date, existing_contract.contract_end_date, 'infinity'::date), '[]')$sql$;
begin
  select pg_get_functiondef('public.apply_change_request(uuid,integer)'::regprocedure) into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'apply_change_request overlap predicate was not found';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$$;
