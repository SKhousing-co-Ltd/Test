alter table public.asset_meter_sub_item
  add column if not exists is_monthly_fixed boolean not null default false,
  add column if not exists monthly_fixed_amount numeric(12, 2);

alter table public.asset_meter_sub_item
  drop constraint if exists ck_asset_meter_sub_item_monthly_fixed_amount,
  add constraint ck_asset_meter_sub_item_monthly_fixed_amount
    check (monthly_fixed_amount is null or monthly_fixed_amount >= 0);

comment on column public.asset_meter_sub_item.is_monthly_fixed is
  '使用量を入力せず、請求グループごとに毎月同じ定額を請求する小分類か';
comment on column public.asset_meter_sub_item.monthly_fixed_amount is
  '毎月定額の小分類で請求グループごとに計上する金額';
