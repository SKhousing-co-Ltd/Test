begin;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.change_request'::regclass
      and conname = 'ck_change_request_request_type'
      and pg_get_constraintdef(oid) like '%parking_fee_setup%'
  ) then raise exception 'parking_fee_setup request type is missing'; end if;

  if to_regprocedure('public.enqueue_parking_fee_change_request(uuid,uuid,uuid)') is null then
    raise exception 'enqueue_parking_fee_change_request is missing';
  end if;
  if to_regprocedure('public.apply_parking_fee_change_request(uuid,integer,numeric,date,date,uuid)') is null then
    raise exception 'apply_parking_fee_change_request is missing';
  end if;
  if to_regprocedure('public.apply_parking_fee_change_request(uuid,integer,numeric,date,uuid)') is not null then
    raise exception 'obsolete apply_parking_fee_change_request overload remains';
  end if;

  if exists (
    select 1
    from public.lease_contract_unit contract_unit
    join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
    where unit.unit_type = 'parking'
      and contract.contract_status <> 'cancelled'
      and not exists (
        select 1 from public.parking_fee_history history
        where history.parking_lease_contract_unit_id = contract_unit.lease_contract_unit_id
      )
      and not exists (
        select 1 from public.change_request request
        where request.source_record_key = concat('parking-fee:', contract_unit.lease_contract_unit_id)
          and request.request_type = 'parking_fee_setup'
      )
  ) then raise exception 'a parking contract without a fee request remains'; end if;
end;
$$;

rollback;
