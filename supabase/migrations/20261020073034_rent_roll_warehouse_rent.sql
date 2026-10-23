-- 倉庫区画の契約金額も「賃料」としてレントロールに集計する。
create or replace function public.rent_roll_list_at_date(
  p_property_id uuid,
  p_as_of_date date
)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(to_jsonb(result_row) order by result_row.floor_label, result_row.unit_code), '[]'::jsonb)
  from (
    select
      unit.unit_id,
      unit.unit_code,
      unit.unit_name,
      unit.floor_label,
      unit.unit_type,
      unit.rentable_area_sqm,
      unit.source_discriminator,
      leasing.leasing_status,
      snapshot.lease_contract_unit_id,
      snapshot.lease_contract_id,
      snapshot.contract_status,
      snapshot.contract_start_date,
      snapshot.contract_end_date,
      snapshot.lease_start_date,
      snapshot.lease_end_date,
      snapshot.tenant_id,
      snapshot.external_tenant_code,
      snapshot.tenant_name,
      snapshot.contract_notes,
      snapshot.leased_area_sqm,
      case
        when unit.unit_type in ('office', 'retail', 'residential', 'storage', 'warehouse')
          then coalesce(snapshot.monthly_rent_amount, 0)
        else 0
      end as monthly_rent_amount,
      coalesce(snapshot.monthly_common_charge_amount, 0) as monthly_common_charge_amount,
      case
        when unit.unit_type in ('office', 'retail', 'residential', 'storage', 'warehouse')
          then coalesce(snapshot.monthly_rent_amount, 0)
        else 0
      end + coalesce(snapshot.monthly_common_charge_amount, 0) as rent_common_total_amount,
      case
        when unit.unit_type = 'parking' then coalesce(parking_fee.monthly_parking_fee, 0)
        else 0
      end as monthly_parking_amount,
      case
        when unit.unit_type not in ('office', 'retail', 'residential', 'storage', 'warehouse', 'parking')
          then coalesce(snapshot.monthly_rent_amount, 0)
        else 0
      end as other_monthly_amount,
      case
        when unit.unit_type in ('office', 'retail', 'residential', 'storage', 'warehouse')
          then coalesce(snapshot.monthly_rent_amount, 0)
        else 0
      end
      + coalesce(snapshot.monthly_common_charge_amount, 0)
      + case when unit.unit_type = 'parking' then coalesce(parking_fee.monthly_parking_fee, 0) else 0 end
      + case
          when unit.unit_type not in ('office', 'retail', 'residential', 'storage', 'warehouse', 'parking')
            then coalesce(snapshot.monthly_rent_amount, 0)
          else 0
        end as monthly_total_amount,
      coalesce(snapshot.deposit_amount, 0) as deposit_amount,
      coalesce(snapshot.security_deposit_amount, 0) as security_deposit_amount,
      coalesce(snapshot.key_money_amount, 0) as key_money_amount,
      coalesce(snapshot.renewal_fee_amount, 0) as renewal_fee_amount,
      case
        when unit.unit_type <> 'parking' then null
        when coalesce(space_availability.availability_status, 'available') = 'unavailable' then 'unavailable'
        when snapshot.lease_contract_id is not null then 'occupied'
        else 'vacant'
      end as space_status,
      parking_space.space_number,
      coalesce(parking_fee.parking_scope, parking_detail.parking_scope) as parking_scope,
      coalesce(parking_fee.monthly_parking_fee, 0) as monthly_parking_fee,
      parking_fee.effective_from as parking_fee_effective_from,
      assignment.access_code,
      vehicle.vehicle_model,
      vehicle.registration_number
    from public.unit_master unit
    left join public.lease_contract_unit_snapshot_at_date(p_property_id, p_as_of_date) snapshot
      on snapshot.unit_id = unit.unit_id
    left join public.unit_leasing_status leasing on leasing.unit_id = unit.unit_id
    left join public.parking_space_master parking_space on parking_space.unit_id = unit.unit_id
    left join public.parking_contract_detail parking_detail on parking_detail.lease_contract_id = snapshot.lease_contract_id
    left join lateral (
      select history.parking_scope, history.monthly_parking_fee, history.effective_from
      from public.parking_fee_history history
      where history.parking_lease_contract_unit_id = snapshot.lease_contract_unit_id
        and history.effective_from <= p_as_of_date
        and (history.effective_to is null or history.effective_to >= p_as_of_date)
      order by history.effective_from desc limit 1
    ) parking_fee on true
    left join lateral (
      select status_history.availability_status
      from public.parking_space_status_history status_history
      where status_history.unit_id = unit.unit_id and status_history.effective_from <= p_as_of_date
      order by status_history.effective_from desc, status_history.created_at desc limit 1
    ) space_availability on true
    left join public.parking_space_assignment assignment on assignment.lease_contract_unit_id = snapshot.lease_contract_unit_id
    left join lateral (
      select history.vehicle_model, history.registration_number
      from public.parking_vehicle_history history
      where history.lease_contract_unit_id = snapshot.lease_contract_unit_id
        and history.effective_from <= p_as_of_date
        and (history.effective_to is null or history.effective_to >= p_as_of_date)
      order by history.effective_from desc, history.created_at desc limit 1
    ) vehicle on true
    where unit.property_id = p_property_id and unit.is_active
  ) result_row;
$function$;

comment on function public.rent_roll_list_at_date(uuid, date) is
  '貸室・倉庫の賃料、共益費、駐車場代、その他月額を独立項目として返す。駐車場代を賃料から差し引かない。';
