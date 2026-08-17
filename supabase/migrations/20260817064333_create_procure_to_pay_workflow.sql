-- 修繕費・仲介料等の発注から請求、支払、収支実績までを一貫管理する。

create extension if not exists pgcrypto;

create table public.vendor_master (
  vendor_id uuid primary key default gen_random_uuid(),
  vendor_code varchar(30) not null unique,
  vendor_name varchar(200) not null,
  invoice_registration_number varchar(20),
  billone_supplier_id varchar(100) unique,
  contact_name varchar(100),
  contact_email varchar(320),
  payment_terms varchar(200),
  is_active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  updated_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.procurement_order (
  procurement_order_id uuid primary key default gen_random_uuid(),
  order_number varchar(40) not null unique default ('PO-' || to_char(current_date, 'YYYYMM') || '-' || upper(substr(gen_random_uuid()::text, 1, 8))),
  property_id uuid not null references public.asset_master (asset_id) on delete restrict,
  account_id varchar(10) not null references public.income_expense_account_master (account_id) on delete restrict,
  vendor_id uuid not null references public.vendor_master (vendor_id) on delete restrict,
  order_type varchar(20) not null check (order_type in ('repair', 'brokerage', 'other')),
  title varchar(300) not null,
  description text,
  gross_amount numeric(14, 0) not null check (gross_amount > 0),
  order_date date,
  expected_completion_date date,
  expected_payment_date date,
  status varchar(30) not null default 'draft'
    check (status in ('draft', 'pending_approval', 'approved', 'ordered', 'partially_invoiced', 'invoiced', 'completed', 'cancelled')),
  appsuite_app_id varchar(100) references public.appsuite_application (app_id) on delete set null,
  appsuite_ringi_number varchar(100),
  requester_employee_id uuid references public.employee_master (employee_id) on delete set null,
  notes text,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  updated_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_procurement_order_dates check (
    expected_completion_date is null or order_date is null or expected_completion_date >= order_date
  )
);

create table public.vendor_invoice (
  vendor_invoice_id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.asset_master (asset_id) on delete restrict,
  account_id varchar(10) not null references public.income_expense_account_master (account_id) on delete restrict,
  vendor_id uuid not null references public.vendor_master (vendor_id) on delete restrict,
  invoice_number varchar(100),
  billone_invoice_id varchar(100) unique,
  billone_document_url text,
  invoice_date date not null,
  received_date date not null default current_date,
  due_date date not null,
  accounting_month date not null,
  subtotal_amount numeric(14, 0) not null default 0 check (subtotal_amount >= 0),
  tax_amount numeric(14, 0) not null default 0 check (tax_amount >= 0),
  gross_amount numeric(14, 0) not null check (gross_amount > 0),
  status varchar(20) not null default 'received'
    check (status in ('received', 'matched', 'approved', 'scheduled', 'paid', 'rejected')),
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  notes text,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  updated_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_vendor_invoice_month check (accounting_month = date_trunc('month', accounting_month)::date),
  constraint ck_vendor_invoice_amounts check (gross_amount = subtotal_amount + tax_amount),
  constraint ck_vendor_invoice_dates check (due_date >= invoice_date)
);

create table public.vendor_invoice_order_allocation (
  vendor_invoice_id uuid not null references public.vendor_invoice (vendor_invoice_id) on delete cascade,
  procurement_order_id uuid not null references public.procurement_order (procurement_order_id) on delete restrict,
  allocated_amount numeric(14, 0) not null check (allocated_amount > 0),
  created_at timestamptz not null default now(),
  primary key (vendor_invoice_id, procurement_order_id)
);

create table public.payment_schedule (
  payment_schedule_id uuid primary key default gen_random_uuid(),
  vendor_invoice_id uuid not null references public.vendor_invoice (vendor_invoice_id) on delete cascade,
  installment_number smallint not null default 1 check (installment_number > 0),
  scheduled_date date not null,
  amount numeric(14, 0) not null check (amount > 0),
  status varchar(20) not null default 'unscheduled'
    check (status in ('unscheduled', 'scheduled', 'processing', 'paid', 'cancelled')),
  payment_reference varchar(100),
  paid_date date,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  updated_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_invoice_id, installment_number),
  constraint ck_payment_schedule_paid check ((status = 'paid') = (paid_date is not null))
);

