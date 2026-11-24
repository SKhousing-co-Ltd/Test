import { useEffect, useMemo, useState } from 'react';
import Encoding from 'encoding-japanese';
import { supabase } from './lib/supabase';
import type { BillingPeriod } from './TenantBillingControls';
import { buildBtobInvoiceCsv } from './utils/btobInvoiceCsv';
import { csvHeaders, emptyValues, loadSavedInvoiceSheet, recalcInvoices, saveInvoiceSheet, taxCategories, type InvoiceRow, type InvoiceSheet, type SpotInvoice } from './utils/invoiceSheet';
import { beginSpotReissue, changeSpotPostingMonth, issueSpot, monthStart } from './utils/spotInvoices';
import { markDepositInvoicesIssued } from './utils/depositInvoice';

type LineItem = { line_item_name: string; display_name: string | null; billing_charge_type_id: string | null };
const columns = [0, 1, 2, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 18, 19, 20] as const;
const invoiceColumns = new Set([0, 1, 2, 4, 5, 6, 7]);
const calculatedColumns = new Set([0, 5, 6, 7, 19]);
const blankSheet = (): InvoiceSheet => ({ rows: [], duePatternByInvoice: {}, dueDateByPattern: {}, periodPatternByRow: {}, periodRangeByPattern: {}, invoiceNote: '', showInvoiceNote: false });

