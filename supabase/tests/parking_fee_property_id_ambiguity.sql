do $$
declare
  setter_definition text;
  apply_definition text;
begin
  -- 公開関数は先行期間を外部扱いに分岐する薄いラッパーであり、
  -- property_id を解決する処理は基底関数に集約されている。
  select pg_get_functiondef('public.set_parking_fee_history_base(uuid,text,uuid,numeric,date,uuid,uuid,text,text,integer)'::regprocedure)
    into setter_definition;
  if setter_definition not like '%parking_property_id uuid%'
     or setter_definition like E'%\n  property_id uuid;%'
     or setter_definition not like '%unit.property_id = parking_property_id%' then
    raise exception 'set_parking_fee_history still contains an ambiguous property_id variable';
  end if;

  select pg_get_functiondef('private.apply_parking_fee_change_request(uuid,integer,numeric,date,date,uuid)'::regprocedure)
    into apply_definition;
  if apply_definition not like '%main_contract_id uuid%'
     or apply_definition not like '%parking_scope, main_contract_id, p_monthly_parking_fee%' then
    raise exception 'parking change request does not convert the selected unit to its contract';
  end if;
end;
$$;
