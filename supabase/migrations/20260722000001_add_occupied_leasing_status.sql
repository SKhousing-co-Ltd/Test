-- 区画状況として手動設定できる「契約中」を追加する。
alter table public.unit_leasing_status
  drop constraint if exists unit_leasing_status_leasing_status_check;

alter table public.unit_leasing_status
  add constraint unit_leasing_status_leasing_status_check
  check (leasing_status in ('occupied', 'vacant', 'applied', 'unavailable'));
