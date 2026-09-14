# 定期建物賃貸借契約書のWord生成

原本は `★定期建物賃貸借契約書.docx` とし、原本自体は変更しない。`scripts/tag_fixed_term_building_lease_template.py` で生成する差込タグ付きコピーだけをStorageへ配置する。

## 原文の抽出

以下を実行して、原文（段落・表を含む）をUTF-8 Markdownで確認する。

```powershell
$source = 'C:\Users\本庄幸人\OneDrive - SKハウジング株式会社\ＳＫハウジング株式会社 - General\PM共通\2026 DX\契約書ひな型\★定期建物賃貸借契約書.docx'
& 'C:\Users\本庄幸人\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' scripts/extract_fixed_term_building_lease_source.py $source tmp/fixed-term-building-lease-source.md
```

抽出時点の主要事項は次のとおり。

- 契約要項、本文第1条から第28条、本物件平面図、原状回復工事基準、個人情報の利用目的で構成される。
- 第3条は期間満了で終了し更新されないこと、協議により再契約できること、1年以上の契約の終了通知を定める。
- 第28条は中途解約の予告期間・違約金を定める。これらの本文は画面から編集しない固定原文である。

## テンプレート作成・登録

```powershell
$source = 'C:\Users\本庄幸人\OneDrive - SKハウジング株式会社\ＳＫハウジング株式会社 - General\PM共通\2026 DX\契約書ひな型\★定期建物賃貸借契約書.docx'
$template = 'tmp/fixed_term_building_lease_document_generation_v1.docx'
$python = 'C:\Users\本庄幸人\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
& $python scripts/tag_fixed_term_building_lease_template.py $source $template
npx.cmd supabase@latest --experimental storage cp $template 'ss:///contract-documents/templates/fixed_term_building_lease/fixed_term_building_lease_document_generation_v1.docx' --linked --content-type application/vnd.openxmlformats-officedocument.wordprocessingml.document
```

Storageへの配置後に `20260907130000_publish_fixed_term_building_lease_document_generation.sql` を適用する。既存の契約書・出力履歴は更新しない。新規の定期建物賃貸借契約書だけがこのリビジョンを使用する。

画面では対象区画の選択が必須であり、そのスナップショットを `{{planImage}}` に差し込む。契約要項の入力項目はテナント、保証人、物件・区画、面積、使用目的、契約開始・終了日、契約年数、賃料・敷金・特約・仲介業者である。
