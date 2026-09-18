-- case_progress_migration_verification re-derived the normalized ringi number
-- inline instead of calling public.normalize_appsuite_ringi_number, so it
-- could not use the existing partial index ix_appsuite_record_normalized_ringi.
-- That forced a sequential scan of appsuite_record per staging row (557 x 2745
-- rows), which exceeds the authenticated role's 8s statement_timeout and the
-- page fails with "canceling statement due to statement timeout".

create or replace view public.case_progress_migration_verification
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
    and record.ringi_number is not null
    and not coalesce(record.is_cancelled, false)
    and public.normalize_appsuite_ringi_number(record.ringi_number) = staging.approval_no_normalized
  order by record.created_at desc, record.appsuite_record_id
  limit 1
) candidate on true;

comment on view public.case_progress_migration_verification is
  '案件進捗stagingとAppSuiteを正規化済み稟議番号で突合する管理者向けread-only view。normalize_appsuite_ringi_numberの既存index (ix_appsuite_record_normalized_ringi) を使うため、突合条件はinline式でなく同関数呼び出しにすること。';

revoke all on public.case_progress_migration_verification from anon, authenticated;
grant select on public.case_progress_migration_verification to authenticated;
