create table public.case_progress_sync_runs (
  case_progress_sync_run_id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status varchar(20) not null default 'running',
  source_system varchar(30) not null,
  spreadsheet_id text not null,
  sheet_name text not null,
  trigger_type varchar(20) not null,
  source_row_count integer not null default 0,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  unchanged_count integer not null default 0,
  inactive_count integer not null default 0,
  blank_id_count integer not null default 0,
  error_count integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  constraint ck_case_progress_sync_run_status
    check (status in ('running', 'success', 'partial', 'failed')),
  constraint ck_case_progress_sync_run_trigger_type
    check (trigger_type in ('scheduled', 'manual')),
  constraint ck_case_progress_sync_run_counts_nonnegative
    check (
      source_row_count >= 0
      and inserted_count >= 0
      and updated_count >= 0
      and unchanged_count >= 0
      and inactive_count >= 0
      and blank_id_count >= 0
      and error_count >= 0
    ),
  constraint ck_case_progress_sync_run_completion
    check (
      (status = 'running' and completed_at is null)
      or (status <> 'running' and completed_at is not null)
    )
);

comment on table public.case_progress_sync_runs is
  'Google案件進捗シートからstagingへの同期実行履歴。';

create table public.case_progress_import_staging (
  case_progress_import_staging_id uuid primary key default gen_random_uuid(),
  source_system varchar(30) not null,
  spreadsheet_id text not null,
  sheet_name text not null,
  source_row_number integer not null,
  source_key text not null,
  legacy_case_id text,
  manager_raw text,
  building_raw text,
  case_name_raw text,
  category_raw text,
  status_raw text,
  input_date date,
  planned_process_date date,
  processed_date date,
  approval_no_raw text,
  approval_no_normalized text,
  budget_amount numeric(14, 0),
  decided_amount numeric(14, 0),
  planned_completion_date date,
  note text,
  raw_payload jsonb not null,
  validation_errors jsonb not null default '[]'::jsonb,
  source_hash text not null,
  identity_quality varchar(20) not null,
  source_active boolean not null default true,
  missing_since timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  source_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_case_progress_import_source
    unique (source_system, spreadsheet_id, sheet_name, source_key),
  constraint ck_case_progress_import_source_row
    check (source_row_number >= 2),
  constraint ck_case_progress_import_identity_quality
    check (identity_quality in ('strong', 'fallback')),
  constraint ck_case_progress_import_identity
    check (
      (identity_quality = 'strong' and legacy_case_id is not null and source_key = 'id:' || legacy_case_id)
      or (identity_quality = 'fallback' and legacy_case_id is null and source_key = 'row:' || source_row_number::text)
    ),
  constraint ck_case_progress_import_raw_payload
    check (jsonb_typeof(raw_payload) = 'object'),
  constraint ck_case_progress_import_validation_errors
    check (jsonb_typeof(validation_errors) = 'array'),
  constraint ck_case_progress_import_source_hash
    check (source_hash ~ '^[0-9a-f]{64}$'),
  constraint ck_case_progress_import_missing_since
    check ((source_active and missing_since is null) or not source_active)
);

comment on table public.case_progress_import_staging is
  'Google案件進捗シートの検証用staging。正式案件データではない。';
comment on column public.case_progress_import_staging.raw_payload is
  'Google Sheetから取得した行の表示値をヘッダー名で保持する。';
comment on column public.case_progress_import_staging.identity_quality is
  'strongはSheet ID、fallbackは一時的な行番号を同期識別子に利用する。';

create index ix_case_progress_import_approval_no
  on public.case_progress_import_staging (approval_no_normalized)
  where approval_no_normalized is not null;
create index ix_case_progress_import_active_synced
  on public.case_progress_import_staging (source_active, source_synced_at desc);
create index ix_case_progress_import_legacy_id
  on public.case_progress_import_staging (legacy_case_id)
  where legacy_case_id is not null;
create index ix_case_progress_sync_runs_started
  on public.case_progress_sync_runs (started_at desc);

create trigger set_case_progress_import_staging_updated_at
  before update on public.case_progress_import_staging
  for each row execute procedure public.set_updated_at();

