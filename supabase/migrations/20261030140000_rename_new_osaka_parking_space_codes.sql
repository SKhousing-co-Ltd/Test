-- 三共新大阪ビルの駐車枠コードを施設種別が分かる名称に揃える。
do $$
declare
  v_property_id uuid;
  v_flat_count integer;
  v_machine_count integer;
begin
  select asset_id
    into strict v_property_id
    from public.asset_master
   where asset_name = '三共新大阪ビル';

  if exists (
    select 1 from public.unit_master
     where property_id = v_property_id
       and unit_code in ('PK-FLAT-1', 'PK-MACHINE-1')
  ) then
    raise exception '変更先の区画コードが三共新大阪ビル内ですでに使われています';
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
