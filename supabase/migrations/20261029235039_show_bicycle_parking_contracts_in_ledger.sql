-- Reattach the contract-admin-created bicycle unit to the existing bicycle slot.
do $$
declare
  v_contract_unit_id uuid;
  v_source_unit_id uuid;
  v_parking_space_unit_id uuid;
begin
  select cu.lease_contract_unit_id, u.unit_id
    into v_contract_unit_id, v_source_unit_id
    from public.lease_contract c
    join public.tenant_master t on t.tenant_id = c.tenant_id
    join public.lease_contract_unit cu on cu.lease_contract_id = c.lease_contract_id
    join public.unit_master u on u.unit_id = cu.unit_id
    join public.asset_master a on a.asset_id = u.property_id
    where c.contract_type = 'bicycle_parking'
      and t.tenant_name = '(有)タイムボム'
      and u.unit_code = '2'
      and u.unit_type = 'bicycle_parking'
      and a.asset_name = '三共四ツ橋ビル'
      and c.contract_status = 'active';
  if not found then
    raise exception 'Expected bicycle contract unit for (有)タイムボム was not found';
  end if;

  select s.unit_id into v_parking_space_unit_id
    from public.parking_space_master s
    join public.parking_facility_master f on f.parking_facility_id = s.parking_facility_id
    join public.unit_master u on u.unit_id = s.unit_id
    join public.asset_master a on a.asset_id = f.property_id
    where s.space_number = '2'
      and f.facility_code = 'BIKE'
      and a.asset_name = '三共四ツ橋ビル'
      and u.unit_code = 'PK-BIKE-2'
      and u.is_active;
  if not found then
    raise exception 'Expected bicycle parking slot 2 was not found';
  end if;

  update public.unit_master
  set unit_type = 'bicycle_parking', updated_at = now()
  where unit_id = v_parking_space_unit_id;

  update public.lease_contract_unit
  set unit_id = v_parking_space_unit_id, updated_at = now()
  where lease_contract_unit_id = v_contract_unit_id
    and unit_id = v_source_unit_id;
  if not found then
    raise exception 'Could not attach the bicycle contract to slot 2';
  end if;

  update public.unit_master
  set is_active = false, updated_at = now()
  where unit_id = v_source_unit_id
    and not exists (
      select 1 from public.lease_contract_unit cu
      where cu.unit_id = v_source_unit_id
    );
end;
$$;

create or replace function public.parking_list_at_date(p_property_id uuid, p_as_of_date date)
returns jsonb
language sql
stable
set search_path = public
as $function$
  select coalesce(jsonb_agg(to_jsonb(list_row) order by list_row.facility_code, list_row.space_number), '[]'::jsonb)
  from (
    select
      p_as_of_date as snapshot_as_of_date,
      case
        when coalesce(space_availability.availability_status, 'available') = 'unavailable' then 'unavailable'
        when active_lease.lease_contract_id is not null then 'occupied'
        else 'vacant'
      end as space_status,
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
      active_lease.lease_start_date as contract_start_date,
      active_lease.lease_end_date as contract_end_date,
      active_lease.tenant_id,
      active_lease.tenant_name,
      coalesce(fee.parking_scope, detail.parking_scope) as parking_scope,
      detail.main_lease_contract_id,
      fee.main_lease_contract_unit_id,
      main_contract.contract_start_date as main_contract_start_date,
      main_contract.contract_end_date as main_contract_end_date,
      case
        when active_lease.contract_type = 'bicycle_parking' then coalesce(active_lease.monthly_total_amount, 0)
        else coalesce(fee.monthly_parking_fee, 0)
      end as monthly_parking_fee,
      case
        when active_lease.contract_type = 'bicycle_parking' then coalesce(fee.effective_from, active_lease.lease_start_date, active_lease.contract_start_date)
        else fee.effective_from
      end as parking_fee_effective_from,
      assignment.access_code,
      assignment.tenant_location_label,
      assignment.notes,
      vehicle.vehicle_model,
      vehicle.registration_number,
      vehicle.chassis_number,
      vehicle.effective_from as vehicle_effective_from
    from public.parking_space_master space
    join public.parking_facility_master facility on facility.parking_facility_id = space.parking_facility_id
    left join public.parking_type_master parking_type on parking_type.parking_type_id = facility.parking_type_id
    join public.asset_master asset on asset.asset_id = facility.property_id
    join public.unit_master unit on unit.unit_id = space.unit_id
    left join public.lease_contract_unit_snapshot_at_date(p_property_id, p_as_of_date) active_lease
      on active_lease.unit_id = space.unit_id and active_lease.contract_type in ('parking', 'bicycle_parking')
    left join lateral (
      select status_history.availability_status
      from public.parking_space_status_history status_history
      where status_history.unit_id = space.unit_id and status_history.effective_from <= p_as_of_date
      order by status_history.effective_from desc, status_history.created_at desc limit 1
    ) space_availability on true
    left join public.parking_contract_detail detail on detail.lease_contract_id = active_lease.lease_contract_id
    left join public.lease_contract main_contract on main_contract.lease_contract_id = detail.main_lease_contract_id
    left join lateral (
      select history.parking_scope, history.main_lease_contract_unit_id,
             history.monthly_parking_fee, history.effective_from
      from public.parking_fee_history history
      where history.parking_lease_contract_unit_id = active_lease.lease_contract_unit_id
        and history.effective_from <= p_as_of_date
        and (history.effective_to is null or history.effective_to >= p_as_of_date)
      order by history.effective_from desc limit 1
    ) fee on true
    left join public.parking_space_assignment assignment on assignment.lease_contract_unit_id = active_lease.lease_contract_unit_id
    left join lateral (
      select history.vehicle_model, history.registration_number, history.chassis_number, history.effective_from
      from public.parking_vehicle_history history
      where history.lease_contract_unit_id = active_lease.lease_contract_unit_id
        and history.effective_from <= p_as_of_date
        and (history.effective_to is null or history.effective_to >= p_as_of_date)
      order by history.effective_from desc, history.created_at desc limit 1
    ) vehicle on true
    where facility.property_id = p_property_id and facility.is_active and space.is_active
  ) list_row;
$function$;