alter table public.case_progress_import_staging enable row level security;
alter table public.case_progress_sync_runs enable row level security;

revoke all on public.case_progress_import_staging from anon, authenticated;
revoke all on public.case_progress_sync_runs from anon, authenticated;
grant select on public.case_progress_import_staging, public.case_progress_sync_runs to authenticated;
grant select, insert, update, delete on public.case_progress_import_staging, public.case_progress_sync_runs to service_role;

create policy "admins read case progress staging"
  on public.case_progress_import_staging
  for select to authenticated
  using ((select public.current_account_is_admin()));

create policy "admins read case progress sync runs"
  on public.case_progress_sync_runs
  for select to authenticated
  using ((select public.current_account_is_admin()));

create or replace function private.case_progress_sync_rows(p_rows jsonb)
returns table (
  source_row_number integer,
  source_key text,
  legacy_case_id text,
  manager_raw text,
  building_raw text,
  case_name_raw text,
  category_raw text,
  status_raw text,
  input_date date,
  planned_process_date date,
  processed_date date,
  approval_no_raw text,
  approval_no_normalized text,
  budget_amount numeric(14, 0),
  decided_amount numeric(14, 0),
  planned_completion_date date,
  note text,
  raw_payload jsonb,
  validation_errors jsonb,
  source_hash text,
  identity_quality varchar(20)
)
language sql
immutable
set search_path = ''
as $$
  select *
    from jsonb_to_recordset(p_rows) as row_data (
      source_row_number integer,
      source_key text,
      legacy_case_id text,
      manager_raw text,
      building_raw text,
      case_name_raw text,
      category_raw text,
      status_raw text,
      input_date date,
      planned_process_date date,
      processed_date date,
      approval_no_raw text,
      approval_no_normalized text,
      budget_amount numeric(14, 0),
      decided_amount numeric(14, 0),
      planned_completion_date date,
      note text,
      raw_payload jsonb,
      validation_errors jsonb,
      source_hash text,
      identity_quality varchar(20)
    );
$$;

revoke all on function private.case_progress_sync_rows(jsonb) from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.case_progress_sync_rows(jsonb) to service_role;

