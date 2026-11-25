import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from './lib/supabase';
import './AdminOperationalRecordsPage.css';

type Kind = 'garage' | 'card';
type Row = Record<string, string | number | null> & { id: string };
type Price = { building_name: string; issue_unit_price: number | null; cancellation_unit_price: number | null };
const garageFields = [
  ['issued_on', '発行日', 'date'], ['building_name', 'ビル名', 'text'], ['tenant_name', 'テナント名', 'text'],
  ['contact_name', '担当様', 'text'], ['parking_number', '№', 'text'], ['vehicle_information', '車両情報', 'text'],
  ['phone_number', '電話番号', 'tel'], ['billing_amount', '請求金額', 'text'], ['notes', '備考', 'text'],
] as const;
const cardFields = [
  ['building_name', 'ビル名', 'text'], ['ordered_on', '発注日', 'date'], ['tenant_name', 'テナント名', 'text'],
  ['order_type', '発行・抹消', 'select'], ['quantity', '枚数', 'number'], ['vendor_invoice', 'カード会社よりの請求', 'text'],
  ['tenant_billed_on', 'テナント様への請求日', 'date'], ['notes', '備考', 'text'],
  ['vendor_payment', 'カード会社への支払', 'text'], ['receipt_created', '預り証作成', 'text'], ['receipt_collected', '預り証回収', 'text'],
] as const;
const empty = (kind: Kind) => Object.fromEntries((kind === 'garage' ? garageFields : cardFields).map(([key]) => [key, ''])) as Record<string, string>;

