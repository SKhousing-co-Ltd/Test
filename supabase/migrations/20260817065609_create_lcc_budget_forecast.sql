-- LCC、年度予算、予測シナリオ、実績、発注・支払予定を月次の物件軸で統合する。

create table public.lcc_plan_item (
  lcc_plan_item_id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.asset_master (asset_id) on delete cascade,
  account_id varchar(10) not null references public.income_expense_account_master (account_id) on delete restrict,
  procurement_order_id uuid references public.procurement_order (procurement_order_id) on delete set null,
  component_category varchar(30) not null check (component_category in (
    'structure', 'exterior', 'hvac', 'electrical', 'plumbing', 'elevator',
    'fire_safety', 'interior', 'site', 'other'
  )),
  work_name varchar(300) not null,
  description text,
  cycle_years integer check (cycle_years is null or cycle_years between 1 and 100),
  last_completed_date date,
  next_planned_date date not null,
  planned_amount numeric(14, 0) not null check (planned_amount > 0),
  priority varchar(20) not null default 'medium'
    check (priority in ('low', 'medium', 'high', 'critical')),
  status varchar(20) not null default 'planned'
    check (status in ('planned', 'approved', 'ordered', 'completed', 'deferred', 'cancelled')),
  completed_date date,
  actual_amount numeric(14, 0) check (actual_amount is null or actual_amount >= 0),
  notes text,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  updated_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_lcc_plan_completion check (
    (status = 'completed' and completed_date is not null)
    or (status <> 'completed' and completed_date is null)
  )
);

create table public.financial_scenario (
  financial_scenario_id uuid primary key default gen_random_uuid(),
  scenario_name varchar(200) not null,
  scenario_type varchar(20) not null default 'baseline'
    check (scenario_type in ('baseline', 'upside', 'downside', 'custom')),
  base_fiscal_year integer not null check (base_fiscal_year between 2000 and 2200),
  forecast_years integer not null default 5 check (forecast_years between 1 and 20),
  status varchar(20) not null default 'draft'
    check (status in ('draft', 'published', 'archived')),
  assumptions jsonb not null default '{}'::jsonb,
  notes text,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  updated_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scenario_name, base_fiscal_year)
);

create table public.financial_scenario_line (
  financial_scenario_line_id uuid primary key default gen_random_uuid(),
  financial_scenario_id uuid not null references public.financial_scenario (financial_scenario_id) on delete cascade,
  property_id uuid not null references public.asset_master (asset_id) on delete cascade,
  account_id varchar(10) not null references public.income_expense_account_master (account_id) on delete restrict,
  accounting_month date not null,
  amount numeric(14, 0) not null check (amount >= 0),
  line_type varchar(20) not null default 'budget'
    check (line_type in ('budget', 'forecast', 'adjustment')),
  description varchar(500),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  updated_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_financial_scenario_line_month check (accounting_month = date_trunc('month', accounting_month)::date),
  unique (financial_scenario_id, property_id, account_id, accounting_month, line_type)
);

create index ix_lcc_plan_item_property_date on public.lcc_plan_item (property_id, next_planned_date)
  where status not in ('completed', 'cancelled');
create index ix_lcc_plan_item_account on public.lcc_plan_item (account_id);
create index ix_lcc_plan_item_order on public.lcc_plan_item (procurement_order_id) where procurement_order_id is not null;
create index ix_lcc_plan_item_created_by on public.lcc_plan_item (created_by) where created_by is not null;
create index ix_lcc_plan_item_updated_by on public.lcc_plan_item (updated_by) where updated_by is not null;
create index ix_financial_scenario_created_by on public.financial_scenario (created_by) where created_by is not null;
create index ix_financial_scenario_updated_by on public.financial_scenario (updated_by) where updated_by is not null;
create index ix_financial_scenario_line_property_month on public.financial_scenario_line (property_id, accounting_month);
create index ix_financial_scenario_line_account on public.financial_scenario_line (account_id);
create index ix_financial_scenario_line_created_by on public.financial_scenario_line (created_by) where created_by is not null;
create index ix_financial_scenario_line_updated_by on public.financial_scenario_line (updated_by) where updated_by is not null;

