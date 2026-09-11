-- テナント請求の共通マスタは請求種別のみとし、明細項目は物件ごとに管理する。
create extension if not exists pgcrypto;

create table if not exists public.billing_charge_type (
  billing_charge_type_id uuid primary key default gen_random_uuid(),
  charge_type_name varchar(100) not null unique,
  sort_order integer not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_billing_charge_type_name check (charge_type_name = btrim(charge_type_name) and charge_type_name <> '')
);

create table if not exists public.asset_billing_period_pattern (
  billing_period_pattern_id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  pattern_name varchar(100) not null,
  start_month_offset smallint not null check (start_month_offset in (-1, 0, 1)),
  start_day_type varchar(10) not null check (start_day_type in ('first', 'last')),
  end_month_offset smallint not null check (end_month_offset in (-1, 0, 1)),
  end_day_type varchar(10) not null check (end_day_type in ('first', 'last')),
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_asset_billing_period_pattern_name unique (asset_id, pattern_name)
);

create table if not exists public.asset_billing_line_item (
  asset_billing_line_item_id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  line_item_name varchar(100) not null,
  display_name varchar(100) not null,
  billing_charge_type_id uuid not null references public.billing_charge_type(billing_charge_type_id) on delete restrict,
  billing_kind varchar(10) not null check (billing_kind in ('fixed', 'variable')),
  period_rule_type varchar(20) not null default 'manual' check (period_rule_type in ('manual', 'meter_reading', 'custom_pattern')),
  billing_period_pattern_id uuid references public.asset_billing_period_pattern(billing_period_pattern_id) on delete set null,
  sort_order integer not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_asset_billing_line_item_name unique (asset_id, line_item_name),
  constraint ck_asset_billing_line_item_name check (line_item_name = btrim(line_item_name) and line_item_name <> ''),
  constraint ck_asset_billing_line_item_period_for_fixed check (billing_kind <> 'fixed' or (period_rule_type = 'manual' and billing_period_pattern_id is null))
);

create index if not exists ix_asset_billing_line_item_asset on public.asset_billing_line_item(asset_id, sort_order);

create or replace function public.set_billing_item_setting_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists set_billing_charge_type_updated_at on public.billing_charge_type;
create trigger set_billing_charge_type_updated_at before update on public.billing_charge_type for each row execute procedure public.set_billing_item_setting_updated_at();
drop trigger if exists set_asset_billing_period_pattern_updated_at on public.asset_billing_period_pattern;
create trigger set_asset_billing_period_pattern_updated_at before update on public.asset_billing_period_pattern for each row execute procedure public.set_billing_item_setting_updated_at();
drop trigger if exists set_asset_billing_line_item_updated_at on public.asset_billing_line_item;
create trigger set_asset_billing_line_item_updated_at before update on public.asset_billing_line_item for each row execute procedure public.set_billing_item_setting_updated_at();

insert into public.billing_charge_type (charge_type_name, sort_order) values
  ('賃料', 10), ('共益費', 20), ('駐車料', 30), ('電気代', 40), ('水道代', 50), ('ガス代', 60), ('その他', 90)
on conflict (charge_type_name) do nothing;

alter table public.billing_charge_type enable row level security;
alter table public.asset_billing_period_pattern enable row level security;
alter table public.asset_billing_line_item enable row level security;
grant select, insert, update, delete on public.billing_charge_type, public.asset_billing_period_pattern, public.asset_billing_line_item to authenticated;
create policy "active users manage billing charge types" on public.billing_charge_type for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage asset billing period patterns" on public.asset_billing_period_pattern for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage asset billing line items" on public.asset_billing_line_item for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
