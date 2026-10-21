-- Restore the usage rounding digits constraint under its stable name.
alter table public.asset_meter_sub_item
  drop constraint if exists asset_meter_sub_item_usage_rounding_digits_check;

alter table public.asset_meter_sub_item
  add constraint ck_asset_meter_sub_item_usage_rounding_digits
  check (usage_rounding_digits >= 0 and usage_rounding_digits <= 3);
