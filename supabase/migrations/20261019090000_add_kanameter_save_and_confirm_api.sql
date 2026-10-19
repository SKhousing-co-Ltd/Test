-- KANAMETERの入力は都度保存し、月次確定をKANAME連携の境界とする。

create or replace function public.save_kanameter_reading(
  p_asset_id uuid,
  p_billing_month date,
  p_asset_meter_id uuid,
  p_value numeric
)
returns table (
  usage_amount numeric,
  previous_reading numeric,
  current_reading numeric,
  month_status text,
  saved_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_billing_month)::date;
  v_input_mode text;
  v_previous numeric;
  v_usage numeric;
  v_saved_at timestamptz := now();
begin
  if auth.uid() is null or not public.current_account_is_active() then
    raise exception 'KANAMETERを利用する権限がありません';
  end if;
  if p_value is null or p_value < 0 then
    raise exception '検針値は0以上で入力してください';
  end if;

  select sub_item.input_mode into v_input_mode
  from public.asset_meter meter
  join public.asset_meter_sub_item sub_item on sub_item.asset_meter_sub_item_id = meter.asset_meter_sub_item_id
  where meter.asset_meter_id = p_asset_meter_id
    and meter.asset_id = p_asset_id
    and meter.is_active;
  if v_input_mode is null then
    raise exception '対象のメーターが見つかりません';
  end if;

  if exists (
    select 1 from public.meter_reading_month
    where asset_id = p_asset_id and billing_month = v_month and status = 'confirmed'
  ) then
    raise exception '確定済みの検針データは変更できません';
  end if;

  insert into public.meter_reading_month (asset_id, billing_month, status)
  values (p_asset_id, v_month, 'draft')
  on conflict (asset_id, billing_month) do nothing;

  if v_input_mode = 'reading' then
    select entry.current_reading into v_previous
    from public.meter_reading_entry entry
    where entry.asset_meter_id = p_asset_meter_id
      and entry.billing_month < v_month
      and entry.current_reading is not null
    order by entry.billing_month desc
    limit 1;
    v_previous := coalesce(v_previous, 0);
    if p_value < v_previous then
      raise exception '今回指針は前回指針（%）以上で入力してください', v_previous;
    end if;
    v_usage := p_value - v_previous;
  else
    v_previous := null;
    v_usage := p_value;
  end if;

  insert into public.meter_reading_entry (
    asset_id, billing_month, asset_meter_id, usage_amount,
    previous_reading, current_reading, previous_reading_manual, updated_at
  ) values (
    p_asset_id, v_month, p_asset_meter_id, v_usage,
    v_previous, case when v_input_mode = 'reading' then p_value else null end, false, v_saved_at
  )
  on conflict (asset_id, billing_month, asset_meter_id) do update set
    usage_amount = excluded.usage_amount,
    previous_reading = excluded.previous_reading,
    current_reading = excluded.current_reading,
    previous_reading_manual = excluded.previous_reading_manual,
    updated_at = excluded.updated_at;

  return query select v_usage, v_previous,
    case when v_input_mode = 'reading' then p_value else null end,
    'draft'::text, v_saved_at;
end;
$$;

revoke all on function public.save_kanameter_reading(uuid, date, uuid, numeric) from public, anon;
grant execute on function public.save_kanameter_reading(uuid, date, uuid, numeric) to authenticated;
comment on function public.save_kanameter_reading(uuid, date, uuid, numeric) is 'KANAMETERの検針入力を即時保存する。指針入力の使用量計算はDB内で行う';

create or replace function public.confirm_kanameter_month(
  p_asset_id uuid,
  p_billing_month date
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
  if not exists (
    select 1 from public.meter_reading_entry
    where asset_id = p_asset_id and billing_month = v_month
  ) then
    raise exception '確定できる検針データがありません';
  end if;
  update public.meter_reading_month
  set status = 'confirmed', confirmed_at = v_confirmed_at, updated_at = v_confirmed_at
  where asset_id = p_asset_id and billing_month = v_month;
  if not found then
    raise exception '対象月の検針データがありません';
  end if;
  return v_confirmed_at;
end;
$$;

revoke all on function public.confirm_kanameter_month(uuid, date) from public, anon;
grant execute on function public.confirm_kanameter_month(uuid, date) to authenticated;
comment on function public.confirm_kanameter_month(uuid, date) is 'KANAMETERの月次入力を確定し、KANAMEから参照可能な確定状態にする';
