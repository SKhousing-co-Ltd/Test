-- 物件別駐車場台帳。契約・区画の正本は lease_contract / lease_contract_unit / unit_master を利用する。
-- Remote migration version: 20260818085141

create extension if not exists pgcrypto;

-- Dashboardで作られた旧駐車場テーブルは本番でも空で、現行契約モデルを参照していない。
-- 実行時にデータが増えていた場合は、破壊的な置換をせずmigrationを停止する。
do $$
declare
  target_table text;
  row_count bigint;
begin
  foreach target_table in array array['parking_contracts', 'parking_spaces_master', 'parkings_master'] loop
    if to_regclass('public.' || target_table) is not null then
      execute format('select count(*) from public.%I', target_table) into row_count;
      if row_count <> 0 then
        raise exception '旧テーブル public.% に % 件のデータがあります。移行方法を確認してください。', target_table, row_count;
      end if;
    end if;
  end loop;
end;
$$;

drop table if exists public.parking_contracts;
drop table if exists public.parking_spaces_master;
drop table if exists public.parkings_master;

create table if not exists public.parking_type_master (
  parking_type_id bigint primary key,
  parking_type_name text not null unique,
  created_at timestamptz not null default now()
);

do $$
begin
  if to_regclass('public.parking_types_master') is not null then
    insert into public.parking_type_master (parking_type_id, parking_type_name)
    select parking_types_id, parking_type_name from public.parking_types_master
    on conflict (parking_type_id) do update set parking_type_name = excluded.parking_type_name;
  end if;
end;
$$;

drop table if exists public.parking_types_master;

insert into public.parking_type_master (parking_type_id, parking_type_name) values
  (1, '機械式駐車場'),
  (2, '自走式駐車場'),
  (3, '平面駐車場')
on conflict (parking_type_id) do update set parking_type_name = excluded.parking_type_name;

