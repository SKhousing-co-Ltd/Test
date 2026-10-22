alter table public.meter_reading_month_sub_item
  add column if not exists rate_source_meter_id uuid references public.asset_meter(asset_meter_id) on delete set null,
  add column if not exists tariff_code varchar(100),
  add column if not exists water_inclusive numeric(12, 0),
  add column if not exists sewer_inclusive numeric(12, 0),
  add column if not exists unit_price_rounding_digits smallint not null default 2
    check (unit_price_rounding_digits between 0 and 4),
  add column if not exists unit_price_rounding_mode varchar(10) not null default 'round'
    check (unit_price_rounding_mode in ('floor', 'ceil', 'round'));

comment on column public.meter_reading_month_sub_item.rate_source_meter_id is '大元メーターから計算した場合に参照したメーター';
comment on column public.meter_reading_month_sub_item.tariff_code is '単価計算に使用した料金表の版';
comment on column public.meter_reading_month_sub_item.water_inclusive is '計算時点の上水道料金（税込）';
comment on column public.meter_reading_month_sub_item.sewer_inclusive is '計算時点の下水道使用料（税込）';
comment on column public.meter_reading_month_sub_item.unit_price_rounding_digits is '月次単価計算で使用した小数桁数';
comment on column public.meter_reading_month_sub_item.unit_price_rounding_mode is '月次単価計算で使用した丸め方法';
