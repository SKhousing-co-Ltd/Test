# 契約書図面 初回登録ツール

このツールは既存のWebシステムから独立して動作します。契約書PDFは指定したOneDriveフォルダから読み取るだけで、原本を移動・アップロードしません。解析結果と承認履歴は `outputs/contract_plan_importer/review.sqlite3` に保存されます。

## 使い方

PowerShellで次を実行します。物件名は既存システムで使う名称にします。

```powershell
& 'C:\Users\本庄幸人\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' .\tools\contract_plan_importer.py scan 'C:\対象\契約書' --property-name '三共新大阪ビル'
start-contract-plan-importer.cmd
```

図面が契約書の末尾以外にある場合は、初回走査に `--all-pages` を付けます。

ブラウザで `http://127.0.0.1:8765` を開きます。フロア、契約書ページ、区画候補を確認し、区画番号と状態を保存します。白図面候補も採用にしてから、承認済みだけを登録用JSONへ出力します。

```powershell
& 'C:\Users\本庄幸人\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' .\tools\contract_plan_importer.py export-approved
```

正式登録前には、書込みを行わない確認を実行します。

```powershell
& 'C:\Users\本庄幸人\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' .\tools\contract_plan_importer.py register-approved
```

確認後、ログイン済み利用者のアクセストークンを設定して `--apply` を実行します。採用済み白図面と承認済み区画だけを既存の `floor_plan`、`floor_plan_revision`、`unit_plan_geometry` へ登録します。

```powershell
$env:SUPABASE_URL='https://<project>.supabase.co'
$env:SUPABASE_ACCESS_TOKEN='<ログイン済み利用者のアクセストークン>'
& 'C:\Users\本庄幸人\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' .\tools\contract_plan_importer.py register-approved --apply
```

## 留意事項

- スキャンPDF向けに、契約書末尾2ページから最大の埋め込み画像を図面候補として取り込みます。区画の自動候補は色付きマーキングを保守的に検出します。
- Tesseract OCR がPCに導入されていれば日本語・英語OCRを実行します。未導入でもフォルダ名・ファイル名からフロアとテナントを分類します。
- 自動生成された白図面は色付きマーキングだけを白に置換します。押印、手書き、黒い枠線は自動削除しないため、確認画面で採否を判断してください。
- 出力JSONは承認済みデータを確認するための登録パッケージです。既存Supabaseの `floor_plan`、`floor_plan_revision`、`unit_plan_geometry` への書込みは、認証済み利用者のトークンを使う専用登録処理として次段階で実行します。
