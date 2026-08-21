create or replace function public.lease_contract_unit_snapshot_at_date(
  p_property_id uuid,
  p_as_of_date date
)
returns table (
  unit_id uuid,
  lease_contract_unit_id uuid,
  lease_contract_id uuid,
  contract_type text,
  contract_status text,
  contract_start_date date,
  contract_end_date date,
  lease_start_date date,
  lease_end_date date,
  tenant_id uuid,
  external_tenant_code text,
  tenant_name text,
  contract_notes text,
  leased_area_sqm numeric,
  monthly_rent_amount numeric,
  monthly_common_charge_amount numeric,
  monthly_total_amount numeric,
  deposit_amount numeric,
  security_deposit_amount numeric,
  key_money_amount numeric,
  renewal_fee_amount numeric
)
language sql
stable
security invoker
set search_path to 'public'
as $$
  select
    unit.unit_id,
    current_allocation.lease_contract_unit_id,
    current_allocation.lease_contract_id,
    current_allocation.contract_type,
    current_allocation.contract_status,
    current_allocation.contract_start_date,
    current_allocation.contract_end_date,
    current_allocation.lease_start_date,
    current_allocation.lease_end_date,
    current_allocation.tenant_id,
    current_allocation.external_tenant_code,
    current_allocation.tenant_name,
    current_allocation.contract_notes,
    current_allocation.leased_area_sqm,
    current_allocation.monthly_rent_amount,
    current_allocation.monthly_common_charge_amount,
    current_allocation.monthly_rent_amount + current_allocation.monthly_common_charge_amount as monthly_total_amount,
    current_allocation.deposit_amount,
    current_allocation.security_deposit_amount,
    current_allocation.key_money_amount,
    current_allocation.renewal_fee_amount
  from public.unit_master unit
  join lateral (
    select
      contract_unit.lease_contract_unit_id,
      contract.lease_contract_id,
      contract.contract_type::text as contract_type,
      contract.contract_status::text as contract_status,
      contract.contract_start_date,
      contract.contract_end_date,
      contract_unit.lease_start_date,
      contract_unit.lease_end_date,
      contract.tenant_id,
      tenant.external_tenant_code::text as external_tenant_code,
      tenant.tenant_name::text as tenant_name,
      contract.notes as contract_notes,
      contract_unit.leased_area_sqm,
      coalesce(term.monthly_rent_amount, contract_unit.monthly_rent_amount, 0::numeric) as monthly_rent_amount,
      coalesce(term.monthly_common_charge_amount, contract_unit.monthly_common_charge_amount, 0::numeric) as monthly_common_charge_amount,
      coalesce(term.deposit_amount, contract_unit.deposit_amount, 0::numeric) as deposit_amount,
      coalesce(term.security_deposit_amount, contract_unit.security_deposit_amount, 0::numeric) as security_deposit_amount,
      coalesce(term.key_money_amount, contract_unit.key_money_amount, 0::numeric) as key_money_amount,
      coalesce(term.renewal_fee_amount, contract_unit.renewal_fee_amount, 0::numeric) as renewal_fee_amount
    from public.lease_contract_unit contract_unit
    join public.lease_contract contract
      on contract.lease_contract_id = contract_unit.lease_contract_id
    join public.tenant_master tenant
      on tenant.tenant_id = contract.tenant_id
    left join public.lease_contract_amendment origin_amendment
      on origin_amendment.lease_contract_amendment_id = contract_unit.created_by_amendment_id
    left join lateral (
      select
        unit_term.monthly_rent_amount,
        unit_term.monthly_common_charge_amount,
        unit_term.deposit_amount,
        unit_term.security_deposit_amount,
        unit_term.key_money_amount,
        unit_term.renewal_fee_amount
      from public.lease_contract_unit_term unit_term
      left join public.lease_contract_amendment term_amendment
        on term_amendment.lease_contract_amendment_id = unit_term.lease_contract_amendment_id
      where unit_term.lease_contract_unit_id = contract_unit.lease_contract_unit_id
        and unit_term.effective_from <= p_as_of_date
        and (unit_term.effective_to is null or unit_term.effective_to >= p_as_of_date)
        and (unit_term.lease_contract_amendment_id is null or term_amendment.status = 'executed')
      order by unit_term.effective_from desc, unit_term.created_at desc
      limit 1
    ) term on true
    where contract_unit.unit_id = unit.unit_id
      and contract.contract_status <> 'draft'
      and (
        contract.contract_status = 'active'
        or (
          contract.contract_status in ('terminated', 'expired')
          and coalesce(contract_unit.lease_end_date, contract.contract_end_date) is not null
        )
      )
      and (contract.contract_start_date is null or contract.contract_start_date <= p_as_of_date)
      and (contract.contract_end_date is null or contract.contract_end_date >= p_as_of_date)
      and (contract_unit.lease_start_date is null or contract_unit.lease_start_date <= p_as_of_date)
      and (contract_unit.lease_end_date is null or contract_unit.lease_end_date >= p_as_of_date)
      and (contract_unit.created_by_amendment_id is null or origin_amendment.status = 'executed')
    order by coalesce(contract_unit.lease_start_date, contract.contract_start_date) desc nulls last,
      contract_unit.created_at desc
    limit 1
  ) current_allocation on true
  where unit.property_id = p_property_id
    and unit.is_active;
