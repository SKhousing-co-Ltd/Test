alter table public.asset_meter_surcharge
  add column if not exists calculation_scope text not null default 'tenant';

alter table public.asset_meter_surcharge
  drop constraint if exists asset_meter_surcharge_calculation_scope_check;
alter table public.asset_meter_surcharge
  add constraint asset_meter_surcharge_calculation_scope_check
  check (calculation_scope in ('tenant', 'unit'));

comment on column public.asset_meter_surcharge.calculation_scope is
  '増額分単価を掛ける単位（tenant：テナントごと、unit：区画ごと）';
