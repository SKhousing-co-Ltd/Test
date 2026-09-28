-- 増額分の単価を、電力会社などからの請求（仕入）と、テナントからの回収額の差から求めます。
-- 仕入の情報は月ごとに手入力するため、増額分の月次テーブルに持たせます。
alter table public.meter_reading_month_surcharge
  add column if not exists purchase_period_start date,
  add column if not exists purchase_period_end date,
  add column if not exists purchase_amount_inclusive numeric(12, 0),
  add column if not exists purchase_usage numeric(14, 3);

comment on column public.meter_reading_month_surcharge.purchase_period_start is '仕入（電力会社などからの請求）の期間の開始日';
comment on column public.meter_reading_month_surcharge.purchase_period_end is '仕入の期間の終了日';
comment on column public.meter_reading_month_surcharge.purchase_amount_inclusive is '仕入の請求金額（税込）';
comment on column public.meter_reading_month_surcharge.purchase_usage is '仕入の使用量';
