-- 5-Hは設置区画の訂正を移設履歴として保存してしまったため、当初からG・Hだった状態へ直す。
do $$
declare
  v_meter_id uuid;
  v_unit_id uuid;
begin
  select meter.asset_meter_id
    into v_meter_id
    from public.asset_meter meter
    join public.asset_master asset on asset.asset_id = meter.asset_id
   where meter.meter_code = '5-H'
     and (asset.asset_name ilike '%福岡%' or asset.short_name ilike '%福岡%')
   order by meter.created_at
   limit 1;

  select assignment.unit_id
    into v_unit_id
    from public.asset_meter_unit_assignment assignment
   where assignment.asset_meter_id = v_meter_id
     and assignment.effective_to is null
   order by assignment.effective_from desc
   limit 1;

  if v_meter_id is null or v_unit_id is null then
    raise exception '三共福岡ビル 5-Hの現在区画を特定できません';
  end if;

  delete from public.asset_meter_unit_assignment
   where asset_meter_id = v_meter_id;

  insert into public.asset_meter_unit_assignment (
    asset_meter_id, unit_id, effective_from, effective_to
  ) values (
    v_meter_id, v_unit_id, date '1900-01-01', null
  );
end;
$$;

-- メーター設定画面では、選択中の請求月初を適用開始日にして区画を保存する。
create or replace function public.assign_kanameter_meter_unit_from(
  p_asset_meter_id uuid,
  p_unit_id uuid,
  p_effective_from date
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
  if p_effective_from is null then raise exception '適用開始日が必要です'; end if;

  select asset_id into v_asset_id
  from public.asset_meter
  where asset_meter_id = p_asset_meter_id;
  if v_asset_id is null then raise exception 'メーターが見つかりません'; end if;

  if p_unit_id is not null and not exists (
    select 1 from public.unit_master
    where unit_id = p_unit_id and property_id = v_asset_id
  ) then
    raise exception '区画が対象ビルのものではありません';
  end if;

  update public.asset_meter
     set is_rate_source = p_unit_id is null, updated_at = now()
   where asset_meter_id = p_asset_meter_id;

  delete from public.asset_meter_unit_assignment
   where asset_meter_id = p_asset_meter_id
     and effective_from >= p_effective_from;

  update public.asset_meter_unit_assignment
     set effective_to = p_effective_from - 1, updated_at = now()
   where asset_meter_id = p_asset_meter_id
     and effective_from < p_effective_from
     and (effective_to is null or effective_to >= p_effective_from);

  if p_unit_id is not null then
    insert into public.asset_meter_unit_assignment (
      asset_meter_id, unit_id, effective_from, effective_to
    ) values (
      p_asset_meter_id, p_unit_id, p_effective_from, null
    );
  end if;
end;
$$;

revoke all on function public.assign_kanameter_meter_unit_from(uuid, uuid, date) from public, anon;
grant execute on function public.assign_kanameter_meter_unit_from(uuid, uuid, date) to authenticated;

comment on function public.assign_kanameter_meter_unit_from(uuid, uuid, date) is
  'KANAMETERから選択中の請求月初を適用開始日としてメーター区画履歴を更新する';
