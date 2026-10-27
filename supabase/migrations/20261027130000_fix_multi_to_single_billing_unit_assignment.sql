create or replace function public.assign_kanameter_meter_billing_unit_from(
  p_asset_meter_id uuid, p_lease_contract_billing_unit_id uuid, p_effective_from date
) returns void language plpgsql security definer set search_path = public as $$
declare v_asset_id uuid;
begin
  if not public.current_account_is_active() then raise exception 'KANAMETERを利用する権限がありません'; end if;
  if p_effective_from is null then raise exception '適用開始日が必要です'; end if;
  select asset_id into v_asset_id from public.asset_meter where asset_meter_id = p_asset_meter_id;
  if v_asset_id is null then raise exception 'メーターが見つかりません'; end if;
  if not exists (
    select 1 from public.lease_contract_billing_unit_member bm
    join public.lease_contract_unit cu using (lease_contract_unit_id)
    join public.unit_master u on u.unit_id = cu.unit_id
    where bm.lease_contract_billing_unit_id = p_lease_contract_billing_unit_id and u.property_id = v_asset_id
  ) then raise exception '請求区画が対象ビルのものではありません'; end if;

  update public.asset_meter set is_rate_source = false, updated_at = now()
   where asset_meter_id = p_asset_meter_id;
  delete from public.asset_meter_unit_assignment
   where asset_meter_id = p_asset_meter_id and effective_from >= p_effective_from;
  update public.asset_meter_unit_assignment set effective_to = p_effective_from - 1, updated_at = now()
   where asset_meter_id = p_asset_meter_id and effective_from < p_effective_from
     and (effective_to is null or effective_to >= p_effective_from);

  insert into public.asset_meter_unit_assignment (
    asset_meter_id, unit_id, lease_contract_billing_unit_id, effective_from, effective_to,
    allocation_method, allocation_weight, area_sqm_snapshot
  ) values (
    p_asset_meter_id, null, p_lease_contract_billing_unit_id, p_effective_from, null,
    'single', 1, null
  );

  update public.asset_meter set parent_asset_meter_id = null
   where asset_meter_id = p_asset_meter_id or parent_asset_meter_id = p_asset_meter_id;
end $$;

revoke all on function public.assign_kanameter_meter_billing_unit_from(uuid, uuid, date) from public, anon;
grant execute on function public.assign_kanameter_meter_billing_unit_from(uuid, uuid, date) to authenticated;
comment on function public.assign_kanameter_meter_billing_unit_from(uuid, uuid, date)
  is 'KANAMETERから複数割当を含む現在の割当を請求区画1つへ変更する';

