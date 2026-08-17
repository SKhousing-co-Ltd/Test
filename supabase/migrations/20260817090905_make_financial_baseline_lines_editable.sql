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