create or replace function public.set_financial_planning_updated_fields()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end;
$$;

create trigger set_lcc_plan_item_updated_fields before update on public.lcc_plan_item
for each row execute function public.set_financial_planning_updated_fields();
create trigger set_financial_scenario_updated_fields before update on public.financial_scenario
for each row execute function public.set_financial_planning_updated_fields();
create trigger set_financial_scenario_line_updated_fields before update on public.financial_scenario_line
for each row execute function public.set_financial_planning_updated_fields();

create or replace function public.validate_financial_scenario_line_month()
returns trigger language plpgsql set search_path = public as $$
declare
  scenario_start date;
  scenario_end date;
begin
  select make_date(base_fiscal_year, 4, 1),
         (make_date(base_fiscal_year, 4, 1) + make_interval(years => forecast_years))::date - 1
    into scenario_start, scenario_end
    from public.financial_scenario
   where financial_scenario_id = new.financial_scenario_id;
  if new.accounting_month < scenario_start or new.accounting_month > scenario_end then
    raise exception '予算・予測月がシナリオ期間外です';
  end if;
  return new;
end;
$$;

create trigger validate_financial_scenario_line_month
before insert or update on public.financial_scenario_line
for each row execute function public.validate_financial_scenario_line_month();

create or replace function public.create_financial_scenario(
  p_scenario_name varchar,
  p_scenario_type varchar,
  p_base_fiscal_year integer,
  p_forecast_years integer,
  p_copy_from uuid default null,
  p_notes text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  new_scenario_id uuid;
begin
  insert into public.financial_scenario (
    scenario_name, scenario_type, base_fiscal_year, forecast_years, notes
  ) values (
    trim(p_scenario_name), p_scenario_type, p_base_fiscal_year, p_forecast_years, p_notes
  ) returning financial_scenario_id into new_scenario_id;

  if p_copy_from is not null then
    insert into public.financial_scenario_line (
      financial_scenario_id, property_id, account_id, accounting_month,
      amount, line_type, description
    )
    select new_scenario_id, property_id, account_id, accounting_month,
      amount, line_type, description
    from public.financial_scenario_line
    where financial_scenario_id = p_copy_from
      and accounting_month >= make_date(p_base_fiscal_year, 4, 1)
      and accounting_month < make_date(p_base_fiscal_year, 4, 1) + make_interval(years => p_forecast_years);
  end if;

  return new_scenario_id;
end;
$$;

create view public.lcc_plan_occurrence
with (security_invoker = true)
as
select
  item.lcc_plan_item_id,
  item.property_id,
  item.account_id,
  item.procurement_order_id,
  item.component_category,
  item.work_name,
  item.priority,
  item.status,
  occurrence_date::date as planned_date,
  date_trunc('month', occurrence_date)::date as accounting_month,
  item.planned_amount,
  item.cycle_years
from public.lcc_plan_item as item
cross join lateral generate_series(
  item.next_planned_date::timestamp,
  (current_date + interval '20 years')::timestamp,
  make_interval(years => coalesce(item.cycle_years, 100))
) as occurrence_date
where item.status not in ('completed', 'cancelled');

create view public.property_financial_scenario_monthly
with (security_invoker = true)
as
with scenario_months as (
  select
    scenario.financial_scenario_id,
    scenario.scenario_name,
    scenario.scenario_type,
    scenario.status as scenario_status,
    asset.asset_id as property_id,
    month_start::date as accounting_month
  from public.financial_scenario as scenario
  cross join public.asset_master as asset
  cross join lateral generate_series(
    make_date(scenario.base_fiscal_year, 4, 1)::timestamp,
    (make_date(scenario.base_fiscal_year, 4, 1) + make_interval(years => scenario.forecast_years) - interval '1 month')::timestamp,
    interval '1 month'
  ) as month_start
  where scenario.status <> 'archived'
), operational as (
  select
    detail.property_id,
    detail.accounting_month,
    coalesce(sum(detail.amount) filter (
      where detail.income_expense_type = '収入' and detail.source_type in ('契約賃料', '契約共益費')
    ), 0)::numeric(14, 0) as contract_income,
    coalesce(sum(detail.amount) filter (
      where detail.income_expense_type = '支出' and detail.source_type = '定期収支'
    ), 0)::numeric(14, 0) as recurring_expense,
    coalesce(sum(detail.amount) filter (
      where detail.income_expense_type = '収入' and detail.source_type = '月次明細'
    ), 0)::numeric(14, 0) as actual_income,
    coalesce(sum(detail.amount) filter (
      where detail.income_expense_type = '支出' and detail.source_type = '月次明細'
    ), 0)::numeric(14, 0) as actual_expense
  from public.property_monthly_income_expense_detail as detail
  group by detail.property_id, detail.accounting_month
), scenario_budget as (
  select
    line.financial_scenario_id,
    line.property_id,
    line.accounting_month,
    coalesce(sum(line.amount) filter (where account.income_expense_type = '収入'), 0)::numeric(14, 0) as budget_income,
    coalesce(sum(line.amount) filter (where account.income_expense_type = '支出'), 0)::numeric(14, 0) as budget_expense
  from public.financial_scenario_line as line
  join public.income_expense_account_master as account on account.account_id = line.account_id
  group by line.financial_scenario_id, line.property_id, line.accounting_month
), lcc as (
  select
    occurrence.property_id,
    occurrence.accounting_month,
    coalesce(sum(occurrence.planned_amount) filter (where occurrence.procurement_order_id is null), 0)::numeric(14, 0) as uncommitted_lcc_expense,
    coalesce(sum(occurrence.planned_amount), 0)::numeric(14, 0) as total_lcc_expense
  from public.lcc_plan_occurrence as occurrence
  group by occurrence.property_id, occurrence.accounting_month
), open_orders as (
  select
    orders.property_id,
    date_trunc('month', coalesce(orders.expected_payment_date, orders.order_date))::date as accounting_month,
    coalesce(sum(orders.uninvoiced_amount), 0)::numeric(14, 0) as committed_order_expense
  from public.procure_to_pay_overview as orders
  where orders.status not in ('draft', 'pending_approval', 'completed', 'cancelled')
    and coalesce(orders.expected_payment_date, orders.order_date) is not null
    and orders.uninvoiced_amount > 0
  group by orders.property_id, date_trunc('month', coalesce(orders.expected_payment_date, orders.order_date))::date
), payments as (
  select
    payment.property_id,
    date_trunc('month', payment.scheduled_date)::date as accounting_month,
    coalesce(sum(payment.amount) filter (where payment.status not in ('paid', 'cancelled')), 0)::numeric(14, 0) as scheduled_payment_expense,
    coalesce(sum(payment.amount) filter (where payment.status = 'paid'), 0)::numeric(14, 0) as paid_cash_expense
  from public.payable_cashflow as payment
  group by payment.property_id, date_trunc('month', payment.scheduled_date)::date
)
select
  months.financial_scenario_id,
  months.scenario_name,
  months.scenario_type,
  months.scenario_status,
  months.property_id,
  months.accounting_month,
  coalesce(operational.contract_income, 0)::numeric(14, 0) as contract_income,
  coalesce(operational.recurring_expense, 0)::numeric(14, 0) as recurring_expense,
  coalesce(operational.actual_income, 0)::numeric(14, 0) as actual_income,
  coalesce(operational.actual_expense, 0)::numeric(14, 0) as actual_expense,
  coalesce(budget.budget_income, 0)::numeric(14, 0) as budget_income,
  coalesce(budget.budget_expense, 0)::numeric(14, 0) as budget_expense,
  coalesce(lcc.total_lcc_expense, 0)::numeric(14, 0) as lcc_planned_expense,
  coalesce(orders.committed_order_expense, 0)::numeric(14, 0) as committed_order_expense,
  coalesce(payments.scheduled_payment_expense, 0)::numeric(14, 0) as scheduled_payment_expense,
  coalesce(payments.paid_cash_expense, 0)::numeric(14, 0) as paid_cash_expense,
  greatest(coalesce(operational.contract_income, 0), coalesce(budget.budget_income, 0))::numeric(14, 0) as projected_income,
  greatest(
    coalesce(budget.budget_expense, 0),
    coalesce(operational.recurring_expense, 0)
      + coalesce(lcc.uncommitted_lcc_expense, 0)
      + coalesce(orders.committed_order_expense, 0)
      + coalesce(payments.scheduled_payment_expense, 0)
  )::numeric(14, 0) as projected_expense,
  (
    greatest(coalesce(operational.contract_income, 0), coalesce(budget.budget_income, 0))
    - greatest(
        coalesce(budget.budget_expense, 0),
        coalesce(operational.recurring_expense, 0)
          + coalesce(lcc.uncommitted_lcc_expense, 0)
          + coalesce(orders.committed_order_expense, 0)
          + coalesce(payments.scheduled_payment_expense, 0)
      )
  )::numeric(14, 0) as projected_net_cashflow
from scenario_months as months
left join operational on operational.property_id = months.property_id and operational.accounting_month = months.accounting_month
left join scenario_budget as budget on budget.financial_scenario_id = months.financial_scenario_id
  and budget.property_id = months.property_id and budget.accounting_month = months.accounting_month
left join lcc on lcc.property_id = months.property_id and lcc.accounting_month = months.accounting_month
left join open_orders as orders on orders.property_id = months.property_id and orders.accounting_month = months.accounting_month
left join payments on payments.property_id = months.property_id and payments.accounting_month = months.accounting_month;

alter table public.lcc_plan_item enable row level security;
alter table public.financial_scenario enable row level security;
alter table public.financial_scenario_line enable row level security;

grant select, insert, update, delete on public.lcc_plan_item, public.financial_scenario,
  public.financial_scenario_line to authenticated;
grant select on public.lcc_plan_occurrence, public.property_financial_scenario_monthly to authenticated;
revoke all on function public.create_financial_scenario(varchar, varchar, integer, integer, uuid, text) from public;
grant execute on function public.create_financial_scenario(varchar, varchar, integer, integer, uuid, text) to authenticated;

create policy "active users read lcc plans" on public.lcc_plan_item for select to authenticated
using ((select public.current_account_is_active()));
create policy "staff insert lcc plans" on public.lcc_plan_item for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "staff update lcc plans" on public.lcc_plan_item for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "managers delete lcc plans" on public.lcc_plan_item for delete to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));

create policy "active users read financial scenarios" on public.financial_scenario for select to authenticated
using ((select public.current_account_is_active()));
create policy "managers insert financial scenarios" on public.financial_scenario for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers update financial scenarios" on public.financial_scenario for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers delete financial scenarios" on public.financial_scenario for delete to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));

create policy "active users read financial scenario lines" on public.financial_scenario_line for select to authenticated
using ((select public.current_account_is_active()));
create policy "staff insert financial scenario lines" on public.financial_scenario_line for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "staff update financial scenario lines" on public.financial_scenario_line for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager', 'staff'));
create policy "managers delete financial scenario lines" on public.financial_scenario_line for delete to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));

comment on table public.lcc_plan_item is '物件設備ごとの長期修繕計画。周期から将来発生月を展開し、発注実績とも紐づける。';
comment on table public.financial_scenario is '基準・強気・弱気等の年度予算／将来予測シナリオ。';
comment on table public.financial_scenario_line is 'シナリオごとの物件・科目・月別予算／予測値。';
comment on view public.property_financial_scenario_monthly is '契約収入、定期費、実績、予算、LCC、発注残、支払予定を統合した月次予測。';
