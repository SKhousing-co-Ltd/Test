import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import type { BillingPeriod } from './TenantBillingControls';
import './InvoiceCreationPage.css';

type RentRollSource = { unit_code: string; unit_name: string | null; floor_label: string | null; lease_contract_id: string | null; tenant_id: string | null; tenant_name: string | null; monthly_rent_amount: number | null; monthly_common_charge_amount: number | null; monthly_parking_amount: number | null; other_monthly_amount: number | null; };
type BillingCode = { billing_code_id: string; tenant_id: string | null; issue_code: string; is_primary: boolean; invoice_display_name: string | null; invoice_subject: string | null };
type DuePattern = { billing_due_date_pattern_id: string; pattern_number: number; month_offset: number; day_of_month: number; holiday_adjustment: 'previous' | 'next' };
type ContractAllocation = { lease_contract_unit_id: string; billing_code_id: string };
type ContractUnit = { lease_contract_unit_id: string; lease_contract_id: string };
type LineItemAllocation = { billing_code_id: string; line_item: { billing_charge_type_id: string } | null; group: { tenant_id: string | null } | null };
type ChargeType = { billing_charge_type_id: string; charge_type_name: string };
type InvoiceRow = { id: string; invoiceKey: string; values: string[] };

// CSV出力時の列順です。請求書番号は出力時に採番し、画面では編集しません。
const csvHeaders = ['請求書番号', '発行先コード', '会社名', '件名', '入金期限', '今回請求金額（税抜）', '今回消費税額', '今回請求金額（税込）', '締日', '備考', '明細項目１', '明細項目２', '数量', '単位', '単価', '金額', '消費税額', '請求金額', '税区分', '税率', '備考'];
const visibleColumns = [1, 2, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 18, 19, 20];
const yen = new Intl.NumberFormat('ja-JP');
const fixedItems: Array<{ name: string; field: keyof Pick<RentRollSource, 'monthly_rent_amount' | 'monthly_common_charge_amount' | 'monthly_parking_amount' | 'other_monthly_amount'> }> = [
  { name: '賃料', field: 'monthly_rent_amount' }, { name: '共益費', field: 'monthly_common_charge_amount' }, { name: '駐車料', field: 'monthly_parking_amount' }, { name: 'その他', field: 'other_monthly_amount' },
];
const emptyValues = () => Array.from({ length: csvHeaders.length }, () => '');
const lastDay = (year: number, month: number) => new Date(year, month, 0).getDate();

