-- 年払いの請求期間（当月から1年分／翌月から1年分）を扱えるようにする。
alter table public.asset_billing_period_pattern
  drop constraint if exists asset_billing_period_pattern_end_month_offset_check;

alter table public.asset_billing_period_pattern
  add constraint asset_billing_period_pattern_end_month_offset_check
  check (end_month_offset between -2 and 12);