alter table public.property_monthly_financial_entry
  add column if not exists source_system varchar(30),
  add column if not exists source_record_id uuid;

create unique index if not exists uq_property_monthly_financial_entry_source
  on public.property_monthly_financial_entry (source_system, source_record_id)
  where source_system is not null and source_record_id is not null;
create index ix_vendor_master_created_by on public.vendor_master (created_by) where created_by is not null;
create index ix_vendor_master_updated_by on public.vendor_master (updated_by) where updated_by is not null;
create index ix_procurement_order_property_status on public.procurement_order (property_id, status);
create index ix_procurement_order_vendor on public.procurement_order (vendor_id);
create index ix_procurement_order_account on public.procurement_order (account_id);
create index ix_procurement_order_appsuite on public.procurement_order (appsuite_app_id) where appsuite_app_id is not null;
create index ix_procurement_order_requester on public.procurement_order (requester_employee_id) where requester_employee_id is not null;
create index ix_procurement_order_created_by on public.procurement_order (created_by) where created_by is not null;
create index ix_procurement_order_updated_by on public.procurement_order (updated_by) where updated_by is not null;
create index ix_vendor_invoice_property_month on public.vendor_invoice (property_id, accounting_month);
create index ix_vendor_invoice_account on public.vendor_invoice (account_id);
create index ix_vendor_invoice_vendor on public.vendor_invoice (vendor_id);
create index ix_vendor_invoice_approved_by on public.vendor_invoice (approved_by) where approved_by is not null;
create index ix_vendor_invoice_created_by on public.vendor_invoice (created_by) where created_by is not null;
create index ix_vendor_invoice_updated_by on public.vendor_invoice (updated_by) where updated_by is not null;
create index ix_vendor_invoice_status_due on public.vendor_invoice (status, due_date);
create index ix_vendor_invoice_order_allocation_order on public.vendor_invoice_order_allocation (procurement_order_id);
create index ix_payment_schedule_status_date on public.payment_schedule (status, scheduled_date);
create index ix_payment_schedule_created_by on public.payment_schedule (created_by) where created_by is not null;
create index ix_payment_schedule_updated_by on public.payment_schedule (updated_by) where updated_by is not null;

create or replace function public.set_procure_to_pay_updated_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end;
$$;

create trigger set_vendor_master_updated_fields before update on public.vendor_master
for each row execute function public.set_procure_to_pay_updated_fields();
create trigger set_procurement_order_updated_fields before update on public.procurement_order
for each row execute function public.set_procure_to_pay_updated_fields();
create trigger set_vendor_invoice_updated_fields before update on public.vendor_invoice
for each row execute function public.set_procure_to_pay_updated_fields();
create trigger set_payment_schedule_updated_fields before update on public.payment_schedule
for each row execute function public.set_procure_to_pay_updated_fields();

create or replace function public.validate_invoice_order_allocation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  invoice_id uuid := coalesce(new.vendor_invoice_id, old.vendor_invoice_id);
  order_id uuid := coalesce(new.procurement_order_id, old.procurement_order_id);
  invoice_total numeric;
  order_total numeric;
  invoice_allocated numeric;
  order_allocated numeric;
