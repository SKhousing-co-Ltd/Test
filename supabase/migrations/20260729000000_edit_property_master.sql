BEGIN;

-- 1) カラム追加
ALTER TABLE property_master ADD COLUMN asset_code integer;
ALTER TABLE property_master ADD COLUMN segment_id uuid;

-- 2) 既存29件に asset_code / segment_id を投入
WITH map(property_id, asset_uid) AS (
  VALUES
    ('335ab5b2-1e2c-4db5-abd8-325561d79f58'::uuid,'852f21cc-951d-492a-a7bb-ebb05a27a3a2'::uuid),
    ('341fafc9-8acf-4cd0-a9db-a4cfbcca7731'::uuid,'28f247f8-d1b7-4410-a979-f2831adce7d9'::uuid),
    ('a4735afa-9dea-4d3d-8855-d117eeeb8def'::uuid,'b179a9d0-7f85-4357-a5a4-be19a4dc7210'::uuid),
    ('a9419dc1-a560-45a5-9a7b-beb3d272333c'::uuid,'0061be21-60e6-422c-899a-9a31123ace1b'::uuid),
    ('8bfa0467-0bdf-4988-a7fc-8a0564e9c5e8'::uuid,'de6444aa-18de-492f-8a01-c27822592988'::uuid),
    ('d0782c90-1748-430b-b0f4-30574260596d'::uuid,'749b892f-8083-4b70-8109-34fca68e6698'::uuid),
    ('00d52706-97e3-4988-9032-bf0a143ddfaa'::uuid,'002cb218-c014-4055-bcd8-703501352223'::uuid),
    ('3c910e06-3dee-4af4-af2e-342b9da1744f'::uuid,'698d168d-005e-42a6-93bd-7903ef48bbb5'::uuid),
    ('4f833fe7-293c-4ff5-b81d-609a4ac66295'::uuid,'89e27fad-157f-4aae-904c-2d610d6754c0'::uuid),
    ('d3ca067c-0034-4ba5-a7b5-11de70738335'::uuid,'4e2c0e1e-3db8-4487-8181-c2f36e46f983'::uuid),
    ('5f2d3078-32f0-45a7-aa15-b3e8c2c3a888'::uuid,'9e677a9d-049d-4e08-bf13-cc18eb84a5d7'::uuid),
    ('995ec473-209a-4ec3-a1d2-a69653acde1d'::uuid,'8e3c7d69-fd11-4363-95db-85c0335fcfbe'::uuid),
    ('eff4d403-111a-42cf-8a05-5eb280edd717'::uuid,'c763d7e6-45b6-4da4-accb-78b1e41566e4'::uuid),
    ('10d42d5c-fcb8-42e6-9990-197f5eab2b8b'::uuid,'4b4a12e8-9a39-4541-930e-ffdf4083a2da'::uuid),
    ('b1d76d80-888c-42a9-9937-a62b7c7cdac8'::uuid,'a6f2782c-7ea2-437b-87fe-560330402d7f'::uuid),
    ('4fadd5be-36d3-4b3f-bb20-69f36fa2135d'::uuid,'5cbf68b4-866a-4a49-8ecb-33a16d2f47fa'::uuid),
    ('1f76810c-e03d-4478-b957-277d52aea47d'::uuid,'cb09326c-eecb-46da-83a3-88d39656f987'::uuid),
    ('50bc5b3d-f15a-4e21-8bc2-54c00ad425c9'::uuid,'bca1fe06-1dad-43c4-bd15-64748a8d5b4a'::uuid),
    ('2f5b7183-c425-4012-af0a-93ad474d66d3'::uuid,'bf34f007-008c-4fb5-9d06-e0e238187b50'::uuid),
    ('798d59c7-16ef-4d32-a6e4-5d917e37dda5'::uuid,'85b149e5-5f67-4568-ba4d-cbc7da4a30dd'::uuid),
    ('23199d8c-2fdd-4e78-ae21-da10c2dafc9f'::uuid,'545ee47e-15ff-43fa-b648-d62f293ffd6f'::uuid),
    ('8dd09894-4ff7-4320-85cb-c2df94435426'::uuid,'e00d24e5-af4d-4a85-a6da-7d7278cc1cd4'::uuid),
    ('38f229ec-cedd-424b-9e39-52235e899b00'::uuid,'3f9b13e7-2e0d-415c-99a2-318eae037b69'::uuid),
    ('4ab49cdc-cfc4-4c98-9e1a-1c1ca17ab57f'::uuid,'28089a6b-f05f-4ce3-858e-a2de4803fa2a'::uuid),
    ('822b9f46-66bb-4f88-aadf-c661a23cc73c'::uuid,'3160be4e-4362-45aa-bf56-319672b17607'::uuid),
    ('20cf61ad-d017-4477-9188-081ed6e61b1f'::uuid,'4d8fc916-b7c1-4fc0-a233-f712009a013d'::uuid),
    ('ef87aea3-3b08-45ef-9d93-a94ce1733602'::uuid,'f183aab9-bd7e-4e53-9353-43e5d779fa43'::uuid),
    ('6e0b6bdf-ed7e-49a3-bb8b-b2c2c4527ec1'::uuid,'6f8b7eaf-70ec-43cd-a517-f3a05a394130'::uuid),
    ('27ff2e51-51f7-4a92-9d34-534819b75444'::uuid,'754ffe94-94df-465e-b7e8-9f9cfea29c90'::uuid)
)
UPDATE property_master p
SET asset_code = a.asset_code,
    segment_id = a.segment_id,
    updated_at = now()
FROM map m
JOIN asset_master a ON a.uid = m.asset_uid
WHERE p.property_id = m.property_id;

-- Fresh preview databases generate different property UUIDs in the initial
-- seed migration. Complete the same mapping by the unique property name so
-- existing properties are enriched instead of inserted a second time.
UPDATE property_master p
SET asset_code = a.asset_code,
    segment_id = a.segment_id,
    updated_at = now()
FROM asset_master a
WHERE p.property_name = a.asset_name
  AND p.asset_code IS NULL;

-- 3) 未対応アセット(44件)を新規追加
INSERT INTO property_master (
  property_id, property_name, short_name, address,
  construction_date, acquisition_date,
  land_area_sqm, building_area_sqm, rentable_area_sqm,
  created_at, updated_at,
  asset_code, segment_id
)
SELECT
  a.uid, a.asset_name, a.short_name, a.address,
  a.construction_date, a.acquisition_date,
  a.land_area_sqm, a.building_area_sqm, a.rentable_area_sqm,
  a.created_at, a.updated_at,
  a.asset_code, a.segment_id
FROM asset_master a
WHERE a.asset_code NOT IN (
  SELECT asset_code FROM property_master WHERE asset_code IS NOT NULL
);

-- 4) その他 を削除
DELETE FROM property_master WHERE property_id = '710d72fd-333e-4ad2-8caf-5af983fd09c0';

COMMIT;