$$;

revoke execute on function public.lease_contract_unit_snapshot_at_date(uuid, date) from public, anon;
grant execute on function public.lease_contract_unit_snapshot_at_date(uuid, date) to authenticated;

create or replace function public.parking_list_at_date(p_property_id uuid, p_as_of_date date)
returns jsonb
language sql
stable
security invoker
set search_path to 'public'
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
      active_lease.lease_start_date as contract_start_date,
      active_lease.lease_end_date as contract_end_date,
      active_lease.tenant_id,
      active_lease.tenant_name,
      detail.parking_scope,
      detail.main_lease_contract_id,
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
    left join public.lease_contract_unit_snapshot_at_date(p_property_id, p_as_of_date) active_lease
      on active_lease.unit_id = space.unit_id
      and active_lease.contract_type = 'parking'
    left join public.parking_contract_detail detail
      on detail.lease_contract_id = active_lease.lease_contract_id
    left join public.lease_contract main_contract
      on main_contract.lease_contract_id = detail.main_lease_contract_id
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

create or replace function public.update_parking_registration(
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
  p_contract_start_date date,
  p_contract_end_date date,
  p_access_code text,
  p_notes text,
  p_vehicle_model text,
  p_registration_number text,
  p_chassis_number text,
  p_vehicle_effective_from date,
  p_vehicle_effective_to date
)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_property_id uuid;
  v_parking_facility_id uuid;
  v_vehicle_history_id uuid;
  v_vehicle_has_values boolean;
  v_contract_min_start date;
  v_contract_max_end date;
  v_all_units_ended boolean;
