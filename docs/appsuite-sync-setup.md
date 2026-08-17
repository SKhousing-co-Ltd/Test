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

## service_role の同期依存権限

`appsuite_record` のトリガーは呼出元権限で動作します。Edge Function が使う `service_role` には、契約照合と発注候補照合に必要な参照権限、変更依頼の登録権限、契約照合関数の実行権限だけを付与します。契約・物件・発注本体への書込権限や、`anon` への公開権限は付与しません。

適用SQLは `20260817075940_grant_appsuite_sync_service_role_dependencies.sql` で管理します。権限エラーを回避するために関数を `SECURITY DEFINER` へ変更しないでください。

同期の成否はHTTP結果だけでなく、`appsuite_sync_run` のアプリ別 `status`、取得・追加・更新・欠落件数と `appsuite_application.last_synced_at` を突合します。
