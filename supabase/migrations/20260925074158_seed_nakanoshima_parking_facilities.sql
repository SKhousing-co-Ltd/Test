-- 中之島の駐車場台帳施設。既存の駐車場契約制約・取込経路をそのまま利用する。
insert into public.parking_facility_master (
  property_id, facility_code, facility_name, parking_type_id
)
select asset.asset_id, seed.facility_code, seed.facility_name, seed.parking_type_id
from public.asset_master asset
cross join (values
  ('NAK-MECH', '中之島 機械式駐車場', 1::bigint),
  ('NAK-FLAT', '中之島 平面駐車場', 3::bigint),
  ('NAK-BIKE', '中之島 バイク駐輪場', 1::bigint)
) as seed(facility_code, facility_name, parking_type_id)
where asset.asset_code = 26
on conflict (property_id, facility_code) do update
set facility_name = excluded.facility_name,
    parking_type_id = excluded.parking_type_id,
    is_active = true,
    updated_at = now();
