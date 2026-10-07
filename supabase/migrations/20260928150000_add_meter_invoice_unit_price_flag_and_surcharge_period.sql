-- 小分類ごとに、請求書に単価を出すかどうかを持たせます。オフの小分類は請求書作成で単価を空欄にします。
alter table public.asset_meter_sub_item
  add column if not exists show_unit_price_on_invoice boolean not null default true;

comment on column public.asset_meter_sub_item.show_unit_price_on_invoice is '請求書に単価を表示するか';

-- 増額分にも既定の請求期間を持たせます。請求設定の請求期間パターンから選びます。
alter table public.asset_meter_surcharge
  add column if not exists billing_period_pattern_id uuid
    references public.asset_billing_period_pattern(billing_period_pattern_id) on delete set null;

comment on column public.asset_meter_surcharge.billing_period_pattern_id is '増額分の既定の請求期間';
