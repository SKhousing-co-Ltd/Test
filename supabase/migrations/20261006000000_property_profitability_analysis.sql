create table if not exists public.property_acquisition_plan (
  property_acquisition_plan_id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.asset_master(asset_id) on delete cascade,
  purchase_price numeric(16,0) not null default 0,
  acquisition_cost numeric(16,0) not null default 0,
  initial_capex numeric(16,0) not null default 0,
  inherited_deposit numeric(16,0) not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint uq_property_acquisition_plan_property unique(property_id),
  constraint ck_property_acquisition_plan_amounts check (purchase_price >= 0 and acquisition_cost >= 0 and initial_capex >= 0 and inherited_deposit >= 0)
);
create table if not exists public.property_acquisition_plan_year (
  property_acquisition_plan_year_id uuid primary key default gen_random_uuid(),
  property_acquisition_plan_id uuid not null references public.property_acquisition_plan(property_acquisition_plan_id) on delete cascade,
  fiscal_year integer not null, income numeric(16,0) not null default 0, opex numeric(16,0) not null default 0,
  noi numeric(16,0) generated always as (income - opex) stored, capex numeric(16,0) not null default 0,
  ncf numeric(16,0) generated always as (income - opex - capex) stored, interest numeric(16,0), principal numeric(16,0),
  constraint uq_property_acquisition_plan_year unique(property_acquisition_plan_id, fiscal_year),
  constraint ck_property_acquisition_plan_year_amounts check (income >= 0 and opex >= 0 and capex >= 0 and (interest is null or interest >= 0) and (principal is null or principal >= 0))
);
alter table public.property_monthly_financial_entry add column if not exists expense_classification varchar(10) not null default 'opex';
alter table public.property_monthly_financial_entry add column if not exists classification_review_status varchar(20) not null default 'unreviewed';
alter table public.property_monthly_financial_entry add column if not exists classification_reason text;
alter table public.property_monthly_financial_entry add column if not exists classified_by uuid references auth.users(id) on delete set null;
alter table public.property_monthly_financial_entry add column if not exists classified_at timestamptz;
alter table public.property_monthly_financial_entry add constraint ck_property_monthly_expense_classification check (expense_classification in ('opex','capex'));
alter table public.property_monthly_financial_entry add constraint ck_property_monthly_review_status check (classification_review_status in ('unreviewed','reviewed'));
create index if not exists ix_property_monthly_financial_entry_property_date on public.property_monthly_financial_entry(property_id, entry_date, accounting_month);
alter table public.property_acquisition_plan enable row level security;
alter table public.property_acquisition_plan_year enable row level security;
grant select on public.property_acquisition_plan, public.property_acquisition_plan_year to authenticated;
create policy "authenticated users can read acquisition plans" on public.property_acquisition_plan for select to authenticated using (true);
create policy "authenticated users can read acquisition plan years" on public.property_acquisition_plan_year for select to authenticated using (true);
create or replace function public.get_property_profitability_analysis(p_property_id uuid, p_reference_date date default current_date, p_granularity text default 'month') returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_property jsonb; v_plan jsonb; v_monthly jsonb; v_yearly jsonb;
begin
  select jsonb_build_object('property_id', asset_id, 'property_name', asset_name, 'short_name', short_name, 'acquisition_date', acquisition_date) into v_property from asset_master where asset_id = p_property_id;
  if v_property is null then return jsonb_build_object('status','not_found'); end if;
  select jsonb_build_object('purchase_price',purchase_price,'acquisition_cost',acquisition_cost,'initial_capex',initial_capex,'inherited_deposit',inherited_deposit,'total_investment',purchase_price+acquisition_cost+initial_capex-inherited_deposit) into v_plan from property_acquisition_plan where property_id=p_property_id;
  with v as (select d.accounting_month as accounting_month, sum(d.amount) filter(where d.account_id in ('M01','M02','M03')) income, sum(d.amount) filter(where d.account_id in ('M04','M05','M06','M07','M08') and coalesce(e.expense_classification,'opex')='opex') opex from property_monthly_income_expense_detail d left join property_monthly_financial_entry e on e.financial_entry_id=d.source_id::uuid where d.property_id=p_property_id and d.accounting_month <= date_trunc('month',p_reference_date)::date group by d.accounting_month)
  select coalesce(jsonb_agg(jsonb_build_object('month',accounting_month,'income',coalesce(income,0),'opex',coalesce(opex,0),'noi',coalesce(income,0)-coalesce(opex,0),'capex',0,'ncf',coalesce(income,0)-coalesce(opex,0),'after_debt_cf',null) order by accounting_month),'[]'::jsonb) into v_monthly from v;
  with a as (select extract(year from (accounting_month + interval '9 months'))::int fiscal_year, sum(income) income, sum(opex) opex from jsonb_to_recordset(v_monthly) x(accounting_month date,income numeric,opex numeric) group by 1), p as (select y.fiscal_year, jsonb_build_object('income',y.income,'opex',y.opex,'noi',y.noi,'capex',y.capex,'ncf',y.ncf,'interest',y.interest,'principal',y.principal) plan from property_acquisition_plan_year y join property_acquisition_plan h on h.property_acquisition_plan_id=y.property_acquisition_plan_id where h.property_id=p_property_id) select coalesce(jsonb_agg(jsonb_build_object('fiscal_year',coalesce(p.fiscal_year,a.fiscal_year),'plan',p.plan,'actual',jsonb_build_object('income',a.income,'opex',a.opex,'noi',a.income-a.opex,'capex',0,'ncf',a.income-a.opex,'interest',null,'principal',null)) order by coalesce(p.fiscal_year,a.fiscal_year)),'[]'::jsonb) into v_yearly from a full join p using(fiscal_year);
  return jsonb_build_object('status','ok','reference_date',p_reference_date,'property',v_property,'plan',v_plan,'monthly',v_monthly,'yearly',v_yearly,'capex_status','planned_for_future','after_tax_cf_status','planned_for_future','forecast_status','planned_for_future');
end; $$;
grant execute on function public.get_property_profitability_analysis(uuid,date,text) to authenticated;
