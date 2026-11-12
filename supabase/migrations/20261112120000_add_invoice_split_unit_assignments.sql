-- 区画で請求書を分ける場合に、区画ごとに請求書番号を割り当てる。
-- 未登録の区画はアプリケーション側で請求書①として扱う。
create table if not exists public.billing_invoice_split_unit_assignment (
  billing_invoice_split_unit_assignment_id uuid primary key default gen_random_uuid(),
  billing_invoice_split_setting_id uuid not null references public.billing_invoice_split_setting(billing_invoice_split_setting_id) on delete cascade,
  lease_contract_unit_id uuid references public.lease_contract_unit(lease_contract_unit_id) on delete restrict,
  lease_contract_billing_unit_id uuid references public.lease_contract_billing_unit(lease_contract_billing_unit_id) on delete restrict,
  invoice_number smallint not null check (invoice_number between 2 and 3),
  constraint ck_billing_invoice_split_unit_assignment_target check (
    ((lease_contract_unit_id is not null)::integer + (lease_contract_billing_unit_id is not null)::integer = 1)
  )
);

create unique index if not exists uq_billing_invoice_split_unit_assignment_unit
  on public.billing_invoice_split_unit_assignment (billing_invoice_split_setting_id, lease_contract_unit_id)
  where lease_contract_unit_id is not null;
create unique index if not exists uq_billing_invoice_split_unit_assignment_billing_unit
  on public.billing_invoice_split_unit_assignment (billing_invoice_split_setting_id, lease_contract_billing_unit_id)
  where lease_contract_billing_unit_id is not null;

alter table public.billing_invoice_split_unit_assignment enable row level security;
grant select, insert, update, delete on public.billing_invoice_split_unit_assignment to authenticated;

create policy "active users manage invoice split unit assignments"
  on public.billing_invoice_split_unit_assignment for all to authenticated
  using (public.current_account_is_active())
  with check (public.current_account_is_active());
