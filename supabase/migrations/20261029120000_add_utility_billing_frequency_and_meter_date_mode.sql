alter table public.asset_utility_price_setting
  add column if not exists billing_frequency text not null default 'monthly';

alter table public.asset_utility_price_setting
  drop constraint if exists asset_utility_price_setting_billing_frequency_check;
alter table public.asset_utility_price_setting
  add constraint asset_utility_price_setting_billing_frequency_check
  check (billing_frequency in ('monthly', 'odd', 'even'));

comment on column public.asset_utility_price_setting.billing_frequency is
  '分類ごとの請求タイミング（monthly：毎月、odd：奇数月、even：偶数月）';

create table if not exists public.asset_meter_building_setting (
  asset_id uuid primary key references public.asset_master(asset_id) on delete cascade,
  meter_date_mode text not null default 'shared'
    check (meter_date_mode in ('shared', 'category')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.asset_meter_building_setting is '物件単位の検針方法設定';
comment on column public.asset_meter_building_setting.meter_date_mode is
  '検針日の入力方式（shared：全分類共通、category：分類別）';

alter table public.asset_meter_building_setting enable row level security;
drop policy if exists "active users manage asset meter building settings" on public.asset_meter_building_setting;
create policy "active users manage asset meter building settings"
  on public.asset_meter_building_setting for all to authenticated
  using (public.current_account_is_active())
  with check (public.current_account_is_active());
grant select, insert, update, delete on public.asset_meter_building_setting to authenticated;

insert into public.asset_meter_building_setting(asset_id, meter_date_mode)
select asset_id, 'shared' from public.asset_master
on conflict (asset_id) do nothing;
