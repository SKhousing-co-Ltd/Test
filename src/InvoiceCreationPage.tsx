import type { BillingPeriod } from './TenantBillingControls';
import './InvoiceCreationPage.css';

export function InvoiceCreationPage({ propertyName, period }: { propertyName: string; period: BillingPeriod }) {
  const year = period.fiscalYear + (period.month <= 3 ? 1 : 0);
  return <section className="invoice-creation-page"><header className="invoice-creation-heading"><div><p className="section-kicker">INVOICE CREATION</p><h3>請求書作成</h3><p>{propertyName || '物件未選択'}・{year}年{period.month}月の請求書を確認・作成します。</p></div><button className="primary-button" disabled>請求書を作成</button></header><p className="invoice-creation-notice">請求対象・金額・発行日のデータ連携は、次の仕様確定後に実装します。現在は請求書作成の画面構成のみです。</p><div className="invoice-creation-summary"><span>作成対象 <strong>— 件</strong></span><span>請求金額合計 <strong>— 円</strong></span><span>発行予定日 <strong>未設定</strong></span></div><div className="invoice-creation-table-wrap"><table><thead><tr><th>請求書番号</th><th>テナントコード</th><th>請求先</th><th>対象区画</th><th>請求期間</th><th>請求額（税抜）</th><th>消費税</th><th>請求額（税込）</th><th>状態</th><th /></tr></thead><tbody><tr><td colSpan={10} className="invoice-creation-empty">請求データの作成仕様が未設定です。請求明細・請求期間・発行日が確定すると、この一覧に請求書候補を表示します。</td></tr></tbody></table></div><aside className="invoice-creation-preview"><h4>請求書プレビュー</h4><p>一覧から請求書を選択すると、請求先・明細項目・数量・単価・税率・請求期間を確認できるようにします。</p></aside></section>;
}
