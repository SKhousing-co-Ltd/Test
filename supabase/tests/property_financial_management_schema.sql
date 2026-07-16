begin;

do $$
declare
  test_property_id uuid;
  recurring_id uuid;
  entry_id uuid;
begin
  insert into public.property_master (property_name)
  values ('収支管理テスト物件')
  on conflict (property_name) do update set updated_at = now()
  returning property_id into test_property_id;

  insert into public.property_recurring_financial_item (
    property_id, account_id, item_name, monthly_amount, effective_from_month, effective_to_month
  ) values (
    test_property_id, 'M04', 'BM委託料', 50000, date '2026-04-01', date '2026-06-01'
  ) returning recurring_item_id into recurring_id;

  insert into public.property_monthly_financial_entry (
    property_id, account_id, accounting_month, amount, entry_date, description
  ) values (
    test_property_id, 'M08', date '2026-04-01', 12000, date '2026-04-15', '消耗品購入'
  ) returning financial_entry_id into entry_id;

  if (select count(*) from public.property_monthly_income_expense_detail where property_id = test_property_id and accounting_month = date '2026-04-01') <> 2 then
    raise exception '収支明細ビューに定期明細と月次明細が集計されていません';
  end if;

  if (select expense_total from public.property_monthly_income_expense_summary where property_id = test_property_id and accounting_month = date '2026-04-01') <> 62000 then
    raise exception '月次収支サマリーの支出合計が正しくありません';
  end if;
end $$;

rollback;