begin
  select gross_amount into invoice_total from public.vendor_invoice where vendor_invoice_id = invoice_id;
  select gross_amount into order_total from public.procurement_order where procurement_order_id = order_id;
  select coalesce(sum(allocated_amount), 0) into invoice_allocated
    from public.vendor_invoice_order_allocation where vendor_invoice_id = invoice_id;
  select coalesce(sum(allocated_amount), 0) into order_allocated
    from public.vendor_invoice_order_allocation where procurement_order_id = order_id;
  if invoice_allocated > invoice_total then raise exception '請求書への配賦額が請求総額を超えています'; end if;
  if order_allocated > order_total then raise exception '発注への請求配賦額が発注総額を超えています'; end if;
  return coalesce(new, old);
end;
$$;

create constraint trigger validate_invoice_order_allocation
after insert or update or delete on public.vendor_invoice_order_allocation
deferrable initially deferred for each row execute function public.validate_invoice_order_allocation();

create or replace function public.sync_procurement_order_invoice_status()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  target_order_id uuid := coalesce(new.procurement_order_id, old.procurement_order_id);
  total_ordered numeric;
  total_invoiced numeric;
begin
  select gross_amount into total_ordered from public.procurement_order where procurement_order_id = target_order_id;
  select coalesce(sum(allocated_amount), 0) into total_invoiced
    from public.vendor_invoice_order_allocation where procurement_order_id = target_order_id;
  update public.procurement_order
     set status = case
       when total_invoiced <= 0 then status
       when total_invoiced < total_ordered then 'partially_invoiced'
       else 'invoiced'
     end
   where procurement_order_id = target_order_id and status not in ('completed', 'cancelled');
  return coalesce(new, old);
end;
$$;

create trigger sync_procurement_order_invoice_status
after insert or update or delete on public.vendor_invoice_order_allocation
for each row execute function public.sync_procurement_order_invoice_status();

create or replace function public.create_default_payment_schedule()
returns trigger language plpgsql set search_path = public as $$
begin
  insert into public.payment_schedule (vendor_invoice_id, scheduled_date, amount)
  values (new.vendor_invoice_id, new.due_date, new.gross_amount);
  return new;
end;
$$;

create trigger create_default_payment_schedule after insert on public.vendor_invoice
for each row execute function public.create_default_payment_schedule();

create or replace function public.sync_invoice_to_financial_entry()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status in ('approved', 'scheduled', 'paid') then
    insert into public.property_monthly_financial_entry (
      property_id, account_id, accounting_month, amount, entry_date, description,
      counterparty_name, notes, source_system, source_record_id
    )
    select new.property_id, new.account_id, new.accounting_month, new.gross_amount,
      new.invoice_date, coalesce(new.invoice_number, '請求書'), vendor.vendor_name,
      new.notes, 'vendor_invoice', new.vendor_invoice_id
    from public.vendor_master as vendor where vendor.vendor_id = new.vendor_id
    on conflict (source_system, source_record_id)
      where source_system is not null and source_record_id is not null
    do update set
      property_id = excluded.property_id,
      account_id = excluded.account_id,
      accounting_month = excluded.accounting_month,
      amount = excluded.amount,
      entry_date = excluded.entry_date,
      description = excluded.description,
      counterparty_name = excluded.counterparty_name,
      notes = excluded.notes;
  else
    delete from public.property_monthly_financial_entry
     where source_system = 'vendor_invoice' and source_record_id = new.vendor_invoice_id;
  end if;
  return new;
end;
$$;

create trigger sync_invoice_to_financial_entry after insert or update on public.vendor_invoice
for each row execute function public.sync_invoice_to_financial_entry();

