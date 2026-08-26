begin;

do $$
declare
  apply_definition text;
  close_definition text;
  enqueue_definition text;
begin
  select pg_get_functiondef(
    'private.apply_parking_fee_change_request(uuid,integer,numeric,date,date,uuid)'::regprocedure
  ) into apply_definition;

  if apply_definition not like '%p_parking_contract_end_date is null%'
     or apply_definition not like '%p_parking_contract_end_date < p_effective_from%'
     or apply_definition not like '%p_parking_contract_end_date < parking_record.lease_start_date%'
     or apply_definition not like '%set lease_end_date = p_parking_contract_end_date%'
     or apply_definition not like '%contract.contract_type = ''parking''%'
     or apply_definition not like '%perform public.set_parking_fee_history(%' then
    raise exception 'parking contract end-date validation or persistence is incomplete';
  end if;

  select pg_get_functiondef('private.close_parking_fee_change_request()'::regprocedure)
  into close_definition;
  if close_definition not like '%''parking_contract_end_date'', parking_contract_end_date%' then
    raise exception 'parking contract end date is missing from resolution_payload';
  end if;

  select pg_get_functiondef(
    'public.enqueue_parking_fee_change_request(uuid,uuid,uuid)'::regprocedure
  ) into enqueue_definition;
  if enqueue_definition not like '%月額駐車料・適用開始日・駐車場契約終了日%'
     or enqueue_definition not like '%控除対象の主契約区画%'
     or enqueue_definition not like '%parking_record.parking_scope = ''external''%' then
    raise exception 'parking fee request guidance does not include the contract end date';
  end if;
end;
$$;

rollback;
