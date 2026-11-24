-- Confirmed office contract requests create one deposit workflow per leased unit.
create table if not exists public.tenant_deposit_management (
  tenant_deposit_id uuid primary key default gen_random_uuid(),
  change_request_id uuid not null references public.change_request(change_request_id),
  lease_contract_unit_id uuid not null references public.lease_contract_unit(lease_contract_unit_id),
  amount numeric(14,0) not null check (amount > 0),
  payment_due_date date,
  due_date_answered_at timestamptz,
  due_date_answered_by uuid references auth.users(id),
  invoice_method text check (invoice_method in ('monthly', 'spot')),
  invoice_month date,
  invoice_record_id text,
  invoiced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (change_request_id, lease_contract_unit_id),
  check ((payment_due_date is null) = (due_date_answered_at is null)),
  check (invoice_method is null or payment_due_date is not null),
  check ((invoice_method is null) = (invoice_record_id is null)),
  check ((invoice_method is null) = (invoice_month is null)),
  check (invoiced_at is null or invoice_record_id is not null)
);

create index if not exists ix_tenant_deposit_management_due
  on public.tenant_deposit_management(payment_due_date, invoiced_at);

create or replace function public.guard_tenant_deposit_management_update()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.change_request_id is distinct from old.change_request_id
     or new.lease_contract_unit_id is distinct from old.lease_contract_unit_id
     or new.amount is distinct from old.amount then
    raise exception 'Deposit source and amount cannot be changed here';
  end if;
  if (new.payment_due_date is distinct from old.payment_due_date
      or new.due_date_answered_at is distinct from old.due_date_answered_at
      or new.due_date_answered_by is distinct from old.due_date_answered_by)
     and not (public.current_account_is_admin() or public.current_account_department_id() =
       (select department_id from public.department_master where department_name = '営業部')) then
    raise exception 'Only sales may answer the deposit due date';
  end if;
  if old.invoice_record_id is not null and new.payment_due_date is distinct from old.payment_due_date then
    raise exception 'Due date cannot change after the deposit is added to an invoice';
  end if;
  if (new.invoice_method is distinct from old.invoice_method
      or new.invoice_month is distinct from old.invoice_month
      or new.invoice_record_id is distinct from old.invoice_record_id
      or new.invoiced_at is distinct from old.invoiced_at)
     and not (public.current_account_is_admin() or public.current_account_is_accounting_department()) then
    raise exception 'Only accounting may update deposit invoicing';
  end if;
  return new;
end;
$$;

create trigger guard_tenant_deposit_management_update
  before update on public.tenant_deposit_management
  for each row execute function public.guard_tenant_deposit_management_update();

create or replace function public.enqueue_office_deposits_after_request()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.request_type <> 'contract_create' or new.status <> 'applied'
     or old.status = 'applied' then return new; end if;

  insert into public.tenant_deposit_management
    (change_request_id, lease_contract_unit_id, amount)
  select new.change_request_id, cu.lease_contract_unit_id, cu.deposit_amount
  from public.lease_contract_unit cu
  join public.unit_master u on u.unit_id = cu.unit_id and u.unit_type = 'office'
  where cu.deposit_amount > 0
    and cu.lease_contract_id = coalesce(
      new.lease_contract_id,
      (select link.lease_contract_id from public.workflow_contract_link link
       where link.appsuite_record_id = new.source_appsuite_record_id
         and link.confirmed_at is not null
       order by link.confirmed_at desc limit 1)
    )
  on conflict (change_request_id, lease_contract_unit_id) do nothing;
  return new;
end;
$$;

drop trigger if exists enqueue_office_deposits_after_request on public.change_request;
create trigger enqueue_office_deposits_after_request
  after update of status on public.change_request
  for each row execute function public.enqueue_office_deposits_after_request();

alter table public.tenant_deposit_management enable row level security;
grant select, update on public.tenant_deposit_management to authenticated;

create policy "active staff read deposit tasks" on public.tenant_deposit_management
  for select to authenticated using (public.current_account_is_active());

create policy "sales and accounting update deposit tasks" on public.tenant_deposit_management
  for update to authenticated
  using (public.current_account_is_admin() or public.current_account_department_id() in
    (select department_id from public.department_master where department_name in ('営業部', '総務経理部')))
  with check (public.current_account_is_admin() or public.current_account_department_id() in
    (select department_id from public.department_master where department_name in ('営業部', '総務経理部')));

create trigger set_tenant_deposit_management_updated_at
  before update on public.tenant_deposit_management
  for each row execute procedure public.set_updated_at();
