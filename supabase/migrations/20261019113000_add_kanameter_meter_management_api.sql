-- KANAMETER が所有するメーター台帳と設置区画履歴を、原子的に更新するAPIです。

create or replace function public.create_kanameter_meter(
  p_asset_id uuid,
  p_asset_meter_sub_item_id uuid,
  p_meter_code text,
  p_unit_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meter_id uuid;
begin
  if not public.current_account_is_active() then
    raise exception 'KANAMETERを利用する権限がありません';
  end if;
  if nullif(trim(p_meter_code), '') is null then
    raise exception 'メーター番号を入力してください';
  end if;
  if not exists (
    select 1 from public.asset_meter_sub_item
    where asset_meter_sub_item_id = p_asset_meter_sub_item_id and asset_id = p_asset_id
  ) then
    raise exception '小分類が対象ビルのものではありません';
  end if;
  if not exists (
    select 1 from public.unit_master where unit_id = p_unit_id and property_id = p_asset_id
  ) then
    raise exception '区画が対象ビルのものではありません';
  end if;

  insert into public.asset_meter (asset_id, asset_meter_sub_item_id, meter_code, is_active)
  values (p_asset_id, p_asset_meter_sub_item_id, trim(p_meter_code), true)
  returning asset_meter_id into v_meter_id;

  insert into public.asset_meter_unit_assignment (asset_meter_id, unit_id, effective_from)
  values (v_meter_id, p_unit_id, date '1900-01-01');
  return v_meter_id;
end;
$$;

create or replace function public.assign_kanameter_meter_unit(
  p_asset_meter_id uuid,
  p_unit_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asset_id uuid;
begin
  if not public.current_account_is_active() then
    raise exception 'KANAMETERを利用する権限がありません';
  end if;
  select asset_id into v_asset_id from public.asset_meter where asset_meter_id = p_asset_meter_id;
  if v_asset_id is null then raise exception 'メーターが見つかりません'; end if;
  if not exists (select 1 from public.unit_master where unit_id = p_unit_id and property_id = v_asset_id) then
    raise exception '区画が対象ビルのものではありません';
  end if;

  update public.asset_meter_unit_assignment
  set effective_to = current_date - 1, updated_at = now()
  where asset_meter_id = p_asset_meter_id
    and effective_from < current_date
    and (effective_to is null or effective_to >= current_date);

  insert into public.asset_meter_unit_assignment (asset_meter_id, unit_id, effective_from, effective_to)
  values (p_asset_meter_id, p_unit_id, current_date, null)
  on conflict (asset_meter_id, effective_from)
  do update set unit_id = excluded.unit_id, effective_to = null, updated_at = now();
end;
$$;

create or replace function public.delete_kanameter_meter(p_asset_meter_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_account_is_active() then
    raise exception 'KANAMETERを利用する権限がありません';
  end if;
  if exists (select 1 from public.meter_reading_entry where asset_meter_id = p_asset_meter_id) then
    raise exception '検針データがあるメーターは削除できません';
  end if;
  delete from public.asset_meter where asset_meter_id = p_asset_meter_id;
  if not found then raise exception 'メーターが見つかりません'; end if;
end;
$$;

revoke all on function public.create_kanameter_meter(uuid, uuid, text, uuid) from public, anon;
revoke all on function public.assign_kanameter_meter_unit(uuid, uuid) from public, anon;
revoke all on function public.delete_kanameter_meter(uuid) from public, anon;
grant execute on function public.create_kanameter_meter(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.assign_kanameter_meter_unit(uuid, uuid) to authenticated;
grant execute on function public.delete_kanameter_meter(uuid) to authenticated;

comment on function public.create_kanameter_meter(uuid, uuid, text, uuid) is 'KANAMETERからメーターと初期設置区画を登録する';
comment on function public.assign_kanameter_meter_unit(uuid, uuid) is 'KANAMETERからメーターの設置区画履歴を更新する';
comment on function public.delete_kanameter_meter(uuid) is '未使用のメーターをKANAMETERから削除する';
