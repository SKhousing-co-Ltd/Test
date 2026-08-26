-- Avoid PL/pgSQL column/variable ambiguity while preserving the public helper's
-- existing contract-id parameter used by parking imports and detail editing.

create or replace function public.set_parking_fee_history(
  p_parking_lease_contract_unit_id uuid,
  p_parking_scope text,
  p_main_lease_contract_id uuid,
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
  target_main_unit_id uuid;
  target_count integer;
  main_start date;
  main_end date;
  next_start date;
  history_end date;
  gross_main_rent numeric;
  other_fee_total numeric;
  result_id uuid;
begin
  if not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車料の編集は管理者またはマネージャーのみ実行できます';
  end if;
  if p_parking_scope not in ('internal', 'external') then
    raise exception '内部・外部を選択してください';
  end if;
  if p_monthly_parking_fee is null or p_monthly_parking_fee < 0
     or trunc(p_monthly_parking_fee) <> p_monthly_parking_fee then
    raise exception '月額駐車料は0以上の整数で指定してください';
  end if;
  if p_effective_from is null then
    raise exception '駐車料の適用開始日は必須です';
  end if;

  select contract.lease_contract_id,
         contract.tenant_id,
         facility.property_id,
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
  if parking_start is not null and p_effective_from < parking_start then
    raise exception '駐車料の適用開始日は駐車場契約開始日以降を指定してください';
  end if;
  if parking_end is not null and p_effective_from > parking_end then
    raise exception '駐車料の適用開始日は駐車場契約終了日以前を指定してください';
  end if;

  select min(history.effective_from)
    into next_start
  from public.parking_fee_history history
  where history.parking_lease_contract_unit_id = p_parking_lease_contract_unit_id
    and history.effective_from > p_effective_from;
  history_end := case
    when next_start is not null and parking_end is not null then least(next_start - 1, parking_end)
    when next_start is not null then next_start - 1
    else parking_end
  end;

  if p_parking_scope = 'internal' then
    if p_main_lease_contract_id is null then
      raise exception '内部契約では主契約を選択してください';
    end if;

    select count(*), min(main_unit.lease_contract_unit_id::text)::uuid,
           min(coalesce(main_unit.lease_start_date, main_contract.contract_start_date)),
           max(coalesce(main_unit.lease_end_date, main_contract.contract_end_date))
      into target_count, target_main_unit_id, main_start, main_end
    from public.lease_contract main_contract
    join public.lease_contract_unit main_unit on main_unit.lease_contract_id = main_contract.lease_contract_id
    join public.unit_master unit on unit.unit_id = main_unit.unit_id
    where main_contract.lease_contract_id = p_main_lease_contract_id
      and main_contract.tenant_id = parking_tenant_id
      and unit.property_id = parking_property_id
      and unit.unit_type <> 'parking';

    if target_count = 0 then raise exception '同一物件・同一テナントの主契約区画が見つかりません'; end if;
    if target_count > 1 then raise exception '主契約に控除対象区画が複数あります。控除対象を一意にしてください'; end if;
    if main_start is not null and main_start > p_effective_from then
      raise exception '駐車開始日時点の過去主契約が不足しています（主契約開始日: %）', main_start;
    end if;
    if history_end is null and main_end is not null then
      raise exception '主契約終了後の駐車料控除先がありません（主契約終了日: %）', main_end;
    end if;
    if history_end is not null and main_end is not null and main_end < history_end then
      raise exception '駐車料の適用期間を主契約が全期間カバーしていません（主契約終了日: %）', main_end;
    end if;

    select snapshot.monthly_rent_amount
      into gross_main_rent
    from public.lease_contract_unit_snapshot_at_date(parking_property_id, p_effective_from) snapshot
    where snapshot.lease_contract_unit_id = target_main_unit_id;
    if gross_main_rent is null then
      raise exception '適用開始日時点の主契約賃料を取得できません';
    end if;

    select coalesce(sum(history.monthly_parking_fee), 0)
      into other_fee_total
    from public.parking_fee_history history
    where history.main_lease_contract_unit_id = target_main_unit_id
      and history.parking_lease_contract_unit_id <> p_parking_lease_contract_unit_id
      and history.effective_from <= p_effective_from
      and (history.effective_to is null or history.effective_to >= p_effective_from);
    if other_fee_total + p_monthly_parking_fee > gross_main_rent then
      raise exception '内部駐車料合計（%円）が主契約賃料（%円）を超えます',
        other_fee_total + p_monthly_parking_fee, gross_main_rent;
    end if;
  else
    if p_main_lease_contract_id is not null then raise exception '外部契約には主契約を指定できません'; end if;
    target_main_unit_id := null;
  end if;

  update public.parking_fee_history history
  set effective_to = p_effective_from - 1,
      updated_at = now()
  where history.parking_lease_contract_unit_id = p_parking_lease_contract_unit_id
    and history.effective_from < p_effective_from
    and (history.effective_to is null or history.effective_to >= p_effective_from);

  insert into public.parking_fee_history (
    parking_lease_contract_unit_id, parking_scope, main_lease_contract_unit_id,
    monthly_parking_fee, effective_from, effective_to,
    source_import_batch_id, source_import_row_id, source_file_name,
    source_sheet_name, source_row_number, created_by
  ) values (
    p_parking_lease_contract_unit_id, p_parking_scope, target_main_unit_id,
    p_monthly_parking_fee, p_effective_from, history_end,
    p_source_import_batch_id, p_source_import_row_id, p_source_file_name,
    p_source_sheet_name, p_source_row_number, auth.uid()
  )
  on conflict (parking_lease_contract_unit_id, effective_from) do update set
    parking_scope = excluded.parking_scope,
    main_lease_contract_unit_id = excluded.main_lease_contract_unit_id,
    monthly_parking_fee = excluded.monthly_parking_fee,
    effective_to = excluded.effective_to,
    source_import_batch_id = excluded.source_import_batch_id,
    source_import_row_id = excluded.source_import_row_id,
    source_file_name = excluded.source_file_name,
    source_sheet_name = excluded.source_sheet_name,
    source_row_number = excluded.source_row_number,
    updated_at = now()
  returning parking_fee_history_id into result_id;

  return jsonb_build_object(
    'parking_fee_history_id', result_id,
    'main_lease_contract_unit_id', target_main_unit_id,
    'effective_from', p_effective_from,
    'effective_to', history_end,
    'monthly_parking_fee', p_monthly_parking_fee
  );
end;
$$;

create or replace function private.apply_parking_fee_change_request(
  p_change_request_id uuid,
  p_expected_row_version integer,
  p_monthly_parking_fee numeric,
  p_effective_from date,
  p_main_lease_contract_unit_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  request_record public.change_request%rowtype;
  parking_lcu_id uuid;
  parking_scope text;
  main_lcu_id uuid;
  main_contract_id uuid;
  candidate_count integer;
  parking_record record;
begin
  if auth.uid() is null
     or not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車料対応依頼の確定は管理者またはマネージャーだけが実行できます';
  end if;
  if p_monthly_parking_fee is null or p_monthly_parking_fee < 0
     or trunc(p_monthly_parking_fee) <> p_monthly_parking_fee then
    raise exception '月額駐車料は0以上の整数で指定してください';
  end if;
  if p_effective_from is null then raise exception '適用開始日を指定してください'; end if;

  select * into request_record from public.change_request request
  where request.change_request_id = p_change_request_id
    and request.request_type = 'parking_fee_setup'
    and request.status in ('open', 'in_review', 'on_hold')
    and request.row_version = p_expected_row_version
  for update;
  if not found then raise exception '対応依頼が更新済みか、確定できない状態です'; end if;

  select item.entity_id into parking_lcu_id
  from public.change_request_item item
  where item.change_request_id = p_change_request_id
    and item.entity_type = 'parking_fee_history'
  order by item.sort_order, item.created_at limit 1;
  if parking_lcu_id is null then raise exception '対象の駐車場契約区画が見つかりません'; end if;

  select detail.parking_scope, contract.tenant_id, unit.property_id,
         contract_unit.lease_start_date, contract_unit.lease_end_date
  into parking_record
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  join public.parking_contract_detail detail on detail.lease_contract_id = contract.lease_contract_id
  where contract_unit.lease_contract_unit_id = parking_lcu_id;
  if not found then raise exception '駐車場契約情報が見つかりません'; end if;
  parking_scope := parking_record.parking_scope;

  if parking_scope = 'internal' then
    main_lcu_id := p_main_lease_contract_unit_id;
    if main_lcu_id is null then
      select count(*), min(candidate.lease_contract_unit_id)
      into candidate_count, main_lcu_id
      from public.lease_contract_unit candidate
      join public.lease_contract main_contract on main_contract.lease_contract_id = candidate.lease_contract_id
      join public.unit_master main_unit on main_unit.unit_id = candidate.unit_id
      where main_contract.tenant_id = parking_record.tenant_id
        and main_unit.property_id = parking_record.property_id
        and main_unit.unit_type <> 'parking'
        and coalesce(candidate.lease_start_date, main_contract.contract_start_date) <= p_effective_from
        and coalesce(candidate.lease_end_date, main_contract.contract_end_date, 'infinity'::date)
          >= coalesce(parking_record.lease_end_date, 'infinity'::date);
      if candidate_count <> 1 then
        raise exception '控除対象の主契約区画を1件選択してください（候補%件）', candidate_count;
      end if;
    end if;

    select contract_unit.lease_contract_id into main_contract_id
    from public.lease_contract_unit contract_unit
    where contract_unit.lease_contract_unit_id = main_lcu_id;
    if main_contract_id is null then raise exception '控除対象の主契約区画が見つかりません'; end if;
  else
    main_lcu_id := null;
    main_contract_id := null;
  end if;

  perform public.set_parking_fee_history(
    parking_lcu_id, parking_scope, main_contract_id, p_monthly_parking_fee,
    p_effective_from, null, null, '対応依頼', null, null
  );

  select * into request_record from public.change_request request
  where request.change_request_id = p_change_request_id;
  return to_jsonb(request_record);
end;
$$;

revoke all on function public.set_parking_fee_history(uuid, text, uuid, numeric, date, uuid, uuid, text, text, integer)
  from public, anon;
grant execute on function public.set_parking_fee_history(uuid, text, uuid, numeric, date, uuid, uuid, text, text, integer)
  to authenticated;

revoke all on function private.apply_parking_fee_change_request(uuid, integer, numeric, date, uuid)
  from public, anon;
grant execute on function private.apply_parking_fee_change_request(uuid, integer, numeric, date, uuid)
  to authenticated;
