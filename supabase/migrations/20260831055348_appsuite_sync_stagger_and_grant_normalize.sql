-- Start exactly one enabled AppSuite application per minute from 02:00 JST.
-- This prevents the daily schedule from sending all AppSuite API requests at once.
do $job$
declare
  v_job_id bigint;
  v_command text := $cron$
    with clock as (
      select now() at time zone 'Asia/Tokyo' as jst_now
    ), ranked as (
      select application.app_id, row_number() over (order by application.app_id) as app_position
      from public.appsuite_application as application
      where application.is_sync_enabled
    ), target as (
      select ranked.app_id
      from ranked
      cross join clock
      where extract(hour from clock.jst_now) = 2
        and ranked.app_position = extract(minute from clock.jst_now)::integer + 1
    )
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'appsuite_sync_project_url_20260728') || '/functions/v1/sync-appsuite-records',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'appsuite_sync_publishable_key_20260728'),
        'x-appsuite-scheduler-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'appsuite_sync_scheduler_secret_20260728')
      ),
      body := jsonb_build_object('appId', target.app_id),
      timeout_milliseconds := 120000
    )
    from target
  $cron$;
begin
  select jobid into v_job_id from cron.job where jobname = 'appsuite-daily-sync';
  if v_job_id is null then
    perform cron.schedule('appsuite-daily-sync', '* 17 * * *', v_command);
  else
    perform cron.alter_job(
      job_id := v_job_id,
      schedule := '* 17 * * *',
      command := v_command,
      active := true
    );
  end if;
end;
$job$;

-- The expression index on appsuite_record invokes this function under the
-- Edge Function's service_role during upsert. Keep it unavailable to browser
-- roles while allowing only the scheduled synchronization to execute it.
grant execute on function public.normalize_appsuite_ringi_number(text) to service_role;
