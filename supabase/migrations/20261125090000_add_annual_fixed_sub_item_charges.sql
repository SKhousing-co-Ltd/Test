alter table public.asset_meter_sub_item
  drop constraint if exists asset_meter_sub_item_calculation_mode_check;

alter table public.asset_meter_sub_item
  add constraint asset_meter_sub_item_calculation_mode_check
  check (calculation_mode in ('meter', 'fixed', 'annual_fixed', 'allocated_amount'));

alter table public.meter_reading_month_fixed_charge
  add column if not exists annual_billing_month smallint
  check (annual_billing_month between 1 and 12);

comment on column public.meter_reading_month_fixed_charge.annual_billing_month is
  '毎年定額の請求月。NULLは毎月定額、1～12は指定月だけ請求する';
