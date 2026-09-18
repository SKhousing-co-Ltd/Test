-- 検針データ管理のテーブルが、画面の保存処理が前提にしている形になっているかを確認します。
begin;

do $$
declare
  property_uuid uuid;
  tenant_uuid uuid;
  contract_uuid uuid;
  basic_item_uuid uuid;
  usage_item_uuid uuid;
  meter_uuid uuid;
  surcharge_uuid uuid;
  table_name text;
  stored numeric;
  remaining integer;
begin
  foreach table_name in array array[
    'asset_meter_category_setting', 'asset_meter_sub_item', 'asset_meter_surcharge',
    'meter_reading_contract', 'meter_reading_contract_item', 'asset_meter',
    'meter_reading_month', 'meter_reading_month_surcharge', 'meter_reading_entry',
    'meter_reading_confirmed_amount'
  ] loop
    if to_regclass('public.' || table_name) is null then
      raise exception '% is missing', table_name;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || table_name)::regclass) then
      raise exception '% must have RLS enabled', table_name;
    end if;
    -- 確定した金額だけは書き換えを許さないので、更新権限は別に見ます。
    if not has_table_privilege('authenticated', 'public.' || table_name, 'select, insert, delete') then
      raise exception 'authenticated must manage %', table_name;
    end if;
    if table_name <> 'meter_reading_confirmed_amount'
       and not has_table_privilege('authenticated', 'public.' || table_name, 'update') then
      raise exception 'authenticated must update %', table_name;
    end if;
  end loop;

  insert into public.asset_master(asset_code, asset_name) values (999951, '検針データテスト物件')
  returning asset_id into property_uuid;
  insert into public.tenant_master(external_tenant_code, tenant_name, normalized_tenant_name)
  values ('METER-TEST', '検針データテストテナント', '検針データテストテナント')
  returning tenant_id into tenant_uuid;

  insert into public.asset_meter_category_setting(asset_id, category, usage_unit, is_billable, is_basic_billable)
  values (property_uuid, 'electric', 'kWh', true, true);

  -- 分類は電気・水道・ガスの3つだけです。
  begin
    insert into public.asset_meter_category_setting(asset_id, category) values (property_uuid, 'internet');
    raise exception 'unknown category must be rejected';
  exception when check_violation then null;
  end;

  insert into public.asset_meter_sub_item(asset_id, category, sub_item_name, sub_item_kind, sort_order)
  values (property_uuid, 'electric', '基本料', 'basic', 0)
  returning asset_meter_sub_item_id into basic_item_uuid;
  insert into public.asset_meter_sub_item(asset_id, category, sub_item_name, sub_item_kind, default_unit_price, sort_order)
  values (property_uuid, 'electric', '電灯', 'custom', 35, 1)
  returning asset_meter_sub_item_id into usage_item_uuid;

  -- 基本料は固定額で請求するため、単価を持たせられません。
  begin
    insert into public.asset_meter_sub_item(asset_id, category, sub_item_name, sub_item_kind, default_unit_price, sort_order)
    values (property_uuid, 'water', '基本料', 'basic', 100, 0);
    raise exception 'basic sub item must not keep a unit price';
  exception when check_violation then null;
  end;

  -- 同じ分類の中で小分類名は重複させません。
  begin
    insert into public.asset_meter_sub_item(asset_id, category, sub_item_name, sub_item_kind, sort_order)
    values (property_uuid, 'electric', '電灯', 'custom', 2);
    raise exception 'duplicated sub item name must be rejected';
  exception when unique_violation then null;
  end;

  insert into public.meter_reading_contract(asset_id, tenant_id, row_no, invoice_number, amount_rounding_mode)
  values (property_uuid, tenant_uuid, 1, 1, 'round')
  returning meter_reading_contract_id into contract_uuid;

  -- 分割行は9行までです。
  begin
    insert into public.meter_reading_contract(asset_id, tenant_id, row_no) values (property_uuid, tenant_uuid, 10);
    raise exception 'row_no over 9 must be rejected';
  exception when check_violation then null;
  end;

  insert into public.meter_reading_contract_item(meter_reading_contract_id, asset_meter_sub_item_id, is_billable, fixed_amount)
  values (contract_uuid, basic_item_uuid, true, 50379);
  insert into public.meter_reading_contract_item(meter_reading_contract_id, asset_meter_sub_item_id, is_billable, unit_price)
  values (contract_uuid, usage_item_uuid, true, 31.65);

  insert into public.asset_meter(asset_id, asset_meter_sub_item_id, meter_code, meter_label, meter_reading_contract_id)
  values (property_uuid, usage_item_uuid, '223-607-805', '2F 南', contract_uuid)
  returning asset_meter_id into meter_uuid;

  -- メーター番号は小分類の中で重複させません。
  begin
    insert into public.asset_meter(asset_id, asset_meter_sub_item_id, meter_code)
    values (property_uuid, usage_item_uuid, '223-607-805');
    raise exception 'duplicated meter code must be rejected';
  exception when unique_violation then null;
  end;

  -- 月次データは月初日で持ちます。
  begin
    insert into public.meter_reading_month(asset_id, billing_month) values (property_uuid, date '2026-08-06');
    raise exception 'billing_month must be the first day of the month';
  exception when check_violation then null;
  end;

  insert into public.meter_reading_month(asset_id, billing_month, meter_date)
  values (property_uuid, date '2026-08-01', date '2026-08-06');

  -- 検針値は月次データがある月にだけ入ります。
  begin
    insert into public.meter_reading_entry(asset_id, billing_month, asset_meter_id, usage_amount)
    values (property_uuid, date '2026-07-01', meter_uuid, 1);
    raise exception 'entry without a month row must be rejected';
  exception when foreign_key_violation then null;
  end;

  insert into public.meter_reading_entry(asset_id, billing_month, asset_meter_id, usage_amount)
  values (property_uuid, date '2026-08-01', meter_uuid, 564.512);
  select usage_amount into stored from public.meter_reading_entry
   where asset_meter_id = meter_uuid and billing_month = date '2026-08-01';
  if stored <> 564.512 then
    raise exception 'usage must keep 3 decimals, got %', stored;
  end if;

  insert into public.asset_meter_surcharge(asset_id, category, surcharge_name, is_billable)
  values (property_uuid, 'electric', '電気増額分', true)
  returning asset_meter_surcharge_id into surcharge_uuid;
  insert into public.meter_reading_month_surcharge(asset_id, billing_month, asset_meter_surcharge_id, unit_price)
  values (property_uuid, date '2026-08-01', surcharge_uuid, 8.02);

  -- 確定した金額は、確定したときの単価と丸めごと残ります。
  insert into public.meter_reading_confirmed_amount(
    asset_id, billing_month, meter_reading_contract_id, tenant_id, tenant_name, row_no, invoice_number,
    category, source_kind, source_id, source_name, usage_amount, usage_unit, unit_price, amount,
    amount_rounding_mode, usage_rounding_digits, usage_rounding_mode, tax_mode, tax_rate
  ) values (
    property_uuid, date '2026-08-01', contract_uuid, tenant_uuid, '検針データテストテナント', 1, 1,
    'electric', 'subItem', usage_item_uuid, '電灯', 564.5, 'kWh', 31.65, 17866,
    'round', 1, 'round', 'exclusive', 0.1
  );

  -- 同じ月・同じ契約行・同じ小分類の金額は二重に残しません。
  begin
    insert into public.meter_reading_confirmed_amount(
      asset_id, billing_month, meter_reading_contract_id, tenant_id, tenant_name,
      category, source_kind, source_id, source_name, usage_unit, amount, amount_rounding_mode
    ) values (
      property_uuid, date '2026-08-01', contract_uuid, tenant_uuid, '検針データテストテナント',
      'electric', 'subItem', usage_item_uuid, '電灯', 'kWh', 1, 'round'
    );
    raise exception 'duplicated confirmed amount must be rejected';
  exception when unique_violation then null;
  end;

  -- 確定した金額は書き換えられません。
  if has_table_privilege('authenticated', 'public.meter_reading_confirmed_amount', 'update') then
    raise exception 'confirmed amounts must not be updatable';
  end if;

  -- 小分類を消すと、そこに属するメーターと検針値も一緒に消えます。
  delete from public.asset_meter_sub_item where asset_meter_sub_item_id = usage_item_uuid;
  select count(*) into remaining from public.asset_meter where asset_meter_id = meter_uuid;
  if remaining <> 0 then
    raise exception 'meters must be removed with their sub item';
  end if;
  select count(*) into remaining from public.meter_reading_entry where asset_meter_id = meter_uuid;
  if remaining <> 0 then
    raise exception 'entries must be removed with their meter';
  end if;

  select count(*) into remaining from public.meter_reading_confirmed_amount
   where asset_id = property_uuid and source_id = usage_item_uuid;
  if remaining <> 1 then
    raise exception 'confirmed amounts must survive a removed sub item';
  end if;

  -- 契約行を消しても、メーターの割り当てが外れるだけで小分類は残ります。
  insert into public.asset_meter(asset_id, asset_meter_sub_item_id, meter_code, meter_reading_contract_id)
  values (property_uuid, basic_item_uuid, 'KEEP-001', contract_uuid)
  returning asset_meter_id into meter_uuid;
  delete from public.meter_reading_contract where meter_reading_contract_id = contract_uuid;
  select count(*) into remaining from public.asset_meter
   where asset_meter_id = meter_uuid and meter_reading_contract_id is null;
  if remaining <> 1 then
    raise exception 'meters must stay when their contract row is removed';
  end if;
end $$;

rollback;
