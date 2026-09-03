begin;

do $$
declare
  definition text;
begin
  select pg_get_functiondef(
    'private.apply_parking_fee_change_request(uuid,integer,numeric,date,date,uuid)'::regprocedure
  ) into definition;

  if definition like '%min(candidate.lease_contract_unit_id)%' then
    raise exception 'parking fee auto-selection must not aggregate uuid with min';
  end if;
  if definition not like '%array_agg(candidate.lease_contract_unit_id order by candidate.lease_contract_unit_id)%' then
    raise exception 'parking fee auto-selection must deterministically select a UUID candidate';
  end if;
end;
$$;

rollback;
