# DB 現行構成の確認ガイド

この文書は、基幹システムの **現在のDB構成を確認するときの入口** です。

## 確認の優先順位

1. **接続先のリモートDB** — 実際にアプリケーションが利用する構成です。テーブル、カラム、制約、インデックス、ビュー、関数、トリガー、RLSの最優先の情報源です。
2. **リモートDBのMigration履歴** — `supabase migration list` の `Remote` 側で、どの変更が適用済みかを確認します。
3. **`supabase/migrations/`** — DB変更を再現するための履歴です。古い名称・廃止済みカラム・途中段階の構造も含むため、現在構成の仕様書として単独で読まないでください。

## リモートDBの確認手順

### 接続先と適用履歴

```powershell
npx supabase status
npx supabase projects list
npx supabase migration list
```

未リンクの場合は、プロジェクトIDを確認した認証済み環境からリンクします。

```powershell
npx supabase link --project-ref <project-ref>
```

`Local` と `Remote` に差分がある場合、先に差分の内容を確認します。ローカルにしかないMigrationを、リモートDBに適用済みだとみなしてはいけません。

### リモートの現在スキーマを取得

Migrationの個別ファイルを読み合わせるのではなく、必要なときはリモートから現在のスキーマをダンプします。

```powershell
npx supabase db dump --linked --schema public --file .tmp/remote-public-schema.sql
```

取得ファイルには環境固有の情報が含まれる可能性があるため、確認後にコミットしないでください。

## SQL Editorで確認する代表クエリ

業務データの全件取得や個人情報の出力は行わず、構造に限定して確認します。

### テーブルとビュー

```sql
select table_schema, table_name, table_type
from information_schema.tables
where table_schema in ('public', 'private')
order by table_schema, table_name;
```

### カラム

```sql
select table_schema, table_name, ordinal_position, column_name,
       data_type, is_nullable, column_default
from information_schema.columns
where table_schema in ('public', 'private')
order by table_schema, table_name, ordinal_position;
```

### 制約とインデックス

```sql
select n.nspname as schema_name, c.relname as table_name,
       con.conname as constraint_name, pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'private')
order by n.nspname, c.relname, con.conname;
```

```sql
select schemaname, tablename, indexname, indexdef
from pg_indexes
where schemaname in ('public', 'private')
order by schemaname, tablename, indexname;
```

## 管理者向けスキーマ探索

管理者アカウントでアプリケーションのスキーマ探索画面を利用できる場合は、`get_schema_explorer_graph()` が返すリモートDBの構造を確認できます。これは業務データの内容ではなく、テーブル・カラム・リレーションなどを確認するための機能です。

定義を確認するときは、次のMigrationだけを根拠にせず、リモートDB上の実体と照合してください。

- `supabase/migrations/20260907045019_schema_explorer_graph.sql`
- `supabase/migrations/20260907070238_harden_schema_explorer_search_path.sql`

## Migrationを読むときの注意

- 古いテーブル名・カラム名が残っていても、現在も利用されているとは限りません。
- `rename`、`drop`、`create or replace` を確認し、同じ機能の最後の適用結果を見ます。
- `remote_history_placeholder` のように、履歴整合性のためだけのファイルがあります。構造定義とはみなしません。
- MigrationとリモートDBが一致しない場合は、名称を推測して実装せず、差分を記録して確認します。

## DB変更を実装するときの原則

1. リモートDBで現在のテーブル・カラム・制約を確認する。
2. `supabase migration list` で適用履歴の差分を確認する。
3. 現在構成に対する差分として、新しいMigrationを追加する。
4. 既存のMigrationを書き換えない。
5. 変更後はローカルDBのreset、DBテスト、型チェックまたはビルドを実行する。
6. リモート適用後に、同じ確認クエリで実体を再確認する。

この文書は固定的なテーブル一覧を複製するものではありません。固定一覧が必要な場合も、作成日時と対象環境を記載し、リモートDBの確認結果として扱います。
