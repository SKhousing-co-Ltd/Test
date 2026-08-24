create table if not exists public.parking_space_status_history (
  parking_space_status_history_id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.parking_space_master(unit_id) on delete cascade,
  effective_from date not null,
  availability_status varchar(20) not null,
  source_file_name text,
  source_sheet_name text,
  source_row_number integer,
  notes text,
  created_by uuid default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_parking_space_availability_status check (availability_status in ('available', 'unavailable')),
  constraint ck_parking_space_status_source_row check (source_row_number is null or source_row_number > 0),
  constraint uq_parking_space_status_effective unique (unit_id, effective_from)
);

create index if not exists idx_parking_space_status_history_lookup
  on public.parking_space_status_history(unit_id, effective_from desc);

alter table public.parking_space_status_history enable row level security;

revoke all on table public.parking_space_status_history from anon;
grant select, insert, update on table public.parking_space_status_history to authenticated;

create policy parking_space_status_history_select
  on public.parking_space_status_history
  for select
  to authenticated
  using ((select public.current_account_is_active()));

create policy parking_space_status_history_insert
  on public.parking_space_status_history
  for insert
  to authenticated
  with check (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );

create policy parking_space_status_history_update
  on public.parking_space_status_history
  for update
  to authenticated
  using (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  )
  with check (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );

create or replace function public.prepare_parking_import(
  p_property_id uuid,
  p_parking_facility_id uuid,
  p_as_of_date date,
  p_source_file_name text,
  p_source_sheet_name text,
  p_source_file_hash text,
  p_rows jsonb
)
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  batch_id uuid;
  source_row jsonb;
  tenant_matches integer;
  tenant_id uuid;
  messages text[];
  row_status text;
begin
  if not (select public.current_account_is_active()) or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車場取込は管理者またはマネージャーだけが実行できます';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception '取込明細がありません';
  end if;
  if not exists (
    select 1
    from public.parking_facility_master
    where parking_facility_id = p_parking_facility_id
      and property_id = p_property_id
      and is_active
  ) then
    raise exception '物件に紐づく有効な駐車場施設を指定してください';
  end if;

  select parking_import_batch_id
  into batch_id
  from public.parking_import_batch
  where property_id = p_property_id
    and source_file_hash = p_source_file_hash;

  if batch_id is not null then
    return batch_id;
  end if;

  insert into public.parking_import_batch (
    property_id,
    parking_facility_id,
    source_file_name,
    source_sheet_name,
    source_file_hash,
    as_of_date
  ) values (
    p_property_id,
    p_parking_facility_id,
    left(p_source_file_name, 255),
    left(p_source_sheet_name, 100),
    lower(p_source_file_hash),
    p_as_of_date
  )
  returning parking_import_batch_id into batch_id;

  for source_row in select value from jsonb_array_elements(p_rows) loop
    row_status := coalesce(
      nullif(trim(source_row->>'parking_status'), ''),
      case when coalesce((source_row->>'is_vacant')::boolean, false) then 'vacant' else 'occupied' end
    );

    if row_status not in ('occupied', 'vacant', 'unavailable') then
      raise exception '状態は「契約中」「空き」「使用不可」のいずれかを指定してください';
    end if;
    if nullif(trim(source_row->>'space_number'), '') is null then
      raise exception '枠番が空の行があります';
    end if;
    if row_status = 'occupied' and nullif(trim(source_row->>'tenant_name'), '') is null then
      raise exception '契約中の区画にテナント名が空の行があります';
    end if;

    tenant_matches := 0;
    tenant_id := null;

    if row_status = 'vacant' then
      messages := array['空き区画として登録します'];
    elsif row_status = 'unavailable' then
      messages := array['使用不可区画として登録します'];
    else
      select count(distinct candidate.tenant_id), min(candidate.tenant_id::text)::uuid
      into tenant_matches, tenant_id
      from public.parking_main_contract_candidate candidate
      where candidate.property_id = p_property_id
        and public.normalize_parking_tenant_name(candidate.tenant_name)
          = public.normalize_parking_tenant_name(source_row->>'tenant_name');

      if tenant_matches = 0 then
        select count(*), min(tenant.tenant_id::text)::uuid
        into tenant_matches, tenant_id
        from public.tenant_master tenant
        where public.normalize_parking_tenant_name(tenant.tenant_name)
          = public.normalize_parking_tenant_name(source_row->>'tenant_name');
      end if;

      messages := array['内部・外部を選択してください'];
      if tenant_matches = 0 then
        messages := array_append(messages, 'テナント候補が見つかりません');
      end if;
      if tenant_matches > 1 then
        messages := array_append(messages, 'テナント候補が複数あります');
      end if;
    end if;

    insert into public.parking_import_row (
      parking_import_batch_id,
      source_row_number,
      space_number,
      access_code,
      tenant_location_label,
      tenant_name,
      normalized_tenant_name,
      matched_tenant_id,
      contract_start_date,
      vehicle_model,
      registration_number,
      chassis_number,
      notes,
      validation_status,
      validation_messages,
      raw_payload
    ) values (
      batch_id,
      (source_row->>'source_row_number')::integer,
      trim(source_row->>'space_number'),
      nullif(trim(source_row->>'access_code'), ''),
      nullif(trim(source_row->>'tenant_location_label'), ''),
      case
        when row_status = 'vacant' then '空き'
        when row_status = 'unavailable' then '使用不可'
        else trim(source_row->>'tenant_name')
      end,
      case when row_status = 'occupied' then public.normalize_parking_tenant_name(source_row->>'tenant_name') else '' end,
      case when row_status = 'occupied' and tenant_matches = 1 then tenant_id end,
      nullif(source_row->>'contract_start_date', '')::date,
      nullif(trim(source_row->>'vehicle_model'), ''),
      nullif(trim(source_row->>'registration_number'), ''),
      nullif(trim(source_row->>'chassis_number'), ''),
      nullif(trim(source_row->>'notes'), ''),
      case when row_status = 'occupied' then 'action_required' else 'ready' end,
      messages,
      source_row || jsonb_build_object(
        'parking_status', row_status,
        'is_vacant', row_status = 'vacant'
      )
    );
  end loop;

  return batch_id;