export function SpotInvoicePanel({ propertyId, propertyName, period }: { propertyId: string; propertyName: string; period: BillingPeriod }) {
  const calendarYear = period.fiscalYear + (period.month <= 3 ? 1 : 0);
  const issueMonth = monthStart(calendarYear, period.month);
  const [sheet, setSheet] = useState<InvoiceSheet | null>(null);
  const [spots, setSpots] = useState<SpotInvoice[]>([]);
  const [items, setItems] = useState<LineItem[]>([]);
  const [chargeNames, setChargeNames] = useState<Record<string, string>>({});
  const [editingSubject, setEditingSubject] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!supabase || !propertyId) { setLoading(false); return; }
      setLoading(true); setError('');
      try {
        const [saved, lineItems, chargeTypes] = await Promise.all([
          loadSavedInvoiceSheet(supabase, propertyId, calendarYear, period.month),
          supabase.from('asset_billing_line_item').select('line_item_name,display_name,billing_charge_type_id').eq('asset_id', propertyId).eq('is_active', true).order('sort_order'),
          supabase.from('billing_charge_type').select('billing_charge_type_id,charge_type_name'),
        ]);
        if (lineItems.error || chargeTypes.error) throw new Error(lineItems.error?.message ?? chargeTypes.error?.message);
        if (cancelled) return;
        const currentSheet = saved?.sheet ?? blankSheet();
        setSheet(currentSheet); setSpots(currentSheet.spotInvoices ?? []);
        setItems((lineItems.data ?? []) as LineItem[]);
        setChargeNames(Object.fromEntries((chargeTypes.data ?? []).map((item) => [item.billing_charge_type_id, item.charge_type_name])));
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : 'スポット請求書を読み込めませんでした。'); }
      finally { if (!cancelled) setLoading(false); }
    }
    void load(); return () => { cancelled = true; };
  }, [propertyId, calendarYear, period.month]);
  useEffect(() => {
    const closeSubject = (event: PointerEvent) => {
      if (!(event.target as Element).closest('.invoice-name-subject')) setEditingSubject('');
    };
    document.addEventListener('pointerdown', closeSubject);
    return () => document.removeEventListener('pointerdown', closeSubject);
  }, []);

  const totals = useMemo(() => ({
    subtotal: spots.reduce((sum, spot) => sum + Number((spot.rows[0]?.values[5] ?? '').replace(/,/g, '')), 0),
    tax: spots.reduce((sum, spot) => sum + Number((spot.rows[0]?.values[6] ?? '').replace(/,/g, '')), 0),
    total: spots.reduce((sum, spot) => sum + Number((spot.rows[0]?.values[7] ?? '').replace(/,/g, '')), 0),
  }), [spots]);
  const updateSpot = (spotId: string, update: (spot: SpotInvoice) => SpotInvoice) => {
    setSpots((current) => current.map((spot) => spot.id === spotId && spot.state !== 'issued' ? update(spot) : spot)); setDirty(true);
  };
  const updateRow = (spotId: string, rowId: string, column: number, value: string) => updateSpot(spotId, (spot) => ({ ...spot, rows: recalcInvoices(spot.rows.map((row) => row.id === rowId ? { ...row, values: row.values.map((cell, index) => index === column ? value : cell) } : row)) }));
  const updateInvoiceValue = (spotId: string, column: number, value: string) => updateSpot(spotId, (spot) => ({ ...spot, rows: recalcInvoices(spot.rows.map((row, index) => index === 0 ? { ...row, values: row.values.map((cell, cellIndex) => cellIndex === column ? value : cell) } : row)) }));
  const persist = async (nextSpots: SpotInvoice[]) => {
    if (!supabase || !propertyId || busy) return false;
    setBusy(true); setError('');
    try {
      const latest = (await loadSavedInvoiceSheet(supabase, propertyId, calendarYear, period.month))?.sheet ?? sheet ?? blankSheet();
      const next = { ...latest, spotInvoices: nextSpots }; await saveInvoiceSheet(supabase, propertyId, calendarYear, period.month, next);
      setSheet(next); setSpots(nextSpots); setDirty(false); return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存できませんでした。'); return false; }
    finally { setBusy(false); }
  };
  const changePosting = async (spot: SpotInvoice, value: string) => {
    if (dirty || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return;
    const next = spots.map((item) => item.id === spot.id ? changeSpotPostingMonth(item, `${value}-01`) : item);
    if (await persist(next)) setNotice('計上月を変更しました。請求明細・入金明細にも反映されます。');
  };
  const startReissue = async (spot: SpotInvoice) => {
    if (dirty) return; const next = spots.map((item) => item.id === spot.id ? beginSpotReissue(item) : item);
    if (await persist(next)) setNotice('再発行の編集を開始しました。');
  };
  const exportCsv = async (spot: SpotInvoice) => {
    if (!supabase || busy || dirty || spot.state === 'issued') return;
    try {
      if (spot.rows.some((row) => !row.values[11]?.trim())) throw new Error('明細項目２を選択してください。');
      const csv = buildBtobInvoiceCsv(spot.rows); const encoded = Encoding.convert(Encoding.stringToCode(csv), { to: 'SJIS', from: 'UNICODE', type: 'array', fallback: 'error' });
      const issuedAt = new Date().toISOString(); const next = spots.map((item) => item.id === spot.id ? issueSpot(item, issuedAt) : item);
      if (!await persist(next)) return;
      let depositSyncError = ''; try { await markDepositInvoicesIssued(supabase, [spot.id], issuedAt); } catch (reason) { depositSyncError = reason instanceof Error ? reason.message : '敷金管理表を更新できませんでした。'; }
      const url = URL.createObjectURL(new Blob([new Uint8Array(encoded)], { type: 'text/csv;charset=shift_jis' })); const link = document.createElement('a');
      link.href = url; link.download = `BtoB請求書_スポット_${propertyName.replace(/[\\/:*?"<>|]/g, '_')}_${issueMonth.slice(0, 7)}_${spot.id.slice(0, 8)}.csv`;
      document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); setError(depositSyncError); setNotice('CSVに出力し、請求済みにしました。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'CSVを出力できませんでした。'); }
  };
  const addLine = (spotId: string) => updateSpot(spotId, (spot) => { const values = emptyValues(); values[18] = '課税'; values[15] = '0'; return { ...spot, rows: [...spot.rows, { ...spot.rows[0], id: `${spot.id}:manual:${crypto.randomUUID()}`, values, chargeType: '' }] }; });
  const deleteLine = (spotId: string, rowId: string) => updateSpot(spotId, (spot) => ({ ...spot, rows: recalcInvoices(spot.rows.filter((row) => row.id !== rowId)) }));
  const updateItem = (spotId: string, rowId: string, name: string) => updateSpot(spotId, (spot) => ({ ...spot, rows: recalcInvoices(spot.rows.map((row) => {
    if (row.id !== rowId) return row; const item = items.find((candidate) => (candidate.display_name || candidate.line_item_name) === name); const values = [...row.values]; values[11] = name;
    return { ...row, values, chargeType: item?.billing_charge_type_id ? chargeNames[item.billing_charge_type_id] ?? name : name };
  })) }));
  const cell = (spot: SpotInvoice, row: InvoiceRow, rowIndex: number, column: number) => {
    const issued = spot.state === 'issued'; const value = invoiceColumns.has(column) ? spot.rows[0]?.values[column] ?? '' : row.values[column];
    if (column === 2) return <div className="invoice-name-subject"><button type="button" className="invoice-company-name" disabled={issued} onClick={() => setEditingSubject((current) => current === spot.id ? '' : spot.id)}>{value}</button>{editingSubject === spot.id && !issued && <div className="invoice-subject-editor"><label>請求書の件名<input value={spot.rows[0]?.values[3] ?? ''} onChange={(event) => updateInvoiceValue(spot.id, 3, event.target.value)} /></label></div>}</div>;
    if (column === 11) return <div className="invoice-manual-line-cell"><select value={row.values[11]} disabled={issued} onChange={(event) => updateItem(spot.id, row.id, event.target.value)}><option value="">選択してください</option>{items.map((item, index) => { const name = item.display_name || item.line_item_name; return <option key={`${item.line_item_name}:${index}`} value={name}>{name}</option>; })}{row.values[11] && !items.some((item) => (item.display_name || item.line_item_name) === row.values[11]) && <option value={row.values[11]}>{row.values[11]}</option>}</select>{!row.depositId && spot.rows.length > 1 && <button type="button" disabled={issued} onClick={() => deleteLine(spot.id, row.id)}>削除</button>}</div>;
    if (column === 18) return <select value={row.values[18]} disabled={issued} onChange={(event) => updateRow(spot.id, row.id, column, event.target.value)}>{taxCategories.map((category) => <option key={category}>{category}</option>)}</select>;
    const onChange = (next: string) => invoiceColumns.has(column) ? updateInvoiceValue(spot.id, column, next) : updateRow(spot.id, row.id, column, next);
    return <input value={value} readOnly={calculatedColumns.has(column)} disabled={issued} onChange={(event) => onChange(event.target.value)} aria-label={`${csvHeaders[column]} ${spot.id} ${rowIndex + 1}`} />;
  };

  return <section className="invoice-creation-page spot-monthly-layout"><header className="invoice-creation-heading"><div><p className="section-kicker">SPOT INVOICE CSV</p><h3>請求書作成</h3><p>{propertyName}・{calendarYear}年{period.month}月 スポット発行</p></div><div className="spot-invoice-create"><button type="button" className="primary-button" disabled={!dirty || busy} onClick={() => void persist(spots)}>保存</button></div></header>
    {error && <p className="invoice-creation-notice invoice-creation-error">{error}</p>}{notice && <p className="invoice-creation-notice">{notice}</p>}
    <div className="invoice-creation-table-wrap invoice-csv-table-wrap"><table className="invoice-csv-table spot-invoice-table"><thead><tr className="invoice-total-row"><th>{spots.length ? '表示中合計' : ''}</th>{columns.slice(1).map((column) => <th key={`total-${column}`}>{column === 5 ? totals.subtotal.toLocaleString('ja-JP') : column === 6 ? totals.tax.toLocaleString('ja-JP') : column === 7 ? totals.total.toLocaleString('ja-JP') : ''}</th>)}<th /></tr><tr>{columns.map((column) => <th key={column}>{csvHeaders[column]}</th>)}<th>発行状態</th></tr></thead><tbody>
      {loading ? <tr><td colSpan={columns.length + 1} className="invoice-creation-empty">読み込み中…</td></tr> : !spots.length ? <tr><td colSpan={columns.length + 1} className="invoice-creation-empty">スポット請求書はありません。</td></tr> : spots.flatMap((spot) => spot.rows.map((row, rowIndex) => <tr key={row.id} className={`${rowIndex === 0 ? 'invoice-start-row' : 'invoice-continuation-row'} ${spot.state === 'issued' ? 'invoice-issued-row' : ''}`}>{columns.map((column) => <td key={`${row.id}:${column}`}>{invoiceColumns.has(column) && rowIndex > 0 ? null : cell(spot, row, rowIndex, column)}</td>)}{rowIndex === 0 && <td className="invoice-status-cell" rowSpan={spot.rows.length}><div className="invoice-issue-state"><label>計上月<input type="month" value={spot.postingMonth.slice(0, 7)} disabled={busy || dirty} onChange={(event) => void changePosting(spot, event.target.value)} /></label><span>{spot.state === 'issued' ? '請求済み' : spot.state === 'reissuing' ? '再発行編集中' : '下書き'}</span>{spot.state === 'issued' ? <button type="button" disabled={busy || dirty} onClick={() => void startReissue(spot)}>再発行</button> : <><button type="button" disabled={busy} onClick={() => addLine(spot.id)}>行を追加</button><button type="button" disabled={busy || dirty} onClick={() => void exportCsv(spot)}>CSVを出力</button></>}</div></td>}</tr>))}
    </tbody></table></div>
  </section>;
}
