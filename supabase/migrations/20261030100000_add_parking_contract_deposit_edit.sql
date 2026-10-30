create or replace function public.update_parking_registration_with_target_unit(
  p_unit_id uuid,
  p_lease_contract_unit_id uuid,
  p_lease_contract_id uuid,
  p_space_number text,
  p_length_mm integer,
  p_width_mm integer,
  p_height_mm integer,
  p_weight_limit_kg integer,
  p_tenant_id uuid,
  p_parking_scope text,
  p_main_lease_contract_id uuid,
  p_main_lease_contract_unit_id uuid,
  p_contract_start_date date,
  p_contract_end_date date,
  p_access_code text,
  p_notes text,
  p_vehicle_model text,
  p_registration_number text,
  p_chassis_number text,
  p_vehicle_effective_from date,
  p_vehicle_effective_to date,
  p_monthly_parking_fee numeric,
  p_parking_fee_effective_from date,
  p_deposit_amount numeric,
  p_security_deposit_amount numeric
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  result jsonb;
begin
  result := public.update_parking_registration_with_target_unit(
    p_unit_id, p_lease_contract_unit_id, p_lease_contract_id, p_space_number,
    p_length_mm, p_width_mm, p_height_mm, p_weight_limit_kg,
    p_tenant_id, p_parking_scope, p_main_lease_contract_id,
    p_main_lease_contract_unit_id, p_contract_start_date, p_contract_end_date,
    p_access_code, p_notes, p_vehicle_model, p_registration_number,
    p_chassis_number, p_vehicle_effective_from, p_vehicle_effective_to,
    p_monthly_parking_fee, p_parking_fee_effective_from
  );

  if p_lease_contract_unit_id is not null then
    update public.lease_contract_unit
    set deposit_amount = p_deposit_amount,
        security_deposit_amount = p_security_deposit_amount,
        updated_at = now()
    where lease_contract_unit_id = p_lease_contract_unit_id
      and lease_contract_id = p_lease_contract_id;

    if not found then
      raise exception '駐車場契約区画が見つかりません';
    end if;
  end if;

  return result || jsonb_build_object(
    'deposit_amount', p_deposit_amount,
    'security_deposit_amount', p_security_deposit_amount
  );
end;
$$;

revoke all on function public.update_parking_registration_with_target_unit(uuid, uuid, uuid, text, integer, integer, integer, integer, uuid, text, uuid, uuid, date, date, text, text, text, text, text, date, date, numeric, date, numeric, numeric) from public, anon;
grant execute on function public.update_parking_registration_with_target_unit(uuid, uuid, uuid, text, integer, integer, integer, integer, uuid, text, uuid, uuid, date, date, text, text, text, text, text, date, date, numeric, date, numeric, numeric) to authenticated;
