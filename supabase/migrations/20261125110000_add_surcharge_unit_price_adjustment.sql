alter table public.meter_reading_month_surcharge
  add column if not exists adjusted_unit_price numeric(12, 4),
  add column if not exists carry_shortfall_forward boolean not null default false,
  add column if not exists shortfall_amount_inclusive numeric(12, 0) not null default 0,
  add column if not exists carried_shortfall_inclusive numeric(12, 0) not null default 0;

comment on column public.meter_reading_month_surcharge.adjusted_unit_price is '当月に実際に請求する増額分の調整単価（税抜）';
comment on column public.meter_reading_month_surcharge.carry_shortfall_forward is '調整単価による回収不足額を次月以降へ引き継ぐか';
comment on column public.meter_reading_month_surcharge.shortfall_amount_inclusive is '本来単価と調整単価による当月回収額の差（税込）';
comment on column public.meter_reading_month_surcharge.carried_shortfall_inclusive is '前月以前から当月計算へ引き継いだ回収不足額（税込）';
