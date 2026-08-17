# AppSuite 同期のデプロイ設定

1. `20260728000000_create_appsuite_sync.sql` を適用します。
2. Edge Function の Secrets に次を設定します。ローカルの `.env.local` にある値をブラウザへ公開しないでください。

   - `APPSUITE_URL`
   - `APPSUITE_ACCESS_KEY`
   - `APPSUITE_SCHEDULER_SECRET`（ランダムな長い文字列）

3. `preview-appsuite-sync`、`commit-appsuite-sync`、`sync-appsuite-records` をデプロイします。
4. Supabase Vault にプロジェクトURL、publishable key、上記のスケジューラー用シークレットを保存し、Cronで毎日02:00 JST（UTC 17:00）に直接同期を呼び出します。同期対象アプリごとに独立したHTTPリクエストを作るため、1アプリの失敗が他アプリを止めません。AppSuite APIの全件取得には5秒を超えるため、タイムアウトは120秒にします。

```sql
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'appsuite-daily-sync'),
  schedule := '0 17 * * *',
  command := $$ select net.http_post(
    url := '<SUPABASE_URL>/functions/v1/sync-appsuite-records',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<PUBLISHABLE_KEY>',
      'x-appsuite-scheduler-secret', '<APPSUITE_SCHEDULER_SECRET>'
    ),
    body := jsonb_build_object('appId', application.app_id),
    timeout_milliseconds := 120000
  )
  from public.appsuite_application as application
  where application.is_sync_enabled; $$,
  active := true
);
```

Supabase Vaultを使う場合は、`<...>` を `vault.decrypted_secrets` の参照に置き換えます。これにより、定期実行用の秘密値をSQL本文へ残しません。