create table public.parking_facility_master (
  parking_facility_id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.asset_master (asset_id) on delete restrict,
  facility_code varchar(30) not null,
  facility_name varchar(100) not null,
  parking_type_id bigint references public.parking_type_master (parking_type_id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_parking_facility_property_code unique (property_id, facility_code),
  constraint ck_parking_facility_code check (facility_code = upper(facility_code) and facility_code ~ '^[A-Z0-9_-]+$')
);

create table public.parking_space_master (
  unit_id uuid primary key references public.unit_master (unit_id) on delete restrict,
  parking_facility_id uuid not null references public.parking_facility_master (parking_facility_id) on delete restrict,
  space_number varchar(50) not null,
  length_mm integer,
  width_mm integer,
  height_mm integer,
  weight_limit_kg integer,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_parking_space_facility_number unique (parking_facility_id, space_number),
  constraint ck_parking_space_dimensions check (
    (length_mm is null or length_mm > 0) and
    (width_mm is null or width_mm > 0) and
    (height_mm is null or height_mm > 0) and
    (weight_limit_kg is null or weight_limit_kg > 0)
  )
);

create table public.parking_contract_detail (
  lease_contract_id uuid primary key references public.lease_contract (lease_contract_id) on delete cascade,
  property_id uuid not null references public.asset_master (asset_id) on delete restrict,
  parking_scope varchar(10) not null,
  main_lease_contract_id uuid references public.lease_contract (lease_contract_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_parking_contract_scope check (parking_scope in ('internal', 'external')),
  constraint ck_parking_contract_main_required check (
    (parking_scope = 'internal' and main_lease_contract_id is not null)
    or (parking_scope = 'external' and main_lease_contract_id is null)
  ),
  constraint ck_parking_contract_not_self check (main_lease_contract_id is null or main_lease_contract_id <> lease_contract_id)
);

create table public.parking_space_assignment (
  lease_contract_unit_id uuid primary key references public.lease_contract_unit (lease_contract_unit_id) on delete cascade,
  access_code varchar(50),
  tenant_location_label varchar(100),
  notes text,
  source_file_name varchar(255),
  source_sheet_name varchar(100),
  source_row_number integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_parking_assignment_source_row check (source_row_number is null or source_row_number > 0)
);

create table public.parking_vehicle_history (
  parking_vehicle_history_id uuid primary key default gen_random_uuid(),
  lease_contract_unit_id uuid not null references public.lease_contract_unit (lease_contract_unit_id) on delete cascade,
  vehicle_model text,
  registration_number text,
  chassis_number text,
  effective_from date not null,
  effective_to date,
  source_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_parking_vehicle_dates check (effective_to is null or effective_to >= effective_from),
  constraint ck_parking_vehicle_has_value check (
    nullif(trim(vehicle_model), '') is not null
    or nullif(trim(registration_number), '') is not null
    or nullif(trim(chassis_number), '') is not null
  )
);

create unique index uq_parking_vehicle_current
  on public.parking_vehicle_history (lease_contract_unit_id)
  where effective_to is null;

create table public.parking_import_batch (
  parking_import_batch_id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.asset_master (asset_id) on delete restrict,
  parking_facility_id uuid not null references public.parking_facility_master (parking_facility_id) on delete restrict,
  source_file_name varchar(255) not null,
  source_sheet_name varchar(100) not null,
  source_file_hash varchar(64) not null,
  as_of_date date not null,
  status varchar(20) not null default 'draft',
  created_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  constraint uq_parking_import_file unique (property_id, source_file_hash),
  constraint ck_parking_import_status check (status in ('draft', 'committed', 'cancelled'))
);

create table public.parking_import_row (
  parking_import_row_id uuid primary key default gen_random_uuid(),
  parking_import_batch_id uuid not null references public.parking_import_batch (parking_import_batch_id) on delete cascade,
  source_row_number integer not null,
  space_number varchar(50) not null,
  access_code varchar(50),
  tenant_location_label varchar(100),
  tenant_name text not null,
  normalized_tenant_name text not null,
  matched_tenant_id uuid references public.tenant_master (tenant_id) on delete restrict,
  parking_scope varchar(10),
  main_lease_contract_id uuid references public.lease_contract (lease_contract_id) on delete restrict,
  contract_start_date date,
  vehicle_model text,
  registration_number text,
  chassis_number text,
  notes text,
  validation_status varchar(20) not null default 'action_required',
  validation_messages text[] not null default '{}',
  raw_payload jsonb not null default '{}'::jsonb,
  committed_unit_id uuid references public.unit_master (unit_id),
  committed_lease_contract_id uuid references public.lease_contract (lease_contract_id),
  committed_lease_contract_unit_id uuid references public.lease_contract_unit (lease_contract_unit_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_parking_import_row unique (parking_import_batch_id, source_row_number),
  constraint ck_parking_import_row_number check (source_row_number > 0),
  constraint ck_parking_import_row_scope check (parking_scope is null or parking_scope in ('internal', 'external')),
  constraint ck_parking_import_row_status check (validation_status in ('action_required', 'ready', 'committed', 'error'))
);

create index ix_parking_facility_property on public.parking_facility_master (property_id);
create index ix_parking_space_facility on public.parking_space_master (parking_facility_id, is_active);
create index ix_parking_contract_property on public.parking_contract_detail (property_id, parking_scope);
create index ix_parking_contract_main on public.parking_contract_detail (main_lease_contract_id) where main_lease_contract_id is not null;
create index ix_parking_vehicle_assignment_dates on public.parking_vehicle_history (lease_contract_unit_id, effective_from desc);
create index ix_parking_import_batch_status on public.parking_import_batch (status, created_at desc);
create index ix_parking_import_row_batch_status on public.parking_import_row (parking_import_batch_id, validation_status);

create or replace function public.normalize_parking_tenant_name(input_name text)
returns text
language sql
immutable
parallel safe
as $$
  select lower(
    regexp_replace(
      replace(replace(replace(replace(replace(replace(coalesce(input_name, ''), '株式会社', ''), '(株)', ''), '（株）', ''), '㈱', ''), '有限会社', ''), '　', ''),
      '[[:space:]・･]', '', 'g'
    )
  );
$$;

create or replace function public.validate_parking_contract_detail()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  child_contract public.lease_contract%rowtype;
  main_contract public.lease_contract%rowtype;
begin
  select * into child_contract from public.lease_contract where lease_contract_id = new.lease_contract_id;
  if not found or child_contract.contract_type is distinct from 'parking' then
    raise exception '駐車場契約は contract_type=parking の契約である必要があります';
  end if;

  if new.parking_scope = 'external' then
    return new;
  end if;

  select * into main_contract from public.lease_contract where lease_contract_id = new.main_lease_contract_id;
  if not found then raise exception '主契約が見つかりません'; end if;
  if main_contract.contract_type = 'parking' or exists (
    select 1 from public.parking_contract_detail where lease_contract_id = main_contract.lease_contract_id
  ) then raise exception '駐車場契約を主契約には指定できません'; end if;
  if main_contract.tenant_id <> child_contract.tenant_id then raise exception '主契約と駐車場契約のテナントが一致しません'; end if;
  if not exists (
    select 1 from public.lease_contract_unit contract_unit
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
    where contract_unit.lease_contract_id = main_contract.lease_contract_id
      and unit.property_id = new.property_id and unit.unit_type <> 'parking'
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
$$;

create trigger validate_parking_contract_detail_before_write
before insert or update on public.parking_contract_detail
for each row execute procedure public.validate_parking_contract_detail();

create trigger set_parking_facility_updated_at before update on public.parking_facility_master
for each row execute procedure public.set_updated_at();
create trigger set_parking_space_updated_at before update on public.parking_space_master
for each row execute procedure public.set_updated_at();
create trigger set_parking_contract_detail_updated_at before update on public.parking_contract_detail
for each row execute procedure public.set_updated_at();
create trigger set_parking_assignment_updated_at before update on public.parking_space_assignment
for each row execute procedure public.set_updated_at();
create trigger set_parking_vehicle_updated_at before update on public.parking_vehicle_history
for each row execute procedure public.set_updated_at();
create trigger set_parking_import_row_updated_at before update on public.parking_import_row
for each row execute procedure public.set_updated_at();

create or replace view public.parking_main_contract_candidate
with (security_invoker = true)
as
select
  unit.property_id,
  contract.lease_contract_id,
  contract.tenant_id,
  tenant.tenant_name,
  contract.contract_start_date,
  contract.contract_end_date,
  contract.contract_status,
  string_agg(distinct coalesce(unit.floor_label || ' ', '') || unit.unit_code, ', ' order by coalesce(unit.floor_label || ' ', '') || unit.unit_code) as unit_labels
from public.lease_contract contract
join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
join public.lease_contract_unit contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
join public.unit_master unit on unit.unit_id = contract_unit.unit_id and unit.unit_type <> 'parking'
where contract.contract_status = 'active'
group by unit.property_id, contract.lease_contract_id, contract.tenant_id, tenant.tenant_name,
  contract.contract_start_date, contract.contract_end_date, contract.contract_status;

create or replace view public.parking_current_list
with (security_invoker = true)
as
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
  active_lease.contract_start_date,
  active_lease.contract_end_date,
  active_lease.tenant_id,
  active_lease.tenant_name,
  active_lease.parking_scope,
  active_lease.main_lease_contract_id,
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
join public.parking_facility_master facility on facility.parking_facility_id = space.parking_facility_id
left join public.parking_type_master parking_type on parking_type.parking_type_id = facility.parking_type_id
join public.asset_master asset on asset.asset_id = facility.property_id
join public.unit_master unit on unit.unit_id = space.unit_id
left join lateral (
  select
    contract_unit.lease_contract_unit_id,
    contract.lease_contract_id,
    contract.contract_status,
    contract.contract_start_date,
    contract.contract_end_date,
    contract.tenant_id,
    tenant.tenant_name,
    detail.parking_scope,
    detail.main_lease_contract_id
  from public.lease_contract_unit contract_unit
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.parking_contract_detail detail on detail.lease_contract_id = contract.lease_contract_id
  join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
  where contract_unit.unit_id = space.unit_id
    and contract.contract_status = 'active'
    and (contract.contract_start_date is null or contract.contract_start_date <= current_date)
    and (contract.contract_end_date is null or contract.contract_end_date >= current_date)
    and (contract_unit.lease_start_date is null or contract_unit.lease_start_date <= current_date)
    and (contract_unit.lease_end_date is null or contract_unit.lease_end_date >= current_date)
  order by coalesce(contract_unit.lease_start_date, contract.contract_start_date) desc nulls last, contract_unit.created_at desc
  limit 1
) active_lease on true
left join public.lease_contract main_contract on main_contract.lease_contract_id = active_lease.main_lease_contract_id
left join public.parking_space_assignment assignment on assignment.lease_contract_unit_id = active_lease.lease_contract_unit_id
left join lateral (
  select history.vehicle_model, history.registration_number, history.chassis_number, history.effective_from
  from public.parking_vehicle_history history
  where history.lease_contract_unit_id = active_lease.lease_contract_unit_id
    and history.effective_from <= current_date
    and (history.effective_to is null or history.effective_to >= current_date)
  order by history.effective_from desc, history.created_at desc
  limit 1
) vehicle on true;

create or replace function public.prepare_parking_import(
  p_property_id uuid,
  p_parking_facility_id uuid,
  p_as_of_date date,
  p_source_file_name text,
  p_source_sheet_name text,
  p_source_file_hash text,
  p_rows jsonb
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  batch_id uuid;
  source_row jsonb;
  tenant_matches integer;
  tenant_id uuid;
  messages text[];
begin
  if not (select public.current_account_is_active()) or (select public.current_account_role()) not in ('admin', 'manager') then
    raise exception '駐車場取込は管理者またはマネージャーだけが実行できます';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception '取込明細がありません'; end if;
  if not exists (
    select 1 from public.parking_facility_master
    where parking_facility_id = p_parking_facility_id and property_id = p_property_id and is_active
  ) then raise exception '物件に紐づく有効な駐車場施設を指定してください'; end if;

  select parking_import_batch_id into batch_id from public.parking_import_batch
  where property_id = p_property_id and source_file_hash = p_source_file_hash;
  if batch_id is not null then return batch_id; end if;

  insert into public.parking_import_batch (
    property_id, parking_facility_id, source_file_name, source_sheet_name, source_file_hash, as_of_date
  ) values (
    p_property_id, p_parking_facility_id, left(p_source_file_name, 255), left(p_source_sheet_name, 100), lower(p_source_file_hash), p_as_of_date
  ) returning parking_import_batch_id into batch_id;

  for source_row in select value from jsonb_array_elements(p_rows) loop
    if nullif(trim(source_row->>'space_number'), '') is null then raise exception '枠番が空の行があります'; end if;
    if nullif(trim(source_row->>'tenant_name'), '') is null then raise exception 'テナント名が空の行があります'; end if;
    select count(*), min(tenant.tenant_id::text)::uuid into tenant_matches, tenant_id
    from public.tenant_master tenant
    where public.normalize_parking_tenant_name(tenant.tenant_name) = public.normalize_parking_tenant_name(source_row->>'tenant_name');
    messages := array['内部・外部を選択してください'];
    if tenant_matches = 0 then messages := messages || 'テナント候補が見つかりません'; end if;
    if tenant_matches > 1 then messages := messages || 'テナント候補が複数あります'; end if;
    insert into public.parking_import_row (
      parking_import_batch_id, source_row_number, space_number, access_code, tenant_location_label,
      tenant_name, normalized_tenant_name, matched_tenant_id, contract_start_date,
      vehicle_model, registration_number, chassis_number, notes, validation_messages, raw_payload
    ) values (
      batch_id, (source_row->>'source_row_number')::integer, trim(source_row->>'space_number'), nullif(trim(source_row->>'access_code'), ''),
      nullif(trim(source_row->>'tenant_location_label'), ''), trim(source_row->>'tenant_name'),
      public.normalize_parking_tenant_name(source_row->>'tenant_name'), case when tenant_matches = 1 then tenant_id end,
      nullif(source_row->>'contract_start_date', '')::date, nullif(trim(source_row->>'vehicle_model'), ''),
      nullif(trim(source_row->>'registration_number'), ''), nullif(trim(source_row->>'chassis_number'), ''),
      nullif(trim(source_row->>'notes'), ''), messages, source_row
    );
  end loop;
  return batch_id;
end;
$$;

create or replace function public.commit_parking_import(p_batch_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
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
    select 1 from public.parking_import_row
    where parking_import_batch_id = p_batch_id
      and (matched_tenant_id is null or parking_scope is null
        or (parking_scope = 'internal' and main_lease_contract_id is null)
        or (parking_scope = 'external' and main_lease_contract_id is not null))
  ) then raise exception 'テナント、内部・外部、主契約の選択を完了してください'; end if;
  if exists (
    select 1 from public.parking_import_row where parking_import_batch_id = p_batch_id
    group by space_number having count(*) > 1
  ) then raise exception '同じ枠番が複数行あります'; end if;

  for import_row in
    select * from public.parking_import_row where parking_import_batch_id = p_batch_id order by source_row_number
  loop
    -- 既存の物理枠を優先し、未整備の旧駐車場区画が1件だけ一致する場合はIDを保ったまま転用する。
    select space.unit_id into target_unit_id from public.parking_space_master space
    where space.parking_facility_id = batch.parking_facility_id and space.space_number = import_row.space_number;
    if target_unit_id is null then
      select count(distinct unit.unit_id), min(unit.unit_id::text)::uuid into reusable_unit_count, reusable_unit_id
      from public.unit_master unit
      join public.lease_contract_unit contract_unit on contract_unit.unit_id = unit.unit_id
      join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
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
      else
        insert into public.unit_master (property_id, unit_code, unit_name, floor_label, unit_type, is_active)
        values (
          batch.property_id, left('PK-' || facility.facility_code || '-' || import_row.space_number, 100),
          '駐車枠 ' || import_row.space_number, '駐車場', 'parking', true
        ) returning unit_id into target_unit_id;
      end if;
      insert into public.parking_space_master (unit_id, parking_facility_id, space_number)
      values (target_unit_id, batch.parking_facility_id, import_row.space_number);
    end if;

    -- 転用した旧区画が既に駐車場単独契約を持つ場合は契約IDも維持する。
    select contract.lease_contract_id into parking_contract_id
    from public.lease_contract_unit contract_unit
    join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
    where contract_unit.unit_id = target_unit_id and contract.tenant_id = import_row.matched_tenant_id
      and contract.contract_status = 'active'
      and not exists (
        select 1 from public.lease_contract_unit other_contract_unit
        join public.unit_master other_unit on other_unit.unit_id = other_contract_unit.unit_id
        where other_contract_unit.lease_contract_id = contract.lease_contract_id and other_unit.unit_type <> 'parking'
      )
    order by contract_unit.created_at desc limit 1;

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
      source_key := 'parking_excel:' || encode(extensions.digest(concat_ws('|', batch.property_id::text,
        import_row.matched_tenant_id::text, import_row.parking_scope,
        coalesce(import_row.main_lease_contract_id::text, 'external'), coalesce(import_row.contract_start_date::text, '')), 'sha256'::text), 'hex');
      insert into public.lease_contract (
        tenant_id, contract_status, contract_type, contract_start_date, source_system, source_record_key, notes
      ) values (
        import_row.matched_tenant_id, 'active', 'parking', import_row.contract_start_date,
        'parking_excel', source_key, '物件別駐車場台帳から登録'
      ) returning lease_contract_id into parking_contract_id;
      insert into public.parking_contract_detail (lease_contract_id, property_id, parking_scope, main_lease_contract_id)
      values (parking_contract_id, batch.property_id, import_row.parking_scope, import_row.main_lease_contract_id);
    end if;

    -- 同じ枠に別の現行契約がある場合は、基準日前日で旧割当を終了する。
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
      committed_lease_contract_unit_id = contract_unit_id, updated_at = now()
    where parking_import_row_id = import_row.parking_import_row_id;
    committed_count := committed_count + 1;
  end loop;

  update public.parking_import_batch set status = 'committed', committed_at = now()
  where parking_import_batch_id = p_batch_id;
  return jsonb_build_object('batch_id', p_batch_id, 'committed_count', committed_count, 'already_committed', false);
end;
$$;

alter table public.parking_type_master enable row level security;
alter table public.parking_facility_master enable row level security;
alter table public.parking_space_master enable row level security;
alter table public.parking_contract_detail enable row level security;
alter table public.parking_space_assignment enable row level security;
alter table public.parking_vehicle_history enable row level security;
alter table public.parking_import_batch enable row level security;
alter table public.parking_import_row enable row level security;

grant select on public.parking_type_master, public.parking_facility_master, public.parking_space_master,
  public.parking_contract_detail, public.parking_space_assignment, public.parking_vehicle_history to authenticated;
grant select, insert, update, delete on public.parking_import_batch, public.parking_import_row to authenticated;
grant select, insert, update, delete on public.parking_facility_master, public.parking_space_master,
  public.parking_contract_detail, public.parking_space_assignment, public.parking_vehicle_history to authenticated;
grant select on public.parking_current_list, public.parking_main_contract_candidate to authenticated;
grant execute on function public.prepare_parking_import(uuid, uuid, date, text, text, text, jsonb) to authenticated;
grant execute on function public.commit_parking_import(uuid) to authenticated;
revoke all on function public.prepare_parking_import(uuid, uuid, date, text, text, text, jsonb) from public;
revoke all on function public.commit_parking_import(uuid) from public;
revoke all on function public.prepare_parking_import(uuid, uuid, date, text, text, text, jsonb) from anon;
revoke all on function public.commit_parking_import(uuid) from anon;

create policy "active users read parking types" on public.parking_type_master for select to authenticated
using ((select public.current_account_is_active()));
create policy "active users read parking facilities" on public.parking_facility_master for select to authenticated
using ((select public.current_account_is_active()));
create policy "managers manage parking facilities" on public.parking_facility_master for all to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "active users read parking spaces" on public.parking_space_master for select to authenticated
using ((select public.current_account_is_active()));
create policy "managers manage parking spaces" on public.parking_space_master for all to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "active users read parking contracts" on public.parking_contract_detail for select to authenticated
using ((select public.current_account_is_active()));
create policy "managers manage parking contracts" on public.parking_contract_detail for all to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "active users read parking assignments" on public.parking_space_assignment for select to authenticated
using ((select public.current_account_is_active()));
create policy "managers manage parking assignments" on public.parking_space_assignment for all to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "active users read parking vehicles" on public.parking_vehicle_history for select to authenticated
using ((select public.current_account_is_active()));
create policy "managers manage parking vehicles" on public.parking_vehicle_history for all to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers manage parking import batches" on public.parking_import_batch for all to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers manage parking import rows" on public.parking_import_row for all to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));

comment on table public.parking_space_master is 'unit_masterの駐車場区画に対する物理枠情報。unit_idが駐車枠の正本キー。';
comment on table public.parking_contract_detail is '駐車場子契約の内部・外部区分と、内部契約の事務所主契約。';
comment on table public.parking_space_assignment is '駐車場契約区画ごとの暗証番号・契約者所在・取込元。';
comment on view public.parking_current_list is 'レントロールと駐車場専用画面が共有する現行駐車枠一覧。';
