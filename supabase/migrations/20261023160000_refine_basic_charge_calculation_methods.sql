update public.asset_meter_category_setting
set basic_charge_method = 'sqm'
where basic_charge_method = 'area';

alter table public.asset_meter_category_setting
  drop constraint if exists ck_asset_meter_category_basic_charge_method;

alter table public.asset_meter_category_setting
  add constraint ck_asset_meter_category_basic_charge_method
    check (basic_charge_method in ('fixed', 'sqm', 'tsubo'));

alter table public.asset_meter_category_setting
  drop column if exists basic_charge_rounding_mode;

comment on column public.asset_meter_category_setting.basic_charge_method is
  '新規契約登録時の基本料初期値の算定方法（fixed：定額、sqm：契約面積㎡×単価、tsubo：坪数×単価）';
comment on column public.asset_meter_category_setting.basic_charge_area_unit_price is
  '面積方式で契約面積（㎡または坪）に乗じる単価。契約へ保存後は自動再計算しない';