export function InvoiceCreationPage({ propertyId, propertyName, period }: { propertyId: string; propertyName: string; period: BillingPeriod }) {
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showInvoiceNote, setShowInvoiceNote] = useState(false);
  const [invoiceNote, setInvoiceNote] = useState('');
  const [duePatterns, setDuePatterns] = useState<DuePattern[]>([]);
  const [duePatternId, setDuePatternId] = useState('');
  const calendarYear = period.fiscalYear + (period.month <= 3 ? 1 : 0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!supabase || !propertyId) { setRows([]); setLoading(false); return; }
      setLoading(true); setError('');
      const referenceDate = `${calendarYear}-${String(period.month).padStart(2, '0')}-01`;
      const [rentRollResult, codeResult, allocationResult, unitResult, lineAllocationResult, typeResult, dueResult] = await Promise.all([
        supabase.rpc('rent_roll_list_with_terms_at_date', { p_property_id: propertyId, p_as_of_date: referenceDate }),
        supabase.from('billing_code').select('billing_code_id, tenant_id, issue_code, is_primary, invoice_display_name, invoice_subject').eq('property_id', propertyId).eq('is_active', true),
        supabase.from('billing_code_contract_allocation').select('lease_contract_unit_id, billing_code_id'),
        supabase.from('lease_contract_unit').select('lease_contract_unit_id, lease_contract_id, unit:unit_master!inner(property_id)').eq('unit.property_id', propertyId),
        supabase.from('billing_code_line_item_allocation').select('billing_code_id, line_item:asset_billing_line_item(billing_charge_type_id), group:billing_code_allocation_group(tenant_id)'),
        supabase.from('billing_charge_type').select('billing_charge_type_id, charge_type_name').eq('is_active', true),
        supabase.from('asset_billing_due_date_pattern').select('billing_due_date_pattern_id, pattern_number, month_offset, day_of_month, holiday_adjustment').eq('asset_id', propertyId).order('pattern_number'),
      ]);
      if (cancelled) return;
      if (rentRollResult.error || codeResult.error) { setError(`請求データを読み込めませんでした: ${rentRollResult.error?.message ?? codeResult.error?.message}`); setRows([]); setLoading(false); return; }
      const codes = (codeResult.data ?? []) as BillingCode[]; const codeById = new Map(codes.map((code) => [code.billing_code_id, code])); const primaryCodeByTenant = new Map<string, BillingCode>(); for (const code of codes) if (code.tenant_id && code.is_primary) primaryCodeByTenant.set(code.tenant_id, code);
      const nextDuePatterns = (dueResult.data ?? []) as DuePattern[]; setDuePatterns(nextDuePatterns); setDuePatternId((current) => nextDuePatterns.some((pattern) => pattern.billing_due_date_pattern_id === current) ? current : (nextDuePatterns[0]?.billing_due_date_pattern_id ?? ''));
      const contractByUnit = new Map(((unitResult.data ?? []) as unknown as ContractUnit[]).map((unit) => [unit.lease_contract_unit_id, unit.lease_contract_id])); const codeByContract = new Map<string, BillingCode>(); for (const allocation of (allocationResult.data ?? []) as ContractAllocation[]) { const contractId = contractByUnit.get(allocation.lease_contract_unit_id); const code = codeById.get(allocation.billing_code_id); if (contractId && code) codeByContract.set(contractId, code); }
      const typeNameById = new Map(((typeResult.data ?? []) as ChargeType[]).map((type) => [type.billing_charge_type_id, type.charge_type_name])); const codeByTenantItem = new Map<string, BillingCode>(); for (const allocation of (lineAllocationResult.data ?? []) as unknown as LineItemAllocation[]) { const code = codeById.get(allocation.billing_code_id); const name = typeNameById.get(allocation.line_item?.billing_charge_type_id ?? ''); if (code && name && allocation.group?.tenant_id) codeByTenantItem.set(`${allocation.group.tenant_id}:${name}`, code); }
      const invoices = new Map<string, { code: string; tenantName: string; displayName: string | null; subject: string | null; unitNames: Set<string>; lines: Map<string, number> }>();
      for (const source of (rentRollResult.data ?? []) as RentRollSource[]) {
        if (!source.tenant_id || !source.tenant_name) continue;
        for (const item of fixedItems) {
          const amount = Number(source[item.field] ?? 0); if (!amount) continue;
          const target = codeByTenantItem.get(`${source.tenant_id}:${item.name}`) ?? (source.lease_contract_id ? codeByContract.get(source.lease_contract_id) : undefined) ?? primaryCodeByTenant.get(source.tenant_id);
          const key = `${source.tenant_id}:${target?.billing_code_id ?? 'unassigned'}`; const invoice = invoices.get(key) ?? { code: target?.issue_code ?? '未採番', tenantName: source.tenant_name, displayName: target?.invoice_display_name ?? null, subject: target?.invoice_subject ?? null, unitNames: new Set<string>(), lines: new Map<string, number>() };
          invoice.unitNames.add([source.floor_label, source.unit_name ?? source.unit_code].filter(Boolean).join(' ') || source.unit_code); invoice.lines.set(item.name, (invoice.lines.get(item.name) ?? 0) + amount); invoices.set(key, invoice);
        }
      }
      const next: InvoiceRow[] = [];
      for (const [invoiceKey, invoice] of invoices) {
        const total = [...invoice.lines.values()].reduce((sum, value) => sum + value, 0); const tax = Math.floor(total * 0.1);
        [...invoice.lines.entries()].forEach(([name, amount], index) => { const values = emptyValues(); if (index === 0) { values[1] = invoice.code; values[2] = invoice.displayName || invoice.tenantName; values[3] = invoice.subject || `${propertyName}${[...invoice.unitNames].join('・')} 御請求書`; values[4] = `${calendarYear}/${period.month}/${lastDay(calendarYear, period.month)}`; values[5] = yen.format(total); values[6] = yen.format(tax); values[7] = yen.format(total + tax); }
          values[10] = '未設定'; values[11] = name; values[12] = '1'; values[13] = '式'; values[14] = yen.format(amount); values[15] = yen.format(amount); values[18] = '課税'; values[19] = '10%（仮）'; next.push({ id: `${invoiceKey}:${index}:${name}`, invoiceKey, values }); });
      }
      setRows(next); setLoading(false);
    };
    void load(); return () => { cancelled = true; };
  }, [propertyId, propertyName, period.fiscalYear, period.month, calendarYear]);

  const fixedTotal = useMemo(() => rows.reduce((sum, row) => sum + Number(row.values[15].split(',').join('') || 0), 0), [rows]);
  const updateCell = (rowId: string, column: number, value: string) => setRows((current) => current.map((row) => row.id === rowId ? { ...row, values: row.values.map((cell, index) => index === column ? value : cell) } : row));
  const updateInvoiceNote = (value: string) => { setInvoiceNote(value); setRows((current) => { const written = new Set<string>(); return current.map((row) => { if (written.has(row.invoiceKey)) return row; written.add(row.invoiceKey); return { ...row, values: row.values.map((cell, index) => index === 9 ? value : cell) }; }); }); };
  const setInvoiceNoteEnabled = (enabled: boolean) => { setShowInvoiceNote(enabled); if (!enabled) updateInvoiceNote(''); };

  return <section className="invoice-creation-page"><header className="invoice-creation-heading"><div><p className="section-kicker">INVOICE CSV</p><h3>請求書作成</h3><p>{propertyName}・{calendarYear}年{period.month}月分</p></div><button className="primary-button" disabled>CSVを出力</button></header>
    <p className="invoice-creation-notice">画面では不要な列を非表示にしています。CSV出力時は請求書番号を自動採番し、モデルCSVの列順で出力します。複数テナントコードの設定は、明細項目・契約の割り振り順に反映します。</p>{error && <p className="invoice-creation-notice invoice-creation-error">{error}</p>}
    <div className="invoice-note-control"><label>入金期日パターン<select value={duePatternId} onChange={(event) => setDuePatternId(event.target.value)}><option value="">未選択</option>{duePatterns.map((pattern) => <option key={pattern.billing_due_date_pattern_id} value={pattern.billing_due_date_pattern_id}>{'①②③④⑤⑥⑦⑧⑨⑩'.charAt(pattern.pattern_number - 1) || pattern.pattern_number}</option>)}</select></label><label><input type="checkbox" checked={showInvoiceNote} onChange={(event) => setInvoiceNoteEnabled(event.target.checked)} />請求書備考を表示する</label><input value={invoiceNote} disabled={!showInvoiceNote} onChange={(event) => updateInvoiceNote(event.target.value)} placeholder="請求書に表示する共通備考を入力" /></div>
    <div className="invoice-creation-summary"><span>請求書数 <strong>{new Set(rows.map((row) => row.invoiceKey)).size}件</strong></span><span>明細行数 <strong>{rows.length}行</strong></span><span>固定費合計（税抜） <strong>{yen.format(fixedTotal)}円</strong></span><span>出力形式 <strong>CSV 21列</strong></span></div>
    <div className="invoice-creation-table-wrap invoice-csv-table-wrap"><table className="invoice-csv-table"><thead><tr>{visibleColumns.map((column) => <th key={csvHeaders[column]}>{csvHeaders[column]}</th>)}</tr></thead><tbody>{loading ? <tr><td colSpan={visibleColumns.length} className="invoice-creation-empty">レントロールを読み込み中…</td></tr> : !rows.length ? <tr><td colSpan={visibleColumns.length} className="invoice-creation-empty">表示できる固定費の契約データがありません。</td></tr> : rows.map((row) => <tr key={row.id}>{visibleColumns.map((column) => <td key={`${row.id}-${column}`}><input aria-label={`${csvHeaders[column]} ${row.id}`} value={row.values[column]} onChange={(event) => updateCell(row.id, column, event.target.value)} /></td>)}</tr>)}</tbody></table></div>
  </section>;
}
