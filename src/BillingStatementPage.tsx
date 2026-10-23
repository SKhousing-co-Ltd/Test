import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { supabase } from './lib/supabase';
import { buildInvoiceSheet, loadSavedInvoiceSheet, statementRows, type StatementRow } from './utils/invoiceSheet';
import type { BillingPeriod } from './TenantBillingControls';
import { loadSavedTenantOrder, moveBefore, saveTenantOrder } from './utils/tenantOrder';
import './BillingStatementPage.css';

// 入金明細表・請求明細表です。中身はすべて請求書作成の内容から作ります。
//   請求書作成を保存していれば、その保存内容（手で直した金額・税区分なども含む）を、
//   保存していなければ、請求書作成と同じくレントロール・検針データから作った内容を表示します。
// 行は請求書1通ごとで、請求種別の列には明細の金額を請求種別ごとに合計して出し、
// 小計・消費税・合計は請求書の金額（消費税は課税の明細の合計×10%、切り捨て）を使います。
type StatementKind = 'payment' | 'invoice';
type ChargeType = { billing_charge_type_id: string; charge_type_name: string; sort_order?: number };
type BillingLineItem = { billing_charge_type_id: string };
type Column = { key: string; label: string };
const currency = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
const amount = (value: number) => value ? currency.format(value) : '—';
const monthKey = (period: BillingPeriod) => `${period.fiscalYear + (period.month <= 3 ? 1 : 0)}${String(period.month).padStart(2, '0')}`;
const savedAtText = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };

