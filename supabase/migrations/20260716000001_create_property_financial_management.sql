-- ビル別収支管理
-- 前提: public.income_expense_account_master（収支科目マスタ）が適用済みであること。

create extension if not exists pgcrypto;

create table if not exists public.property_recurring_financial_item (
  recurring_item_id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.property_master (property_id) on delete cascade,
  account_id varchar(10) not null references public.income_expense_account_master (account_id) on delete restrict,
  item_name varchar(200) not null,
  monthly_amount numeric(14, 0) not null,
  effective_from_month date not null,
  effective_to_month date,
  counterparty_name varchar(200),
  notes text,
  is_active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  updated_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_property_recurring_financial_item_amount_positive check (monthly_amount > 0),
  constraint ck_property_recurring_financial_item_from_month check (effective_from_month = date_trunc('month', effective_from_month)::date),
  constraint ck_property_recurring_financial_item_to_month check (effective_to_month is null or effective_to_month = date_trunc('month', effective_to_month)::date),
  constraint ck_property_recurring_financial_item_term check (effective_to_month is null or effective_to_month >= effective_from_month)
);

create table if not exists public.property_monthly_financial_entry (
  financial_entry_id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.property_master (property_id) on delete cascade,
  account_id varchar(10) not null references public.income_expense_account_master (account_id) on delete restrict,
  accounting_month date not null,
  amount numeric(14, 0) not null,
  entry_date date,
  description varchar(500) not null,
  counterparty_name varchar(200),
  notes text,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  updated_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_property_monthly_financial_entry_amount_positive check (amount > 0),
  constraint ck_property_monthly_financial_entry_month check (accounting_month = date_trunc('month', accounting_month)::date)
);

create index if not exists ix_property_recurring_financial_item_property_term
  on public.property_recurring_financial_item (property_id, effective_from_month, effective_to_month)
  where is_active;
create index if not exists ix_property_monthly_financial_entry_property_month
  on public.property_monthly_financial_entry (property_id, accounting_month);
create index if not exists ix_property_monthly_financial_entry_account_month
  on public.property_monthly_financial_entry (account_id, accounting_month);

create or replace function public.set_property_financial_updated_fields()
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

drop trigger if exists set_property_recurring_financial_item_updated_fields on public.property_recurring_financial_item;
create trigger set_property_recurring_financial_item_updated_fields
before update on public.property_recurring_financial_item
for each row execute procedure public.set_property_financial_updated_fields();

drop trigger if exists set_property_monthly_financial_entry_updated_fields on public.property_monthly_financial_entry;
create trigger set_property_monthly_financial_entry_updated_fields
before update on public.property_monthly_financial_entry
for each row execute procedure public.set_property_financial_updated_fields();

