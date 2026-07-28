# AppSuite 同期のデプロイ設定

1. `20260728000000_create_appsuite_sync.sql` を適用します。
2. Edge Function の Secrets に次を設定します。ローカルの `.env.local` にある値をブラウザへ公開しないでください。

   - `APPSUITE_URL`
   - `APPSUITE_ACCESS_KEY`
   - `APPSUITE_SCHEDULER_SECRET`（ランダムな長い文字列）

3. `preview-appsuite-sync`、`commit-appsuite-sync`、`sync-appsuite-records` をデプロイします。
4. Supabase Vault にプロジェクトURL、publishable key、上記のスケジューラー用シークレットを保存し、Cronで毎日02:00 JST（UTC 17:00）に直接同期を呼び出します。値は環境により異なるため、次のSQLのプレースホルダーをVault参照に置き換えて実行します。

```sql
select cron.schedule(
  'appsuite-daily-sync',
  '0 17 * * *',
  $$ select net.http_post(
    url := '<SUPABASE_URL>/functions/v1/sync-appsuite-records',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<PUBLISHABLE_KEY>',
      'x-appsuite-scheduler-secret', '<APPSUITE_SCHEDULER_SECRET>'
    ),
    body := '{}'::jsonb
  ); $$
);
```

Supabase Vaultを使う場合は、`<...>` を `vault.decrypted_secrets` の参照に置き換えます。これにより、定期実行用の秘密値をSQL本文へ残しません。
