-- 親子メーターは差引使用量の計算関係であり、設置区画の一致を要件としない。
drop trigger if exists validate_asset_meter_parent_unit_trigger on public.asset_meter;
drop function if exists public.validate_asset_meter_parent_unit();

comment on column public.asset_meter.parent_asset_meter_id is
  '差引使用量の計算に使う親メーター。設置区画が異なるメーターも指定できる。';
