begin;

do $$
declare
  v_first_run_id uuid;
  v_second_run_id uuid;
  v_rejected_run_id uuid;
  v_result jsonb;
begin
  if to_regclass('public.case_progress_import_staging') is null then
    raise exception 'case_progress_import_staging is missing';
  end if;
  if to_regclass('public.case_progress_sync_runs') is null then
    raise exception 'case_progress_sync_runs is missing';
  end if;
  if to_regclass('public.case_progress_migration_verification') is null then
    raise exception 'case_progress_migration_verification is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.case_progress_import_staging'::regclass) then
    raise exception 'staging RLS must be enabled';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.case_progress_sync_runs'::regclass) then
    raise exception 'sync runs RLS must be enabled';
  end if;
  if not exists (
    select 1 from pg_class
     where oid = 'public.case_progress_migration_verification'::regclass
       and reloptions @> array['security_invoker=true']
  ) then
    raise exception 'verification view must be security invoker';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.apply_case_progress_sync(uuid,text,text,text,timestamptz,jsonb)',
    'execute'
  ) then
    raise exception 'authenticated must not execute case progress sync RPC';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.apply_case_progress_sync(uuid,text,text,text,timestamptz,jsonb)',
    'execute'
  ) then
    raise exception 'service_role must execute case progress sync RPC';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.apply_case_progress_sync(uuid,text,text,text,timestamptz,jsonb)'::regprocedure) then
    raise exception 'case progress sync RPC must be security invoker';
  end if;

  insert into public.case_progress_sync_runs (
    source_system, spreadsheet_id, sheet_name, trigger_type
  ) values (
    'google_sheets', 'test-sheet', '案件シート', 'manual'
  ) returning case_progress_sync_run_id into v_first_run_id;

  select public.apply_case_progress_sync(
    v_first_run_id,
    'google_sheets',
    'test-sheet',
    '案件シート',
    timestamptz '2026-09-18 04:00:00+09',
    jsonb_build_array(
      jsonb_build_object(
        'source_row_number', 2,
        'source_key', 'id:000001',
        'legacy_case_id', '000001',
        'manager_raw', '01_担当者',
        'building_raw', '01_小山',
        'case_name_raw', '空調更新',
        'category_raw', '空調',
        'status_raw', '検討中',
        'input_date', '2026-09-01',
        'approval_no_raw', null,
        'approval_no_normalized', null,
        'budget_amount', 1000000,
        'raw_payload', jsonb_build_object('ID', '000001'),
        'validation_errors', '[]'::jsonb,
        'source_hash', repeat('a', 64),
        'identity_quality', 'strong'
      ),
      jsonb_build_object(
        'source_row_number', 3,
        'source_key', 'id:000002',
        'legacy_case_id', '000002',
        'case_name_raw', '照明更新',
        'approval_no_raw', 'SK-TEST-001',
        'approval_no_normalized', 'SK-TEST-001',
        'raw_payload', jsonb_build_object('ID', '000002'),
        'validation_errors', '[]'::jsonb,
        'source_hash', repeat('b', 64),
        'identity_quality', 'strong'
      )
    )
  ) into v_result;

  if v_result ->> 'status' <> 'success'
     or (v_result ->> 'insertedCount')::integer <> 2
     or (v_result ->> 'updatedCount')::integer <> 0
     or (v_result ->> 'unchangedCount')::integer <> 0 then
    raise exception 'initial sync counts are incorrect: %', v_result;
  end if;
  if (select count(*) from public.case_progress_import_staging where spreadsheet_id = 'test-sheet') <> 2 then
    raise exception 'initial sync must insert two staging rows';
  end if;
  if (select match_status from public.case_progress_migration_verification where spreadsheet_id = 'test-sheet' and legacy_case_id = '000001') <> 'no_approval_no' then
    raise exception 'blank approval number must be classified as no_approval_no';
  end if;
  if (select match_status from public.case_progress_migration_verification where spreadsheet_id = 'test-sheet' and legacy_case_id = '000002') <> 'workflow_not_found' then
    raise exception 'unmatched approval number must be classified as workflow_not_found';
  end if;

  insert into public.appsuite_record (
    app_id, data_id, workflow_type, approval_status, ringi_number, source_updated_at, raw_payload
  ) values (
    '65', 'case-progress-match-1', '案件進捗照合テスト', '審査中', E' sk-test-001\n', now(), '{}'
  );
  if (select match_status from public.case_progress_migration_verification where spreadsheet_id = 'test-sheet' and legacy_case_id = '000002') <> 'matched' then
    raise exception 'normalized approval number must match one AppSuite record';
  end if;

  insert into public.appsuite_record (
    app_id, data_id, workflow_type, approval_status, ringi_number, source_updated_at, raw_payload
  ) values (
    '65', 'case-progress-match-2', '案件進捗照合テスト', '審査中', 'SK-TEST-001', now(), '{}'
  );
  if (select match_status from public.case_progress_migration_verification where spreadsheet_id = 'test-sheet' and legacy_case_id = '000002') <> 'ambiguous' then
    raise exception 'multiple AppSuite records must be classified as ambiguous';
  end if;

  insert into public.case_progress_sync_runs (
    source_system, spreadsheet_id, sheet_name, trigger_type
  ) values (
    'google_sheets', 'test-sheet', '案件シート', 'scheduled'
  ) returning case_progress_sync_run_id into v_second_run_id;

  select public.apply_case_progress_sync(
    v_second_run_id,
    'google_sheets',
    'test-sheet',
    '案件シート',
    timestamptz '2026-09-19 04:00:00+09',
    jsonb_build_array(
      jsonb_build_object(
        'source_row_number', 7,
        'source_key', 'id:000001',
        'legacy_case_id', '000001',
        'manager_raw', '01_担当者',
        'building_raw', '01_小山',
        'case_name_raw', '空調更新（変更）',
        'category_raw', '空調',
        'status_raw', '発注済',
        'input_date', '2026-09-01',
        'approval_no_raw', null,
        'approval_no_normalized', null,
        'budget_amount', 1100000,
        'raw_payload', jsonb_build_object('ID', '000001'),
        'validation_errors', '[]'::jsonb,
        'source_hash', repeat('c', 64),
        'identity_quality', 'strong'
      ),
      jsonb_build_object(
        'source_row_number', 8,
        'source_key', 'row:8',
        'legacy_case_id', null,
        'case_name_raw', 'IDなし案件',
        'raw_payload', jsonb_build_object('ID', ''),
        'validation_errors', '[]'::jsonb,
        'source_hash', repeat('d', 64),
        'identity_quality', 'fallback'
      )
    )
  ) into v_result;

  if (v_result ->> 'updatedCount')::integer <> 1
     or (v_result ->> 'inactiveCount')::integer <> 1
     or (v_result ->> 'insertedCount')::integer <> 1
     or (v_result ->> 'blankIdCount')::integer <> 1 then
    raise exception 'repeat sync counts are incorrect: %', v_result;
  end if;
  if not exists (
    select 1 from public.case_progress_import_staging
     where spreadsheet_id = 'test-sheet'
       and legacy_case_id = '000001'
       and source_active
       and source_row_number = 7
  ) then
    raise exception 'strong identity must survive row movement';
  end if;
  if not exists (
    select 1 from public.case_progress_import_staging
     where spreadsheet_id = 'test-sheet'
       and legacy_case_id = '000002'
       and not source_active
       and missing_since is not null
  ) then
    raise exception 'missing source row must become inactive';
  end if;
  if not exists (
    select 1 from public.case_progress_import_staging
     where spreadsheet_id = 'test-sheet'
       and source_key = 'row:8'
       and identity_quality = 'fallback'
       and legacy_case_id is null
  ) then
    raise exception 'blank ID must use the row-number fallback key';
  end if;

  insert into public.case_progress_sync_runs (
    source_system, spreadsheet_id, sheet_name, trigger_type
  ) values (
    'google_sheets', 'test-sheet', '案件シート', 'manual'
  ) returning case_progress_sync_run_id into v_rejected_run_id;

  begin
    perform public.apply_case_progress_sync(
      v_rejected_run_id,
      'google_sheets',
      'test-sheet',
      '案件シート',
      timestamptz '2026-09-20 04:00:00+09',
      jsonb_build_array(
        jsonb_build_object(
          'source_row_number', 2,
          'source_key', 'id:duplicate',
          'legacy_case_id', 'duplicate',
          'raw_payload', '{}'::jsonb,
          'validation_errors', '[]'::jsonb,
          'source_hash', repeat('e', 64),
          'identity_quality', 'strong'
        ),
        jsonb_build_object(
          'source_row_number', 3,
          'source_key', 'id:duplicate',
          'legacy_case_id', 'duplicate',
          'raw_payload', '{}'::jsonb,
          'validation_errors', '[]'::jsonb,
          'source_hash', repeat('f', 64),
          'identity_quality', 'strong'
        )
      )
    );
    raise exception 'duplicate source keys were accepted';
  exception when others then
    if sqlerrm = 'duplicate source keys were accepted' then
      raise;
    end if;
    if sqlerrm <> 'payload contains duplicate source keys' then
      raise exception 'unexpected duplicate-key error: %', sqlerrm;
    end if;
  end;
  if (select status from public.case_progress_sync_runs where case_progress_sync_run_id = v_rejected_run_id) <> 'running' then
    raise exception 'rejected RPC must not partially update its run';
  end if;
