alter table public.asset_meter
  add column if not exists rollover_digits smallint;

alter table public.asset_meter
  drop constraint if exists asset_meter_rollover_digits_check;
alter table public.asset_meter
  add constraint asset_meter_rollover_digits_check
  check (rollover_digits is null or rollover_digits between 1 and 12);

comment on column public.asset_meter.rollover_digits is
  'メーターが一周する整数桁数。4なら10,000で一周する。';

create or replace function public.save_kanameter_reading_rollover(
  p_asset_id uuid,
  p_billing_month date,
  p_asset_meter_id uuid,
  p_value numeric,
  p_rollover_digits integer
)
returns table (usage_amount numeric, previous_reading numeric, current_reading numeric, month_status text, saved_at timestamptz)
language plpgsql security invoker set search_path = public as $$
declare
  v_month date := date_trunc('month', p_billing_month)::date;
  v_previous numeric;
  v_normalized_previous numeric;
  v_rollover numeric;
  v_usage numeric;
  v_saved_at timestamptz := now();
begin
  if auth.uid() is null or not public.current_account_is_active() then raise exception 'KANAMETERを利用する権限がありません'; end if;
  if p_value is null or p_value < 0 then raise exception '検針値は0以上で入力してください'; end if;
  if p_rollover_digits is null or p_rollover_digits < 1 or p_rollover_digits > 12 then raise exception '一周する桁数が正しくありません'; end if;
  if not exists (
    select 1 from public.asset_meter meter
    join public.asset_meter_sub_item sub_item on sub_item.asset_meter_sub_item_id = meter.asset_meter_sub_item_id
    where meter.asset_meter_id = p_asset_meter_id and meter.asset_id = p_asset_id and meter.is_active
      and (sub_item.input_mode = 'reading' or (sub_item.input_mode = 'mixed' and meter.use_reading_input))
  ) then raise exception '対象の読取値入力メーターが見つかりません'; end if;
  if exists (select 1 from public.meter_reading_month where asset_id = p_asset_id and billing_month = v_month and status = 'confirmed') then raise exception '確定済みの検針データは変更できません'; end if;

  select entry.current_reading into v_previous from public.meter_reading_entry entry
  where entry.asset_meter_id = p_asset_meter_id and entry.billing_month < v_month and entry.current_reading is not null
  order by entry.billing_month desc limit 1;
  v_previous := coalesce(v_previous, 0);
  v_rollover := power(10::numeric, p_rollover_digits);
  v_normalized_previous := mod(v_previous, v_rollover);
  v_usage := case
    when p_value >= v_normalized_previous then p_value - v_normalized_previous
    else v_rollover - v_normalized_previous + p_value
  end;

  insert into public.meter_reading_month (asset_id, billing_month, status)
  values (p_asset_id, v_month, 'draft') on conflict (asset_id, billing_month) do nothing;
  insert into public.meter_reading_entry (asset_id, billing_month, asset_meter_id, usage_amount, previous_reading, current_reading, previous_reading_manual, updated_at)
  values (p_asset_id, v_month, p_asset_meter_id, v_usage, v_previous, p_value, false, v_saved_at)
  on conflict (asset_id, billing_month, asset_meter_id) do update set
    usage_amount = excluded.usage_amount,
    previous_reading = excluded.previous_reading,
    current_reading = excluded.current_reading,
    previous_reading_manual = excluded.previous_reading_manual,
    updated_at = excluded.updated_at;

  update public.asset_meter set rollover_digits = p_rollover_digits, updated_at = v_saved_at
  where asset_meter_id = p_asset_meter_id and asset_id = p_asset_id;

  return query select v_usage, v_previous, p_value, 'draft'::text, v_saved_at;
end;
$$;

revoke all on function public.save_kanameter_reading_rollover(uuid, date, uuid, numeric, integer) from public, anon;
grant execute on function public.save_kanameter_reading_rollover(uuid, date, uuid, numeric, integer) to authenticated;