create or replace function public.register_vendor_invoice(
  p_property_id uuid,
  p_account_id varchar,
  p_vendor_id uuid,
  p_invoice_number varchar,
  p_billone_invoice_id varchar,
  p_invoice_date date,
  p_due_date date,
  p_accounting_month date,
  p_subtotal_amount numeric,
  p_tax_amount numeric,
  p_procurement_order_id uuid default null,
  p_notes text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  invoice_id uuid;
  total_amount numeric := p_subtotal_amount + p_tax_amount;
begin
  insert into public.vendor_invoice (
    property_id, account_id, vendor_id, invoice_number, billone_invoice_id,
    invoice_date, due_date, accounting_month, subtotal_amount, tax_amount, gross_amount, notes
  ) values (
    p_property_id, p_account_id, p_vendor_id, nullif(trim(p_invoice_number), ''), nullif(trim(p_billone_invoice_id), ''),
    p_invoice_date, p_due_date, p_accounting_month, p_subtotal_amount, p_tax_amount, total_amount, p_notes
  ) returning vendor_invoice_id into invoice_id;
  if p_procurement_order_id is not null then
    insert into public.vendor_invoice_order_allocation (vendor_invoice_id, procurement_order_id, allocated_amount)
    values (invoice_id, p_procurement_order_id, total_amount);
    update public.vendor_invoice set status = 'matched' where vendor_invoice_id = invoice_id;
  end if;
  return invoice_id;
end;
$$;

create or replace function public.set_vendor_invoice_status(
  p_vendor_invoice_id uuid,
  p_status varchar,
  p_paid_date date default null,
  p_payment_reference varchar default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_status not in ('received', 'matched', 'approved', 'scheduled', 'paid', 'rejected') then
    raise exception '不正な請求書ステータスです';
  end if;
  update public.vendor_invoice
     set status = p_status,
         approved_at = case when p_status in ('approved', 'scheduled', 'paid') then coalesce(approved_at, now()) else approved_at end,
         approved_by = case when p_status in ('approved', 'scheduled', 'paid') then coalesce(approved_by, auth.uid()) else approved_by end
   where vendor_invoice_id = p_vendor_invoice_id;
  if not found then raise exception '請求書が見つからないか、更新権限がありません'; end if;
  update public.payment_schedule
     set status = case when p_status = 'paid' then 'paid' when p_status = 'scheduled' then 'scheduled' else status end,
         paid_date = case when p_status = 'paid' then coalesce(p_paid_date, current_date) else paid_date end,
         payment_reference = coalesce(p_payment_reference, payment_reference)
   where vendor_invoice_id = p_vendor_invoice_id;
end;
$$;

create view public.procure_to_pay_overview
with (security_invoker = true)
as
select
  orders.procurement_order_id, orders.order_number, orders.property_id, asset.asset_name,
  orders.account_id, account.account_name, orders.vendor_id, vendor.vendor_name,
  orders.order_type, orders.title, orders.gross_amount as ordered_amount, orders.order_date,
  orders.expected_payment_date, orders.status,
  coalesce(allocation.invoiced_amount, 0)::numeric(14, 0) as invoiced_amount,
  greatest(orders.gross_amount - coalesce(allocation.invoiced_amount, 0), 0)::numeric(14, 0) as uninvoiced_amount,
  coalesce(allocation.paid_amount, 0)::numeric(14, 0) as paid_amount,
  allocation.next_payment_date, orders.appsuite_ringi_number, orders.updated_at
from public.procurement_order as orders
join public.asset_master as asset on asset.asset_id = orders.property_id
join public.income_expense_account_master as account on account.account_id = orders.account_id
join public.vendor_master as vendor on vendor.vendor_id = orders.vendor_id
left join lateral (
  select
    sum(link.allocated_amount) as invoiced_amount,
    sum(link.allocated_amount) filter (where invoice.status = 'paid') as paid_amount,
    min(payment.scheduled_date) filter (where payment.status not in ('paid', 'cancelled')) as next_payment_date
  from public.vendor_invoice_order_allocation as link
  join public.vendor_invoice as invoice on invoice.vendor_invoice_id = link.vendor_invoice_id
  left join public.payment_schedule as payment on payment.vendor_invoice_id = invoice.vendor_invoice_id
  where link.procurement_order_id = orders.procurement_order_id
) as allocation on true;

create view public.payable_cashflow
with (security_invoker = true)
as
select
  payment.payment_schedule_id, payment.vendor_invoice_id, invoice.property_id, asset.asset_name,
  invoice.account_id, account.account_name, invoice.vendor_id, vendor.vendor_name,
  invoice.invoice_number, invoice.billone_invoice_id, invoice.invoice_date, invoice.due_date,
  payment.scheduled_date, payment.amount, payment.status, payment.paid_date, payment.payment_reference
from public.payment_schedule as payment
join public.vendor_invoice as invoice on invoice.vendor_invoice_id = payment.vendor_invoice_id
join public.asset_master as asset on asset.asset_id = invoice.property_id
join public.income_expense_account_master as account on account.account_id = invoice.account_id
join public.vendor_master as vendor on vendor.vendor_id = invoice.vendor_id;

alter table public.vendor_master enable row level security;
alter table public.procurement_order enable row level security;
alter table public.vendor_invoice enable row level security;
alter table public.vendor_invoice_order_allocation enable row level security;
alter table public.payment_schedule enable row level security;

grant select, insert, update, delete on public.vendor_master, public.procurement_order,
  public.vendor_invoice, public.vendor_invoice_order_allocation, public.payment_schedule to authenticated;
grant select on public.procure_to_pay_overview, public.payable_cashflow to authenticated;
revoke all on function public.register_vendor_invoice(uuid, varchar, uuid, varchar, varchar, date, date, date, numeric, numeric, uuid, text) from public;
revoke all on function public.set_vendor_invoice_status(uuid, varchar, date, varchar) from public;
grant execute on function public.register_vendor_invoice(uuid, varchar, uuid, varchar, varchar, date, date, date, numeric, numeric, uuid, text) to authenticated;
grant execute on function public.set_vendor_invoice_status(uuid, varchar, date, varchar) to authenticated;

create policy "active users read vendors" on public.vendor_master for select to authenticated
using ((select public.current_account_is_active()));
create policy "managers insert vendors" on public.vendor_master for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers update vendors" on public.vendor_master for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers delete vendors" on public.vendor_master for delete to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));

