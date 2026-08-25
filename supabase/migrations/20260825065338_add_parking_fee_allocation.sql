-- 駐車料を契約原本の賃料から分離して、基準日別のレントロール表示へ配賦する。

alter table public.parking_import_row
  add column if not exists monthly_parking_fee numeric(14, 0);

alter table public.parking_import_row
  add constraint ck_parking_import_row_monthly_fee
  check (monthly_parking_fee is null or monthly_parking_fee >= 0);

create table public.parking_fee_history (
  parking_fee_history_id uuid primary key default gen_random_uuid(),
  parking_lease_contract_unit_id uuid not null references public.lease_contract_unit(lease_contract_unit_id) on delete cascade,
  parking_scope varchar(10) not null,
  main_lease_contract_unit_id uuid references public.lease_contract_unit(lease_contract_unit_id) on delete restrict,
  monthly_parking_fee numeric(14, 0) not null,
  effective_from date not null,
  effective_to date,
  source_import_batch_id uuid references public.parking_import_batch(parking_import_batch_id) on delete set null,
  source_import_row_id uuid references public.parking_import_row(parking_import_row_id) on delete set null,
  source_file_name text,
  source_sheet_name text,
  source_row_number integer,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_parking_fee_history_start unique (parking_lease_contract_unit_id, effective_from),
  constraint ck_parking_fee_history_scope check (parking_scope in ('internal', 'external')),
  constraint ck_parking_fee_history_main_link check (
    (parking_scope = 'internal' and main_lease_contract_unit_id is not null)
    or (parking_scope = 'external' and main_lease_contract_unit_id is null)
  ),
  constraint ck_parking_fee_history_amount check (monthly_parking_fee >= 0),
  constraint ck_parking_fee_history_dates check (effective_to is null or effective_to >= effective_from),
  constraint ck_parking_fee_history_source_row check (source_row_number is null or source_row_number > 0),
  constraint ck_parking_fee_history_not_self check (main_lease_contract_unit_id is null or main_lease_contract_unit_id <> parking_lease_contract_unit_id)
);

create index ix_parking_fee_history_parking_date
  on public.parking_fee_history(parking_lease_contract_unit_id, effective_from desc, effective_to);
create index ix_parking_fee_history_main_date
  on public.parking_fee_history(main_lease_contract_unit_id, effective_from, effective_to)
  where main_lease_contract_unit_id is not null;

create index ix_parking_fee_history_source_batch
  on public.parking_fee_history(source_import_batch_id)
  where source_import_batch_id is not null;
create index ix_parking_fee_history_source_row
  on public.parking_fee_history(source_import_row_id)
  where source_import_row_id is not null;
create index ix_parking_fee_history_created_by
  on public.parking_fee_history(created_by);

create trigger set_parking_fee_history_updated_at
before update on public.parking_fee_history
for each row execute procedure public.set_updated_at();

create or replace function public.validate_parking_fee_history_overlap()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $$
begin
  if exists (
    select 1
    from public.parking_fee_history existing
    where existing.parking_lease_contract_unit_id = new.parking_lease_contract_unit_id
      and existing.parking_fee_history_id <> coalesce(new.parking_fee_history_id, gen_random_uuid())
      and daterange(existing.effective_from, coalesce(existing.effective_to, 'infinity'::date), '[]')
        && daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]')
  ) then
    raise exception '同じ駐車枠の駐車料履歴を重複期間で登録できません';
  end if;
  return new;
end;
$$;

create trigger validate_parking_fee_history_overlap_before_write
before insert or update on public.parking_fee_history
for each row execute procedure public.validate_parking_fee_history_overlap();

create or replace function public.sync_parking_import_monthly_fee()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  fee_text text;
  row_status text;
begin
  row_status := coalesce(
    nullif(trim(new.raw_payload->>'parking_status'), ''),
    case when coalesce((new.raw_payload->>'is_vacant')::boolean, false) then 'vacant' else 'occupied' end
  );
  fee_text := nullif(trim(new.raw_payload->>'monthly_parking_fee'), '');

  if new.monthly_parking_fee is null and fee_text is not null then
    if fee_text !~ '^\d+$' then
      raise exception '月額駐車料は0以上の整数で指定してください';
    end if;
    new.monthly_parking_fee := fee_text::numeric;
  end if;

  if row_status = 'occupied' and new.monthly_parking_fee is null then
    raise exception '契約中の区画には月額駐車料が必要です';
  end if;
  if row_status in ('vacant', 'unavailable') and new.monthly_parking_fee is not null then
    raise exception '空き・使用不可の区画には月額駐車料を指定できません';
  end if;
  return new;
end;
$$;

create trigger sync_parking_import_monthly_fee_before_write
before insert or update of monthly_parking_fee, raw_payload on public.parking_import_row
for each row execute procedure public.sync_parking_import_monthly_fee();

