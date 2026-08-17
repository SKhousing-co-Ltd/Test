begin;

do $$
declare
  test_property_id uuid;
  test_vendor_id uuid;
  test_order_id uuid;
  test_invoice_id uuid;
begin
  insert into public.asset_master (asset_code, asset_name)
  values (999903, '発注支払テスト物件')
  returning asset_id into test_property_id;

  insert into public.vendor_master (vendor_code, vendor_name)
  values ('TEST-P2P', '発注支払テスト取引先')
  returning vendor_id into test_vendor_id;

  insert into public.procurement_order (
    property_id, account_id, vendor_id, order_type, title, gross_amount, order_date, status
  ) values (
    test_property_id, 'M08', test_vendor_id, 'repair', '空調修繕', 110000, date '2026-08-01', 'ordered'
  ) returning procurement_order_id into test_order_id;

  select public.register_vendor_invoice(
    test_property_id, 'M08', test_vendor_id, 'INV-TEST-001', 'BILLONE-TEST-001',
    date '2026-08-10', date '2026-09-30', date '2026-08-01', 100000, 10000,
    test_order_id, '自動テスト'
  ) into test_invoice_id;

  if (select status from public.procurement_order where procurement_order_id = test_order_id) <> 'invoiced' then
    raise exception '請求照合後に発注ステータスが更新されていません';
  end if;
  if (select count(*) from public.payment_schedule where vendor_invoice_id = test_invoice_id) <> 1 then
    raise exception '支払予定が自動作成されていません';
  end if;

  perform public.set_vendor_invoice_status(test_invoice_id, 'approved');
  if not exists (
    select 1 from public.property_monthly_financial_entry
    where source_system = 'vendor_invoice' and source_record_id = test_invoice_id and amount = 110000
  ) then
    raise exception '承認請求書が物件収支実績へ連携されていません';
  end if;

  perform public.set_vendor_invoice_status(test_invoice_id, 'paid', date '2026-09-29', 'BANK-TEST-001');
  if not exists (
    select 1 from public.payable_cashflow
    where vendor_invoice_id = test_invoice_id and status = 'paid' and paid_date = date '2026-09-29'
  ) then
    raise exception '支払実績が資金繰りビューへ反映されていません';
  end if;
end $$;

rollback;
