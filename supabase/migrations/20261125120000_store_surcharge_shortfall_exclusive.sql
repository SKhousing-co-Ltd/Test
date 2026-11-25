alter table public.meter_reading_month_surcharge
  add column if not exists shortfall_amount_exclusive numeric(12, 0) not null default 0,
  add column if not exists carried_shortfall_exclusive numeric(12, 0) not null default 0;

comment on column public.meter_reading_month_surcharge.shortfall_amount_exclusive is '本来単価と調整単価による当月回収額の差（税抜）';
comment on column public.meter_reading_month_surcharge.carried_shortfall_exclusive is '前月以前から当月計算へ引き継いだ回収不足額（税抜）';
