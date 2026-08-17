begin;

do $$
declare
  test_property_id uuid;
  scenario_id uuid;
  copied_scenario_id uuid;
  lcc_id uuid;
  april_row public.property_financial_scenario_monthly;
begin
  insert into public.asset_master (asset_code, asset_name)
  values (999904, 'LCC予測テスト物件')
  returning asset_id into test_property_id;

  select public.create_financial_scenario(
    'LCC予測テスト基準', 'baseline', 2027, 5, null, '自動テスト'
  ) into scenario_id;

  insert into public.financial_scenario_line (
    financial_scenario_id, property_id, account_id, accounting_month, amount, line_type, description
  ) values
    (scenario_id, test_property_id, 'M01', date '2027-04-01', 1000000, 'budget', '賃料予算'),
    (scenario_id, test_property_id, 'M08', date '2027-04-01', 200000, 'budget', '支出予算');

  insert into public.lcc_plan_item (
    property_id, account_id, component_category, work_name, cycle_years,
    next_planned_date, planned_amount, priority
  ) values (
    test_property_id, 'M08', 'hvac', '空調更新', 10,
    date '2027-04-15', 300000, 'high'
  ) returning lcc_plan_item_id into lcc_id;

  select * into april_row
  from public.property_financial_scenario_monthly
  where financial_scenario_id = scenario_id
    and property_id = test_property_id
    and accounting_month = date '2027-04-01';

  if april_row.budget_income <> 1000000 or april_row.budget_expense <> 200000 then
    raise exception '予算がシナリオ月次ビューへ反映されていません';
  end if;
  if april_row.lcc_planned_expense <> 300000 then
    raise exception 'LCC予定が月次予測へ反映されていません';
  end if;
  if april_row.projected_net_cashflow <> 700000 then
    raise exception '月次予測キャッシュフローが正しくありません: %', april_row.projected_net_cashflow;
  end if;
  if (select count(*) from public.lcc_plan_occurrence where lcc_plan_item_id = lcc_id) < 2 then
    raise exception '周期LCCが将来日程へ展開されていません';
  end if;

  select public.create_financial_scenario(
    'LCC予測テスト弱気', 'downside', 2027, 5, scenario_id, '複製テスト'
  ) into copied_scenario_id;
  if (select count(*) from public.financial_scenario_line where financial_scenario_id = copied_scenario_id) <> 2 then
    raise exception 'シナリオ複製で月次予算が引き継がれていません';
  end if;

  begin
    insert into public.financial_scenario_line (
      financial_scenario_id, property_id, account_id, accounting_month, amount
    ) values (scenario_id, test_property_id, 'M08', date '2048-04-01', 1);
    raise exception 'シナリオ期間外の行が登録されました';
  exception when others then
    if sqlerrm = 'シナリオ期間外の行が登録されました' then raise; end if;
  end;
end $$;

rollback;