create or replace function public.apply_case_progress_sync(
  p_sync_run_id uuid,
  p_source_system text,
  p_spreadsheet_id text,
  p_sheet_name text,
  p_synced_at timestamptz,
  p_rows jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_run public.case_progress_sync_runs;
  v_source_row_count integer;
  v_inserted_count integer;
  v_updated_count integer;
  v_unchanged_count integer;
  v_inactive_count integer;
  v_blank_id_count integer;
  v_error_count integer;
  v_status varchar(20);
begin
  if p_synced_at is null then
    raise exception 'p_synced_at is required';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'p_rows must be a non-empty JSON array';
  end if;

  select * into v_run
    from public.case_progress_sync_runs
   where case_progress_sync_run_id = p_sync_run_id
   for update;

  if v_run.case_progress_sync_run_id is null then
    raise exception 'sync run not found';
  end if;
  if v_run.status <> 'running' then
    raise exception 'sync run is not running';
  end if;
  if v_run.source_system <> p_source_system
     or v_run.spreadsheet_id <> p_spreadsheet_id
     or v_run.sheet_name <> p_sheet_name then
    raise exception 'sync run source does not match payload';
  end if;

  select count(*) into v_source_row_count from private.case_progress_sync_rows(p_rows);
  if v_source_row_count <> jsonb_array_length(p_rows) then
    raise exception 'payload rows could not be parsed completely';
  end if;
  if exists (
    select 1 from private.case_progress_sync_rows(p_rows)
     where source_row_number < 2
        or source_key = ''
        or jsonb_typeof(raw_payload) <> 'object'
        or jsonb_typeof(validation_errors) <> 'array'
        or source_hash !~ '^[0-9a-f]{64}$'
        or identity_quality not in ('strong', 'fallback')
        or (identity_quality = 'strong' and (legacy_case_id is null or source_key <> 'id:' || legacy_case_id))
        or (identity_quality = 'fallback' and (legacy_case_id is not null or source_key <> 'row:' || source_row_number::text))
  ) then
    raise exception 'payload contains an invalid row';
  end if;
  if exists (
    select source_key from private.case_progress_sync_rows(p_rows) group by source_key having count(*) > 1
  ) then
    raise exception 'payload contains duplicate source keys';
  end if;

  select count(*) into v_inserted_count
    from private.case_progress_sync_rows(p_rows) incoming
   where not exists (
     select 1 from public.case_progress_import_staging stored
      where stored.source_system = p_source_system
        and stored.spreadsheet_id = p_spreadsheet_id
        and stored.sheet_name = p_sheet_name
        and stored.source_key = incoming.source_key
   );

  select count(*) into v_updated_count
    from private.case_progress_sync_rows(p_rows) incoming
    join public.case_progress_import_staging stored
      on stored.source_system = p_source_system
     and stored.spreadsheet_id = p_spreadsheet_id
     and stored.sheet_name = p_sheet_name
     and stored.source_key = incoming.source_key
   where stored.source_hash is distinct from incoming.source_hash;

  select count(*) into v_unchanged_count
    from private.case_progress_sync_rows(p_rows) incoming
    join public.case_progress_import_staging stored
      on stored.source_system = p_source_system
     and stored.spreadsheet_id = p_spreadsheet_id
     and stored.sheet_name = p_sheet_name
     and stored.source_key = incoming.source_key
   where stored.source_hash = incoming.source_hash;

  insert into public.case_progress_import_staging (
    source_system, spreadsheet_id, sheet_name, source_row_number, source_key,
    legacy_case_id, manager_raw, building_raw, case_name_raw, category_raw, status_raw,
    input_date, planned_process_date, processed_date,
    approval_no_raw, approval_no_normalized, budget_amount, decided_amount,
    planned_completion_date, note, raw_payload, validation_errors, source_hash,
    identity_quality, source_active, missing_since, first_seen_at, last_seen_at, source_synced_at
  )
  select
    p_source_system, p_spreadsheet_id, p_sheet_name, incoming.source_row_number, incoming.source_key,
    incoming.legacy_case_id, incoming.manager_raw, incoming.building_raw, incoming.case_name_raw,
    incoming.category_raw, incoming.status_raw, incoming.input_date, incoming.planned_process_date,
    incoming.processed_date, incoming.approval_no_raw, incoming.approval_no_normalized,
    incoming.budget_amount, incoming.decided_amount, incoming.planned_completion_date, incoming.note,
    incoming.raw_payload, incoming.validation_errors, incoming.source_hash, incoming.identity_quality,
    true, null, p_synced_at, p_synced_at, p_synced_at
  from private.case_progress_sync_rows(p_rows) incoming
  on conflict (source_system, spreadsheet_id, sheet_name, source_key) do update set
    source_row_number = excluded.source_row_number,
    legacy_case_id = excluded.legacy_case_id,
    manager_raw = excluded.manager_raw,
    building_raw = excluded.building_raw,
    case_name_raw = excluded.case_name_raw,
    category_raw = excluded.category_raw,
    status_raw = excluded.status_raw,
    input_date = excluded.input_date,
    planned_process_date = excluded.planned_process_date,
    processed_date = excluded.processed_date,
    approval_no_raw = excluded.approval_no_raw,
    approval_no_normalized = excluded.approval_no_normalized,
    budget_amount = excluded.budget_amount,
    decided_amount = excluded.decided_amount,
    planned_completion_date = excluded.planned_completion_date,
    note = excluded.note,
    raw_payload = excluded.raw_payload,
    validation_errors = excluded.validation_errors,
    source_hash = excluded.source_hash,
    identity_quality = excluded.identity_quality,
    source_active = true,
    missing_since = null,
    last_seen_at = p_synced_at,
    source_synced_at = p_synced_at;

  update public.case_progress_import_staging stored
     set source_active = false,
         missing_since = coalesce(stored.missing_since, p_synced_at),
         source_synced_at = p_synced_at
   where stored.source_system = p_source_system
     and stored.spreadsheet_id = p_spreadsheet_id
     and stored.sheet_name = p_sheet_name
     and stored.source_active
     and not exists (
       select 1 from private.case_progress_sync_rows(p_rows) incoming where incoming.source_key = stored.source_key
     );
  get diagnostics v_inactive_count = row_count;

  select count(*) filter (where legacy_case_id is null),
         count(*) filter (where jsonb_array_length(validation_errors) > 0)
    into v_blank_id_count, v_error_count
    from private.case_progress_sync_rows(p_rows);

  v_status := case when v_error_count > 0 then 'partial' else 'success' end;

  update public.case_progress_sync_runs
     set completed_at = p_synced_at,
         status = v_status,
         source_row_count = v_source_row_count,
         inserted_count = v_inserted_count,
         updated_count = v_updated_count,
         unchanged_count = v_unchanged_count,
         inactive_count = v_inactive_count,
         blank_id_count = v_blank_id_count,
         error_count = v_error_count,
         error_message = null
   where case_progress_sync_run_id = p_sync_run_id;

  return jsonb_build_object(
    'runId', p_sync_run_id,
    'status', v_status,
    'sourceRowCount', v_source_row_count,
    'insertedCount', v_inserted_count,
    'updatedCount', v_updated_count,
    'unchangedCount', v_unchanged_count,
    'inactiveCount', v_inactive_count,
    'blankIdCount', v_blank_id_count,
    'errorCount', v_error_count
  );
end;
$$;

revoke all on function public.apply_case_progress_sync(uuid, text, text, text, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_case_progress_sync(uuid, text, text, text, timestamptz, jsonb)
  to service_role;

create view public.case_progress_migration_verification
with (security_invoker = true)
as
select
  staging.case_progress_import_staging_id,
  staging.source_system,
  staging.spreadsheet_id,
  staging.sheet_name,
  staging.legacy_case_id,
  staging.manager_raw,
  staging.building_raw,
  staging.case_name_raw,
  staging.category_raw,
  staging.status_raw,
  staging.input_date,
  staging.planned_process_date,
  staging.processed_date,
  staging.approval_no_raw,
  staging.approval_no_normalized,
  staging.budget_amount,
  staging.decided_amount,
  staging.planned_completion_date,
  staging.note,
  staging.identity_quality,
  staging.source_active,
  staging.validation_errors,
  staging.source_row_number,
  staging.source_synced_at,
  coalesce(candidate.match_count, 0)::integer as appsuite_match_count,
  case when candidate.match_count = 1 then candidate.appsuite_record_id end as appsuite_record_id,
  case when candidate.match_count = 1 then candidate.app_id end as appsuite_app_id,
  case when candidate.match_count = 1 then candidate.data_id end as appsuite_data_id,
  case when candidate.match_count = 1 then candidate.approval_status end as appsuite_approval_status,
  case
    when staging.approval_no_normalized is null then 'no_approval_no'
    when coalesce(candidate.match_count, 0) = 0 then 'workflow_not_found'
    when candidate.match_count = 1 then 'matched'
    else 'ambiguous'
  end as match_status,
  case
    when staging.approval_no_normalized is null or coalesce(candidate.match_count, 0) = 0 then 'sheet_only'
    when candidate.match_count = 1 then 'matched'
    else 'needs_review'
  end as summary_group
from public.case_progress_import_staging staging
left join lateral (
  select
    count(*) over () as match_count,
    record.appsuite_record_id,
    record.app_id,
    record.data_id,
    record.approval_status
  from public.appsuite_record record
  where staging.approval_no_normalized is not null
    and record.is_present
    and not coalesce(record.is_cancelled, false)
    and upper(regexp_replace(btrim(coalesce(record.ringi_number, '')), '[[:space:]　]+', '', 'g'))
        = staging.approval_no_normalized
  order by record.created_at desc, record.appsuite_record_id
  limit 1
) candidate on true;

comment on view public.case_progress_migration_verification is
  '案件進捗stagingとAppSuiteを正規化済み稟議番号で突合する管理者向けread-only view。';

revoke all on public.case_progress_migration_verification from anon, authenticated;
grant select on public.case_progress_migration_verification to authenticated;
