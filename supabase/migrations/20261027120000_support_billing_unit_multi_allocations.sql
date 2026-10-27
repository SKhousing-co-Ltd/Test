create unique index if not exists uq_asset_meter_assignment_billing_unit_start
  on public.asset_meter_unit_assignment(asset_meter_id, lease_contract_billing_unit_id, effective_from)
  where lease_contract_billing_unit_id is not null;

create or replace function public.assign_kanameter_meter_units_from(
  p_asset_meter_id uuid, p_method text, p_allocations jsonb, p_effective_from date
)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_asset_id uuid;
  v_count integer;
  v_item jsonb;
  v_unit_id uuid;
  v_billing_unit_id uuid;
  v_weight numeric;
  v_area numeric;
begin
  if not public.current_account_is_active() then raise exception 'KANAMETERを利用する権限がありません'; end if;
  if p_effective_from is null then raise exception '適用開始日が必要です'; end if;
  if p_method not in ('area', 'ratio') then raise exception '按分方法が不正です'; end if;
  if jsonb_typeof(p_allocations) <> 'array' then raise exception '区画設定が不正です'; end if;
  v_count := jsonb_array_length(p_allocations);
  if v_count < 2 then raise exception '複数区画を2区画以上選択してください'; end if;
  select asset_id into v_asset_id from public.asset_meter where asset_meter_id = p_asset_meter_id;
  if v_asset_id is null then raise exception 'メーターが見つかりません'; end if;
  if (
    select count(distinct coalesce('unit:' || value ->> 'unit_id', 'billing:' || value ->> 'billing_unit_id'))
    from jsonb_array_elements(p_allocations)
  ) <> v_count then raise exception '同じ区画が重複しています'; end if;

  for v_item in select value from jsonb_array_elements(p_allocations)
  loop
    v_unit_id := nullif(v_item ->> 'unit_id', '')::uuid;
    v_billing_unit_id := nullif(v_item ->> 'billing_unit_id', '')::uuid;
    if (v_unit_id is not null)::integer + (v_billing_unit_id is not null)::integer <> 1 then raise exception '区画設定が不正です'; end if;
    if v_unit_id is not null then
      select rentable_area_sqm into v_area from public.unit_master
       where unit_id = v_unit_id and property_id = v_asset_id and is_active = true;
    else
      select case when count(*) > 0 and bool_and(coalesce(u.rentable_area_sqm, 0) > 0) then sum(u.rentable_area_sqm) end
        into v_area
        from public.lease_contract_billing_unit_member bm
        join public.lease_contract_unit cu using (lease_contract_unit_id)
        join public.unit_master u on u.unit_id = cu.unit_id
       where bm.lease_contract_billing_unit_id = v_billing_unit_id and u.property_id = v_asset_id;
      if not exists (select 1 from public.lease_contract_billing_unit where lease_contract_billing_unit_id = v_billing_unit_id) then
        raise exception '対象ビルに存在しない請求区画が含まれています';
      end if;
    end if;
    if v_unit_id is not null and not found then raise exception '対象ビルに存在しない区画が含まれています'; end if;
    if p_method = 'area' and coalesce(v_area, 0) <= 0 then raise exception '面積未登録の区画は面積按分に使用できません'; end if;
    if p_method = 'ratio' then
      v_weight := (v_item ->> 'weight')::numeric;
      if v_weight <= 0 or trunc(v_weight) <> v_weight then raise exception '比率は正の整数で入力してください'; end if;
    end if;
  end loop;

  update public.asset_meter set is_rate_source = false, updated_at = now() where asset_meter_id = p_asset_meter_id;
  delete from public.asset_meter_unit_assignment where asset_meter_id = p_asset_meter_id and effective_from >= p_effective_from;
  update public.asset_meter_unit_assignment set effective_to = p_effective_from - 1, updated_at = now()
   where asset_meter_id = p_asset_meter_id and effective_from < p_effective_from
     and (effective_to is null or effective_to >= p_effective_from);

  for v_item in select value from jsonb_array_elements(p_allocations)
  loop
    v_unit_id := nullif(v_item ->> 'unit_id', '')::uuid;
    v_billing_unit_id := nullif(v_item ->> 'billing_unit_id', '')::uuid;
    if v_unit_id is not null then
      select rentable_area_sqm into v_area from public.unit_master where unit_id = v_unit_id;
    else
      select sum(u.rentable_area_sqm) into v_area
        from public.lease_contract_billing_unit_member bm
        join public.lease_contract_unit cu using (lease_contract_unit_id)
        join public.unit_master u on u.unit_id = cu.unit_id
       where bm.lease_contract_billing_unit_id = v_billing_unit_id;
    end if;
    v_weight := case when p_method = 'area' then v_area else (v_item ->> 'weight')::numeric end;
    insert into public.asset_meter_unit_assignment (
      asset_meter_id, unit_id, lease_contract_billing_unit_id, effective_from, allocation_method, allocation_weight, area_sqm_snapshot
    ) values (
      p_asset_meter_id, v_unit_id, v_billing_unit_id, p_effective_from, p_method, v_weight,
      case when p_method = 'area' then v_area else null end
    );
  end loop;
  update public.asset_meter set parent_asset_meter_id = null
   where asset_meter_id = p_asset_meter_id or parent_asset_meter_id = p_asset_meter_id;
end;
$$;

revoke all on function public.assign_kanameter_meter_units_from(uuid, text, jsonb, date) from public, anon;
grant execute on function public.assign_kanameter_meter_units_from(uuid, text, jsonb, date) to authenticated;
comment on function public.assign_kanameter_meter_units_from(uuid, text, jsonb, date) is 'KANAMETERから物理区画・請求区画を含む複数区画割当を適用月付きで保存する';

