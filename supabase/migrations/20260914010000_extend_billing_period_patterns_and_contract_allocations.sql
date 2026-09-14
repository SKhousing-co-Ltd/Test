-- 請求期間パターンで前々月～翌々月・検針日（当日/翌日）を扱えるようにする。
alter table public.asset_billing_period_pattern
  add column if not exists start_meter_day_offset smallint not null default 0,
  add column if not exists end_meter_day_offset smallint not null default 0;

alter table public.asset_billing_period_pattern
  drop constraint if exists asset_billing_period_pattern_start_month_offset_check,
  drop constraint if exists asset_billing_period_pattern_end_month_offset_check,
  drop constraint if exists asset_billing_period_pattern_start_day_type_check,
  drop constraint if exists asset_billing_period_pattern_end_day_type_check;

alter table public.asset_billing_period_pattern
  add constraint asset_billing_period_pattern_start_month_offset_check check (start_month_offset in (-2, -1, 0, 1, 2)),
  add constraint asset_billing_period_pattern_end_month_offset_check check (end_month_offset in (-2, -1, 0, 1, 2)),
  add constraint asset_billing_period_pattern_start_day_type_check check (start_day_type in ('first', 'last', 'meter', 'day_1', 'day_2', 'day_3', 'day_4', 'day_5', 'day_6', 'day_7', 'day_8', 'day_9', 'day_10', 'day_11', 'day_12', 'day_13', 'day_14', 'day_15', 'day_16', 'day_17', 'day_18', 'day_19', 'day_20', 'day_21', 'day_22', 'day_23', 'day_24', 'day_25', 'day_26', 'day_27', 'day_28', 'day_29', 'day_30')),
  add constraint asset_billing_period_pattern_end_day_type_check check (end_day_type in ('first', 'last', 'meter', 'day_1', 'day_2', 'day_3', 'day_4', 'day_5', 'day_6', 'day_7', 'day_8', 'day_9', 'day_10', 'day_11', 'day_12', 'day_13', 'day_14', 'day_15', 'day_16', 'day_17', 'day_18', 'day_19', 'day_20', 'day_21', 'day_22', 'day_23', 'day_24', 'day_25', 'day_26', 'day_27', 'day_28', 'day_29', 'day_30')),
  add constraint asset_billing_period_pattern_start_meter_day_offset_check check (start_meter_day_offset in (0, 1)),
  add constraint asset_billing_period_pattern_end_meter_day_offset_check check (end_meter_day_offset in (0, 1));

-- 契約単位の割当は、複数コードグループに対して履歴を残す。
create table if not exists public.billing_code_contract_allocation (
  billing_code_allocation_group_id uuid not null references public.billing_code_allocation_group(billing_code_allocation_group_id) on delete cascade,
  lease_contract_unit_id uuid not null references public.lease_contract_unit(lease_contract_unit_id) on delete cascade,
  billing_code_id uuid not null references public.billing_code(billing_code_id) on delete restrict,
  effective_from date not null,
  effective_to date,
  primary key (billing_code_allocation_group_id, lease_contract_unit_id, effective_from),
  constraint ck_billing_code_contract_allocation_dates check (effective_to is null or effective_to >= effective_from)
);

alter table public.billing_code_contract_allocation enable row level security;
grant select, insert, update, delete on public.billing_code_contract_allocation to authenticated;
create policy "active users manage billing code contract allocations" on public.billing_code_contract_allocation for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
