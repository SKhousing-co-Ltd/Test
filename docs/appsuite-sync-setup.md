# AppSuite 同期のデプロイ設定

1. `20260728000000_create_appsuite_sync.sql` を適用します。
2. Edge Function の Secrets に次を設定します。ローカルの `.env.local` にある値をブラウザへ公開しないでください。

   - `APPSUITE_URL`
   - `APPSUITE_ACCESS_KEY`
   - `APPSUITE_SCHEDULER_SECRET`（ランダムな長い文字列）

3. `preview-appsuite-sync`、`commit-appsuite-sync`、`sync-appsuite-records` をデプロイします。
4. Supabase Vault にプロジェクトURL、publishable key、上記のスケジューラー用シークレットを保存します。Cronは02:00 JSTから1分ごとに同期対象を1アプリずつ起動します。これによりAppSuite APIへ同時リクエストを送らず、あるアプリの失敗も後続アプリを止めません。AppSuite APIの全件取得には5秒を超えるため、タイムアウトは120秒にします。

```sql
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'appsuite-daily-sync'),
  schedule := '* 17 * * *',
  command := $$ with clock as (
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
  ) select net.http_post(
    url := '<SUPABASE_URL>/functions/v1/sync-appsuite-records',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<PUBLISHABLE_KEY>',
      'x-appsuite-scheduler-secret', '<APPSUITE_SCHEDULER_SECRET>'
    ),
    body := jsonb_build_object('appId', target.app_id),
    timeout_milliseconds := 120000
  )
  from target; $$,
  active := true
);
```

Supabase Vaultを使う場合は、`<...>` を `vault.decrypted_secrets` の参照に置き換えます。これにより、定期実行用の秘密値をSQL本文へ残しません。

## service_role の同期依存権限

`appsuite_record` のトリガーは呼出元権限で動作します。Edge Function が使う `service_role` には、契約照合と発注候補照合に必要な参照権限、変更依頼の登録権限、契約照合関数の実行権限だけを付与します。契約・物件・発注本体への書込権限や、`anon` への公開権限は付与しません。

適用SQLは `20260817075940_grant_appsuite_sync_service_role_dependencies.sql` と `20260831055348_appsuite_sync_stagger_and_grant_normalize.sql` で管理します。`normalize_appsuite_ringi_number` は `appsuite_record` の式インデックスで使用するため、同期専用の `service_role` にだけ実行権限を付与します。ブラウザロールへの権限付与や、権限エラー回避のための関数の `SECURITY DEFINER` 化は行いません。

同期の成否はHTTP結果だけでなく、`appsuite_sync_run` のアプリ別 `status`、取得・追加・更新・欠落件数と `appsuite_application.last_synced_at` を突合します。
