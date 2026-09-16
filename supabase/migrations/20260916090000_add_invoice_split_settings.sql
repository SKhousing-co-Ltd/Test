-- テナントコード単位で、区画または明細項目による請求書分割方法を保存する。
create table if not exists public.billing_invoice_split_setting (
  billing_invoice_split_setting_id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  billing_code_id uuid not null references public.billing_code(billing_code_id) on delete cascade,
  split_mode varchar(20) not null check (split_mode in ('unit', 'line_item')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_billing_invoice_split_setting_code unique (asset_id, billing_code_id)
);

create table if not exists public.billing_invoice_split_assignment (
  billing_invoice_split_setting_id uuid not null references public.billing_invoice_split_setting(billing_invoice_split_setting_id) on delete cascade,
  asset_billing_line_item_id uuid not null references public.asset_billing_line_item(asset_billing_line_item_id) on delete cascade,
  lease_contract_unit_id uuid references public.lease_contract_unit(lease_contract_unit_id) on delete restrict,
  invoice_number smallint,
  primary key (billing_invoice_split_setting_id, asset_billing_line_item_id),
  constraint ck_billing_invoice_split_assignment_target check (
    (lease_contract_unit_id is not null and invoice_number is null)
    or (lease_contract_unit_id is null and invoice_number between 1 and 3)
  )
);

create index if not exists ix_billing_invoice_split_setting_asset on public.billing_invoice_split_setting(asset_id);

alter table public.billing_invoice_split_setting enable row level security;
alter table public.billing_invoice_split_assignment enable row level security;

grant select, insert, update, delete on public.billing_invoice_split_setting, public.billing_invoice_split_assignment to authenticated;

create policy "active users manage invoice split settings"
  on public.billing_invoice_split_setting for all to authenticated
  using (public.current_account_is_active())
  with check (public.current_account_is_active());

create policy "active users manage invoice split assignments"
  on public.billing_invoice_split_assignment for all to authenticated
  using (public.current_account_is_active())
  with check (public.current_account_is_active());

drop trigger if exists set_billing_invoice_split_setting_updated_at on public.billing_invoice_split_setting;
create trigger set_billing_invoice_split_setting_updated_at
before update on public.billing_invoice_split_setting
for each row execute procedure public.set_updated_at();
