create or replace function public.set_parking_fee_history_base_for_unit(
  p_parking_lease_contract_unit_id uuid,
  p_parking_scope text,
  p_main_lease_contract_id uuid,
  p_main_lease_contract_unit_id uuid,
  p_monthly_parking_fee numeric,
  p_effective_from date,
  p_source_import_batch_id uuid default null,
  p_source_import_row_id uuid default null,
  p_source_file_name text default null,
  p_source_sheet_name text default null,
  p_source_row_number integer default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  parking_contract_id uuid;
  parking_tenant_id uuid;
  parking_property_id uuid;
  parking_start date;
  parking_end date;
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
  where contract_unit.lease_contract_unit_id = p_parking_lease_contract_unit_id
    and contract.contract_type = 'parking'
  for update of contract_unit;
  if not found then raise exception '駐車場契約割当が見つかりません'; end if;
  if parking_start is not null and p_effective_from < parking_start then raise exception '駐車料の適用開始日は駐車場契約開始日以降を指定してください'; end if;
  if parking_end is not null and p_effective_from > parking_end then raise exception '駐車料の適用開始日は駐車場契約終了日以前を指定してください'; end if;

  select min(history.effective_from) into next_start
  from public.parking_fee_history history
  where history.parking_lease_contract_unit_id = p_parking_lease_contract_unit_id
    and history.effective_from > p_effective_from;
  history_end := case
    when next_start is not null and parking_end is not null then least(next_start - 1, parking_end)
    when next_start is not null then next_start - 1
    else parking_end
  end;

  if p_parking_scope = 'internal' then
    if p_main_lease_contract_id is null or p_main_lease_contract_unit_id is null then
      raise exception '内部契約では主契約と控除対象区画を選択してください';
    end if;
    select coalesce(main_unit.lease_start_date, main_contract.contract_start_date),
           coalesce(main_unit.lease_end_date, main_contract.contract_end_date)
      into main_start, main_end
    from public.lease_contract main_contract
    join public.lease_contract_unit main_unit
      on main_unit.lease_contract_id = main_contract.lease_contract_id
     and main_unit.lease_contract_unit_id = p_main_lease_contract_unit_id
    join public.unit_master unit on unit.unit_id = main_unit.unit_id
    where main_contract.lease_contract_id = p_main_lease_contract_id
      and main_contract.tenant_id = parking_tenant_id
      and unit.property_id = parking_property_id
      and unit.unit_type <> 'parking';
    if not found then raise exception '控除対象区画は主契約・契約先・物件に紐づいていません'; end if;
    if main_start is not null and main_start > p_effective_from then raise exception '駐車開始日時点の主契約が不足しています（主契約開始日: %）', main_start; end if;
    if history_end is null and main_end is not null then raise exception '主契約終了後の駐車料控除先がありません（主契約終了日: %）', main_end; end if;
    if history_end is not null and main_end is not null and main_end < history_end then raise exception '駐車料の適用期間を主契約が全期間カバーしていません（主契約終了日: %）', main_end; end if;
  else
    if p_main_lease_contract_id is not null or p_main_lease_contract_unit_id is not null then
      raise exception '外部契約には主契約・控除対象区画を指定できません';
    end if;
  end if;

  update public.parking_fee_history history
  set effective_to = p_effective_from - 1, updated_at = now()
  where history.parking_lease_contract_unit_id = p_parking_lease_contract_unit_id
    and history.effective_from < p_effective_from
    and (history.effective_to is null or history.effective_to >= p_effective_from);

  select parking_fee_history_id into result_id
  from public.parking_fee_history
  where parking_lease_contract_unit_id = p_parking_lease_contract_unit_id
    and effective_from = p_effective_from
  for update;
  if found then
    update public.parking_fee_history set
      parking_scope = p_parking_scope,
      main_lease_contract_unit_id = case when p_parking_scope = 'internal' then p_main_lease_contract_unit_id else null end,
      monthly_parking_fee = p_monthly_parking_fee,
      effective_to = history_end,
      source_import_batch_id = p_source_import_batch_id,
      source_import_row_id = p_source_import_row_id,
      source_file_name = p_source_file_name,
      source_sheet_name = p_source_sheet_name,
      source_row_number = p_source_row_number,
      updated_at = now()
    where parking_fee_history_id = result_id;
  else
    insert into public.parking_fee_history (
      parking_lease_contract_unit_id, parking_scope, main_lease_contract_unit_id,
      monthly_parking_fee, effective_from, effective_to,
      source_import_batch_id, source_import_row_id, source_file_name,
      source_sheet_name, source_row_number, created_by
    ) values (
      p_parking_lease_contract_unit_id, p_parking_scope,
      case when p_parking_scope = 'internal' then p_main_lease_contract_unit_id else null end,
      p_monthly_parking_fee, p_effective_from, history_end,
      p_source_import_batch_id, p_source_import_row_id, p_source_file_name,
      p_source_sheet_name, p_source_row_number, auth.uid()
    ) returning parking_fee_history_id into result_id;
  end if;
  return jsonb_build_object(
    'parking_fee_history_id', result_id,
    'main_lease_contract_unit_id', case when p_parking_scope = 'internal' then p_main_lease_contract_unit_id else null end,
    'effective_from', p_effective_from,
    'effective_to', history_end,
    'monthly_parking_fee', p_monthly_parking_fee
  );
end;
$$;

create or replace function public.set_parking_fee_history_for_unit(
  p_parking_lease_contract_unit_id uuid,
  p_parking_scope text,
  p_main_lease_contract_id uuid,
  p_main_lease_contract_unit_id uuid,
  p_monthly_parking_fee numeric,
  p_effective_from date,
  p_source_import_batch_id uuid default null,
  p_source_import_row_id uuid default null,
  p_source_file_name text default null,
  p_source_sheet_name text default null,
  p_source_row_number integer default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  main_start date;
  external_result jsonb;
  internal_result jsonb;
  external_end date;
begin
  if p_parking_scope <> 'internal' or p_main_lease_contract_id is null then
    return public.set_parking_fee_history_base_for_unit(
      p_parking_lease_contract_unit_id, p_parking_scope, p_main_lease_contract_id,
      p_main_lease_contract_unit_id, p_monthly_parking_fee, p_effective_from,
      p_source_import_batch_id, p_source_import_row_id, p_source_file_name,
      p_source_sheet_name, p_source_row_number
    );
  end if;

  select coalesce(main_unit.lease_start_date, main_contract.contract_start_date)
    into main_start
  from public.lease_contract main_contract
  join public.lease_contract_unit main_unit
    on main_unit.lease_contract_id = main_contract.lease_contract_id
   and main_unit.lease_contract_unit_id = p_main_lease_contract_unit_id
  join public.unit_master unit on unit.unit_id = main_unit.unit_id
  join public.lease_contract_unit parking_unit
    on parking_unit.lease_contract_unit_id = p_parking_lease_contract_unit_id
  join public.lease_contract parking_contract
    on parking_contract.lease_contract_id = parking_unit.lease_contract_id
  join public.parking_space_master parking_space on parking_space.unit_id = parking_unit.unit_id
  join public.parking_facility_master facility on facility.parking_facility_id = parking_space.parking_facility_id
  where main_contract.lease_contract_id = p_main_lease_contract_id
    and main_contract.tenant_id = parking_contract.tenant_id
    and unit.property_id = facility.property_id
    and unit.unit_type <> 'parking';
  if not found then raise exception '控除対象区画は主契約・契約先・物件に紐づいていません'; end if;

  if main_start is null or p_effective_from >= main_start then
    return public.set_parking_fee_history_base_for_unit(
      p_parking_lease_contract_unit_id, p_parking_scope, p_main_lease_contract_id,
      p_main_lease_contract_unit_id, p_monthly_parking_fee, p_effective_from,
      p_source_import_batch_id, p_source_import_row_id, p_source_file_name,
      p_source_sheet_name, p_source_row_number
    );
  end if;

  external_result := public.set_parking_fee_history_base_for_unit(
    p_parking_lease_contract_unit_id, 'external', null, null,
    p_monthly_parking_fee, p_effective_from, p_source_import_batch_id,
    p_source_import_row_id, p_source_file_name, p_source_sheet_name, p_source_row_number
  );
  external_end := nullif(external_result ->> 'effective_to', '')::date;

  if external_end is null or main_start <= external_end then
    internal_result := public.set_parking_fee_history_base_for_unit(
      p_parking_lease_contract_unit_id, 'internal', p_main_lease_contract_id,
      p_main_lease_contract_unit_id, p_monthly_parking_fee, main_start,
      p_source_import_batch_id, p_source_import_row_id, p_source_file_name,
      p_source_sheet_name, p_source_row_number
    );
  end if;
  return jsonb_build_object(
    'pre_main_period_as_external', true,
    'external_history', external_result,
    'internal_history', internal_result
  );
end;
$$;

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
  p_parking_fee_effective_from date
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  result jsonb;
begin
  if p_lease_contract_id is not null and p_monthly_parking_fee is null then
    raise exception '契約中の区画には月額駐車料が必要です';
  end if;
  if p_parking_scope = 'internal' and p_lease_contract_unit_id is not null
     and (p_main_lease_contract_id is null or p_main_lease_contract_unit_id is null) then
    raise exception '内部契約では主契約と控除対象区画を選択してください';
  end if;
  if p_parking_scope = 'external' and p_main_lease_contract_unit_id is not null then
    raise exception '外部契約には控除対象区画を指定できません';
  end if;

  result := public.update_parking_registration_without_fee(
    p_unit_id, p_lease_contract_unit_id, p_lease_contract_id, p_space_number,
    p_length_mm, p_width_mm, p_height_mm, p_weight_limit_kg,
    p_tenant_id, p_parking_scope, p_main_lease_contract_id,
    p_contract_start_date, p_contract_end_date, p_access_code, p_notes,
    p_vehicle_model, p_registration_number, p_chassis_number,
    p_vehicle_effective_from, p_vehicle_effective_to
  );

  if p_lease_contract_unit_id is not null then
    perform public.set_parking_fee_history_for_unit(
      p_lease_contract_unit_id, p_parking_scope,
      case when p_parking_scope = 'internal' then p_main_lease_contract_id else null end,
      case when p_parking_scope = 'internal' then p_main_lease_contract_unit_id else null end,
      p_monthly_parking_fee,
      coalesce(p_parking_fee_effective_from, p_contract_start_date, current_date),
      null, null, '駐車場詳細画面', null, null
    );
  end if;
  return result || jsonb_build_object('monthly_parking_fee', p_monthly_parking_fee);
end;
$$;

revoke all on function public.set_parking_fee_history_base_for_unit(uuid, text, uuid, uuid, numeric, date, uuid, uuid, text, text, integer) from public, anon;
revoke all on function public.set_parking_fee_history_for_unit(uuid, text, uuid, uuid, numeric, date, uuid, uuid, text, text, integer) from public, anon;
revoke all on function public.update_parking_registration_with_target_unit(uuid, uuid, uuid, text, integer, integer, integer, integer, uuid, text, uuid, uuid, date, date, text, text, text, text, text, date, date, numeric, date) from public, anon;
grant execute on function public.set_parking_fee_history_base_for_unit(uuid, text, uuid, uuid, numeric, date, uuid, uuid, text, text, integer) to authenticated;
grant execute on function public.set_parking_fee_history_for_unit(uuid, text, uuid, uuid, numeric, date, uuid, uuid, text, text, integer) to authenticated;
grant execute on function public.update_parking_registration_with_target_unit(uuid, uuid, uuid, text, integer, integer, integer, integer, uuid, text, uuid, uuid, date, date, text, text, text, text, text, date, date, numeric, date) to authenticated;
