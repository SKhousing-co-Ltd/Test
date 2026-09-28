-- 使用量を画面に出すときの小数点以下の桁数です。計算の丸め（usage_rounding_digits）とは別に持ちます。
alter table public.asset_meter_sub_item
  add column if not exists usage_display_digits smallint not null default 1
  check (usage_display_digits between 0 and 3);

comment on column public.asset_meter_sub_item.usage_display_digits is '使用量の表示桁数（小数点以下）';
