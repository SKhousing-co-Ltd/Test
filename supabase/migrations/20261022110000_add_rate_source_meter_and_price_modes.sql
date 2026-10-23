-- 単価計算専用の大元メーターと、変動単価の算出方法を明示的に管理します。
alter table public.asset_meter
  add column if not exists is_rate_source boolean not null default false;

comment on column public.asset_meter.is_rate_source is
  '区画へ請求せず、段階料金から共通単価を算出するための大元メーター';

alter table public.asset_meter_sub_item
  drop constraint if exists asset_meter_sub_item_price_mode_check;
alter table public.asset_meter_sub_item
  drop constraint if exists ck_asset_meter_sub_item_price_mode;
alter table public.asset_meter_sub_item
  alter column price_mode type varchar(20);

update public.asset_meter_sub_item
set price_mode = 'amount'
where price_mode = 'variable';

alter table public.asset_meter_sub_item
  add constraint ck_asset_meter_sub_item_price_mode
  check (price_mode in ('fixed', 'amount', 'master_meter'));

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
  if p_unit_id is not null and not exists (
    select 1 from public.unit_master where unit_id = p_unit_id and property_id = p_asset_id
  ) then
    raise exception '区画が対象ビルのものではありません';
  end if;

  insert into public.asset_meter (
    asset_id, asset_meter_sub_item_id, meter_code, is_active, is_rate_source
  ) values (
    p_asset_id, p_asset_meter_sub_item_id, trim(p_meter_code), true, p_unit_id is null
  ) returning asset_meter_id into v_meter_id;

  if p_unit_id is not null then
    insert into public.asset_meter_unit_assignment (asset_meter_id, unit_id, effective_from)
    values (v_meter_id, p_unit_id, date '1900-01-01');
  end if;
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
  if p_unit_id is not null and not exists (
    select 1 from public.unit_master where unit_id = p_unit_id and property_id = v_asset_id
  ) then
    raise exception '区画が対象ビルのものではありません';
  end if;

  update public.asset_meter
  set is_rate_source = p_unit_id is null, updated_at = now()
  where asset_meter_id = p_asset_meter_id;

  update public.asset_meter_unit_assignment
  set effective_to = current_date - 1, updated_at = now()
  where asset_meter_id = p_asset_meter_id
    and effective_from < current_date
    and (effective_to is null or effective_to >= current_date);

  delete from public.asset_meter_unit_assignment
  where asset_meter_id = p_asset_meter_id and effective_from = current_date;

  if p_unit_id is not null then
    insert into public.asset_meter_unit_assignment (asset_meter_id, unit_id, effective_from, effective_to)
    values (p_asset_meter_id, p_unit_id, current_date, null)
    on conflict (asset_meter_id, effective_from)
    do update set unit_id = excluded.unit_id, effective_to = null, updated_at = now();
  end if;
end;
$$;
