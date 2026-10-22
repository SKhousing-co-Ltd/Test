create or replace function public.confirm_kanameter_month_with_amounts(
  p_asset_id uuid,
  p_billing_month date,
  p_amounts jsonb
)
returns timestamptz
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_billing_month)::date;
  v_confirmed_at timestamptz := now();
begin
  if auth.uid() is null or not public.current_account_is_active() then
    raise exception 'KANAMETERを利用する権限がありません';
  end if;
  if jsonb_typeof(coalesce(p_amounts, '[]'::jsonb)) <> 'array' then
    raise exception '確定明細の形式が正しくありません';
  end if;
  if not exists (
    select 1 from public.meter_reading_entry
    where asset_id = p_asset_id and billing_month = v_month
  ) then
    raise exception '確定できる検針データがありません';
  end if;
  if not exists (
    select 1 from public.meter_reading_month
    where asset_id = p_asset_id and billing_month = v_month
  ) then
    raise exception '対象月の検針データがありません';
  end if;

  delete from public.meter_reading_confirmed_amount
  where asset_id = p_asset_id and billing_month = v_month;

  insert into public.meter_reading_confirmed_amount (
    asset_id, billing_month, meter_reading_contract_id, tenant_id, tenant_name,
    row_no, invoice_number, category, source_kind, source_id, source_name,
    asset_billing_line_item_id, line_item_name, usage_amount, usage_unit,
    unit_price, amount, amount_rounding_mode, usage_rounding_digits,
    usage_rounding_mode, tax_mode, tax_rate
  )
  select
    p_asset_id, v_month, amount.meter_reading_contract_id, amount.tenant_id,
    amount.tenant_name, amount.row_no, amount.invoice_number, amount.category,
    amount.source_kind, amount.source_id, amount.source_name,
    amount.asset_billing_line_item_id, amount.line_item_name, amount.usage_amount,
    amount.usage_unit, amount.unit_price, amount.amount,
    amount.amount_rounding_mode, amount.usage_rounding_digits,
    amount.usage_rounding_mode, amount.tax_mode, amount.tax_rate
  from jsonb_to_recordset(coalesce(p_amounts, '[]'::jsonb)) as amount(
    meter_reading_contract_id uuid,
    tenant_id uuid,
    tenant_name varchar(200),
    row_no smallint,
    invoice_number smallint,
    category varchar(10),
    source_kind varchar(10),
    source_id uuid,
    source_name varchar(100),
    asset_billing_line_item_id uuid,
    line_item_name varchar(200),
    usage_amount numeric(14, 3),
    usage_unit varchar(10),
    unit_price numeric(12, 4),
    amount numeric(12, 0),
    amount_rounding_mode varchar(10),
    usage_rounding_digits smallint,
    usage_rounding_mode varchar(10),
    tax_mode varchar(10),
    tax_rate numeric(5, 4)
  );

  update public.meter_reading_month
  set status = 'confirmed', confirmed_at = v_confirmed_at, updated_at = v_confirmed_at
  where asset_id = p_asset_id and billing_month = v_month;

  return v_confirmed_at;
end;
$$;

create or replace function public.release_kanameter_month(
  p_asset_id uuid,
  p_billing_month date
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_billing_month)::date;
begin
  if auth.uid() is null or not public.current_account_is_active() then
    raise exception 'KANAMETERを利用する権限がありません';
  end if;

  delete from public.meter_reading_confirmed_amount
  where asset_id = p_asset_id and billing_month = v_month;

  update public.meter_reading_month
  set status = 'draft', confirmed_at = null, updated_at = now()
  where asset_id = p_asset_id and billing_month = v_month;

  if not found then
    raise exception '対象月の検針データがありません';
  end if;
end;
$$;

revoke all on function public.confirm_kanameter_month_with_amounts(uuid, date, jsonb) from public, anon;
grant execute on function public.confirm_kanameter_month_with_amounts(uuid, date, jsonb) to authenticated;
revoke all on function public.release_kanameter_month(uuid, date) from public, anon;
grant execute on function public.release_kanameter_month(uuid, date) to authenticated;

comment on function public.confirm_kanameter_month_with_amounts(uuid, date, jsonb) is 'KANAMETERの確定明細保存と月次確定を同一トランザクションで行う';
comment on function public.release_kanameter_month(uuid, date) is 'KANAMETERの確定明細を削除し月次を再編集可能に戻す';
