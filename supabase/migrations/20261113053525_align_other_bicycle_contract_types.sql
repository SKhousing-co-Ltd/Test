-- Convert bicycle-only contracts; mixed car/bicycle contracts need separate handling.
do $$
declare v_count integer;
begin
  select count(*) into v_count from public.lease_contract c
  where c.contract_type='parking' and c.contract_status='active'
    and exists (select 1 from public.lease_contract_unit cu join public.unit_master u on u.unit_id=cu.unit_id
      join public.asset_master a on a.asset_id=u.property_id where cu.lease_contract_id=c.lease_contract_id
        and u.unit_type='bicycle_parking' and a.asset_name in ('リバーサイドタワー中之島','三共梅田ビル','三共横浜ビル'))
    and not exists (select 1 from public.lease_contract_unit cu join public.unit_master u on u.unit_id=cu.unit_id
      where cu.lease_contract_id=c.lease_contract_id and u.unit_type <> 'bicycle_parking');
  if v_count=0 then return; end if;
  if v_count<>47 then raise exception 'Expected 47 bicycle-only contracts, found %',v_count; end if;
  update public.lease_contract c set contract_type='bicycle_parking',updated_at=now()
  where c.contract_type='parking' and c.contract_status='active'
    and exists (select 1 from public.lease_contract_unit cu join public.unit_master u on u.unit_id=cu.unit_id
      join public.asset_master a on a.asset_id=u.property_id where cu.lease_contract_id=c.lease_contract_id
        and u.unit_type='bicycle_parking' and a.asset_name in ('リバーサイドタワー中之島','三共梅田ビル','三共横浜ビル'))
    and not exists (select 1 from public.lease_contract_unit cu join public.unit_master u on u.unit_id=cu.unit_id
      where cu.lease_contract_id=c.lease_contract_id and u.unit_type <> 'bicycle_parking');
  get diagnostics v_count=row_count;
  if v_count<>47 then raise exception 'Unexpected converted count: %',v_count; end if;
end $$;