create policy "active users read procurement orders" on public.procurement_order for select to authenticated
using ((select public.current_account_is_active()));
create policy "staff insert procurement orders" on public.procurement_order for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "staff update procurement orders" on public.procurement_order for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "staff delete procurement orders" on public.procurement_order for delete to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));

create policy "active users read vendor invoices" on public.vendor_invoice for select to authenticated
using ((select public.current_account_is_active()));
create policy "staff insert vendor invoices" on public.vendor_invoice for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "staff update vendor invoices" on public.vendor_invoice for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "staff delete vendor invoices" on public.vendor_invoice for delete to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));

create policy "active users read invoice allocations" on public.vendor_invoice_order_allocation for select to authenticated
using ((select public.current_account_is_active()));
create policy "staff insert invoice allocations" on public.vendor_invoice_order_allocation for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "staff update invoice allocations" on public.vendor_invoice_order_allocation for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "staff delete invoice allocations" on public.vendor_invoice_order_allocation for delete to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));

create policy "active users read payment schedules" on public.payment_schedule for select to authenticated
using ((select public.current_account_is_active()));
create policy "staff insert payment schedules" on public.payment_schedule for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "staff update payment schedules" on public.payment_schedule for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "staff delete payment schedules" on public.payment_schedule for delete to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));

comment on table public.vendor_master is '発注・請求・支払で共通利用する取引先マスタ。Bill Oneの取引先識別子を保持する。';
comment on table public.procurement_order is '修繕費・仲介料等の発注とAppSuite稟議の対応を管理する。';
comment on table public.vendor_invoice is 'Bill One等で受領した請求書の照合・承認状態を管理する。';
comment on table public.payment_schedule is '請求書ごとの支払予定と支払実績を管理し、資金繰りの根拠とする。';
