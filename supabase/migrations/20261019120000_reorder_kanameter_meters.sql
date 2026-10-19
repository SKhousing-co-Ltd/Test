-- KANAMETERのメーター設定画面で、小分類内の表示順を安全に更新します。

create or replace function public.reorder_kanameter_meters(
  p_asset_id uuid,
  p_asset_meter_sub_item_id uuid,
  p_asset_meter_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_account_is_active() then
    raise exception 'KANAMETERを利用する権限がありません';
  end if;
  if coalesce(array_length(p_asset_meter_ids, 1), 0) <> (
    select count(*)
    from public.asset_meter
    where asset_id = p_asset_id
      and asset_meter_sub_item_id = p_asset_meter_sub_item_id
      and is_active
  ) then
    raise exception '並べ替え対象のメーターが一致しません';
  end if;
  if exists (
    select 1
    from unnest(p_asset_meter_ids) as requested(asset_meter_id)
    left join public.asset_meter meter
      on meter.asset_meter_id = requested.asset_meter_id
     and meter.asset_id = p_asset_id
     and meter.asset_meter_sub_item_id = p_asset_meter_sub_item_id
     and meter.is_active
    where meter.asset_meter_id is null
  ) or (
    select count(distinct asset_meter_id) from unnest(p_asset_meter_ids) as ids(asset_meter_id)
  ) <> coalesce(array_length(p_asset_meter_ids, 1), 0) then
    raise exception '並べ替え対象に不正なメーターが含まれています';
  end if;

  update public.asset_meter meter
  set sort_order = requested.ordinality - 1,
      updated_at = now()
  from unnest(p_asset_meter_ids) with ordinality as requested(asset_meter_id, ordinality)
  where meter.asset_meter_id = requested.asset_meter_id;
end;
$$;

revoke all on function public.reorder_kanameter_meters(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.reorder_kanameter_meters(uuid, uuid, uuid[]) to authenticated;

comment on function public.reorder_kanameter_meters(uuid, uuid, uuid[]) is
  'KANAMETERから小分類内のメーター表示順を一括更新する';