export function AdminOperationalRecordsPage({ kind, userId, userName }: { kind: Kind; userId: string; userName: string }) {
  const garage = kind === 'garage';
  const table = garage ? 'garage_certificate_records' : 'security_card_orders';
  const fields = garage ? garageFields : cardFields;
  const [rows, setRows] = useState<Row[]>([]);
  const [prices, setPrices] = useState<Price[]>([]);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [invoiceDate, setInvoiceDate] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const load = async () => {
    if (!supabase) return;
    const [records, priceRows] = await Promise.all([
      supabase.from(table).select('*').order(garage ? 'issued_on' : 'ordered_on', { ascending: false }).limit(500),
      garage ? Promise.resolve({ data: [] as Price[], error: null }) : supabase.from('security_card_prices').select('building_name,issue_unit_price,cancellation_unit_price').order('building_name'),
    ]);
    if (records.error || priceRows.error) setError(records.error?.message ?? priceRows.error?.message ?? '読み込みに失敗しました。');
    else { setRows((records.data ?? []) as Row[]); setPrices((priceRows.data ?? []) as Price[]); setError(''); }
  };
  useEffect(() => { void load(); }, [kind]);
  const selectedPrice = prices.find((price) => price.building_name === draft?.building_name);
  const unitPrice = draft?.order_type === '発行' ? selectedPrice?.issue_unit_price : null;
  const total = unitPrice == null || !draft?.quantity ? null : Number(draft.quantity) * unitPrice;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !draft) return;
    if (!garage && draft.order_type === '発行' && total == null) { setError('このビルの発行単価を登録してください。'); return; }
    setSaving(true); setError('');
    const { error: saveError } = garage
      ? await supabase.from('garage_certificate_records').insert({ ...draft, issued_on: draft.issued_on || null, invoice_issued_on: null, created_by: userId, person_in_charge: userName })
      : await supabase.from('security_card_orders').insert({ ...draft, ordered_on: draft.ordered_on || null, tenant_billed_on: draft.tenant_billed_on || null, quantity: Number(draft.quantity), tenant_billing_amount: total, unit_price_at_order: unitPrice ?? null, created_by: userId, person_in_charge: userName });
    setSaving(false);
    if (saveError) setError(saveError.message); else { setDraft(null); await load(); }
  };
  const setIssuedDate = async () => {
    if (!supabase || !invoiceId || !invoiceDate) return;
    setSaving(true);
    const { error: saveError } = await supabase.from(table).update({ invoice_issued_on: invoiceDate }).eq('id', invoiceId);
    setSaving(false);
    if (saveError) setError(saveError.message); else { setInvoiceId(null); await load(); }
  };
  return <section className="admin-development-page operational-page">
    <header className="admin-console-page-heading"><p className="section-kicker">DEVELOPMENT</p><h1>{garage ? '車庫証明発行管理' : 'セキュリティカード発注管理'}</h1><p>{garage ? 'H29 の管理票に沿って発行記録を管理します。' : '発注履歴と物件別の請求単価を管理します。'}</p></header>
    <div className="operational-actions"><Link to="/admin/development">← 開発中の機能</Link><button type="button" onClick={() => { setDraft(empty(kind)); setError(''); }}>＋ {garage ? '発行記録' : '発注履歴'}を追加</button></div>
    {error && <p className="operational-error" role="alert">{error}</p>}
    {!garage && <details className="operational-prices"><summary>カード料金一覧（税抜）</summary><div className="operational-price-grid">{prices.map((price) => <div key={price.building_name}><strong>{price.building_name}</strong><span>発行 {price.issue_unit_price?.toLocaleString() ?? '未設定'} 円</span><span>抹消 {price.cancellation_unit_price?.toLocaleString() ?? '未設定'} 円</span></div>)}</div></details>}
    <div className="operational-table-wrap"><table><thead><tr><th>担当者</th>{fields.map(([, label]) => <th key={label}>{label}</th>)}{garage ? <th>請求日</th> : <th>テナント請求額（税抜）</th>}</tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.person_in_charge}</td>{fields.map(([key]) => <td key={key}>{row[key] == null ? '' : String(row[key])}</td>)}<td>{garage ? <>{row.invoice_issued_on || <button type="button" onClick={() => { setInvoiceId(row.id); setInvoiceDate(''); }}>請求日を登録</button>}</> : row.tenant_billing_amount == null ? '—' : `¥${Number(row.tenant_billing_amount).toLocaleString()}`}</td></tr>)}</tbody></table>{rows.length === 0 && !error && <p>登録済みの記録はありません。</p>}</div>
    {draft && <div className="operational-backdrop" onMouseDown={() => !saving && setDraft(null)}><section className="operational-modal" role="dialog" aria-modal="true" aria-label="記録を追加" onMouseDown={(event) => event.stopPropagation()}><header><h2>{garage ? '車庫証明の発行記録' : 'カード発注履歴'}を追加</h2><button type="button" onClick={() => setDraft(null)} aria-label="閉じる">×</button></header><form onSubmit={(event) => void save(event)}><div className="operational-form-grid">{fields.map(([key, label, type]) => <label key={key}>{label}{type === 'select' ? <select value={draft[key]} required onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}><option value="">選択してください</option><option>発行</option><option>抹消</option></select> : key === 'building_name' && !garage ? <select value={draft[key]} required onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}><option value="">ビルを選択</option>{prices.map((price) => <option key={price.building_name}>{price.building_name}</option>)}</select> : <input type={type} value={draft[key]} min={type === 'number' ? 1 : undefined} required={['issued_on', 'ordered_on', 'building_name', 'tenant_name', 'quantity'].includes(key)} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />}</label>)}</div><p>担当者: {userName}{!garage && <>　テナント請求額（税抜）: {total == null ? '単価未設定' : `¥${total.toLocaleString()}`}</>}</p>{error && <p className="operational-error" role="alert">{error}</p>}<footer><button type="button" onClick={() => setDraft(null)}>キャンセル</button><button type="submit" disabled={saving}>{saving ? '保存中…' : '追加する'}</button></footer></form></section></div>}
    {invoiceId && <div className="operational-backdrop" onMouseDown={() => !saving && setInvoiceId(null)}><section className="operational-modal operational-date-modal" role="dialog" aria-modal="true" aria-label="請求日を登録" onMouseDown={(event) => event.stopPropagation()}><header><h2>請求日を登録</h2><button type="button" onClick={() => setInvoiceId(null)} aria-label="閉じる">×</button></header><p>請求書を発行した日を入力してください。</p><input type="date" value={invoiceDate} onChange={(event) => setInvoiceDate(event.target.value)} /><footer><button type="button" onClick={() => setInvoiceId(null)}>キャンセル</button><button type="button" disabled={!invoiceDate || saving} onClick={() => void setIssuedDate()}>保存</button></footer></section></div>}
  </section>;
}