alter table public.parking_fee_history enable row level security;
revoke all on table public.parking_fee_history from public, anon;
grant select, insert, update, delete on table public.parking_fee_history to authenticated;

create policy parking_fee_history_select
  on public.parking_fee_history for select to authenticated
  using ((select public.current_account_is_active()));
create policy parking_fee_history_insert
  on public.parking_fee_history for insert to authenticated
  with check (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );
create policy parking_fee_history_update
  on public.parking_fee_history for update to authenticated
  using (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  )
  with check (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );
create policy parking_fee_history_delete
  on public.parking_fee_history for delete to authenticated
  using (
    (select public.current_account_is_active())
    and (select public.current_account_role()) in ('admin', 'manager')
  );

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
set search_path to 'public'
as $$
declare
  parking_contract_id uuid;
  parking_tenant_id uuid;
  property_id uuid;
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
  if p_monthly_parking_fee is null or p_monthly_parking_fee < 0 or trunc(p_monthly_parking_fee) <> p_monthly_parking_fee then
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
    into parking_contract_id, parking_tenant_id, property_id, parking_start, parking_end
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
      and unit.property_id = property_id
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
    from public.lease_contract_unit_snapshot_at_date(property_id, p_effective_from) snapshot
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
      raise exception '内部駐車料合計（%円）が主契約賃料（%円）を超えます', other_fee_total + p_monthly_parking_fee, gross_main_rent;
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

revoke all on function public.set_parking_fee_history(uuid, text, uuid, numeric, date, uuid, uuid, text, text, integer) from public, anon;
grant execute on function public.set_parking_fee_history(uuid, text, uuid, numeric, date, uuid, uuid, text, text, integer) to authenticated;

alter function public.commit_parking_import(uuid) rename to commit_parking_import_without_fee;