export function BillingStatementPage({ kind, propertyId, propertyName, period }: { kind: StatementKind; propertyId: string; propertyName: string; period: BillingPeriod }) {
  const [rows, setRows] = useState<StatementRow[]>([]);
  const [chargeTypes, setChargeTypes] = useState<ChargeType[]>([]);
  const [savedAt, setSavedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropBefore, setDropBefore] = useState<number | null>(null);
  const calendarYear = period.fiscalYear + (period.month <= 3 ? 1 : 0);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!supabase || !propertyId) { setRows([]); setChargeTypes([]); setLoading(false); return; }
      setLoading(true); setError('');
      try {
        const [lineItemResult, typeResult, saved, savedOrder] = await Promise.all([
          supabase.from('asset_billing_line_item').select('billing_charge_type_id').eq('asset_id', propertyId).eq('is_active', true),
          supabase.from('billing_charge_type').select('billing_charge_type_id, charge_type_name, sort_order').eq('is_active', true).order('sort_order'),
          loadSavedInvoiceSheet(supabase, propertyId, calendarYear, period.month),
          loadSavedTenantOrder(supabase, propertyId),
        ]);
        if (lineItemResult.error || typeResult.error) throw new Error(`明細項目の請求種別を読み込めませんでした: ${lineItemResult.error?.message ?? typeResult.error?.message}`);
        const sheet = saved?.sheet ?? (await buildInvoiceSheet(supabase, propertyId, propertyName, calendarYear, period.month)).sheet;
        if (cancelled) return;
        const usedTypeIds = new Set(((lineItemResult.data ?? []) as BillingLineItem[]).map((item) => item.billing_charge_type_id));
        setChargeTypes(((typeResult.data ?? []) as ChargeType[]).filter((type) => usedTypeIds.has(type.billing_charge_type_id)));
        const tenantRank = new Map(savedOrder.sort((left, right) => left.sort_order - right.sort_order).map((item, index) => [item.tenant_id, index]));
        setRows(statementRows(sheet.rows).sort((left, right) => (tenantRank.get(left.tenantId) ?? Number.MAX_SAFE_INTEGER) - (tenantRank.get(right.tenantId) ?? Number.MAX_SAFE_INTEGER)));
        setSavedAt(saved?.savedAt ?? '');
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : '明細を読み込めませんでした'); setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load(); return () => { cancelled = true; };
  }, [propertyId, propertyName, calendarYear, period.month]);

  const endDrag = () => { setDragIndex(null); setDropBefore(null); };
  const dragOver = (event: DragEvent<HTMLTableRowElement>, index: number) => {
    if (dragIndex === null) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const box = event.currentTarget.getBoundingClientRect();
    setDropBefore(event.clientY < box.top + box.height / 2 ? index : index + 1);
  };
  const drop = async (event: DragEvent<HTMLTableRowElement>) => {
    event.preventDefault();
    if (dragIndex === null || dropBefore === null || dropBefore === dragIndex || dropBefore === dragIndex + 1 || !supabase) { endDrag(); return; }
    const next = moveBefore(rows, dragIndex, dropBefore);
    setRows(next); endDrag(); setNotice('並び順を保存しています…'); setError('');
    try { await saveTenantOrder(supabase, propertyId, next.map((row) => row.tenantId)); setNotice('テナント並び順を保存しました。'); }
    catch (saveError) { setError(saveError instanceof Error ? saveError.message : 'テナント並び順を保存できませんでした'); setNotice(''); }
  };

  // 列は明細項目で使っている請求種別だけを並べます。
  const columns = useMemo<Column[]>(() => {
    return chargeTypes.map((type) => ({ key: type.charge_type_name, label: type.charge_type_name }));
  }, [chargeTypes]);
  const title = kind === 'payment' ? '入金明細表' : '請求明細表';
  const columnTotals = useMemo(() => columns.map((column) => rows.reduce((sum, row) => sum + (row.amounts[column.key] ?? 0), 0)), [rows, columns]);
  const subtotal = rows.reduce((sum, row) => sum + row.subtotal, 0);
  const tax = rows.reduce((sum, row) => sum + row.tax, 0);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const dueDates = [...new Set(rows.map((row) => row.dueDate).filter(Boolean))];
  const columnCount = 3 + columns.length + 3 + (kind === 'payment' ? 3 : 0);
  return <section className="billing-statement-page">
    <header className="billing-statement-heading">
      <div><p className="section-kicker">{monthKey(period)}</p><h3>{title}（{propertyName || '物件未選択'}）</h3></div>
      <div className="billing-statement-dates">
        <span>{savedAt ? `請求書作成の保存内容（${savedAtText(savedAt)}）` : '請求書作成は未保存のため、最新データから作成した内容です'}</span>
        {kind === 'invoice' && <span>支払期日：{dueDates.length ? dueDates.join('・') : '未設定'}</span>}
      </div>
    </header>
    {notice && <p className="billing-statement-notice">{notice}</p>}
    {error && <p className="billing-statement-notice">{error}</p>}
    <div className="billing-statement-table-wrap"><table>
      <colgroup><col className="statement-handle" /><col className="statement-code" /><col className="statement-floor" /><col className="statement-tenant" />{columns.map((column) => <col className="statement-money" key={column.key} />)}<col className="statement-money" /><col className="statement-money" /><col className="statement-money" />{kind === 'payment' && <><col className="statement-money" /><col className="statement-money" /><col className="statement-date" /></>}</colgroup>
      <thead><tr><th aria-label="並べ替え" /><th>コード</th><th>階</th><th>テナント名</th>{columns.map((column) => <th key={column.key}>{column.label}</th>)}<th>小計</th><th>消費税</th><th>合計</th>{kind === 'payment' && <><th>未入金額</th><th>入金額</th><th>入金日</th></>}</tr></thead>
      <tbody>{loading ? <tr><td colSpan={columnCount + 1}>読み込み中…</td></tr> : rows.map((row, index) => <tr key={row.key} className={[dragIndex === index ? 'statement-dragging' : '', dropBefore === index ? 'statement-drop-before' : '', dropBefore === index + 1 && index === rows.length - 1 ? 'statement-drop-after' : ''].filter(Boolean).join(' ') || undefined} onDragOver={(event) => dragOver(event, index)} onDrop={(event) => void drop(event)}>
        <td className="statement-handle-cell"><span className="statement-drag-handle" draggable title="ドラッグして並べ替え" aria-label={`${row.tenantName}を並べ替え`} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.key); setDragIndex(index); }} onDragEnd={endDrag}>⋮⋮</span></td>
        <td><strong>{row.code || '—'}</strong></td><td>{row.floor || '—'}</td><td>{row.tenantName}</td>
        {columns.map((column) => <td className="numeric" key={column.key}>{amount(row.amounts[column.key] ?? 0)}</td>)}
        <td className="numeric">{amount(row.subtotal)}</td><td className="numeric">{amount(row.tax)}</td><td className="numeric total">{amount(row.total)}</td>
        {kind === 'payment' && <><td className="numeric">{amount(row.total)}</td><td className="numeric">—</td><td>—</td></>}
      </tr>)}{!loading && !rows.length && <tr><td colSpan={columnCount + 1} className="billing-statement-empty">請求書がありません。</td></tr>}</tbody>
      <tfoot>{rows.length > 0 && <tr><th colSpan={4}>合計</th>{columnTotals.map((value, index) => <th className="numeric" key={columns[index].key}>{amount(value)}</th>)}<th className="numeric">{amount(subtotal)}</th><th className="numeric">{amount(tax)}</th><th className="numeric total">{amount(total)}</th>{kind === 'payment' && <><th className="numeric">{amount(total)}</th><th>—</th><th>—</th></>}</tr>}</tfoot>
    </table></div>
  </section>;
}
