-- 入力時に作られた仮のPK-FLAT-2～4区画から駐車場台帳の実区画へ
-- 契約区画を付け替え、重複区画を統合してコード表記を揃える。
do $$
declare
  v_property_id uuid;
  v_duplicate_unit_id uuid;
  v_parking_unit_id uuid;
  v_space_number text;
  v_contract_units_moved integer;
begin
  select asset_id
    into strict v_property_id
    from public.asset_master
   where asset_name = '三共新大阪ビル';

  foreach v_space_number in array array['2', '3', '4'] loop
    select u.unit_id
      into strict v_duplicate_unit_id
      from public.unit_master u
     where u.property_id = v_property_id
       and u.unit_code = 'PK-FLAT-' || v_space_number;

    select u.unit_id
      into strict v_parking_unit_id
      from public.parking_facility_master f
      join public.parking_space_master s
        on s.parking_facility_id = f.parking_facility_id
      join public.unit_master u
        on u.unit_id = s.unit_id
     where f.property_id = v_property_id
       and f.facility_code = 'FLAT'
       and s.space_number = v_space_number
       and u.unit_code = 'PK-B-' || v_space_number;

    if exists (
      select 1
        from public.lease_contract_unit duplicate_contract_unit
        join public.lease_contract_unit parking_contract_unit
          on parking_contract_unit.lease_contract_id = duplicate_contract_unit.lease_contract_id
         and parking_contract_unit.unit_id = v_parking_unit_id
       where duplicate_contract_unit.unit_id = v_duplicate_unit_id
    ) then
      raise exception '三共新大阪ビル平面駐車場 枠%に同一契約の重複紐付けがあります', v_space_number;
    end if;

    if exists (select 1 from public.parking_space_master where unit_id = v_duplicate_unit_id)
       or exists (select 1 from public.asset_meter_unit_assignment where unit_id = v_duplicate_unit_id)
       or exists (select 1 from public.meter_reading_contract_unit where unit_id = v_duplicate_unit_id)
       or exists (select 1 from public.parking_import_row where committed_unit_id = v_duplicate_unit_id)
       or exists (select 1 from public.rent_roll_snapshot_parking_allocation where unit_id = v_duplicate_unit_id)
       or exists (select 1 from public.unit_leasing_status where unit_id = v_duplicate_unit_id)
       or exists (select 1 from public.unit_lineage where source_unit_id = v_duplicate_unit_id or target_unit_id = v_duplicate_unit_id)
       or exists (select 1 from public.unit_plan_geometry where unit_id = v_duplicate_unit_id) then
      raise exception 'PK-FLAT-%区画に駐車場台帳以外の参照があるため統合を中止します', v_space_number;
    end if;

    update public.lease_contract_unit
       set unit_id = v_parking_unit_id,
           updated_at = now()
     where unit_id = v_duplicate_unit_id;
    get diagnostics v_contract_units_moved = row_count;

    if v_contract_units_moved = 0 then
      raise exception 'PK-FLAT-%区画に契約紐付けがありません', v_space_number;
    end if;

    delete from public.unit_master
     where unit_id = v_duplicate_unit_id;

    update public.unit_master
       set unit_code = 'PK-FLAT-' || v_space_number,
           unit_name = '駐車枠 ' || v_space_number,
           floor_label = '駐車場',
           updated_at = now()
     where unit_id = v_parking_unit_id;
  end loop;
end;
$$;