create function public.commit_parking_import(p_batch_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  batch public.parking_import_batch%rowtype;
  import_row public.parking_import_row%rowtype;
  result jsonb;
  row_status text;
  fee_effective_from date;
  fee_contract_unit_id uuid;
begin
  if not (select public.current_account_is_active())
     or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車場取込は管理者またはマネージャーだけが実行できます';
  end if;
  select * into batch from public.parking_import_batch where parking_import_batch_id = p_batch_id;
  if not found then raise exception '取込バッチが見つかりません'; end if;

  if exists (
    select 1
    from public.parking_import_row row_data
    where row_data.parking_import_batch_id = p_batch_id
      and coalesce(nullif(trim(row_data.raw_payload->>'parking_status'), ''),
        case when coalesce((row_data.raw_payload->>'is_vacant')::boolean, false) then 'vacant' else 'occupied' end) = 'occupied'
      and row_data.monthly_parking_fee is null
  ) then
    raise exception '契約中の行は月額駐車料を入力してください';
  end if;

  result := public.commit_parking_import_without_fee(p_batch_id);

  for import_row in
    select * from public.parking_import_row where parking_import_batch_id = p_batch_id order by source_row_number
  loop
    row_status := coalesce(
      nullif(trim(import_row.raw_payload->>'parking_status'), ''),
      case when coalesce((import_row.raw_payload->>'is_vacant')::boolean, false) then 'vacant' else 'occupied' end
    );
    fee_contract_unit_id := import_row.committed_lease_contract_unit_id;

    if row_status = 'occupied' then
      select case
        when exists (
          select 1 from public.parking_fee_history history
          where history.parking_lease_contract_unit_id = fee_contract_unit_id
        ) then batch.as_of_date
        else coalesce(import_row.contract_start_date, batch.as_of_date)
      end into fee_effective_from;

      perform public.set_parking_fee_history(
        fee_contract_unit_id,
        import_row.parking_scope,
        import_row.main_lease_contract_id,
        import_row.monthly_parking_fee,
        fee_effective_from,
        batch.parking_import_batch_id,
        import_row.parking_import_row_id,
        batch.source_file_name,
        batch.source_sheet_name,
        import_row.source_row_number
      );
    else
      if fee_contract_unit_id is null and import_row.committed_unit_id is not null then
        select contract_unit.lease_contract_unit_id
          into fee_contract_unit_id
        from public.lease_contract_unit contract_unit
        join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
        where contract_unit.unit_id = import_row.committed_unit_id
          and contract.contract_type = 'parking'
        order by coalesce(contract_unit.lease_end_date, 'infinity'::date) desc, contract_unit.created_at desc
        limit 1;
      end if;
      if fee_contract_unit_id is not null then
        delete from public.parking_fee_history history
        where history.parking_lease_contract_unit_id = fee_contract_unit_id
          and history.effective_from >= batch.as_of_date;
        update public.parking_fee_history history
        set effective_to = batch.as_of_date - 1,
            updated_at = now()
        where history.parking_lease_contract_unit_id = fee_contract_unit_id
          and history.effective_from < batch.as_of_date
          and (history.effective_to is null or history.effective_to >= batch.as_of_date);
      end if;
    end if;
  end loop;

  return result || jsonb_build_object('parking_fees_applied', true);
end;
$$;

revoke all on function public.commit_parking_import_without_fee(uuid) from public, anon;
grant execute on function public.commit_parking_import_without_fee(uuid) to authenticated;
revoke all on function public.commit_parking_import(uuid) from public, anon;
grant execute on function public.commit_parking_import(uuid) to authenticated;

alter function public.update_parking_registration(
  uuid, uuid, uuid, text, integer, integer, integer, integer, uuid, text,
  uuid, date, date, text, text, text, text, text, date, date
) rename to update_parking_registration_without_fee;

create function public.update_parking_registration(
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
  p_vehicle_effective_to date,
  p_monthly_parking_fee numeric,
  p_parking_fee_effective_from date
)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  result jsonb;
begin
  if p_lease_contract_id is not null and p_monthly_parking_fee is null then
    raise exception '契約中の区画には月額駐車料が必要です';
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
    perform public.set_parking_fee_history(
      p_lease_contract_unit_id,
      p_parking_scope,
      case when p_parking_scope = 'internal' then p_main_lease_contract_id else null end,
      p_monthly_parking_fee,
      coalesce(p_parking_fee_effective_from, p_contract_start_date, current_date),
      null, null, '駐車場詳細画面', null, null
    );
  end if;

  return result || jsonb_build_object('monthly_parking_fee', p_monthly_parking_fee);
end;
$$;

revoke all on function public.update_parking_registration_without_fee(
  uuid, uuid, uuid, text, integer, integer, integer, integer, uuid, text,
  uuid, date, date, text, text, text, text, text, date, date
) from public, anon;
grant execute on function public.update_parking_registration_without_fee(
  uuid, uuid, uuid, text, integer, integer, integer, integer, uuid, text,
  uuid, date, date, text, text, text, text, text, date, date
) to authenticated;
revoke all on function public.update_parking_registration(
  uuid, uuid, uuid, text, integer, integer, integer, integer, uuid, text,
  uuid, date, date, text, text, text, text, text, date, date, numeric, date
) from public, anon;
grant execute on function public.update_parking_registration(
  uuid, uuid, uuid, text, integer, integer, integer, integer, uuid, text,
  uuid, date, date, text, text, text, text, text, date, date, numeric, date
) to authenticated;

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
      on active_lease.unit_id = space.unit_id and active_lease.contract_type = 'parking'
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
$$;

create or replace function public.rent_roll_list_at_date(p_property_id uuid, p_as_of_date date)
returns jsonb
language sql
stable
security invoker
set search_path to 'public'
as $$
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
      coalesce(snapshot.monthly_rent_amount, 0) as gross_monthly_rent_amount,
      coalesce(deduction.monthly_parking_fee, 0) as parking_fee_deduction_amount,
      case
        when unit.unit_type = 'parking' then coalesce(parking_fee.monthly_parking_fee, 0)
        else coalesce(snapshot.monthly_rent_amount, 0) - coalesce(deduction.monthly_parking_fee, 0)
      end as monthly_rent_amount,
      coalesce(snapshot.monthly_common_charge_amount, 0) as monthly_common_charge_amount,
      case
        when unit.unit_type = 'parking' then coalesce(parking_fee.monthly_parking_fee, 0)
        else coalesce(snapshot.monthly_rent_amount, 0) - coalesce(deduction.monthly_parking_fee, 0)
      end + coalesce(snapshot.monthly_common_charge_amount, 0) as monthly_total_amount,
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
      select coalesce(sum(history.monthly_parking_fee), 0) as monthly_parking_fee
      from public.parking_fee_history history
      where history.main_lease_contract_unit_id = snapshot.lease_contract_unit_id
        and history.effective_from <= p_as_of_date
        and (history.effective_to is null or history.effective_to >= p_as_of_date)
    ) deduction on true
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
$$;

revoke all on function public.parking_list_at_date(uuid, date) from public, anon;
grant execute on function public.parking_list_at_date(uuid, date) to authenticated;
revoke all on function public.rent_roll_list_at_date(uuid, date) from public, anon;
grant execute on function public.rent_roll_list_at_date(uuid, date) to authenticated;

comment on table public.parking_fee_history is '駐車枠ごとの月額駐車料と内部契約の控除対象主契約区画を基準日履歴で保持する。';
comment on function public.rent_roll_list_at_date(uuid, date) is '契約原本の総額賃料を保持したまま、内部駐車料を主契約から控除して基準日レントロールを返す。';
