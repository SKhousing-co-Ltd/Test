-- テナントコードごとの請求書表示情報と、物件ごとの入金期日パターン。
alter table public.billing_code
  add column if not exists invoice_display_name varchar(200),
  add column if not exists invoice_subject varchar(300);

create table if not exists public.asset_billing_due_date_pattern (
  billing_due_date_pattern_id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  pattern_number integer not null check (pattern_number > 0),
  month_offset smallint not null check (month_offset in (0, 1)),
  day_of_month smallint not null check (day_of_month between 1 and 31),
  holiday_adjustment varchar(10) not null default 'next' check (holiday_adjustment in ('previous', 'next')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (asset_id, pattern_number)
);
alter table public.asset_billing_due_date_pattern enable row level security;
grant select, insert, update, delete on public.asset_billing_due_date_pattern to authenticated;
create policy "active users manage asset billing due date patterns" on public.asset_billing_due_date_pattern for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create trigger set_asset_billing_due_date_pattern_updated_at before update on public.asset_billing_due_date_pattern for each row execute procedure public.set_billing_item_setting_updated_at();
