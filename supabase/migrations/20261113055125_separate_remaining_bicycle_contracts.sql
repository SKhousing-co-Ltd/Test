-- Split the two confirmed mixed car/bicycle contracts without changing contract-unit IDs.
do $$
declare v_row record; v_new_contract uuid; v_count integer; v_processed integer := 0;
begin
  select count(*) into v_count from public.lease_contract_unit cu
  join public.lease_contract c on c.lease_contract_id=cu.lease_contract_id
  join public.tenant_master t on t.tenant_id=c.tenant_id
  join public.unit_master u on u.unit_id=cu.unit_id
  join public.asset_master a on a.asset_id=u.property_id
  where c.contract_type='parking' and c.contract_status='active' and u.unit_type='bicycle_parking'
    and ((a.asset_name='リバーサイドタワー中之島' and t.tenant_name='長嶺勇仁' and u.unit_code='PK-NAK-BIKE-B16')
      or (a.asset_name='三共横浜ビル' and t.tenant_name='(株)サンライズエステート' and u.unit_code='PK-BIKE-18'));
  if v_count=0 then return; end if;
  if v_count<>2 then raise exception 'Expected two mixed-contract bicycle units, found %',v_count; end if;
  for v_row in
    select c.lease_contract_id as old_id,cu.lease_contract_unit_id as unit_id,cu.lease_start_date,cu.lease_end_date,
      d.property_id,d.parking_scope,d.main_lease_contract_id
    from public.lease_contract_unit cu join public.lease_contract c on c.lease_contract_id=cu.lease_contract_id
    join public.tenant_master t on t.tenant_id=c.tenant_id join public.unit_master u on u.unit_id=cu.unit_id
    join public.asset_master a on a.asset_id=u.property_id join public.parking_contract_detail d on d.lease_contract_id=c.lease_contract_id
    where c.contract_type='parking' and c.contract_status='active' and u.unit_type='bicycle_parking'
      and ((a.asset_name='リバーサイドタワー中之島' and t.tenant_name='長嶺勇仁' and u.unit_code='PK-NAK-BIKE-B16')
        or (a.asset_name='三共横浜ビル' and t.tenant_name='(株)サンライズエステート' and u.unit_code='PK-BIKE-18'))
    order by a.asset_name
  loop
    if v_row.lease_start_date is null then raise exception 'Missing unit start date'; end if;
    insert into public.lease_contract (tenant_id,contract_status,contract_type,contract_start_date,contract_end_date,
      renewal_terms,payment_terms,notes,source_system,lease_term_type,due_month_offset,due_day_of_month,
      due_holiday_adjustment,period_month_offset,is_annual_billing,annual_billing_month,annual_start_offset)
    select tenant_id,contract_status,'bicycle_parking',v_row.lease_start_date,v_row.lease_end_date,
      renewal_terms,payment_terms,'駐車場契約から駐輪枠を分離','manual',lease_term_type,due_month_offset,due_day_of_month,
      due_holiday_adjustment,period_month_offset,is_annual_billing,annual_billing_month,annual_start_offset
    from public.lease_contract where lease_contract_id=v_row.old_id returning lease_contract_id into v_new_contract;
    insert into public.parking_contract_detail (lease_contract_id,property_id,parking_scope,main_lease_contract_id)
      values (v_new_contract,v_row.property_id,v_row.parking_scope,v_row.main_lease_contract_id);
    update public.lease_contract_unit set lease_contract_id=v_new_contract,updated_at=now()
      where lease_contract_unit_id=v_row.unit_id and lease_contract_id=v_row.old_id;
    if not found then raise exception 'Contract unit changed during split'; end if;
    update public.change_request set lease_contract_id=v_new_contract,updated_at=now()
      where lease_contract_id=v_row.old_id and source_record_key=concat('parking-fee:',v_row.unit_id)
        and request_type='parking_fee_setup' and status='applied';
    if not found then raise exception 'Expected completed fee request not found'; end if;
    v_processed:=v_processed+1;
  end loop;
  if v_processed<>2 then raise exception 'Split incomplete: %',v_processed; end if;
end $$;
