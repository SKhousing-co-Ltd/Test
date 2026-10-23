alter table public.asset_meter
  add column if not exists billing_adjustment_enabled boolean not null default false,
  add column if not exists billing_adjustment_method text,
  add column if not exists billing_adjustment_percent numeric,
  add column if not exists billing_adjustment_numerator numeric,
  add column if not exists billing_adjustment_denominator numeric,
  add column if not exists billing_adjustment_note text;

alter table public.asset_meter
  drop constraint if exists asset_meter_billing_adjustment_method_check;

alter table public.asset_meter
  add constraint asset_meter_billing_adjustment_method_check
  check (billing_adjustment_method is null or billing_adjustment_method in ('ratio', 'percent'));

alter table public.asset_meter
  drop constraint if exists asset_meter_billing_adjustment_values_check;

alter table public.asset_meter
  add constraint asset_meter_billing_adjustment_values_check
  check (
    not billing_adjustment_enabled
    or (
      billing_adjustment_method = 'percent'
      and billing_adjustment_percent is not null
      and billing_adjustment_percent >= 0
    )
    or (
      billing_adjustment_method = 'ratio'
      and billing_adjustment_numerator is not null
      and billing_adjustment_numerator >= 0
      and billing_adjustment_denominator is not null
      and billing_adjustment_denominator > 0
    )
  );

comment on column public.asset_meter.billing_adjustment_enabled is '請求使用量への補正を有効にする';
comment on column public.asset_meter.billing_adjustment_method is '補正方法: ratio または percent';
comment on column public.asset_meter.billing_adjustment_note is '補正設定の備考';