end;
$$;

create or replace function public.commit_parking_import(p_batch_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path to 'public', 'extensions'
as $$
declare
  batch public.parking_import_batch%rowtype;
  import_row public.parking_import_row%rowtype;
  facility public.parking_facility_master%rowtype;
  target_unit_id uuid;
  reusable_unit_id uuid;
  reusable_unit_count integer;
  parking_contract_id uuid;
  contract_unit_id uuid;
  current_vehicle public.parking_vehicle_history%rowtype;
  source_key text;
  committed_count integer := 0;
  row_status text;
begin
  if not (select public.current_account_is_active()) or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車場取込は管理者またはマネージャーだけが実行できます';
  end if;
  select * into batch from public.parking_import_batch where parking_import_batch_id = p_batch_id for update;
  if not found then raise exception '取込バッチが見つかりません'; end if;
  if batch.status = 'committed' then
    return jsonb_build_object('batch_id', batch.parking_import_batch_id, 'committed_count', 0, 'already_committed', true);
  end if;
  select * into facility from public.parking_facility_master where parking_facility_id = batch.parking_facility_id;

  if exists (
    select 1 from public.parking_import_row r
    where r.parking_import_batch_id = p_batch_id
      and coalesce(
        nullif(trim(r.raw_payload->>'parking_status'), ''),
        case when coalesce((r.raw_payload->>'is_vacant')::boolean, false) then 'vacant' else 'occupied' end
      ) = 'occupied'
      and (r.matched_tenant_id is null or r.parking_scope is null
        or (r.parking_scope = 'internal' and r.main_lease_contract_id is null)
        or (r.parking_scope = 'external' and r.main_lease_contract_id is not null))
  ) then raise exception '契約中の行はテナント、内部・外部、主契約の選択を完了してください'; end if;
  if exists (
    select 1 from public.parking_import_row where parking_import_batch_id = p_batch_id
    group by space_number having count(*) > 1
  ) then raise exception '同じ枠番が複数行あります'; end if;

  for import_row in
    select * from public.parking_import_row where parking_import_batch_id = p_batch_id order by source_row_number
  loop
    target_unit_id := null;
    reusable_unit_id := null;
    reusable_unit_count := 0;
    parking_contract_id := null;
    contract_unit_id := null;
    row_status := coalesce(
      nullif(trim(import_row.raw_payload->>'parking_status'), ''),
      case when coalesce((import_row.raw_payload->>'is_vacant')::boolean, false) then 'vacant' else 'occupied' end
    );

    if row_status not in ('occupied', 'vacant', 'unavailable') then
      raise exception '枠%の状態が不正です', import_row.space_number;
    end if;

    select space.unit_id into target_unit_id from public.parking_space_master space
    where space.parking_facility_id = batch.parking_facility_id and space.space_number = import_row.space_number;
    if target_unit_id is null and row_status = 'occupied' then
      select count(distinct unit.unit_id), min(unit.unit_id::text)::uuid into reusable_unit_count, reusable_unit_id
      from public.unit_master unit
      join public.lease_contract_unit existing_contract_unit on existing_contract_unit.unit_id = unit.unit_id
      join public.lease_contract contract on contract.lease_contract_id = existing_contract_unit.lease_contract_id
      where unit.property_id = batch.property_id and unit.unit_type = 'parking'
        and contract.tenant_id = import_row.matched_tenant_id
        and contract.contract_status = 'active'
        and not exists (select 1 from public.parking_space_master existing where existing.unit_id = unit.unit_id);
      if reusable_unit_count = 1 then
        target_unit_id := reusable_unit_id;
        update public.unit_master set
          unit_code = left('PK-' || facility.facility_code || '-' || import_row.space_number, 100),
          unit_name = '駐車枠 ' || import_row.space_number,
          floor_label = '駐車場', unit_type = 'parking', is_active = true, updated_at = now()
        where unit_id = target_unit_id;
      end if;
    end if;

    if target_unit_id is null then
      insert into public.unit_master (property_id, unit_code, unit_name, floor_label, unit_type, is_active)
      values (
        batch.property_id, left('PK-' || facility.facility_code || '-' || import_row.space_number, 100),
        '駐車枠 ' || import_row.space_number, '駐車場', 'parking', true
      ) returning unit_id into target_unit_id;
    end if;

    if not exists (
      select 1 from public.parking_space_master space
      where space.parking_facility_id = batch.parking_facility_id and space.space_number = import_row.space_number
    ) then
      insert into public.parking_space_master (unit_id, parking_facility_id, space_number)
      values (target_unit_id, batch.parking_facility_id, import_row.space_number);
    end if;

    insert into public.parking_space_status_history (
      unit_id,
      effective_from,
      availability_status,
      source_file_name,
      source_sheet_name,
      source_row_number,
      notes,
      created_by
    ) values (
      target_unit_id,
      batch.as_of_date,
      case when row_status = 'unavailable' then 'unavailable' else 'available' end,
      batch.source_file_name,
      batch.source_sheet_name,
      import_row.source_row_number,
      import_row.notes,
      auth.uid()
    )
    on conflict (unit_id, effective_from) do update set
      availability_status = excluded.availability_status,
      source_file_name = excluded.source_file_name,
      source_sheet_name = excluded.source_sheet_name,
      source_row_number = excluded.source_row_number,
      notes = excluded.notes,
      updated_at = now();

    if row_status in ('vacant', 'unavailable') then
      if exists (
        select 1
        from public.lease_contract_unit existing
        join public.lease_contract existing_contract on existing_contract.lease_contract_id = existing.lease_contract_id
        where existing.unit_id = target_unit_id
          and existing_contract.contract_status = 'active'
          and (existing.lease_end_date is null or existing.lease_end_date >= batch.as_of_date)
          and existing.lease_start_date is not null
          and existing.lease_start_date >= batch.as_of_date
      ) then raise exception '枠%には基準日以降に開始する契約があります', import_row.space_number; end if;

      update public.lease_contract_unit existing
      set lease_end_date = batch.as_of_date - 1, updated_at = now()
      from public.lease_contract existing_contract
      where existing_contract.lease_contract_id = existing.lease_contract_id
        and existing.unit_id = target_unit_id
        and existing_contract.contract_status = 'active'
        and (existing.lease_end_date is null or existing.lease_end_date >= batch.as_of_date)
        and (existing.lease_start_date is null or existing.lease_start_date < batch.as_of_date);

      update public.parking_import_row set
        matched_tenant_id = null,
        parking_scope = null,
        main_lease_contract_id = null,
        validation_status = 'committed',
        validation_messages = '{}',
        committed_unit_id = target_unit_id,
        committed_lease_contract_id = null,
        committed_lease_contract_unit_id = null,
        raw_payload = coalesce(raw_payload, '{}'::jsonb) || jsonb_build_object(
          'parking_status', row_status,
          'is_vacant', row_status = 'vacant'
        ),
        updated_at = now()
      where parking_import_row_id = import_row.parking_import_row_id;
      committed_count := committed_count + 1;
      continue;
    end if;

    select contract.lease_contract_id into parking_contract_id
    from public.lease_contract_unit existing_contract_unit
    join public.lease_contract contract on contract.lease_contract_id = existing_contract_unit.lease_contract_id
    where existing_contract_unit.unit_id = target_unit_id and contract.tenant_id = import_row.matched_tenant_id
      and contract.contract_status = 'active'
      and not exists (
        select 1 from public.lease_contract_unit other_contract_unit
        join public.unit_master other_unit on other_unit.unit_id = other_contract_unit.unit_id
        where other_contract_unit.lease_contract_id = contract.lease_contract_id and other_unit.unit_type <> 'parking'
      )
    order by existing_contract_unit.created_at desc limit 1;

    if parking_contract_id is not null and not exists (
      select 1 from public.parking_contract_detail where lease_contract_id = parking_contract_id
    ) then
      update public.lease_contract set contract_type = 'parking', updated_at = now() where lease_contract_id = parking_contract_id;
      insert into public.parking_contract_detail (lease_contract_id, property_id, parking_scope, main_lease_contract_id)
      values (parking_contract_id, batch.property_id, import_row.parking_scope, import_row.main_lease_contract_id);
    end if;

    if parking_contract_id is null then
      select detail.lease_contract_id into parking_contract_id
      from public.parking_contract_detail detail
      join public.lease_contract contract on contract.lease_contract_id = detail.lease_contract_id
      where detail.property_id = batch.property_id
        and detail.parking_scope = import_row.parking_scope
        and detail.main_lease_contract_id is not distinct from import_row.main_lease_contract_id
        and contract.tenant_id = import_row.matched_tenant_id
        and contract.contract_start_date is not distinct from import_row.contract_start_date
        and contract.contract_status = 'active'
      order by contract.created_at limit 1;
    end if;

    if parking_contract_id is null then
      source_key := 'parking_excel:' || encode(digest(concat_ws('|', batch.property_id::text,
        import_row.matched_tenant_id::text, import_row.parking_scope,
        coalesce(import_row.main_lease_contract_id::text, 'external'), coalesce(import_row.contract_start_date::text, '')), 'sha256'), 'hex');
      insert into public.lease_contract (
        tenant_id, contract_status, contract_type, contract_start_date, source_system, source_record_key, notes
      ) values (
        import_row.matched_tenant_id, 'active', 'parking', import_row.contract_start_date,
        'parking_excel', source_key, '物件別駐車場台帳から登録'
      ) returning lease_contract_id into parking_contract_id;
      insert into public.parking_contract_detail (lease_contract_id, property_id, parking_scope, main_lease_contract_id)
      values (parking_contract_id, batch.property_id, import_row.parking_scope, import_row.main_lease_contract_id);
    end if;

    if exists (
      select 1 from public.lease_contract_unit existing
      join public.lease_contract existing_contract on existing_contract.lease_contract_id = existing.lease_contract_id
      where existing.unit_id = target_unit_id and existing.lease_contract_id <> parking_contract_id
        and existing_contract.contract_status = 'active'
        and (existing.lease_end_date is null or existing.lease_end_date >= batch.as_of_date)
        and existing.lease_start_date is not null and existing.lease_start_date >= batch.as_of_date
    ) then raise exception '枠%には基準日以降に開始する別契約があります', import_row.space_number; end if;
    update public.lease_contract_unit existing set lease_end_date = batch.as_of_date - 1, updated_at = now()
    from public.lease_contract existing_contract
    where existing_contract.lease_contract_id = existing.lease_contract_id
      and existing.unit_id = target_unit_id and existing.lease_contract_id <> parking_contract_id
      and existing_contract.contract_status = 'active'
      and (existing.lease_end_date is null or existing.lease_end_date >= batch.as_of_date);

    select lease_contract_unit_id into contract_unit_id from public.lease_contract_unit
    where lease_contract_id = parking_contract_id and unit_id = target_unit_id;
    if contract_unit_id is null then
      insert into public.lease_contract_unit (lease_contract_id, unit_id, lease_start_date)
      values (parking_contract_id, target_unit_id, coalesce(import_row.contract_start_date, batch.as_of_date))
      returning lease_contract_unit_id into contract_unit_id;
    end if;

    insert into public.parking_space_assignment (
      lease_contract_unit_id, access_code, tenant_location_label, notes,
      source_file_name, source_sheet_name, source_row_number
    ) values (
      contract_unit_id, import_row.access_code, import_row.tenant_location_label, import_row.notes,
      batch.source_file_name, batch.source_sheet_name, import_row.source_row_number
    ) on conflict (lease_contract_unit_id) do update set
      access_code = excluded.access_code, tenant_location_label = excluded.tenant_location_label,
      notes = excluded.notes, source_file_name = excluded.source_file_name,
      source_sheet_name = excluded.source_sheet_name, source_row_number = excluded.source_row_number,
      updated_at = now();

    if import_row.vehicle_model is not null or import_row.registration_number is not null or import_row.chassis_number is not null then
      select * into current_vehicle from public.parking_vehicle_history
      where lease_contract_unit_id = contract_unit_id and effective_to is null;
      if not found or current_vehicle.vehicle_model is distinct from import_row.vehicle_model
        or current_vehicle.registration_number is distinct from import_row.registration_number
        or current_vehicle.chassis_number is distinct from import_row.chassis_number then
        update public.parking_vehicle_history set effective_to = batch.as_of_date - 1, updated_at = now()
        where lease_contract_unit_id = contract_unit_id and effective_to is null and effective_from < batch.as_of_date;
        if exists (
          select 1 from public.parking_vehicle_history where lease_contract_unit_id = contract_unit_id and effective_to is null
        ) then raise exception '枠%の車両履歴が基準日以降に開始済みです', import_row.space_number; end if;
        insert into public.parking_vehicle_history (
          lease_contract_unit_id, vehicle_model, registration_number, chassis_number, effective_from, source_notes
        ) values (
          contract_unit_id, import_row.vehicle_model, import_row.registration_number,
          import_row.chassis_number, batch.as_of_date, import_row.notes
        );
      end if;
    end if;

    update public.parking_import_row set validation_status = 'committed', validation_messages = '{}',
      committed_unit_id = target_unit_id, committed_lease_contract_id = parking_contract_id,
      committed_lease_contract_unit_id = contract_unit_id,
      raw_payload = coalesce(raw_payload, '{}'::jsonb) || jsonb_build_object('parking_status', 'occupied', 'is_vacant', false),
      updated_at = now()
    where parking_import_row_id = import_row.parking_import_row_id;
    committed_count := committed_count + 1;
  end loop;

  update public.parking_import_batch set status = 'committed', committed_at = now()
  where parking_import_batch_id = p_batch_id;
  return jsonb_build_object('batch_id', p_batch_id, 'committed_count', committed_count, 'already_committed', false);
end;
$$;

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
    left join lateral (
      select status_history.availability_status
      from public.parking_space_status_history status_history
      where status_history.unit_id = space.unit_id
        and status_history.effective_from <= p_as_of_date
      order by status_history.effective_from desc, status_history.created_at desc
      limit 1
    ) space_availability on true
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
