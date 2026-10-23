alter table public.asset_meter_sub_item
  drop column if exists monthly_fixed_amount;

comment on column public.asset_meter_sub_item.is_monthly_fixed is
  '使用量を入力せず、公共料金請求グループごとの設定額を毎月請求する小分類か';

comment on column public.meter_reading_contract_item.fixed_amount is
  '公共料金請求グループ別の基本料または毎月定額小分類の金額';
