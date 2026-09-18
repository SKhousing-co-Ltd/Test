# 案件進捗シート同期 設定手順

## 1. Supabase

Migration と Edge Function を通常のデプロイ手順で反映する。

```powershell
npx supabase db push
npx supabase functions deploy sync-case-progress-staging
```

同期専用Secretを十分に長いランダム値で作成し、Edge Function Secretへ設定する。値はGit、画面、ログへ記録しない。

```powershell
npx supabase secrets set CASE_PROGRESS_SYNC_SECRET=<同期専用Secret>
```

Edge Function URLは次の形式になる。

```text
https://tkschtjyjcvofuszfgzr.supabase.co/functions/v1/sync-case-progress-staging
```

## 2. Google Apps Script

対象Spreadsheetの既存Apps Scriptプロジェクト「案件進捗管理」を開く。

1. `scripts/google-apps-script/case-progress-sync.gs` の内容をApps Scriptの `SupabaseSync.gs` へ反映する。
2. プロジェクトの設定でタイムゾーンを `Asia/Tokyo` にする。
3. Script Propertiesへ次を設定する。

| Property | 値 |
| --- | --- |
| `CASE_PROGRESS_SYNC_URL` | 上記Edge Function URL |
| `CASE_PROGRESS_SYNC_SECRET` | Supabaseへ設定したものと同じ同期専用Secret |

service role keyはApps Scriptへ設定しない。

## 3. 初回確認

Apps Script Editorから次の順で手動実行する。

1. `verifyCaseProgressSheetAccess()`
2. `syncCaseProgress()`

Googleの認可画面が表示された場合は、Spreadsheetの読取りと外部リクエストを許可する。実行ログで `status`、`sourceRowCount`、`insertedCount`、`blankIdCount`、`errorCount` を確認する。

管理画面 `/admin/case-progress-migration` で次を確認する。

- Google Sheet件数と `sourceRowCount` が一致する。
- 初回は全件が追加として記録される。
- IDなしが0件である。
- AppSuite突合状況が表示される。

## 4. 日次Trigger

初回同期確認後に、会社管理アカウントで `setupDailyTrigger()` を1回手動実行する。同関数は既存の `syncCaseProgress` triggerを削除してから4時台JSTのtriggerを1件作成するため、再実行しても重複しない。

インストール型triggerは作成者の権限で動く。作成者アカウントのSpreadsheetアクセス権とGoogle認可を維持する。

## 5. 障害確認

- Apps Script側: Apps Scriptの「実行数」と実行ログを確認する。
- Supabase側: 管理画面の同期履歴、または `case_progress_sync_runs` を確認する。
- `failed`: `error_message` を確認し、原因解消後に `syncCaseProgress()` を手動再実行する。
- `partial`: staging行の変換警告を確認する。原文は `raw_payload` に保持される。

Google Sheet、AppSuite、正式案件テーブルへの書戻しは行わない。
