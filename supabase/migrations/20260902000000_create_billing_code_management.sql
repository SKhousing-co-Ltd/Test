-- テナント請求の発行コード。テナントマスタの外部コードとは別に、物件単位で管理する。
create extension if not exists pgcrypto;

create table if not exists public.billing_code (
  billing_code_id uuid primary key default gen_random_uuid(),
  property_id uuid references public.asset_master(asset_id) on delete restrict,
  issue_code varchar(30) not null,
  recipient_name varchar(250) not null,
  source_sheet_name varchar(30),
  source_row_number integer,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_billing_code_source_row check (source_row_number is null or source_row_number > 0)
);

create unique index if not exists uq_billing_code_property_issue_code
  on public.billing_code(property_id, issue_code)
  where property_id is not null;
create index if not exists ix_billing_code_property on public.billing_code(property_id, issue_code);

create table if not exists public.billing_code_charge_flag (
  billing_code_id uuid not null references public.billing_code(billing_code_id) on delete cascade,
  charge_type varchar(30) not null,
  is_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (billing_code_id, charge_type),
  constraint ck_billing_code_charge_flag_type check (charge_type in ('meeting_room', 'electricity', 'electricity_increment', 'water', 'gas', 'fluorescent_light', 'other'))
);

create or replace function public.set_billing_code_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_billing_code_updated_at on public.billing_code;
create trigger set_billing_code_updated_at before update on public.billing_code
for each row execute procedure public.set_billing_code_updated_at();
drop trigger if exists set_billing_code_charge_flag_updated_at on public.billing_code_charge_flag;
create trigger set_billing_code_charge_flag_updated_at before update on public.billing_code_charge_flag
for each row execute procedure public.set_billing_code_updated_at();

alter table public.billing_code enable row level security;
alter table public.billing_code_charge_flag enable row level security;
grant select, insert, update, delete on public.billing_code, public.billing_code_charge_flag to authenticated;
create policy "active users manage billing codes" on public.billing_code
  for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage billing code charge flags" on public.billing_code_charge_flag
  for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());

comment on table public.billing_code is '物件ごとの請求書発行コード。Excelの発行コードマスタを移行する。';
comment on table public.billing_code_charge_flag is '会議室利用料・水光熱費等を請求対象にする発行コード別フラグ。';
