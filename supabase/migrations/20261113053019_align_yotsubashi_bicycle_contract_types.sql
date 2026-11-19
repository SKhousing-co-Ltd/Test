-- Convert only contracts whose every unit is a Yotsubashi bicycle slot.
do $$
declare v_count integer;
begin
  select count(*) into v_count from public.lease_contract c
  where c.contract_type = 'parking' and c.contract_status = 'active'
    and exists (select 1 from public.lease_contract_unit cu join public.unit_master u on u.unit_id=cu.unit_id
      join public.asset_master a on a.asset_id=u.property_id join public.parking_space_master s on s.unit_id=u.unit_id
      join public.parking_facility_master f on f.parking_facility_id=s.parking_facility_id
      where cu.lease_contract_id=c.lease_contract_id and a.asset_name='三共四ツ橋ビル' and f.facility_code='BIKE' and u.unit_type='bicycle_parking')
    and not exists (select 1 from public.lease_contract_unit cu join public.unit_master u on u.unit_id=cu.unit_id
      join public.asset_master a on a.asset_id=u.property_id left join public.parking_space_master s on s.unit_id=u.unit_id
      left join public.parking_facility_master f on f.parking_facility_id=s.parking_facility_id
      where cu.lease_contract_id=c.lease_contract_id and (a.asset_name<>'三共四ツ橋ビル' or f.facility_code is distinct from 'BIKE' or u.unit_type<>'bicycle_parking'));
  if v_count=0 then return; end if;
  if v_count<>14 then raise exception 'Expected 14 bicycle-only contracts, found %', v_count; end if;
  update public.lease_contract c set contract_type='bicycle_parking', updated_at=now()
  where c.contract_type='parking' and c.contract_status='active'
    and exists (select 1 from public.lease_contract_unit cu join public.unit_master u on u.unit_id=cu.unit_id
      join public.asset_master a on a.asset_id=u.property_id join public.parking_space_master s on s.unit_id=u.unit_id
      join public.parking_facility_master f on f.parking_facility_id=s.parking_facility_id
      where cu.lease_contract_id=c.lease_contract_id and a.asset_name='三共四ツ橋ビル' and f.facility_code='BIKE' and u.unit_type='bicycle_parking')
    and not exists (select 1 from public.lease_contract_unit cu join public.unit_master u on u.unit_id=cu.unit_id
      join public.asset_master a on a.asset_id=u.property_id left join public.parking_space_master s on s.unit_id=u.unit_id
      left join public.parking_facility_master f on f.parking_facility_id=s.parking_facility_id
      where cu.lease_contract_id=c.lease_contract_id and (a.asset_name<>'三共四ツ橋ビル' or f.facility_code is distinct from 'BIKE' or u.unit_type<>'bicycle_parking'));
  get diagnostics v_count=row_count;
  if v_count<>14 then raise exception 'Unexpected update count: %',v_count; end if;
end $$;
