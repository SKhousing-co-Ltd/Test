import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { supabase } from './lib/supabase';
import { applyCurrentBillingDisplayNames, buildInvoiceSheet, loadSavedInvoiceSheet, saveInvoiceSheet, statementRows, type InvoiceSheet, type StatementRow } from './utils/invoiceSheet';
import { mergeRecurringInvoiceRows, removeManualInvoiceRow } from './utils/recurringInvoiceRows';
import type { BillingPeriod } from './TenantBillingControls';
import { loadSavedTenantOrder, moveBefore, saveTenantOrder } from './utils/tenantOrder';
import { monthStart, spotInvoicesForMonth } from './utils/spotInvoices';
import { RevenuePostingPanel } from './RevenuePostingPanel';
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

export function BillingStatementPage({ kind, propertyId, propertyName, period, canEdit }: { kind: StatementKind; propertyId: string; propertyName: string; period: BillingPeriod; canEdit: boolean }) {
  const [rows, setRows] = useState<StatementRow[]>([]);
  const [spotRows, setSpotRows] = useState<StatementRow[]>([]);
  const [includeSpots, setIncludeSpots] = useState(false);
  const [invoiceSheet, setInvoiceSheet] = useState<InvoiceSheet | null>(null);
  const [deletingRowId, setDeletingRowId] = useState('');
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
        const [lineItemResult, typeResult, saved, savedOrder, recurringResult, spotResult] = await Promise.all([
          supabase.from('asset_billing_line_item').select('billing_charge_type_id').eq('asset_id', propertyId).eq('is_active', true),
          supabase.from('billing_charge_type').select('billing_charge_type_id, charge_type_name, sort_order').eq('is_active', true).order('sort_order'),
          loadSavedInvoiceSheet(supabase, propertyId, calendarYear, period.month),
          loadSavedTenantOrder(supabase, propertyId),
          supabase.from('tenant_invoice_sheet').select('sheet,billing_month').eq('asset_id', propertyId).lt('billing_month', `${calendarYear}-${String(period.month).padStart(2, '0')}-01`).order('billing_month', { ascending: false }),
          supabase.from('tenant_invoice_sheet').select('sheet').eq('asset_id', propertyId),
        ]);
        if (lineItemResult.error || typeResult.error) throw new Error(`明細項目の請求種別を読み込めませんでした: ${lineItemResult.error?.message ?? typeResult.error?.message}`);
        if (recurringResult.error) throw new Error(`継続明細を読み込めませんでした: ${recurringResult.error.message}`);
        if (spotResult.error) throw new Error(`スポット請求書を読み込めませんでした: ${spotResult.error.message}`);
        const baseSheet = saved?.sheet.rows.length ? saved.sheet : { ...(await buildInvoiceSheet(supabase, propertyId, propertyName, calendarYear, period.month)).sheet, spotInvoices: saved?.sheet.spotInvoices ?? [] };
        const sheet = mergeRecurringInvoiceRows(baseSheet, (recurringResult.data ?? []).map((record) => record.sheet as InvoiceSheet), `${calendarYear}-${String(period.month).padStart(2, '0')}-01`);
        if (cancelled) return;
        const usedTypeIds = new Set(((lineItemResult.data ?? []) as BillingLineItem[]).map((item) => item.billing_charge_type_id));
        setChargeTypes(((typeResult.data ?? []) as ChargeType[]).filter((type) => usedTypeIds.has(type.billing_charge_type_id)));
        const tenantRank = new Map(savedOrder.sort((left, right) => left.sort_order - right.sort_order).map((item, index) => [item.tenant_id, index]));
        const currentNames = await applyCurrentBillingDisplayNames(supabase, propertyId, sheet.rows);
        const displayRows = currentNames.map((row, index) => sheet.invoiceStatuses?.[row.invoiceKey] ? sheet.rows[index] : row);
        if (cancelled) return;
        setRows(statementRows(displayRows).sort((left, right) => (tenantRank.get(left.tenantId) ?? Number.MAX_SAFE_INTEGER) - (tenantRank.get(right.tenantId) ?? Number.MAX_SAFE_INTEGER)));
        const matchingSpots = spotInvoicesForMonth((spotResult.data ?? []).map((record) => record.sheet as InvoiceSheet), monthStart(calendarYear, period.month));
        setSpotRows(matchingSpots.filter((spot) => spot.state !== 'draft').flatMap((spot) => statementRows(spot.rows)));
        setInvoiceSheet({ ...sheet, rows: displayRows });
        setSavedAt(saved?.savedAt ?? '');
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : '明細を読み込めませんでした'); setRows([]); setSpotRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load(); return () => { cancelled = true; };
  }, [propertyId, propertyName, calendarYear, period.month]);

  const endDrag = () => { setDragIndex(null); setDropBefore(null); };
  const deleteAddedLine = async (rowId: string) => {
    if (!supabase || !invoiceSheet) return;
    const invoiceKey = invoiceSheet.rows.find((row) => row.id === rowId)?.invoiceKey;
    if (invoiceKey && invoiceSheet.invoiceStatuses?.[invoiceKey]?.state === 'issued') return;
    const next = removeManualInvoiceRow(invoiceSheet, rowId);
    if (next === invoiceSheet) return;
    setDeletingRowId(rowId); setError('');
    try {
      const at = await saveInvoiceSheet(supabase, propertyId, calendarYear, period.month, next);
      setInvoiceSheet(next); setSavedAt(at);
      const rank = new Map(rows.map((row, index) => [row.key, index]));
      setRows(statementRows(next.rows).sort((left, right) => (rank.get(left.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.key) ?? Number.MAX_SAFE_INTEGER)));
      setNotice('追加明細を削除しました。請求書作成にも反映されます。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '追加明細を削除できませんでした'); }
    finally { setDeletingRowId(''); }
  };
  const dragOver = (event: DragEvent<HTMLTableRowElement>, index: number) => {
    if (dragIndex === null) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const box = event.currentTarget.getBoundingClientRect();
    setDropBefore(event.clientY < box.top + box.height / 2 ? index : index + 1);
  };
  const drop = async (event: DragEvent<HTMLTableRowElement>) => {
    event.preventDefault();
    if (includeSpots) { endDrag(); return; }
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
  const visibleRows = includeSpots ? [...rows, ...spotRows] : rows;
  const spotKeys = new Set(spotRows.map((row) => row.key));
  const columnTotals = useMemo(() => columns.map((column) => visibleRows.reduce((sum, row) => sum + (row.amounts[column.key] ?? 0), 0)), [visibleRows, columns]);
  const subtotal = visibleRows.reduce((sum, row) => sum + row.subtotal, 0);
  const tax = visibleRows.reduce((sum, row) => sum + row.tax, 0);
  const total = visibleRows.reduce((sum, row) => sum + row.total, 0);
  const dueDates = [...new Set(visibleRows.map((row) => row.dueDate).filter(Boolean))];
  const columnCount = 3 + columns.length + 3 + (kind === 'payment' ? 3 : 0);
  return <section className="billing-statement-page">
    <header className="billing-statement-heading">
      <div><p className="section-kicker">{monthKey(period)}</p><h3>{title}（{propertyName || '物件未選択'}）</h3></div>
      <div className="billing-statement-dates">
        <label><input type="checkbox" checked={includeSpots} onChange={(event) => setIncludeSpots(event.target.checked)} />スポット発行分を含む</label>
        {savedAt && <span>請求書作成の保存内容（{savedAtText(savedAt)}）</span>}
        {kind === 'invoice' && <span>支払期日：{dueDates.length ? dueDates.join('・') : '未設定'}</span>}
        {kind === 'invoice' && canEdit && <span id="revenue-posting-toolbar" />}
      </div>
    </header>
    {kind === 'invoice' && canEdit && <RevenuePostingPanel propertyId={propertyId} propertyName={propertyName} period={period} />}
    {notice && <p className="billing-statement-notice">{notice}</p>}
    {error && <p className="billing-statement-notice">{error}</p>}
    <div className="billing-statement-table-wrap"><table>
      <colgroup><col className="statement-handle" /><col className="statement-code" /><col className="statement-floor" /><col className="statement-tenant" />{columns.map((column) => <col className="statement-money" key={column.key} />)}<col className="statement-money" /><col className="statement-money" /><col className="statement-money" />{kind === 'payment' && <><col className="statement-money" /><col className="statement-money" /><col className="statement-date" /></>}</colgroup>
      <thead><tr><th aria-label="並べ替え" /><th>コード</th><th>階</th><th>テナント名</th>{columns.map((column) => <th className="numeric" key={column.key}>{column.label}</th>)}<th className="numeric">小計</th><th className="numeric">消費税</th><th className="numeric">合計</th>{kind === 'payment' && <><th className="numeric">未入金額</th><th className="numeric">入金額</th><th>入金日</th></>}</tr></thead>
      <tbody>{loading ? <tr><td colSpan={columnCount + 1}>読み込み中…</td></tr> : visibleRows.map((row, index) => <tr key={row.key} className={[spotKeys.has(row.key) ? 'statement-spot-row' : '', dragIndex === index ? 'statement-dragging' : '', dropBefore === index ? 'statement-drop-before' : '', dropBefore === index + 1 && index === visibleRows.length - 1 ? 'statement-drop-after' : ''].filter(Boolean).join(' ') || undefined} onDragOver={(event) => dragOver(event, index)} onDrop={(event) => void drop(event)}>
        <td className="statement-handle-cell">{!includeSpots && <span className="statement-drag-handle" draggable title="ドラッグして並べ替え" aria-label={`${row.tenantName}を並べ替え`} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.key); setDragIndex(index); }} onDragEnd={endDrag}>⋮⋮</span>}</td>
        <td><strong>{row.code || '—'}</strong></td><td>{row.floor || '—'}</td><td>{row.tenantName}{spotKeys.has(row.key) && <small className="statement-spot-label">スポット</small>}{kind === 'invoice' && invoiceSheet?.rows.filter((item) => item.invoiceKey === row.key && item.id.includes(':manual:')).map((item) => <div className="statement-added-line" key={item.id}><span>追加：{item.values[11]}（{item.values[15]}円）</span><button type="button" disabled={Boolean(deletingRowId) || invoiceSheet.invoiceStatuses?.[item.invoiceKey]?.state === 'issued'} onClick={() => void deleteAddedLine(item.id)}>削除</button></div>)}</td>
        {columns.map((column) => <td className="numeric" key={column.key}>{amount(row.amounts[column.key] ?? 0)}</td>)}
        <td className="numeric">{amount(row.subtotal)}</td><td className="numeric">{amount(row.tax)}</td><td className="numeric total">{amount(row.total)}</td>
        {kind === 'payment' && <><td className="numeric">{amount(row.total)}</td><td className="numeric">—</td><td>—</td></>}
      </tr>)}{!loading && !visibleRows.length && <tr><td colSpan={columnCount + 1} className="billing-statement-empty">請求書がありません。</td></tr>}</tbody>
      <tfoot>{visibleRows.length > 0 && <tr><th colSpan={4}>合計</th>{columnTotals.map((value, index) => <th className="numeric" key={columns[index].key}>{amount(value)}</th>)}<th className="numeric">{amount(subtotal)}</th><th className="numeric">{amount(tax)}</th><th className="numeric total">{amount(total)}</th>{kind === 'payment' && <><th className="numeric">{amount(total)}</th><th>—</th><th>—</th></>}</tr>}</tfoot>
    </table></div>
  </section>;
}
