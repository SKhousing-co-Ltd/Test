create or replace function public.preview_financial_baseline(
  p_base_fiscal_year integer,
  p_forecast_years integer
)
returns table (
  fiscal_year integer,
  property_count bigint,
  contract_income numeric,
  recurring_income numeric,
  recurring_expense numeric,
  lcc_planned_expense numeric,
  committed_order_expense numeric,
  scheduled_payment_expense numeric,
  projected_income numeric,
  projected_expense numeric,
  projected_net_cashflow numeric
)
language plpgsql
security invoker
stable
set search_path = public
as $$
declare
  period_start date;
  period_end date;
begin
  if not public.current_account_is_active() then
    raise exception '有効なアカウントが必要です';
  end if;
  if p_base_fiscal_year not between 2000 and 2200 then
    raise exception '開始年度は2000年から2200年の範囲で指定してください';
  end if;
  if p_forecast_years not between 1 and 20 then
    raise exception '予測年数は1年から20年の範囲で指定してください';
  end if;

  period_start := make_date(p_base_fiscal_year, 4, 1);
  period_end := (period_start + make_interval(years => p_forecast_years))::date;

  return query
  with fiscal_years as (
    select value as fiscal_year
    from generate_series(p_base_fiscal_year, p_base_fiscal_year + p_forecast_years - 1) as value
  ),
  operational as (
    select
      (extract(year from detail.accounting_month)::integer
        - case when extract(month from detail.accounting_month) < 4 then 1 else 0 end) as fiscal_year,
      coalesce(sum(detail.amount) filter (
        where detail.income_expense_type = '収入'
          and detail.source_type in ('契約賃料', '契約共益費')
      ), 0)::numeric as contract_income,
      coalesce(sum(detail.amount) filter (
        where detail.income_expense_type = '収入'
          and detail.source_type = '定期収支'
      ), 0)::numeric as recurring_income,
      coalesce(sum(detail.amount) filter (
        where detail.income_expense_type = '支出'
          and detail.source_type = '定期収支'
      ), 0)::numeric as recurring_expense
    from public.property_monthly_income_expense_detail as detail
    where detail.accounting_month >= period_start
      and detail.accounting_month < period_end
    group by 1
  ),
  lcc as (
    select
      (extract(year from occurrence.accounting_month)::integer
        - case when extract(month from occurrence.accounting_month) < 4 then 1 else 0 end) as fiscal_year,
      coalesce(sum(occurrence.planned_amount) filter (
        where occurrence.procurement_order_id is null
      ), 0)::numeric as uncommitted_lcc_expense,
      coalesce(sum(occurrence.planned_amount), 0)::numeric as lcc_planned_expense
    from public.lcc_plan_occurrence as occurrence
    where occurrence.accounting_month >= period_start
      and occurrence.accounting_month < period_end
    group by 1
  ),
  orders as (
    select
      (extract(year from coalesce(item.expected_payment_date, item.order_date))::integer
        - case when extract(month from coalesce(item.expected_payment_date, item.order_date)) < 4 then 1 else 0 end) as fiscal_year,
      coalesce(sum(item.uninvoiced_amount), 0)::numeric as committed_order_expense
    from public.procure_to_pay_overview as item
    where item.status not in ('draft', 'pending_approval', 'completed', 'cancelled')
      and coalesce(item.expected_payment_date, item.order_date) >= period_start
      and coalesce(item.expected_payment_date, item.order_date) < period_end
      and item.uninvoiced_amount > 0
    group by 1
  ),
  payments as (
    select
      (extract(year from payment.scheduled_date)::integer
        - case when extract(month from payment.scheduled_date) < 4 then 1 else 0 end) as fiscal_year,
      coalesce(sum(payment.amount) filter (
        where payment.status not in ('paid', 'cancelled')
      ), 0)::numeric as scheduled_payment_expense
    from public.payable_cashflow as payment
    where payment.scheduled_date >= period_start
      and payment.scheduled_date < period_end
    group by 1
  ),
  totals as (
    select
      years.fiscal_year,
      (select count(*) from public.asset_master)::bigint as property_count,
      coalesce(operational.contract_income, 0)::numeric as contract_income,
      coalesce(operational.recurring_income, 0)::numeric as recurring_income,
      coalesce(operational.recurring_expense, 0)::numeric as recurring_expense,
      coalesce(lcc.lcc_planned_expense, 0)::numeric as lcc_planned_expense,
      coalesce(lcc.uncommitted_lcc_expense, 0)::numeric as uncommitted_lcc_expense,
      coalesce(orders.committed_order_expense, 0)::numeric as committed_order_expense,
      coalesce(payments.scheduled_payment_expense, 0)::numeric as scheduled_payment_expense
    from fiscal_years as years
    left join operational using (fiscal_year)
    left join lcc using (fiscal_year)
    left join orders using (fiscal_year)
    left join payments using (fiscal_year)
  )
  select
    totals.fiscal_year,
    totals.property_count,
    totals.contract_income,
    totals.recurring_income,
    totals.recurring_expense,
    totals.lcc_planned_expense,
    totals.committed_order_expense,
    totals.scheduled_payment_expense,
    (totals.contract_income + totals.recurring_income)::numeric as projected_income,
    (
      totals.recurring_expense
      + totals.uncommitted_lcc_expense
      + totals.committed_order_expense
      + totals.scheduled_payment_expense
    )::numeric as projected_expense,
    (
      totals.contract_income + totals.recurring_income
      - totals.recurring_expense
      - totals.uncommitted_lcc_expense
      - totals.committed_order_expense
      - totals.scheduled_payment_expense
    )::numeric as projected_net_cashflow
  from totals
  order by totals.fiscal_year;
