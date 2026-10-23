-- usage_rounding_digits はSKシステム既存機能の計算丸め桁として引き続き使用します。
-- KANAMETERの表示・集計桁は aggregation_decimal_digits で管理します。
alter table public.asset_meter_sub_item
  drop constraint if exists ck_asset_meter_sub_item_usage_rounding_digits;

alter table public.asset_meter_sub_item
  add constraint ck_asset_meter_sub_item_usage_rounding_digits
    check (usage_rounding_digits between 0 and 3);

comment on column public.asset_meter_sub_item.usage_rounding_digits is
  '使用量計算で残す小数点以下の桁数（0～3）。KANAMETERの集計表示桁はaggregation_decimal_digitsを使用する';
