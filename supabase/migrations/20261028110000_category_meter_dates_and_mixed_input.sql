-- 分類別の検針日と、小分類内で使用量入力・読取値入力を混在できる設定を追加する。

alter table public.meter_reading_month
  add column if not exists meter_date_electric date,
  add column if not exists meter_date_water date,
  add column if not exists meter_date_gas date;

update public.meter_reading_month
set meter_date_electric = coalesce(meter_date_electric, meter_date),
    meter_date_water = coalesce(meter_date_water, meter_date),
    meter_date_gas = coalesce(meter_date_gas, meter_date)
where meter_date is not null;

comment on column public.meter_reading_month.meter_date_electric is '電気の検針日';
comment on column public.meter_reading_month.meter_date_water is '水道の検針日';
comment on column public.meter_reading_month.meter_date_gas is 'ガスの検針日';

alter table public.asset_meter_sub_item drop constraint if exists ck_asset_meter_sub_item_input_mode;
alter table public.asset_meter_sub_item drop constraint if exists asset_meter_sub_item_input_mode_check;
alter table public.asset_meter_sub_item
  add constraint ck_asset_meter_sub_item_input_mode
  check (input_mode in ('usage', 'reading', 'mixed'));
comment on column public.asset_meter_sub_item.input_mode is
  '検針値の入力方式（usage：使用量、reading：読取値、mixed：メーターごとに選択）';

alter table public.asset_meter
  add column if not exists use_reading_input boolean not null default false;
comment on column public.asset_meter.use_reading_input is
  '小分類のinput_modeがmixedの場合に、このメーターを読取値入力にする';

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

  select case
    when sub_item.input_mode = 'mixed' and meter.use_reading_input then 'reading'
    when sub_item.input_mode = 'mixed' then 'usage'
    else sub_item.input_mode
  end into v_input_mode
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
comment on function public.save_kanameter_reading(uuid, date, uuid, numeric) is
  'KANAMETERの検針入力を即時保存する。混在方式はメーターごとの設定に従いDB内で使用量を計算する';
