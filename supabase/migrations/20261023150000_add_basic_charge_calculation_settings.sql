alter table public.asset_meter_category_setting
  add column if not exists basic_charge_method varchar(10) not null default 'fixed',
  add column if not exists basic_charge_fixed_amount numeric(12, 2),
  add column if not exists basic_charge_area_unit_price numeric(12, 4),
  add column if not exists basic_charge_rounding_mode varchar(10) not null default 'round';

alter table public.asset_meter_category_setting
  drop constraint if exists ck_asset_meter_category_basic_charge_method,
  add constraint ck_asset_meter_category_basic_charge_method
    check (basic_charge_method in ('fixed', 'area')),
  drop constraint if exists ck_asset_meter_category_basic_charge_fixed_amount,
  add constraint ck_asset_meter_category_basic_charge_fixed_amount
    check (basic_charge_fixed_amount is null or basic_charge_fixed_amount >= 0),
  drop constraint if exists ck_asset_meter_category_basic_charge_area_unit_price,
  add constraint ck_asset_meter_category_basic_charge_area_unit_price
    check (basic_charge_area_unit_price is null or basic_charge_area_unit_price >= 0),
  drop constraint if exists ck_asset_meter_category_basic_charge_rounding_mode,
  add constraint ck_asset_meter_category_basic_charge_rounding_mode
    check (basic_charge_rounding_mode in ('floor', 'round', 'ceil'));

comment on column public.asset_meter_category_setting.basic_charge_method is
  '新規契約登録時の基本料初期値の算定方法（fixed：定額、area：契約面積×面積単価）';
comment on column public.asset_meter_category_setting.basic_charge_fixed_amount is
  '定額方式で新規契約へ初期設定する基本料。契約へ保存後は自動再計算しない';
comment on column public.asset_meter_category_setting.basic_charge_area_unit_price is
  '面積方式で契約面積に乗じる単価。契約へ保存後は自動再計算しない';
comment on column public.asset_meter_category_setting.basic_charge_rounding_mode is
  '面積×単価で算出した基本料の1円未満の処理';
