alter table public.meter_reading_month_sub_item
  add column if not exists unit_price_adjustment_enabled boolean not null default false,
  add column if not exists unit_price_adjustment_factor numeric(12, 6) not null default 1;

alter table public.meter_reading_month_sub_item
  drop constraint if exists meter_reading_month_sub_item_adjustment_factor_check;

alter table public.meter_reading_month_sub_item
  add constraint meter_reading_month_sub_item_adjustment_factor_check
  check (unit_price_adjustment_factor > 0);
