-- Remote migration version: 20260818090030
-- 駐車場単体画面とレントロールが同じ基準日の契約・車両情報を参照する。
create or replace function public.parking_list_at_date(
  p_property_id uuid,
  p_as_of_date date
) returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(list_row) order by list_row.facility_code, list_row.space_number), '[]'::jsonb)
  from (
    select
      facility.property_id,
      asset.asset_name as property_name,
      facility.parking_facility_id,
      facility.facility_code,
      facility.facility_name,
      facility.parking_type_id,
      parking_type.parking_type_name,
      space.unit_id,
      unit.unit_code,
      space.space_number,
      space.is_active,
      active_lease.lease_contract_unit_id,
      active_lease.lease_contract_id,
      active_lease.contract_status,
      active_lease.contract_start_date,
      active_lease.contract_end_date,
      active_lease.tenant_id,
      active_lease.tenant_name,
      active_lease.parking_scope,
      active_lease.main_lease_contract_id,
      main_contract.contract_start_date as main_contract_start_date,
      main_contract.contract_end_date as main_contract_end_date,
      assignment.access_code,
      assignment.tenant_location_label,
      assignment.notes,
      vehicle.vehicle_model,
      vehicle.registration_number,
      vehicle.chassis_number,
      vehicle.effective_from as vehicle_effective_from
    from public.parking_space_master space
    join public.parking_facility_master facility
      on facility.parking_facility_id = space.parking_facility_id
    left join public.parking_type_master parking_type
      on parking_type.parking_type_id = facility.parking_type_id
    join public.asset_master asset on asset.asset_id = facility.property_id
    join public.unit_master unit on unit.unit_id = space.unit_id
    left join lateral (
      select
        contract_unit.lease_contract_unit_id,
        contract.lease_contract_id,
        contract.contract_status,
        contract.contract_start_date,
        contract.contract_end_date,
        contract.tenant_id,
        tenant.tenant_name,
        detail.parking_scope,
        detail.main_lease_contract_id
      from public.lease_contract_unit contract_unit
      join public.lease_contract contract
        on contract.lease_contract_id = contract_unit.lease_contract_id
      join public.parking_contract_detail detail
        on detail.lease_contract_id = contract.lease_contract_id
      join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
      where contract_unit.unit_id = space.unit_id
        and contract.contract_status = 'active'
        and (contract.contract_start_date is null or contract.contract_start_date <= p_as_of_date)
        and (contract.contract_end_date is null or contract.contract_end_date >= p_as_of_date)
        and (contract_unit.lease_start_date is null or contract_unit.lease_start_date <= p_as_of_date)
        and (contract_unit.lease_end_date is null or contract_unit.lease_end_date >= p_as_of_date)
      order by coalesce(contract_unit.lease_start_date, contract.contract_start_date) desc nulls last,
        contract_unit.created_at desc
      limit 1
    ) active_lease on true
    left join public.lease_contract main_contract
      on main_contract.lease_contract_id = active_lease.main_lease_contract_id
    left join public.parking_space_assignment assignment
      on assignment.lease_contract_unit_id = active_lease.lease_contract_unit_id
    left join lateral (
      select
        history.vehicle_model,
        history.registration_number,
        history.chassis_number,
        history.effective_from
      from public.parking_vehicle_history history
      where history.lease_contract_unit_id = active_lease.lease_contract_unit_id
        and history.effective_from <= p_as_of_date
        and (history.effective_to is null or history.effective_to >= p_as_of_date)
      order by history.effective_from desc, history.created_at desc
      limit 1
    ) vehicle on true
    where facility.property_id = p_property_id
      and facility.is_active
      and space.is_active
  ) list_row;
$$;

revoke all on function public.parking_list_at_date(uuid, date) from public, anon;
grant execute on function public.parking_list_at_date(uuid, date) to authenticated;
