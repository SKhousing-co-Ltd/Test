# AppSuite・Bill One 発注請求連携

## AppSuite 修繕発注稟議

AppSuite アプリ ID `87`（`【BM】＜SHU＞修繕発注稟議書`）を同期対象にすると、決裁状況が `完了`、`承認`、`決裁済み` のレコードを発注連携受信箱へ展開します。

- 1申請内の発注業者①〜③を別々の発注候補として保持します。
- 物件コード、取引先名、金額、発注内容を照合します。
- 取引先未登録などの不備は本番の発注台帳へ反映せず、画面に理由を表示します。
- 確定時の発注状態は、AppSuite で決裁済みのため `approved` です。
- 過去データを一括同期しても自動確定されません。

アプリ87の実フィールド名は `発注業者①`、`発注金額①（税込）`、`発注内容①`、`支払予定日①`（②・③も同様）です。丸数字を正規名称として読み、過去の数字形式も互換入力として受け付けます。`{"error":"under_maintenance"}` のようなAppSuiteエラーオブジェクトは業務値として取り込みません。

同期後は、物件・取引先・金額が揃った候補だけを発注へ確定します。取引先マスタが未整備の場合は `action_required` のまま保持し、取引先を登録して再照合するまで発注本体へ書き込みません。

## Bill One 連携受信 API

Bill One の公開 API 仕様は公開情報から確定できないため、Bill One または契約済み連携サービスの出力を次の正規化形式へ変換して送信します。接続先固有の処理はこの API の前段に限定され、基幹システム側の照合・重複防止・確定処理は共通です。

Edge Function `receive-billone-invoices` に `POST` し、`x-billone-webhook-secret` ヘッダーへ Supabase secret `BILLONE_WEBHOOK_SECRET` と同じ値を設定します。1回に最大500件を送信できます。

```json
{
  "invoices": [
    {
      "sourceInvoiceId": "Bill One側の一意な請求書ID",
      "invoiceNumber": "請求書番号",
      "supplierId": "Bill One側の取引先ID",
      "supplierName": "取引先名",
      "invoiceDate": "2026-08-01",
      "receivedDate": "2026-08-03",
      "dueDate": "2026-08-31",
      "subtotalAmount": 100000,
      "taxAmount": 10000,
      "grossAmount": 110000,
      "documentUrl": "https://...",
      "orderNumber": "PO-...",
      "ringiNumber": "SHU-...",
      "propertyCode": "物件コード",
      "propertyName": "物件名",
      "accountId": "M08"
    }
  ]
}
```

`sourceInvoiceId` は必須で、同じIDの再送は同じ受信箱行を更新します。発注番号または稟議番号が一致すれば、発注の物件・取引先・科目を優先して照合します。照合未完了の請求書は請求台帳へ入りません。

## デプロイ設定

1. マイグレーションを適用します。
2. 十分に長いランダム値を `BILLONE_WEBHOOK_SECRET` として Supabase secrets に設定します。
3. `receive-billone-invoices` を `verify_jwt = false` でデプロイします。関数内で共有シークレットを必須検証します。
4. AppSuite 同期画面でアプリ ID `87` を有効化し、最初は手動プレビューで件数を確認してから反映します。
