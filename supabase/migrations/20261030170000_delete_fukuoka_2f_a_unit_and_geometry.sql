-- Excelの区画構成に存在しない三共福岡ビル2F Aの区画と図面形状を削除する。
do $$
declare
  v_property_id uuid;
  v_unit_id uuid;
  v_deleted integer;
begin
  select asset_id
    into strict v_property_id
    from public.asset_master
   where asset_name = '三共福岡ビル';

  select unit_id
    into strict v_unit_id
    from public.unit_master
   where property_id = v_property_id
     and floor_label = '2F'
     and unit_code = 'A'
     and unit_type = 'office'
     and is_active;

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
  if v_deleted <> 1 then
    raise exception '三共福岡ビル2F Aの図面形状が1件ではありません: %', v_deleted;
  end if;

  delete from public.unit_leasing_status where unit_id = v_unit_id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception '三共福岡ビル2F Aの空室状態が1件ではありません: %', v_deleted;
  end if;

  delete from public.unit_master where unit_id = v_unit_id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception '三共福岡ビル2F Aの区画レコードを削除できませんでした';
  end if;
end;
$$;
