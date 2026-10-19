# KANAME / KANAMETER データ所有境界

## 方針

KANAME と KANAMETER は同じ Supabase を使用するが、各データの書き込み元は一方に限定する。
共有DBは同期手段ではなく、両アプリが同じ正本を参照するために使用する。

- KANAME は、ビル・区画・テナント・契約と請求条件の正本を持つ。
- KANAMETER は、メーター構成、月次検針、計算根拠と計算結果の正本を持つ。
- 相手側が所有するテーブルは参照専用とし、画面から更新しない。
- KANAME への連携は、KANAMETER の月次確定処理で確定結果を作成して行う。

## KANAME が所有するデータ

| 対象 | 主なテーブル | KANAMETERでの扱い |
| --- | --- | --- |
| ログイン・ユーザー | `app_user` など認証関連 | 参照 |
| ビル | `asset_master` | 参照 |
| 区画・階 | `unit_master` | 参照 |
| テナント | `tenant_master` | 参照 |
| 賃貸借契約・入居期間 | `lease_contract`, `lease_contract_unit` | 参照 |
| ビルで請求する公共料金分類 | `asset_meter_category_setting` | 参照 |
| 基本料・電灯・空調などの請求小分類 | `asset_meter_sub_item` | 参照 |
| 請求明細項目 | `asset_billing_line_item`, `billing_charge_type` | 参照 |
| ビル共通の単価方針 | `asset_utility_price_setting` | 参照 |
| 契約区画ごとの単価 | `lease_contract_unit_utility_price`, `lease_contract_unit_category_price` | 参照 |
| 契約区画ごとの基本料 | `lease_contract_unit_basic_charge` | 参照 |
| 契約区画ごとの丸め方法 | `lease_contract_unit.utility_amount_rounding_mode` | 参照 |
| 請求期間パターン | `asset_billing_period_pattern` | 参照 |

分類・小分類は請求書の明細構造を決めるため KANAME 所有とする。KANAMETER は名称や請求有無を変更しない。

## KANAMETER が所有するデータ

| 対象 | 主なテーブル | KANAMEでの扱い |
| --- | --- | --- |
| メーター台帳 | `asset_meter` | 参照 |
| メーターの設置区画履歴 | `asset_meter_unit_assignment` | 参照 |
| 月次検針ヘッダー・確定状態 | `meter_reading_month` | 参照 |
| メーターごとの検針値・使用量 | `meter_reading_entry` | 参照 |
| 中間検針・メーター交換情報 | `meter_reading_break` と検針値の交換列 | 参照 |
| 月次の変動単価計算根拠 | `meter_reading_month_sub_item` | 参照 |
| 増額分の購入量・購入金額・単価 | `meter_reading_month_surcharge` | 参照 |
| 月次の計算結果 | 確定結果用テーブル／API | KANAMEが請求書作成時に参照 |

## 整理対象の既存データ

`meter_reading_contract` と `meter_reading_contract_item` には、契約区画の請求条件と重複する列がある。
今後は次のように整理する。

- 基本料、契約単価、請求有無、金額丸めは KANAME の契約区画設定を正本とする。
- `meter_reading_contract_item.fixed_amount` と `unit_price` は新規処理では正本にしない。
- 検針結果を複数請求行へ分けるための配賦設定だけが必要な場合は、KANAMETER所有の配賦設定として別途明確化する。
- 既存データは即時削除せず、照合・移行後に廃止する。

## アプリ間の処理

1. KANAMETER は請求月・ビルを指定してKANAME所有のマスターと契約条件を参照する。
2. KANAMETER は自アプリ所有のメーターと検針データを読み込む。
3. 使用量・金額計算はDB関数で実行し、計算根拠と結果をKANAMETER所有領域へ保存する。
4. 確定時に対象月をロックし、KANAMEが参照できる確定結果を作成する。
5. KANAMEは確定結果だけを請求書へ取り込み、検針値や計算根拠を更新しない。

## 実装上の制約

現状は両アプリが同じログインと `authenticated` ロールを使うため、RLSだけではアクセス元アプリを識別できない。
当面はUIとリポジトリ層で書き込み先を限定する。完全なDB強制が必要になった時点で、次のいずれかを採用する。

- アプリ別バックエンドAPIを経由し、直接DML権限を取り除く。
- JWTにアプリ識別claimを追加し、RLSで書き込み元を制限する。
- 更新用RPCをアプリ別に分け、テーブルへの直接更新権限を取り除く。

## 移行順序

1. KANAMETERの読込をKANAMEの正本テーブルへ統一する。
2. 肥後橋で分類・小分類・基本料・単価・丸め方法を照合する。
3. KANAMETERにメーター台帳と設置区画設定画面を実装する。
4. DB計算関数と確定結果を実装する。
5. KANAME側の検針値・メーター編集を参照専用へ変更する。
6. 重複する `meter_reading_contract*` のデータを移行して廃止判断を行う。
