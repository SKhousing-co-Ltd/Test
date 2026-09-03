-- production migration 20260821041423: add_parking_registration_editor
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
begin
  if not (select public.current_account_is_active()) or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車場情報の編集は管理者またはマネージャーのみ実行できます';
  end if;
  if nullif(btrim(p_space_number), '') is null then raise exception '枠番は必須です'; end if;
  if coalesce(p_length_mm, 0) < 0 or coalesce(p_width_mm, 0) < 0 or coalesce(p_height_mm, 0) < 0 or coalesce(p_weight_limit_kg, 0) < 0 then
    raise exception '車両制限値に負の数は指定できません';
  end if;

  select facility.property_id, space.parking_facility_id into v_property_id, v_parking_facility_id
  from public.parking_space_master space
  join public.parking_facility_master facility on facility.parking_facility_id = space.parking_facility_id
  where space.unit_id = p_unit_id
  for update of space;
  if not found then raise exception '駐車枠が見つかりません'; end if;

  if exists (select 1 from public.parking_space_master other_space where other_space.parking_facility_id = v_parking_facility_id and other_space.space_number = btrim(p_space_number) and other_space.unit_id <> p_unit_id) then
    raise exception '同じ駐車場内に枠番 % が既に存在します', btrim(p_space_number);
  end if;

  update public.parking_space_master
  set space_number = btrim(p_space_number), length_mm = nullif(p_length_mm, 0), width_mm = nullif(p_width_mm, 0), height_mm = nullif(p_height_mm, 0), weight_limit_kg = nullif(p_weight_limit_kg, 0), updated_at = now()
  where unit_id = p_unit_id;

  if p_lease_contract_id is null then
    if p_lease_contract_unit_id is not null then raise exception '契約情報の指定が不整合です'; end if;
    return jsonb_build_object('unit_id', p_unit_id, 'occupied', false);
  end if;
  if p_lease_contract_unit_id is null then raise exception '契約中の区画には契約割当情報が必要です'; end if;
  if p_tenant_id is null then raise exception '契約先を選択してください'; end if;
  if p_parking_scope not in ('internal', 'external') then raise exception '内部・外部を選択してください'; end if;
  if p_contract_start_date is not null and p_contract_end_date is not null and p_contract_end_date < p_contract_start_date then raise exception '契約終了日は契約開始日以降を指定してください'; end if;
  if not exists (select 1 from public.lease_contract_unit contract_unit where contract_unit.lease_contract_unit_id = p_lease_contract_unit_id and contract_unit.lease_contract_id = p_lease_contract_id and contract_unit.unit_id = p_unit_id) then raise exception '駐車枠と契約の紐づきが一致しません'; end if;
  if not exists (select 1 from public.tenant_master tenant where tenant.tenant_id = p_tenant_id) then raise exception '契約先が見つかりません'; end if;

  if p_parking_scope = 'internal' then
    if p_main_lease_contract_id is null then raise exception '内部契約では主契約を選択してください'; end if;
    if not exists (select 1 from public.parking_main_contract_candidate candidate where candidate.property_id = v_property_id and candidate.tenant_id = p_tenant_id and candidate.lease_contract_id = p_main_lease_contract_id) then raise exception '選択した主契約は物件・契約先に紐づいていません'; end if;
  elsif p_main_lease_contract_id is not null then
    raise exception '外部契約には主契約を指定できません';
  end if;

  update public.lease_contract set tenant_id = p_tenant_id, contract_start_date = p_contract_start_date, contract_end_date = p_contract_end_date, updated_at = now() where lease_contract_id = p_lease_contract_id;
  update public.lease_contract_unit set lease_start_date = p_contract_start_date, lease_end_date = p_contract_end_date, updated_at = now() where lease_contract_unit_id = p_lease_contract_unit_id;
  update public.parking_contract_detail set parking_scope = p_parking_scope, main_lease_contract_id = case when p_parking_scope = 'internal' then p_main_lease_contract_id else null end, updated_at = now() where lease_contract_id = p_lease_contract_id;

  update public.parking_space_assignment set access_code = nullif(btrim(p_access_code), ''), notes = nullif(btrim(p_notes), ''), updated_at = now() where lease_contract_unit_id = p_lease_contract_unit_id;
  if not found then insert into public.parking_space_assignment (lease_contract_unit_id, access_code, notes) values (p_lease_contract_unit_id, nullif(btrim(p_access_code), ''), nullif(btrim(p_notes), '')); end if;

  select history.parking_vehicle_history_id into v_vehicle_history_id from public.parking_vehicle_history history where history.lease_contract_unit_id = p_lease_contract_unit_id order by history.effective_from desc, history.created_at desc limit 1 for update;
  v_vehicle_has_values := nullif(btrim(p_vehicle_model), '') is not null or nullif(btrim(p_registration_number), '') is not null or nullif(btrim(p_chassis_number), '') is not null;
  if v_vehicle_history_id is not null then
    update public.parking_vehicle_history set vehicle_model = nullif(btrim(p_vehicle_model), ''), registration_number = nullif(btrim(p_registration_number), ''), chassis_number = nullif(btrim(p_chassis_number), ''), effective_from = coalesce(p_vehicle_effective_from, effective_from), effective_to = p_vehicle_effective_to, updated_at = now() where parking_vehicle_history_id = v_vehicle_history_id;
  elsif v_vehicle_has_values then
    insert into public.parking_vehicle_history (lease_contract_unit_id, vehicle_model, registration_number, chassis_number, effective_from, effective_to, source_notes) values (p_lease_contract_unit_id, nullif(btrim(p_vehicle_model), ''), nullif(btrim(p_registration_number), ''), nullif(btrim(p_chassis_number), ''), coalesce(p_vehicle_effective_from, current_date), p_vehicle_effective_to, '駐車場詳細画面から登録');
  end if;

  return jsonb_build_object('unit_id', p_unit_id, 'lease_contract_id', p_lease_contract_id, 'occupied', true);
end;
$$;
