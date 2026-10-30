-- Excelの区画構成に存在しない三共福岡ビル2F Aの区画と図面形状を削除する。
do $$
declare
  v_property_id uuid;
  v_unit_id uuid;
  v_deleted integer;
  v_property_count integer;
  v_unit_count integer;
begin
  select min(asset_id::text)::uuid, count(*)
    into v_property_id, v_property_count
    from public.asset_master
   where asset_name = '三共福岡ビル';
  if v_property_count = 0 then
    return;
  elsif v_property_count <> 1 then
    raise exception '三共福岡ビルのアセットが一意ではありません';
  end if;

  select count(*), min(unit_id::text)::uuid
    into v_unit_count, v_unit_id
    from public.unit_master
   where property_id = v_property_id
     and floor_label = '2F'
     and unit_code = 'A'
     and unit_type = 'office'
     and is_active;
  if v_unit_count = 0 then
    return; -- The extra 2F A unit is absent in this database.
  elsif v_unit_count <> 1 then
    raise exception '三共福岡ビル2F Aの区画が一意ではありません';
  end if;

  if exists (select 1 from public.lease_contract_unit where unit_id = v_unit_id)
     or exists (select 1 from public.asset_meter_unit_assignment where unit_id = v_unit_id)
     or exists (select 1 from public.meter_reading_contract_unit where unit_id = v_unit_id)
     or exists (select 1 from public.parking_import_row where committed_unit_id = v_unit_id)
     or exists (select 1 from public.parking_space_master where unit_id = v_unit_id)
     or exists (select 1 from public.rent_roll_snapshot_parking_allocation where unit_id = v_unit_id)
     or exists (select 1 from public.unit_lineage where source_unit_id = v_unit_id or target_unit_id = v_unit_id) then
    raise exception '三共福岡ビル2F Aに関連データが追加されているため削除を中止します';
  end if;

  delete from public.unit_plan_geometry where unit_id = v_unit_id;
  get diagnostics v_deleted = row_count;
  if v_deleted > 1 then
    raise exception '三共福岡ビル2F Aの図面形状が複数あります: %', v_deleted;
  end if;

  delete from public.unit_leasing_status where unit_id = v_unit_id;
  get diagnostics v_deleted = row_count;
  if v_deleted > 1 then
    raise exception '三共福岡ビル2F Aの空室状態が複数あります: %', v_deleted;
  end if;

  delete from public.unit_master where unit_id = v_unit_id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception '三共福岡ビル2F Aの区画レコードを削除できませんでした';
  end if;
end;
$$;