begin
  if not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車場情報の編集は管理者またはマネージャーのみ実行できます';
  end if;

  if nullif(btrim(p_space_number), '') is null then
    raise exception '枠番は必須です';
  end if;

  if coalesce(p_length_mm, 0) < 0
     or coalesce(p_width_mm, 0) < 0
     or coalesce(p_height_mm, 0) < 0
     or coalesce(p_weight_limit_kg, 0) < 0 then
    raise exception '車両制限値に負の数は指定できません';
  end if;

  select facility.property_id, space.parking_facility_id
    into v_property_id, v_parking_facility_id
  from public.parking_space_master space
  join public.parking_facility_master facility
    on facility.parking_facility_id = space.parking_facility_id
  where space.unit_id = p_unit_id
  for update of space;

  if not found then
    raise exception '駐車枠が見つかりません';
  end if;

  if exists (
    select 1
    from public.parking_space_master other_space
    where other_space.parking_facility_id = v_parking_facility_id
      and other_space.space_number = btrim(p_space_number)
      and other_space.unit_id <> p_unit_id
  ) then
    raise exception '同じ駐車場内に枠番 % が既に存在します', btrim(p_space_number);
  end if;

  update public.parking_space_master
  set space_number = btrim(p_space_number),
      length_mm = nullif(p_length_mm, 0),
      width_mm = nullif(p_width_mm, 0),
      height_mm = nullif(p_height_mm, 0),
      weight_limit_kg = nullif(p_weight_limit_kg, 0),
      updated_at = now()
  where unit_id = p_unit_id;

  if p_lease_contract_id is null then
    if p_lease_contract_unit_id is not null then
      raise exception '契約情報の指定が不整合です';
    end if;
    return jsonb_build_object('unit_id', p_unit_id, 'occupied', false);
  end if;

  if p_lease_contract_unit_id is null then
    raise exception '契約中の区画には契約割当情報が必要です';
  end if;

  if p_tenant_id is null then
    raise exception '契約先を選択してください';
  end if;

  if p_parking_scope not in ('internal', 'external') then
    raise exception '内部・外部を選択してください';
  end if;

  if p_contract_start_date is not null
     and p_contract_end_date is not null
     and p_contract_end_date < p_contract_start_date then
    raise exception '区画利用終了日は区画利用開始日以降を指定してください';
  end if;

  if not exists (
    select 1
    from public.lease_contract_unit contract_unit
    where contract_unit.lease_contract_unit_id = p_lease_contract_unit_id
      and contract_unit.lease_contract_id = p_lease_contract_id
      and contract_unit.unit_id = p_unit_id
  ) then
    raise exception '駐車枠と契約の紐づきが一致しません';
  end if;

  if not exists (
    select 1 from public.tenant_master tenant where tenant.tenant_id = p_tenant_id
  ) then
    raise exception '契約先が見つかりません';
  end if;

  if p_parking_scope = 'internal' then
    if p_main_lease_contract_id is null then
      raise exception '内部契約では主契約を選択してください';
    end if;
    if not exists (
      select 1
      from public.parking_main_contract_candidate candidate
      where candidate.property_id = v_property_id
        and candidate.tenant_id = p_tenant_id
        and candidate.lease_contract_id = p_main_lease_contract_id
    ) then
      raise exception '選択した主契約は物件・契約先に紐づいていません';
    end if;
  elsif p_main_lease_contract_id is not null then
    raise exception '外部契約には主契約を指定できません';
  end if;

  update public.lease_contract_unit
  set lease_start_date = p_contract_start_date,
      lease_end_date = p_contract_end_date,
      updated_at = now()
  where lease_contract_unit_id = p_lease_contract_unit_id;

  select
    min(contract_unit.lease_start_date),
    max(contract_unit.lease_end_date),
    bool_and(contract_unit.lease_end_date is not null)
    into v_contract_min_start, v_contract_max_end, v_all_units_ended
  from public.lease_contract_unit contract_unit
  where contract_unit.lease_contract_id = p_lease_contract_id;

  update public.lease_contract
  set tenant_id = p_tenant_id,
      contract_start_date = coalesce(v_contract_min_start, contract_start_date),
      contract_end_date = case when coalesce(v_all_units_ended, false) then v_contract_max_end else null end,
      updated_at = now()
  where lease_contract_id = p_lease_contract_id;

  update public.parking_contract_detail
  set parking_scope = p_parking_scope,
      main_lease_contract_id = case when p_parking_scope = 'internal' then p_main_lease_contract_id else null end,
      updated_at = now()
  where lease_contract_id = p_lease_contract_id;

  update public.parking_space_assignment
  set access_code = nullif(btrim(p_access_code), ''),
      notes = nullif(btrim(p_notes), ''),
      updated_at = now()
  where lease_contract_unit_id = p_lease_contract_unit_id;

  if not found then
    insert into public.parking_space_assignment (
      lease_contract_unit_id,
      access_code,
      notes
    ) values (
      p_lease_contract_unit_id,
      nullif(btrim(p_access_code), ''),
      nullif(btrim(p_notes), '')
    );
  end if;

  select history.parking_vehicle_history_id
    into v_vehicle_history_id
  from public.parking_vehicle_history history
  where history.lease_contract_unit_id = p_lease_contract_unit_id
  order by history.effective_from desc, history.created_at desc
  limit 1
  for update;

  v_vehicle_has_values := nullif(btrim(p_vehicle_model), '') is not null
    or nullif(btrim(p_registration_number), '') is not null
    or nullif(btrim(p_chassis_number), '') is not null;

  if v_vehicle_history_id is not null then
    update public.parking_vehicle_history
    set vehicle_model = nullif(btrim(p_vehicle_model), ''),
        registration_number = nullif(btrim(p_registration_number), ''),
        chassis_number = nullif(btrim(p_chassis_number), ''),
        effective_from = coalesce(p_vehicle_effective_from, effective_from),
        effective_to = p_vehicle_effective_to,
        updated_at = now()
    where parking_vehicle_history_id = v_vehicle_history_id;
  elsif v_vehicle_has_values then
    insert into public.parking_vehicle_history (
      lease_contract_unit_id,
      vehicle_model,
      registration_number,
      chassis_number,
      effective_from,
      effective_to,
      source_notes
    ) values (
      p_lease_contract_unit_id,
      nullif(btrim(p_vehicle_model), ''),
      nullif(btrim(p_registration_number), ''),
      nullif(btrim(p_chassis_number), ''),
      coalesce(p_vehicle_effective_from, current_date),
      p_vehicle_effective_to,
      '駐車場詳細画面から登録'
    );
  end if;

  return jsonb_build_object(
    'unit_id', p_unit_id,
    'lease_contract_id', p_lease_contract_id,
    'lease_contract_unit_id', p_lease_contract_unit_id,
    'occupied', true
  );
end;
$$;
