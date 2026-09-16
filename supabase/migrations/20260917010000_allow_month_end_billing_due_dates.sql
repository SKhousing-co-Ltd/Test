-- 入金期日パターンの day_of_month = 0 は、対象月の末日を表す。
alter table public.asset_billing_due_date_pattern
  drop constraint if exists asset_billing_due_date_pattern_day_of_month_check;

alter table public.asset_billing_due_date_pattern
  add constraint asset_billing_due_date_pattern_day_of_month_check
  check (day_of_month between 0 and 31);

comment on column public.asset_billing_due_date_pattern.day_of_month is '入金期日の日。0は対象月の末日、1～31は指定日。';
