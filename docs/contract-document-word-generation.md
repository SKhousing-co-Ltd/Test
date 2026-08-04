# Word中心の契約書作成・正式PDF化

## 対象と正本

普通借家を先行対象とする。画面フォームに保存された `lease_contract_document` の値が正本であり、DeskNet'sの初期値、利用者による頭書修正、約款、別表、対象箇所図をここで管理する。外部で編集したWordファイルの再取込は行わない。

既存のAcroForm/PDF方式は `acroform_legacy` として凍結する。既存のPDFと契約データを自動変換しない。デモ契約だけを `document_generation` 方式に切り替える。

## 操作フロー

1. フォームを入力して保存する。
2. **Wordを生成** を選ぶ。サーバーが保存済みの契約データとDOCXひな型から確認用Wordを生成する。
3. **最新Wordを開く** で確認する。
4. 内容に変更がなければ **正式PDFを出力** を選ぶ。サーバーが同一内容版のWordをAdobeでPDF化する。
5. **最新正式PDFを開く** で正式版を確認する。

フォームを変更すると内容版が進み、以前のWord・PDFは履歴に残る。現在の内容版のWordがない限り、正式PDFの出力はできない。

## 保存先と版履歴

`lease_contract_document.content_version` がフォーム内容の版番号である。`lease_contract_document_output_revision` は内容版ごとに次を保持する。

- 生成元のテンプレート版
- 確認用WordのStorageパス
- 正式PDFのStorageパス
- `word_generated` / `formalized` / `failed` の状態
- 生成・確定日時、生成者、失敗時のエラー概要

出力パスは `contract-documents/documents/{契約ID}/{書式}/{契約書ID}/outputs/v{内容版}/` 配下とする。過去版のファイルを上書きしない。`lease_contract_document.pdf_file_path` は後方互換のため最新正式PDFを指す。

## Adobe連携

Edge Functionはブラウザから本文・PDF・資格情報を受け取らない。契約行、適用テンプレート版、対象箇所図スナップショットをSupabaseから読み、Adobeへ送る。

- `generate-contract-word`: Adobe Document Generation APIでDOCXを出力する。
- `finalize-contract-pdf`: 現在のWord出力版だけをAdobe Create PDF APIでPDFへ変換する。
- Adobe Client ID / Client SecretはSupabase Edge Function Secretの `ADOBE_PDF_SERVICES_CLIENT_ID` / `ADOBE_PDF_SERVICES_CLIENT_SECRET` にのみ置く。

Adobe Developer Consoleで同じプロジェクトに **Document Generation API** と **PDF Services API** を追加する。Document Generation APIが未契約・未有効の場合はWord生成が明確なAdobe APIエラーで失敗する。

## DOCX正本の作り方

現在の普通借家用DOCXは `templates/ordinary_lease/ordinary_lease_document_generation_v1.docx` に登録している。差し込みタグは以下を使用する。

| 区分 | タグ |
| --- | --- |
| 頭書 | `tenantName`, `propertyName`, `propertyAddress`, `unitNames`, `contractStartDate`, `contractEndDate`, `monthlyRentAmount`, `usePurpose`, `specialProvisions` |
| 約款 | `termsText` |
| 別表 | `restorationText` |
| 図面 | `planImage` |

長文の約款・別表は、本文中に独立した段落としてタグを配置する。表セルや固定高さのテキストボックスへ入れない。Wordの標準段落と改ページに任せることで、9,000字超の約款や改行を扱う。

図面はAdobe Document Generation Word Add-inで画像タグとして `planImage` を挿入する。生成スクリプトで作成した最初のDOCXは文字タグの確認用であり、正式運用前に法務レイアウトのDOCXへ置き換える。

日本語文字化けを防ぐため、正本DOCXは利用許諾上埋め込み可能な日本語TrueTypeフォントを使い、Wordの「ファイル > オプション > 保存 > ファイルにフォントを埋め込む」を有効にして保存する。Adobe生成WordとPDFで日本語・長文・図面を必ず目視確認する。

## 検証項目

- DeskNet's初期値、手修正、再読込、約款・別表がWord/PDFへ一致する。
- 9,000字超の約款、1,600字超の別表、日本語、改行、図面でページ送りと表が崩れない。
- フォーム変更後は古いWordから正式PDFを出力できない。
- 生成失敗は出力履歴へ `failed` として残り、再試行できる。
- ひな型を更新しても既存の契約・出力版は変わらない。
