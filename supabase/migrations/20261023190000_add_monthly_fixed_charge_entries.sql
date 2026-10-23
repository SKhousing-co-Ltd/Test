create table if not exists public.meter_reading_month_fixed_charge (
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  billing_month date not null,
  meter_reading_contract_id uuid not null references public.meter_reading_contract(meter_reading_contract_id) on delete cascade,
  asset_meter_sub_item_id uuid not null references public.asset_meter_sub_item(asset_meter_sub_item_id) on delete cascade,
  amount numeric(12, 2) not null check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (asset_id, billing_month, meter_reading_contract_id, asset_meter_sub_item_id),
  foreign key (asset_id, billing_month) references public.meter_reading_month(asset_id, billing_month) on delete cascade
);

alter table public.meter_reading_month_fixed_charge enable row level security;
grant select, insert, update, delete on public.meter_reading_month_fixed_charge to authenticated;
create policy "active users manage monthly fixed charges" on public.meter_reading_month_fixed_charge
  for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());

drop trigger if exists set_meter_reading_month_fixed_charge_updated_at on public.meter_reading_month_fixed_charge;
create trigger set_meter_reading_month_fixed_charge_updated_at before update on public.meter_reading_month_fixed_charge
  for each row execute procedure public.set_billing_item_setting_updated_at();

comment on table public.meter_reading_month_fixed_charge is
  '検針画面で入力する公共料金グループ別の毎月定額。未入力月は直近月の金額を引き継ぐ';