end;
$$;

create or replace function public.create_financial_baseline_scenario(
  p_scenario_name varchar,
  p_base_fiscal_year integer,
  p_forecast_years integer,
  p_notes text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  period_start date;
  period_end date;
  new_scenario_id uuid;
  inserted_line_count integer;
  preview_snapshot jsonb;
begin
  if not public.current_account_is_active()
    or public.current_account_role() not in ('admin', 'manager') then
    raise exception '基準シナリオを作成する権限がありません';
  end if;
  if nullif(trim(p_scenario_name), '') is null then
    raise exception 'シナリオ名を入力してください';
  end if;
  if p_base_fiscal_year not between 2000 and 2200 then
    raise exception '開始年度は2000年から2200年の範囲で指定してください';
  end if;
  if p_forecast_years not between 1 and 20 then
    raise exception '予測年数は1年から20年の範囲で指定してください';
  end if;

  period_start := make_date(p_base_fiscal_year, 4, 1);
  period_end := (period_start + make_interval(years => p_forecast_years))::date;

  select coalesce(jsonb_agg(to_jsonb(preview) order by preview.fiscal_year), '[]'::jsonb)
    into preview_snapshot
    from public.preview_financial_baseline(p_base_fiscal_year, p_forecast_years) as preview;

  insert into public.financial_scenario (
    scenario_name,
    scenario_type,
    base_fiscal_year,
    forecast_years,
    status,
    assumptions,
    notes
  ) values (
    trim(p_scenario_name),
    'baseline',
    p_base_fiscal_year,
    p_forecast_years,
    'draft',
    jsonb_build_object(
      'generator', 'financial_baseline_v1',
      'generated_at', clock_timestamp(),
      'mode', 'editable_forecast_lines_with_live_commitments',
      'sources', jsonb_build_array('active_contracts', 'recurring_items', 'uncommitted_lcc', 'open_orders', 'scheduled_payments'),
      'preview', preview_snapshot
    ),
    nullif(trim(p_notes), '')
  )
  returning financial_scenario_id into new_scenario_id;

  with source_lines as (
    select
      detail.property_id,
      detail.account_id,
      detail.accounting_month,
      detail.amount
    from public.property_monthly_income_expense_detail as detail
    where detail.accounting_month >= period_start
      and detail.accounting_month < period_end
      and detail.source_type in ('契約賃料', '契約共益費', '定期収支')

    union all

    select
      occurrence.property_id,
      occurrence.account_id,
      occurrence.accounting_month,
      occurrence.planned_amount
    from public.lcc_plan_occurrence as occurrence
    where occurrence.accounting_month >= period_start
      and occurrence.accounting_month < period_end
      and occurrence.procurement_order_id is null
  ),
  grouped_lines as (
    select
      source.property_id,
      source.account_id,
      source.accounting_month,
      sum(source.amount)::numeric(14, 0) as amount
    from source_lines as source
    group by source.property_id, source.account_id, source.accounting_month
    having sum(source.amount) > 0
  )
  insert into public.financial_scenario_line (
    financial_scenario_id,
    property_id,
    account_id,
    accounting_month,
    amount,
    line_type,
    description
  )
  select
    new_scenario_id,
    line.property_id,
    line.account_id,
    line.accounting_month,
    line.amount,
    'budget',
    '契約・定期収支・未発注LCCから自動生成'
  from grouped_lines as line;

  get diagnostics inserted_line_count = row_count;

  return jsonb_build_object(
    'financial_scenario_id', new_scenario_id,
    'status', 'draft',
    'generated_line_count', inserted_line_count,
    'preview', preview_snapshot
  );
end;
$$;

create or replace function public.publish_financial_scenario(
  p_financial_scenario_id uuid
)
returns public.financial_scenario
language plpgsql
security invoker
set search_path = public
as $$
declare
  published_scenario public.financial_scenario;
begin
  if not public.current_account_is_active()
    or public.current_account_role() not in ('admin', 'manager') then
    raise exception 'シナリオを公開する権限がありません';
  end if;

  update public.financial_scenario
     set status = 'published'
   where financial_scenario_id = p_financial_scenario_id
     and status = 'draft'
  returning * into published_scenario;

  if published_scenario.financial_scenario_id is null then
    raise exception '公開可能な下書きシナリオが見つかりません';
  end if;

  return published_scenario;
end;
$$;

revoke all on function public.preview_financial_baseline(integer, integer) from public, anon;
revoke all on function public.create_financial_baseline_scenario(varchar, integer, integer, text) from public, anon;
revoke all on function public.publish_financial_scenario(uuid) from public, anon;

grant execute on function public.preview_financial_baseline(integer, integer) to authenticated;
grant execute on function public.create_financial_baseline_scenario(varchar, integer, integer, text) to authenticated;
grant execute on function public.publish_financial_scenario(uuid) to authenticated;

comment on function public.preview_financial_baseline(integer, integer) is
  '契約・定期収支・LCC・発注残・支払予定から年度別の基準見通しを変更なしで試算する。';
comment on function public.create_financial_baseline_scenario(varchar, integer, integer, text) is
  '試算済みの運用データから編集可能な予測明細を持つ下書き基準シナリオを作成する。';
comment on function public.publish_financial_scenario(uuid) is
  '管理者またはマネージャーが確認済みの下書きシナリオを公開する。';
