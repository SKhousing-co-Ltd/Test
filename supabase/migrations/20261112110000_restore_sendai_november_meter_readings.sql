-- KANAMEの請求設定保存で消えた仙台2026年11月の読取値を、残っている使用量と直前の読取値から復元する。
-- 過去の読取値が無い、使用量が無い、または読取入力対象でないメーターは変更しない。
with target_entries as (
  select
    entry.asset_id,
    entry.billing_month,
    entry.asset_meter_id,
    entry.usage_amount,
    entry.exchange_removed_reading,
    entry.exchange_installed_reading,
    previous.current_reading as previous_reading
  from public.meter_reading_entry entry
  join public.asset_master asset on asset.asset_id = entry.asset_id
  join public.asset_meter meter on meter.asset_meter_id = entry.asset_meter_id
  join public.asset_meter_sub_item sub_item on sub_item.asset_meter_sub_item_id = meter.asset_meter_sub_item_id
  join lateral (
    select older.current_reading
    from public.meter_reading_entry older
    where older.asset_meter_id = entry.asset_meter_id
      and older.billing_month < entry.billing_month
      and older.current_reading is not null
    order by older.billing_month desc
    limit 1
  ) previous on true
  where asset.asset_name = '三共仙台ビル'
    and entry.billing_month = date '2026-11-01'
    and entry.current_reading is null
    and entry.usage_amount is not null
    and (meter.use_reading_input is true or sub_item.input_mode = 'reading')
)
update public.meter_reading_entry entry
set previous_reading = target.previous_reading,
    current_reading = case
      when target.exchange_removed_reading is not null and target.exchange_installed_reading is not null
        then target.usage_amount - target.exchange_removed_reading + target.previous_reading + target.exchange_installed_reading
      else target.previous_reading + target.usage_amount
    end,
    previous_reading_manual = false,
    updated_at = now()
from target_entries target
where entry.asset_id = target.asset_id
  and entry.billing_month = target.billing_month
  and entry.asset_meter_id = target.asset_meter_id;