-- 明細ビューはダッシュボードの根拠表示にも使用する。
create or replace view public.property_monthly_income_expense_detail
with (security_invoker = true)
as
with contract_months as (
  select
    unit.property_id,
    month_start::date as accounting_month,
    case line.kind when 'rent' then 'M01' else 'M02' end::varchar(10) as account_id,
    case line.kind when 'rent' then coalesce(contract_unit.monthly_rent_amount, 0) else coalesce(contract_unit.monthly_common_charge_amount, 0) end::numeric(14, 0) as amount,
    case line.kind when 'rent' then '契約賃料' else '契約共益費' end::varchar(30) as source_type,
    contract.lease_contract_id::text as source_id,
    tenant.tenant_name as description,
    tenant.tenant_name as counterparty_name
  from public.lease_contract as contract
  join public.lease_contract_unit as contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
  join public.unit_master as unit on unit.unit_id = contract_unit.unit_id
  join public.tenant_master as tenant on tenant.tenant_id = contract.tenant_id
  cross join lateral (values ('rent'), ('common')) as line(kind)
  cross join lateral generate_series(
    date_trunc('month', coalesce(contract.contract_start_date, current_date))::date,
    date_trunc('month', least(coalesce(contract.contract_end_date, current_date + interval '10 years')::timestamp, current_date + interval '10 years'))::date,
    interval '1 month'
  ) as month_start
  where contract.contract_status = 'active'
    and (line.kind = 'rent' and coalesce(contract_unit.monthly_rent_amount, 0) > 0
      or line.kind = 'common' and coalesce(contract_unit.monthly_common_charge_amount, 0) > 0)
), recurring_items as (
  select
    item.property_id,
    month_start::date as accounting_month,
    item.account_id,
    item.monthly_amount as amount,
    '定期収支'::varchar(30) as source_type,
    item.recurring_item_id::text as source_id,
    item.item_name as description,
    item.counterparty_name
  from public.property_recurring_financial_item as item
  cross join lateral generate_series(
    item.effective_from_month,
    coalesce(item.effective_to_month, current_date + interval '10 years')::date,
    interval '1 month'
  ) as month_start
  where item.is_active
), monthly_entries as (
  select
    entry.property_id,
    entry.accounting_month,
    entry.account_id,
    entry.amount,
    '月次明細'::varchar(30) as source_type,
    entry.financial_entry_id::text as source_id,
    entry.description,
    entry.counterparty_name
  from public.property_monthly_financial_entry as entry
)
select detail.*, account.account_name, account.income_expense_type
from (
  select * from contract_months
  union all select * from recurring_items
  union all select * from monthly_entries
) as detail
join public.income_expense_account_master as account on account.account_id = detail.account_id;

create or replace view public.property_monthly_income_expense_summary
with (security_invoker = true)
as
select
  property_id,
  accounting_month,
  coalesce(sum(amount) filter (where income_expense_type = '収入' and source_type = '契約賃料'), 0)::numeric(14, 0) as contract_rent_income,
  coalesce(sum(amount) filter (where income_expense_type = '収入' and source_type = '契約共益費'), 0)::numeric(14, 0) as contract_common_charge_income,
  coalesce(sum(amount) filter (where income_expense_type = '収入' and source_type <> '契約賃料' and source_type <> '契約共益費'), 0)::numeric(14, 0) as other_income,
  coalesce(sum(amount) filter (where income_expense_type = '支出' and source_type = '定期収支'), 0)::numeric(14, 0) as recurring_expense,
  coalesce(sum(amount) filter (where income_expense_type = '支出' and source_type = '月次明細'), 0)::numeric(14, 0) as variable_expense,
  coalesce(sum(amount) filter (where income_expense_type = '収入'), 0)::numeric(14, 0) as income_total,
  coalesce(sum(amount) filter (where income_expense_type = '支出'), 0)::numeric(14, 0) as expense_total,
  coalesce(sum(amount) filter (where income_expense_type = '収入'), 0)::numeric(14, 0)
    - coalesce(sum(amount) filter (where income_expense_type = '支出'), 0)::numeric(14, 0) as balance
from public.property_monthly_income_expense_detail
group by property_id, accounting_month;

alter table public.property_recurring_financial_item enable row level security;
alter table public.property_monthly_financial_entry enable row level security;

grant select, insert, update, delete on public.property_recurring_financial_item, public.property_monthly_financial_entry to authenticated;
grant select on public.property_monthly_income_expense_detail, public.property_monthly_income_expense_summary to authenticated;
grant select on public.property_master to authenticated;

create policy "authenticated users can manage recurring financial items"
  on public.property_recurring_financial_item for all to authenticated using (true) with check (true);
create policy "authenticated users can manage monthly financial entries"
  on public.property_monthly_financial_entry for all to authenticated using (true) with check (true);
drop policy if exists "authenticated users can read properties" on public.property_master;
create policy "authenticated users can read properties"
  on public.property_master for select to authenticated using (true);

comment on table public.property_recurring_financial_item is '物件ごとの定期収入・準固定支出。金額改定時は新規行を追加して履歴を保持する。';
comment on table public.property_monthly_financial_entry is '物件ごとの月次収支実績明細。収入・支出の判定は収支科目マスタに従う。';
