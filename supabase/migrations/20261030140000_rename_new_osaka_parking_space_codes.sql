-- 三共新大阪ビルの駐車枠コードを施設種別が分かる名称に揃える。
do $$
declare
  v_property_id uuid;
  v_flat_source_count integer;
  v_machine_source_count integer;
  v_flat_target_count integer;
  v_machine_target_count integer;
  v_flat_count integer;
  v_machine_count integer;
begin
  select min(asset_id::text)::uuid, count(*)
    into v_property_id, v_flat_count
    from public.asset_master
   where asset_name = '三共新大阪ビル';
  if v_flat_count = 0 then
    return;
  elsif v_flat_count <> 1 then
    raise exception '三共新大阪ビルのアセットが一意ではありません';
  end if;

  select count(*) into v_flat_source_count
  from public.parking_space_master s
  join public.parking_facility_master f on f.parking_facility_id = s.parking_facility_id
  join public.unit_master u on u.unit_id = s.unit_id
  where f.property_id = v_property_id and f.facility_code = 'FLAT'
    and s.space_number = '1' and u.unit_code = 'PK-B-1';

  select count(*) into v_machine_source_count
  from public.parking_space_master s
  join public.parking_facility_master f on f.parking_facility_id = s.parking_facility_id
  join public.unit_master u on u.unit_id = s.unit_id
  where f.property_id = v_property_id and f.facility_code = 'MACHINE1'
    and s.space_number = '1' and u.unit_code = 'PK-A-1';

  select count(*) into v_flat_target_count
  from public.parking_space_master s
  join public.parking_facility_master f on f.parking_facility_id = s.parking_facility_id
  join public.unit_master u on u.unit_id = s.unit_id
  where f.property_id = v_property_id and f.facility_code = 'FLAT'
    and s.space_number = '1' and u.unit_code = 'PK-FLAT-1';

  select count(*) into v_machine_target_count
  from public.parking_space_master s
  join public.parking_facility_master f on f.parking_facility_id = s.parking_facility_id
  join public.unit_master u on u.unit_id = s.unit_id
  where f.property_id = v_property_id and f.facility_code = 'MACHINE1'
    and s.space_number = '1' and u.unit_code = 'PK-MACHINE-1';

  if v_flat_source_count = 0 and v_machine_source_count = 0
     and v_flat_target_count = 0 and v_machine_target_count = 0 then
    return; -- Preview databases may not contain the manually entered parking slots.
  elsif v_flat_source_count = 0 and v_machine_source_count = 0
     and v_flat_target_count = 1 and v_machine_target_count = 1 then
    return; -- Already renamed.
  elsif v_flat_source_count <> 1 or v_machine_source_count <> 1
     or v_flat_target_count <> 0 or v_machine_target_count <> 0 then
    raise exception '三共新大阪ビル駐車枠1の状態が想定と異なります（旧FLAT: %, 旧MACHINE: %, 新FLAT: %, 新MACHINE: %）',
      v_flat_source_count, v_machine_source_count, v_flat_target_count, v_machine_target_count;
  end if;

  update public.unit_master u
     set unit_code = 'PK-FLAT-1', updated_at = now()
    from public.parking_space_master s
    join public.parking_facility_master f
      on f.parking_facility_id = s.parking_facility_id
   where s.unit_id = u.unit_id
     and f.property_id = v_property_id
     and f.facility_code = 'FLAT'
     and s.space_number = '1'
     and u.unit_code = 'PK-B-1';
  get diagnostics v_flat_count = row_count;

  update public.unit_master u
     set unit_code = 'PK-MACHINE-1', updated_at = now()
    from public.parking_space_master s
    join public.parking_facility_master f
      on f.parking_facility_id = s.parking_facility_id
   where s.unit_id = u.unit_id
     and f.property_id = v_property_id
     and f.facility_code = 'MACHINE1'
     and s.space_number = '1'
     and u.unit_code = 'PK-A-1';
  get diagnostics v_machine_count = row_count;

  if v_flat_count <> 1 or v_machine_count <> 1 then
    raise exception '三共新大阪ビルの駐車枠1の対象件数が想定と異なります（FLAT: %, MACHINE: %）',
      v_flat_count, v_machine_count;
  end if;
end;
$$;
