-- KANAMETERの小分類ごとに、入力表示・集計表示・使用量丸めの桁設定を保持します。
alter table public.asset_meter_sub_item
  add column if not exists input_decimal_digits smallint not null default 1,
  add column if not exists aggregation_decimal_digits smallint not null default 1;

alter table public.asset_meter_sub_item
  drop constraint if exists ck_asset_meter_sub_item_input_decimal_digits,
  drop constraint if exists ck_asset_meter_sub_item_aggregation_decimal_digits;

alter table public.asset_meter_sub_item
  add constraint ck_asset_meter_sub_item_input_decimal_digits
    check (input_decimal_digits between 0 and 3),
  add constraint ck_asset_meter_sub_item_aggregation_decimal_digits
    check (aggregation_decimal_digits between 0 and 3);

-- 既存列は「処理する小数点の桁」を表すものとして使用します。
update public.asset_meter_sub_item
set usage_rounding_digits = 1
where usage_rounding_digits < 1;

alter table public.asset_meter_sub_item
  drop constraint if exists asset_meter_sub_item_usage_rounding_digits_check;
alter table public.asset_meter_sub_item
  drop constraint if exists ck_asset_meter_sub_item_usage_rounding_digits;
alter table public.asset_meter_sub_item
  add constraint ck_asset_meter_sub_item_usage_rounding_digits
    check (usage_rounding_digits between 1 and 3);

comment on column public.asset_meter_sub_item.input_decimal_digits is '検針入力欄で表示・入力する小数点以下の桁数（0～3）';
comment on column public.asset_meter_sub_item.aggregation_decimal_digits is '区画・テナント集計で表示する小数点以下の桁数（0～3）';
comment on column public.asset_meter_sub_item.usage_rounding_digits is '使用量の小数点処理を行う桁（1～3。1は小数点第一位）';
comment on column public.asset_meter_sub_item.usage_rounding_mode is '使用量の小数点処理方法（floor=切り捨て、round=四捨五入、ceil=切り上げ）';
