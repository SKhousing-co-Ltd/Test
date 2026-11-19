CREATE OR REPLACE FUNCTION public.parking_list_at_date(p_property_id uuid, p_as_of_date date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
      coalesce(fee.monthly_parking_fee, 0) as monthly_parking_fee,
      fee.effective_from as parking_fee_effective_from,
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

CREATE OR REPLACE FUNCTION public.validate_parking_contract_detail()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  child_contract public.lease_contract%rowtype;
  main_contract public.lease_contract%rowtype;
begin
  select * into child_contract from public.lease_contract where lease_contract_id = new.lease_contract_id;
  if not found or child_contract.contract_type is null or child_contract.contract_type not in ('parking', 'bicycle_parking') then
    raise exception '駐車場・駐輪場契約である必要があります';
  end if;

  if new.parking_scope = 'external' then
    return new;
  end if;

  select * into main_contract from public.lease_contract where lease_contract_id = new.main_lease_contract_id;
  if not found then raise exception '主契約が見つかりません'; end if;
  if main_contract.contract_type in ('parking', 'bicycle_parking') or exists (
    select 1 from public.parking_contract_detail where lease_contract_id = main_contract.lease_contract_id
  ) then raise exception '駐車場契約を主契約には指定できません'; end if;
  if main_contract.tenant_id <> child_contract.tenant_id then raise exception '主契約と駐車場契約のテナントが一致しません'; end if;
  if not exists (
    select 1 from public.lease_contract_unit contract_unit
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
    where contract_unit.lease_contract_id = main_contract.lease_contract_id
      and unit.property_id = new.property_id and unit.unit_type not in ('parking', 'bicycle_parking')
  ) then raise exception '同一物件の非駐車場区画を持つ主契約を指定してください'; end if;
  if child_contract.contract_start_date is not null and main_contract.contract_end_date is not null
     and child_contract.contract_start_date > main_contract.contract_end_date then
    raise exception '駐車場契約の開始日が主契約の終了日より後です';
  end if;
  if child_contract.contract_end_date is not null and main_contract.contract_start_date is not null
     and child_contract.contract_end_date < main_contract.contract_start_date then
    raise exception '駐車場契約の終了日が主契約の開始日より前です';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_parking_fee_main_contract_candidates(p_parking_lease_contract_unit_id uuid, p_effective_from date, p_parking_contract_end_date date)
 RETURNS TABLE(lease_contract_unit_id uuid, unit_code text, unit_name text, lease_start_date date, lease_end_date date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare parking_tenant_id uuid; parking_property_id uuid;
begin
  if auth.uid() is null or not (select public.current_account_is_active()) or (select public.current_account_role()) not in ('admin', 'manager') then raise exception '駐車料金の主契約候補を参照する権限がありません'; end if;
  if p_effective_from is null or p_parking_contract_end_date is null or p_parking_contract_end_date < p_effective_from then raise exception '主契約候補の判定期間が不正です'; end if;
  select contract.tenant_id, unit.property_id into parking_tenant_id, parking_property_id from public.lease_contract_unit contract_unit join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id join public.unit_master unit on unit.unit_id = contract_unit.unit_id join public.parking_contract_detail detail on detail.lease_contract_id = contract.lease_contract_id where contract_unit.lease_contract_unit_id = p_parking_lease_contract_unit_id and contract.contract_type in ('parking', 'bicycle_parking') and unit.unit_type in ('parking', 'bicycle_parking');
  if not found then raise exception '対象の駐車場契約区画が見つかりません'; end if;
  return query select candidate.lease_contract_unit_id, main_unit.unit_code::text, main_unit.unit_name::text, coalesce(candidate.lease_start_date, main_contract.contract_start_date), coalesce(candidate.lease_end_date, main_contract.contract_end_date) from public.lease_contract_unit candidate join public.lease_contract main_contract on main_contract.lease_contract_id = candidate.lease_contract_id join public.unit_master main_unit on main_unit.unit_id = candidate.unit_id where main_contract.tenant_id = parking_tenant_id and main_unit.property_id = parking_property_id and main_unit.unit_type not in ('parking', 'bicycle_parking') and coalesce(candidate.lease_start_date, main_contract.contract_start_date) <= p_effective_from and coalesce(candidate.lease_end_date, main_contract.contract_end_date, 'infinity'::date) >= p_parking_contract_end_date order by main_unit.unit_code, candidate.lease_contract_unit_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_parking_fee_history_base(p_parking_lease_contract_unit_id uuid, p_parking_scope text, p_main_lease_contract_id uuid, p_monthly_parking_fee numeric, p_effective_from date, p_source_import_batch_id uuid DEFAULT NULL::uuid, p_source_import_row_id uuid DEFAULT NULL::uuid, p_source_file_name text DEFAULT NULL::text, p_source_sheet_name text DEFAULT NULL::text, p_source_row_number integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  parking_contract_id uuid;
  parking_tenant_id uuid;
  parking_property_id uuid;
  parking_start date;
  parking_end date;
  target_main_unit_id uuid;
  target_count integer;
  main_start date;
  main_end date;
  next_start date;
  history_end date;
  result_id uuid;
begin
  if not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車料の編集は管理者またはマネージャーのみ実行できます';
  end if;
  if p_parking_scope not in ('internal', 'external') then raise exception '内部・外部を選択してください'; end if;
  if p_monthly_parking_fee is null or p_monthly_parking_fee < 0 or trunc(p_monthly_parking_fee) <> p_monthly_parking_fee then
    raise exception '月額駐車料は0以上の整数で指定してください';
  end if;
  if p_effective_from is null then raise exception '駐車料の適用開始日は必須です'; end if;

  select contract.lease_contract_id, contract.tenant_id, facility.property_id,
         coalesce(contract_unit.lease_start_date, contract.contract_start_date),
         coalesce(contract_unit.lease_end_date, contract.contract_end_date)
    into parking_contract_id, parking_tenant_id, parking_property_id, parking_start, parking_end
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.parking_space_master space on space.unit_id = contract_unit.unit_id
  join public.parking_facility_master facility on facility.parking_facility_id = space.parking_facility_id
  where contract_unit.lease_contract_unit_id = p_parking_lease_contract_unit_id and contract.contract_type in ('parking', 'bicycle_parking')
  for update of contract_unit;
  if not found then raise exception '駐車場契約割当が見つかりません'; end if;
  if parking_start is not null and p_effective_from < parking_start then raise exception '駐車料の適用開始日は駐車場契約開始日以降を指定してください'; end if;
  if parking_end is not null and p_effective_from > parking_end then raise exception '駐車料の適用開始日は駐車場契約終了日以前を指定してください'; end if;

  select min(history.effective_from) into next_start
  from public.parking_fee_history history
  where history.parking_lease_contract_unit_id = p_parking_lease_contract_unit_id and history.effective_from > p_effective_from;
  history_end := case when next_start is not null and parking_end is not null then least(next_start - 1, parking_end)
    when next_start is not null then next_start - 1 else parking_end end;

  if p_parking_scope = 'internal' then
    if p_main_lease_contract_id is null then raise exception '内部契約では主契約を選択してください'; end if;
    select count(*), min(main_unit.lease_contract_unit_id::text)::uuid,
           min(coalesce(main_unit.lease_start_date, main_contract.contract_start_date)),
           max(coalesce(main_unit.lease_end_date, main_contract.contract_end_date))
      into target_count, target_main_unit_id, main_start, main_end
    from public.lease_contract main_contract
    join public.lease_contract_unit main_unit on main_unit.lease_contract_id = main_contract.lease_contract_id
    join public.unit_master unit on unit.unit_id = main_unit.unit_id
    where main_contract.lease_contract_id = p_main_lease_contract_id and main_contract.tenant_id = parking_tenant_id
      and unit.property_id = parking_property_id and unit.unit_type not in ('parking', 'bicycle_parking');
    if target_count = 0 then raise exception '同一物件・同一テナントの主契約区画が見つかりません'; end if;
    if target_count > 1 then raise exception '主契約に控除対象区画が複数あります。控除対象を一意にしてください'; end if;
    if main_start is not null and main_start > p_effective_from then raise exception '駐車開始日時点の過去主契約が不足しています（主契約開始日: %）', main_start; end if;
    if history_end is null and main_end is not null then raise exception '主契約終了後の駐車料控除先がありません（主契約終了日: %）', main_end; end if;
    if history_end is not null and main_end is not null and main_end < history_end then raise exception '駐車料の適用期間を主契約が全期間カバーしていません（主契約終了日: %）', main_end; end if;
  else
    if p_main_lease_contract_id is not null then raise exception '外部契約には主契約を指定できません'; end if;
    target_main_unit_id := null;
  end if;

  update public.parking_fee_history history
  set effective_to = p_effective_from - 1, updated_at = now()
  where history.parking_lease_contract_unit_id = p_parking_lease_contract_unit_id and history.effective_from < p_effective_from
    and (history.effective_to is null or history.effective_to >= p_effective_from);

  select parking_fee_history_id into result_id from public.parking_fee_history
  where parking_lease_contract_unit_id = p_parking_lease_contract_unit_id and effective_from = p_effective_from
  for update;
  if found then
    update public.parking_fee_history set
      parking_scope = p_parking_scope, main_lease_contract_unit_id = target_main_unit_id,
      monthly_parking_fee = p_monthly_parking_fee, effective_to = history_end,
      source_import_batch_id = p_source_import_batch_id, source_import_row_id = p_source_import_row_id,
      source_file_name = p_source_file_name, source_sheet_name = p_source_sheet_name,
      source_row_number = p_source_row_number, updated_at = now()
    where parking_fee_history_id = result_id;
  else
    insert into public.parking_fee_history (
      parking_lease_contract_unit_id, parking_scope, main_lease_contract_unit_id, monthly_parking_fee, effective_from, effective_to,
      source_import_batch_id, source_import_row_id, source_file_name, source_sheet_name, source_row_number, created_by
    ) values (
      p_parking_lease_contract_unit_id, p_parking_scope, target_main_unit_id, p_monthly_parking_fee, p_effective_from, history_end,
      p_source_import_batch_id, p_source_import_row_id, p_source_file_name, p_source_sheet_name, p_source_row_number, auth.uid()
    ) returning parking_fee_history_id into result_id;
  end if;
  return jsonb_build_object('parking_fee_history_id', result_id, 'main_lease_contract_unit_id', target_main_unit_id,
    'effective_from', p_effective_from, 'effective_to', history_end, 'monthly_parking_fee', p_monthly_parking_fee);
end;
$function$;

CREATE OR REPLACE FUNCTION private.apply_parking_fee_change_request(p_change_request_id uuid, p_expected_row_version integer, p_monthly_parking_fee numeric, p_effective_from date, p_parking_contract_end_date date, p_main_lease_contract_unit_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'private'
AS $function$
declare request_record public.change_request%rowtype; parking_lcu_id uuid; parking_scope text; parking_contract_id uuid; main_lcu_id uuid; main_contract_id uuid; candidate_count integer; parking_record record; contract_max_end date; all_contract_units_ended boolean;
begin
  if auth.uid() is null or not (select public.current_account_is_active()) or (select public.current_account_role()) not in ('admin', 'manager') then raise exception '駐車料金対応依頼の確定は管理者またはマネージャーだけが可能です'; end if;
  if p_monthly_parking_fee is null or p_monthly_parking_fee < 0 or trunc(p_monthly_parking_fee) <> p_monthly_parking_fee then raise exception '月額駐車料は0以上の整数で指定してください'; end if;
  if p_effective_from is null then raise exception '適用開始日を指定してください'; end if;
  select * into request_record from public.change_request request where request.change_request_id = p_change_request_id and request.request_type = 'parking_fee_setup' and request.status in ('open', 'in_review', 'on_hold') and request.row_version = p_expected_row_version for update;
  if not found then raise exception '対応依頼が最新状態か、確定可能な状態ではありません'; end if;
  select item.entity_id into parking_lcu_id from public.change_request_item item where item.change_request_id = p_change_request_id and item.entity_type = 'parking_fee_history' order by item.sort_order, item.created_at limit 1;
  if parking_lcu_id is null then raise exception '対象の駐車場契約区画が見つかりません'; end if;
  select detail.parking_scope, contract.lease_contract_id, contract.tenant_id, unit.property_id, coalesce(contract_unit.lease_start_date, contract.contract_start_date) as lease_start_date, contract_unit.lease_end_date into parking_record from public.lease_contract_unit contract_unit join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id join public.unit_master unit on unit.unit_id = contract_unit.unit_id join public.parking_contract_detail detail on detail.lease_contract_id = contract.lease_contract_id where contract_unit.lease_contract_unit_id = parking_lcu_id and contract.contract_type in ('parking', 'bicycle_parking') and unit.unit_type in ('parking', 'bicycle_parking') for update of contract_unit, contract;
  if not found then raise exception '駐車場契約区画が見つかりません'; end if;
  if p_parking_contract_end_date is null then raise exception '駐車場契約の終了日が未設定です。終了日を入力してください'; end if;
  if p_parking_contract_end_date < p_effective_from then raise exception '駐車場契約の終了日は適用開始日以降を指定してください'; end if;
  if parking_record.lease_start_date is not null and p_parking_contract_end_date < parking_record.lease_start_date then raise exception '駐車場契約の終了日は契約開始日以降を指定してください'; end if;
  parking_scope := parking_record.parking_scope; parking_contract_id := parking_record.lease_contract_id;
  update public.lease_contract_unit contract_unit set lease_end_date = p_parking_contract_end_date, updated_at = now() where contract_unit.lease_contract_unit_id = parking_lcu_id;
  select max(contract_unit.lease_end_date), bool_and(contract_unit.lease_end_date is not null) into contract_max_end, all_contract_units_ended from public.lease_contract_unit contract_unit where contract_unit.lease_contract_id = parking_contract_id;
  update public.lease_contract contract set contract_end_date = case when coalesce(all_contract_units_ended, false) then contract_max_end else null end, updated_at = now() where contract.lease_contract_id = parking_contract_id and contract.contract_type in ('parking', 'bicycle_parking');
  if parking_scope = 'internal' then
    main_lcu_id := p_main_lease_contract_unit_id;
    if main_lcu_id is null then
      select count(*), (array_agg(candidate.lease_contract_unit_id order by candidate.lease_contract_unit_id))[1] into candidate_count, main_lcu_id from public.lease_contract_unit candidate join public.lease_contract main_contract on main_contract.lease_contract_id = candidate.lease_contract_id join public.unit_master main_unit on main_unit.unit_id = candidate.unit_id where main_contract.tenant_id = parking_record.tenant_id and main_unit.property_id = parking_record.property_id and main_unit.unit_type not in ('parking', 'bicycle_parking') and coalesce(candidate.lease_start_date, main_contract.contract_start_date) <= p_effective_from and coalesce(candidate.lease_end_date, main_contract.contract_end_date, 'infinity'::date) >= p_parking_contract_end_date;
      if candidate_count <> 1 then raise exception '控除対象の主契約区画を1件選択してください（候補%件）', candidate_count; end if;
    elsif not exists (select 1 from public.lease_contract_unit candidate join public.lease_contract main_contract on main_contract.lease_contract_id = candidate.lease_contract_id join public.unit_master main_unit on main_unit.unit_id = candidate.unit_id where candidate.lease_contract_unit_id = main_lcu_id and main_contract.tenant_id = parking_record.tenant_id and main_unit.property_id = parking_record.property_id and main_unit.unit_type not in ('parking', 'bicycle_parking') and coalesce(candidate.lease_start_date, main_contract.contract_start_date) <= p_effective_from and coalesce(candidate.lease_end_date, main_contract.contract_end_date, 'infinity'::date) >= p_parking_contract_end_date) then raise exception '選択した主契約区画は駐車料の適用期間をカバーしていません'; end if;
    select contract_unit.lease_contract_id into main_contract_id from public.lease_contract_unit contract_unit where contract_unit.lease_contract_unit_id = main_lcu_id;
    if main_contract_id is null then raise exception '控除対象の主契約区画が見つかりません'; end if;
  else main_lcu_id := null; main_contract_id := null; end if;
  perform public.set_parking_fee_history(parking_lcu_id, parking_scope, main_contract_id, p_monthly_parking_fee, p_effective_from, null, null, '対応依頼', null, null);
  select * into request_record from public.change_request request where request.change_request_id = p_change_request_id;
  return to_jsonb(request_record);
end;
$function$;

CREATE OR REPLACE FUNCTION private.close_parking_fee_change_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'private'
AS $function$
declare
  target record;
  closed_request record;
  parking_contract_end_date date;
begin
  if auth.uid() is null
     or not public.current_account_is_active()
     or public.current_account_role() not in ('admin', 'manager') then
    raise exception '駐車料対応依頼の確定は管理者またはマネージャーだけが実行できます';
  end if;

  for target in
    select request.change_request_id, request.row_version
    from public.change_request as request
    where request.source_type = 'manual'
      and request.source_record_key = concat('parking-fee:', new.parking_lease_contract_unit_id)
      and request.request_type = 'parking_fee_setup'
      and request.status in ('open', 'in_review', 'on_hold')
    order by request.created_at
  loop
    perform private.recheck_change_request_internal(target.change_request_id, target.row_version);
  end loop;

  select contract_unit.lease_end_date
    into parking_contract_end_date
  from public.lease_contract_unit as contract_unit
  join public.lease_contract as contract
    on contract.lease_contract_id = contract_unit.lease_contract_id
  where contract_unit.lease_contract_unit_id = new.parking_lease_contract_unit_id
    and contract.contract_type in ('parking', 'bicycle_parking');

  update public.change_request_item as item
  set proposed_value = to_jsonb(new.monthly_parking_fee),
      validation_status = 'valid',
      validation_message = null,
      updated_at = now()
  from public.change_request as request
  where request.change_request_id = item.change_request_id
    and request.source_type = 'manual'
    and request.source_record_key = concat('parking-fee:', new.parking_lease_contract_unit_id)
    and request.request_type = 'parking_fee_setup'
    and request.status not in ('applied', 'excluded');

  for closed_request in
    update public.change_request as request
    set status = 'applied',
        resolved_at = now(),
        resolved_by = auth.uid(),
        applied_at = now(),
        applied_by = auth.uid(),
        resolution_payload = jsonb_build_object(
          'parking_fee_history_id', new.parking_fee_history_id,
          'monthly_parking_fee', new.monthly_parking_fee,
          'effective_from', new.effective_from,
          'parking_contract_end_date', parking_contract_end_date,
          'main_lease_contract_unit_id', new.main_lease_contract_unit_id
        ),
        row_version = request.row_version + 1,
        updated_by = auth.uid(),
        updated_at = now()
    where request.source_type = 'manual'
      and request.source_record_key = concat('parking-fee:', new.parking_lease_contract_unit_id)
      and request.request_type = 'parking_fee_setup'
      and request.status not in ('applied', 'excluded')
    returning request.change_request_id
  loop
    insert into public.change_request_action_log (
      change_request_id, action_type, previous_status, next_status, details, performed_by
    ) values (
      closed_request.change_request_id, 'applied', 'open', 'applied',
      jsonb_build_object(
        'parking_fee_history_id', new.parking_fee_history_id,
        'parking_contract_end_date', parking_contract_end_date
      ),
      auth.uid()
    );
  end loop;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.parking_fee_setup_state(p_parking_lease_contract_unit_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  parking_record record;
  resolved boolean;
  validation_message text;
begin
  select
    contract_unit.lease_contract_unit_id,
    contract_unit.lease_start_date,
    contract_unit.lease_end_date,
    contract.lease_contract_id,
    contract.tenant_id,
    tenant.tenant_name,
    unit.property_id,
    asset.asset_name,
    coalesce(space.space_number, unit.unit_code) as space_number,
    detail.parking_scope,
    detail.main_lease_contract_id,
    fee.parking_fee_history_id,
    fee.monthly_parking_fee,
    fee.effective_from,
    fee.main_lease_contract_unit_id
  into parking_record
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract
    on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  join public.asset_master asset on asset.asset_id = unit.property_id
  left join public.parking_space_master space on space.unit_id = unit.unit_id
  left join public.parking_contract_detail detail
    on detail.lease_contract_id = contract.lease_contract_id
  left join lateral (
    select history.parking_fee_history_id, history.monthly_parking_fee,
           history.effective_from, history.main_lease_contract_unit_id
    from public.parking_fee_history history
    where history.parking_lease_contract_unit_id = contract_unit.lease_contract_unit_id
    order by history.effective_from desc, history.created_at desc
    limit 1
  ) fee on true
  where contract_unit.lease_contract_unit_id = p_parking_lease_contract_unit_id
    and contract.contract_type in ('parking', 'bicycle_parking')
    and unit.unit_type in ('parking', 'bicycle_parking');

  if not found then
    return jsonb_build_object('supported', false, 'resolved', false);
  end if;

  resolved := parking_record.parking_fee_history_id is not null
    and parking_record.effective_from is not null
    and parking_record.lease_end_date is not null
    and (
      parking_record.parking_scope = 'external'
      or parking_record.main_lease_contract_unit_id is not null
    );
  validation_message := concat_ws('・',
    case when parking_record.parking_fee_history_id is null then '月額駐車料と適用開始日' end,
    case when parking_record.lease_end_date is null then '駐車場契約終了日' end,
    case when parking_record.parking_scope is null
           or parking_record.parking_scope not in ('internal', 'external')
         then '契約区分' end,
    case when parking_record.parking_scope = 'internal'
           and parking_record.main_lease_contract_unit_id is null
         then '控除対象の主契約区画' end
  );
  if not resolved then
    validation_message := concat(validation_message, 'を確認してください');
  end if;

  return jsonb_build_object(
    'supported', true,
    'resolved', resolved,
    'validation_message', validation_message,
    'lease_contract_unit_id', parking_record.lease_contract_unit_id,
    'lease_contract_id', parking_record.lease_contract_id,
    'lease_start_date', parking_record.lease_start_date,
    'lease_end_date', parking_record.lease_end_date,
    'tenant_id', parking_record.tenant_id,
    'tenant_name', parking_record.tenant_name,
    'property_id', parking_record.property_id,
    'property_name', parking_record.asset_name,
    'space_number', parking_record.space_number,
    'parking_scope', parking_record.parking_scope,
    'main_lease_contract_id', parking_record.main_lease_contract_id,
    'current_state', jsonb_strip_nulls(jsonb_build_object(
      'parking_fee_history_id', parking_record.parking_fee_history_id,
      'monthly_parking_fee', parking_record.monthly_parking_fee,
      'effective_from', parking_record.effective_from,
      'parking_contract_end_date', parking_record.lease_end_date,
      'main_lease_contract_unit_id', parking_record.main_lease_contract_unit_id
    ))
  );
end;
$function$;
