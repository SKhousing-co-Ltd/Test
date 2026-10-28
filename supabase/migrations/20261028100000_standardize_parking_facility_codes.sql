-- Replace ambiguous facility codes with codes that reflect facility names.
-- Space and contract references use parking_facility_id, so these code updates
-- preserve all existing parking-space and lease relationships.
do $$
declare
  item record;
  changed_count integer;
begin
  for item in
    select * from (values
      (11, 'MAIN', '三共四ツ橋ビル 駐車場', 'MACHINE1'),
      (12, 'MAIN', '三共広島ビル 駐車場', 'MACHINE1'),
      (13, 'MAIN', '三共ビル東館 駐車場', 'MACHINE1'),
      (16, 'A', '三共新大阪ビル 機械式駐車場', 'MACHINE1'),
      (16, 'B', '三共新大阪ビル 平面駐車場', 'FLAT'),
      (17, 'MAIN', '三共肥後橋ビル 駐車場', 'MACHINE1'),
      (21, 'MAIN', '三共京橋ビル 機械式駐車場', 'MACHINE1'),
      (21, 'B', '三共京橋ビル 平面駐車場', 'FLAT'),
      (22, 'MAIN', '三共若草ビル 機械式駐車場', 'MACHINE1'),
      (22, 'B', '三共若草ビル 平面駐車場', 'FLAT'),
      (24, 'MAIN', '三共稲荷町ビル機械式駐車場1号機（手前側）', 'MACHINE1'),
      (24, 'B', '三共稲荷町ビル機械式駐車場2号機（奥側）', 'MACHINE2'),
      (25, 'MAIN', '三共本町ビル 駐車場', 'MACHINE1'),
      (27, 'MAIN', '三共神戸ツインビル 駐車場', 'MACHINE1'),
      (29, 'MAIN', '三共梅田ビル 駐車場', 'SELF1'),
      (30, 'A-1', '三共仙台ビル 機械式駐車場（手前側）', 'MACHINE1-FRONT'),
      (30, 'A-2', '三共仙台ビル 機械式駐車場（奥側）', 'MACHINE1-REAR'),
      (30, 'B-1', '三共仙台ビル 機械式駐車場②（手前側）', 'MACHINE2-FRONT'),
      (30, 'B-2', '三共仙台ビル 機械式駐車場②（奥側）', 'MACHINE2-REAR'),
      (30, 'P', '三共仙台ビル平面 駐車場', 'FLAT'),
      (41, 'MAIN', '三共堺筋本町ビル 駐車場', 'MACHINE1'),
      (44, 'A', '三共ビル郡山南館 平面駐車場', 'FLAT'),
      (44, 'B', '三共ビル郡山南館 機械式駐車場', 'MACHINE1'),
      (45, 'MAIN', '三共小石川THビル 駐車場', 'MACHINE1'),
      (46, 'MAIN', '三共ビル郡山北館 駐車場', 'MACHINE1'),
      (47, 'A', '三共仙台東ビル 機械式駐車場（地下）', 'MACHINE-B1'),
      (47, 'B', '三共仙台東ビル 平面駐車場', 'FLAT'),
      (47, 'MAIN', '三共仙台東ビル 機械式駐車場（地上）', 'MACHINE-1F'),
      (49, 'A', '三共横浜ビル 機械式駐車場（2段式）', 'MACHINE-2TIER'),
      (49, 'B', '三共横浜ビル機械式駐車場①', 'MACHINE1'),
      (49, 'MAIN', '三共横浜ビル機械式駐車場②', 'MACHINE2'),
      (49, 'C', '三共横浜ビル 機械式駐車場③', 'MACHINE3'),
      (50, 'B', '三共小山ビル 機械式駐車場', 'MACHINE1'),
      (50, 'MAIN', '三共小山ビル 平面駐車場', 'FLAT')
    ) as mapping(asset_code, old_code, expected_facility_name, new_code)
  loop
    -- Safe to re-run after a prior application of this migration.
    if exists (
      select 1
      from public.parking_facility_master facility
      join public.asset_master asset on asset.asset_id = facility.property_id
      where asset.asset_code = item.asset_code
        and facility.facility_code = item.new_code
        and facility.facility_name = item.expected_facility_name
    ) then
      continue;
    end if;

    if exists (
      select 1
      from public.parking_facility_master target
      join public.asset_master asset on asset.asset_id = target.property_id
      where asset.asset_code = item.asset_code
        and target.facility_code = item.new_code
        and target.facility_code <> item.old_code
    ) then
      raise exception '物件コード % に施設コード % が既にあります。', item.asset_code, item.new_code;
    end if;

    update public.parking_facility_master facility
       set facility_code = item.new_code
      from public.asset_master asset
     where asset.asset_id = facility.property_id
       and asset.asset_code = item.asset_code
       and facility.facility_code = item.old_code
       and facility.facility_name = item.expected_facility_name;

    get diagnostics changed_count = row_count;
    if changed_count > 1 then
      raise exception '物件コード % の施設 % (% → %) を一意に特定できませんでした。',
        item.asset_code, item.expected_facility_name, item.old_code, item.new_code;
    end if;
  end loop;
end;
$$;