end;
$$;

insert into public.employee_master (employee_name, email)
values
  ('Case Progress Admin', 'case-progress-admin@example.invalid'),
  ('Case Progress Viewer', 'case-progress-viewer@example.invalid');

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'case-progress-admin@example.invalid', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('10000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'case-progress-viewer@example.invalid', '{}'::jsonb, '{}'::jsonb, now(), now());

update public.user_profiles
   set role = 'admin', account_status = 'active'
 where user_id = '10000000-0000-0000-0000-000000000001';
update public.user_profiles
   set role = 'viewer', account_status = 'active'
 where user_id = '10000000-0000-0000-0000-000000000002';

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
do $$
begin
  if (select count(*) from public.case_progress_import_staging where spreadsheet_id = 'test-sheet') <> 3 then
    raise exception 'admin must read staging rows';
  end if;
  if (select count(*) from public.case_progress_sync_runs where spreadsheet_id = 'test-sheet') <> 3 then
    raise exception 'admin must read sync runs';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
do $$
begin
  if exists (select 1 from public.case_progress_import_staging where spreadsheet_id = 'test-sheet') then
    raise exception 'non-admin must not read staging rows';
  end if;
  if exists (select 1 from public.case_progress_sync_runs where spreadsheet_id = 'test-sheet') then
    raise exception 'non-admin must not read sync runs';
  end if;
  if exists (select 1 from public.case_progress_migration_verification where spreadsheet_id = 'test-sheet') then
    raise exception 'non-admin must not read the verification view';
  end if;
end;
$$;
reset role;

rollback;
