-- Make AppSuite the reliable daily source for contract/rent-roll and procurement workflows.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create index if not exists ix_appsuite_sync_run_app_started
  on public.appsuite_sync_run (app_id, started_at desc);

create or replace function public.enqueue_contract_change_request_from_appsuite()
returns trigger
language plpgsql
set search_path = public
as $$
declare request_id uuid;
begin
  if new.app_id <> '65' or not new.is_present
     or lower(coalesce(new.approval_status, '')) not in ('approved', 'completed', '完了', '決裁済み', '社長決裁済') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.revision is not distinct from new.revision
     and old.raw_payload is not distinct from new.raw_payload
     and old.approval_status is not distinct from new.approval_status
     and old.is_present is not distinct from new.is_present then
    return new;
  end if;
  if exists (
    select 1 from public.change_request as request
     where request.source_type = 'desknets'
       and request.source_record_key = concat(new.app_id, ':', new.data_id)
       and request.request_type = 'contract_create'
       and request.status not in ('applied', 'excluded')
  ) then return new; end if;

  begin
    insert into public.change_request (
      source_type, source_record_key, request_type, status, title, summary, source_payload, proposed_payload
    ) values (
      'desknets', concat(new.app_id, ':', new.data_id), 'contract_create', 'open',
      concat('DeskNet''s新規契約: ', coalesce(new.property_name, '物件未設定'), ' / ', coalesce(new.tenant_name, '契約者未設定')),
      'DeskNet''sで完了した契約です。区画を確認してからレントロールへ適用してください。',
      new.raw_payload, new.raw_payload
    ) returning change_request_id into request_id;
  exception when unique_violation then
    return new;
  end;

  insert into public.change_request_item (
    change_request_id, entity_type, validation_status, validation_message
  ) values (
    request_id, 'other', 'pending', '対象の契約区画・項目・値を選んでください。'
  );
  return new;
end;
$$;

drop trigger if exists enqueue_contract_change_request_from_appsuite on public.appsuite_record;
create trigger enqueue_contract_change_request_from_appsuite
after insert or update of revision, raw_payload, approval_status, is_present on public.appsuite_record
for each row execute function public.enqueue_contract_change_request_from_appsuite();

revoke all on function public.enqueue_contract_change_request_from_appsuite() from public;

create or replace view public.appsuite_sync_health
with (security_invoker = true)
as
select
  application.app_id,
  application.app_name,
  application.is_sync_enabled,
  application.last_synced_at,
  application.is_sync_enabled and (
    application.last_synced_at is null or application.last_synced_at < now() - interval '36 hours'
  ) as is_stale,
  latest.status as last_run_status,
  latest.started_at as last_run_started_at,
  latest.finished_at as last_run_finished_at,
  latest.fetched_count as last_fetched_count,
  latest.inserted_count as last_inserted_count,
  latest.updated_count as last_updated_count,
  latest.error_message as last_error_message
from public.appsuite_application as application
left join lateral (
  select run.status, run.started_at, run.finished_at, run.fetched_count,
    run.inserted_count, run.updated_count, run.error_message
  from public.appsuite_sync_run as run
  where run.app_id = application.app_id
  order by run.started_at desc
  limit 1
) as latest on true;

grant select on public.appsuite_sync_health to authenticated;

do $job$
declare
  v_job_id bigint;
  v_command text := $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'appsuite_sync_project_url_20260728') || '/functions/v1/sync-appsuite-records',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'appsuite_sync_publishable_key_20260728'),
        'x-appsuite-scheduler-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'appsuite_sync_scheduler_secret_20260728')
      ),
      body := jsonb_build_object('appId', application.app_id),
      timeout_milliseconds := 120000
    )
    from public.appsuite_application as application
    where application.is_sync_enabled
  $cron$;
begin
  select jobid into v_job_id from cron.job where jobname = 'appsuite-daily-sync';
  if v_job_id is null then
    perform cron.schedule('appsuite-daily-sync', '0 17 * * *', v_command);
  else
    perform cron.alter_job(
      job_id := v_job_id,
      schedule := '0 17 * * *',
      command := v_command,
      active := true
    );
  end if;
end;
$job$;

comment on view public.appsuite_sync_health is '同期対象アプリごとの鮮度、直近実行、取得件数、エラーを監視する。';
