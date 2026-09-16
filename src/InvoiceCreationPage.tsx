import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { supabase } from './lib/supabase';
import type { BillingPeriod } from './TenantBillingControls';
import { dueDate, periodRange, periodText } from './utils/billingDates';
import './InvoiceCreationPage.css';

type RentRollSource = { unit_code: string; unit_name: string | null; floor_label: string | null; lease_contract_id: string | null; tenant_id: string | null; tenant_name: string | null; monthly_rent_amount: number | null; monthly_common_charge_amount: number | null; monthly_parking_amount: number | null; other_monthly_amount: number | null; };
type BillingCode = { billing_code_id: string; tenant_id: string | null; issue_code: string; is_primary: boolean; invoice_display_name: string | null; invoice_subject: string | null };
type DuePattern = { billing_due_date_pattern_id: string; pattern_number: number; month_offset: number; day_of_month: number; holiday_adjustment: 'previous' | 'next' };
type ContractAllocation = { lease_contract_unit_id: string; billing_code_id: string };
type ContractUnit = { lease_contract_unit_id: string; lease_contract_id: string; unit: { unit_code: string; unit_name: string | null } | { unit_code: string; unit_name: string | null }[] | null };
type LineItemAllocation = { billing_code_id: string; line_item: { asset_billing_line_item_id: string; billing_charge_type_id: string } | null; group: { tenant_id: string | null } | null };
type ChargeType = { billing_charge_type_id: string; charge_type_name: string };
type AssetLineItem = { asset_billing_line_item_id: string; billing_charge_type_id: string };
type InvoiceSplitAssignment = { asset_billing_line_item_id: string; lease_contract_unit_id: string | null; invoice_number: number | null };
type InvoiceSplitSetting = { billing_code_id: string; split_mode: 'unit' | 'line_item'; assignments: InvoiceSplitAssignment[] | null };
type PeriodPattern = { billing_period_pattern_id: string; pattern_name: string; start_month_offset: number; start_day_type: string; start_meter_day_offset: number; end_month_offset: number; end_day_type: string; end_meter_day_offset: number };
type InvoiceRow = { id: string; invoiceKey: string; values: string[] };

// CSV出力時の列順です。請求書番号は画面生成時に請求書単位で採番し、編集はできません。
const csvHeaders = ['請求書番号', '発行先コード', '会社名', '件名', '入金期限', '今回請求金額（税抜）', '今回消費税額', '今回請求金額（税込）', '締日', '備考', '明細項目１', '明細項目２', '数量', '単位', '単価', '金額', '消費税額', '請求金額', '税区分', '税率', '備考'];
const screenHeaders = csvHeaders.map((header, index) => index === 5 ? '請求金額（税抜）' : index === 6 ? '消費税額' : index === 7 ? '請求金額（税込）' : index === 9 ? '請求書備考' : header);
const baseColumns = [0, 1, 2, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 18, 19, 20];
// 請求書備考（9列目）は「請求書備考を表示」を入れたときだけ、締日の次に差し込みます。
const invoiceNoteColumn = 9;
const initialColumnWidths: Record<number, number> = { 0: 88, 1: 72, 2: 150, 4: 130, 5: 100, 6: 100, 7: 100, 9: 150, 10: 132, 11: 135, 12: 48, 13: 52, 14: 96, 15: 96, 18: 70, 19: 70, 20: 130 };
const columnWidthStorageKey = 'invoice-creation-column-widths-v2';
const legacyColumnWidthStorageKey = 'invoice-creation-column-widths';
const loadColumnWidths = (): Record<number, number> => {
  const widths = { ...initialColumnWidths };
  try {
    const stored = JSON.parse(localStorage.getItem(columnWidthStorageKey) ?? 'null');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const column of Object.keys(initialColumnWidths)) { const width = stored[column]; if (typeof width === 'number' && width >= 44) widths[Number(column)] = width; }
      return widths;
    }
    // 旧形式は表示順の配列だったため、請求書備考を除いた並びに対応付けて引き継ぎます。
    const legacy = JSON.parse(localStorage.getItem(legacyColumnWidthStorageKey) ?? 'null');
    if (Array.isArray(legacy) && legacy.length === baseColumns.length) baseColumns.forEach((column, position) => { const width = legacy[position]; if (typeof width === 'number' && width >= 44) widths[column] = width; });
  } catch { return widths; }
  return widths;
};
const yen = new Intl.NumberFormat('ja-JP');
const fixedItems: Array<{ name: string; field: keyof Pick<RentRollSource, 'monthly_rent_amount' | 'monthly_common_charge_amount' | 'monthly_parking_amount' | 'other_monthly_amount'> }> = [
  { name: '賃料', field: 'monthly_rent_amount' }, { name: '共益費', field: 'monthly_common_charge_amount' }, { name: '駐車料', field: 'monthly_parking_amount' }, { name: 'その他', field: 'other_monthly_amount' },
];
const emptyValues = () => Array.from({ length: csvHeaders.length }, () => '');
const numberValue = (value: string) => Number(value.split(',').join('') || 0);
const patternMark = (number: number) => '①②③④⑤⑥⑦⑧⑨⑩'.charAt(number - 1) || String(number);
const duePatternMark = (pattern: DuePattern) => patternMark(pattern.pattern_number);
const duePatternLabel = (pattern: DuePattern) => `${patternMark(pattern.pattern_number)} ${pattern.month_offset ? '翌月' : '当月'}${pattern.day_of_month === 0 ? '末日' : `${pattern.day_of_month}日`}（休日は${pattern.holiday_adjustment === 'previous' ? '前日' : '翌日'}）`;
const firstOf = <T,>(value: T | T[] | null) => Array.isArray(value) ? value[0] ?? null : value;

export function InvoiceCreationPage({ propertyId, propertyName, period }: { propertyId: string; propertyName: string; period: BillingPeriod }) {
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showInvoiceNote, setShowInvoiceNote] = useState(false);
  const [invoiceNote, setInvoiceNote] = useState('');
  const [duePatterns, setDuePatterns] = useState<DuePattern[]>([]);
  const [duePatternByInvoice, setDuePatternByInvoice] = useState<Record<string, string>>({});
  const [dueDateByPattern, setDueDateByPattern] = useState<Record<string, string>>({});
  const [periodPatterns, setPeriodPatterns] = useState<PeriodPattern[]>([]);
  const [periodPatternByRow, setPeriodPatternByRow] = useState<Record<string, string>>({});
  const [periodRangeByPattern, setPeriodRangeByPattern] = useState<Record<string, { start: string; end: string }>>({});
  const [lineItem1Filter, setLineItem1Filter] = useState('all');
  const [lineItem2Filter, setLineItem2Filter] = useState('all');
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>(loadColumnWidths);
  const calendarYear = period.fiscalYear + (period.month <= 3 ? 1 : 0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!supabase || !propertyId) { setRows([]); setLoading(false); return; }
      setLoading(true); setError('');
      const referenceDate = `${calendarYear}-${String(period.month).padStart(2, '0')}-01`;
      const [rentRollResult, codeResult, allocationResult, unitResult, lineAllocationResult, typeResult, dueResult, assetItemResult, splitResult, periodResult] = await Promise.all([
        supabase.rpc('rent_roll_list_with_terms_at_date', { p_property_id: propertyId, p_as_of_date: referenceDate }),
        supabase.from('billing_code').select('billing_code_id, tenant_id, issue_code, is_primary, invoice_display_name, invoice_subject').eq('property_id', propertyId).eq('is_active', true),
        supabase.from('billing_code_contract_allocation').select('lease_contract_unit_id, billing_code_id'),
        supabase.from('lease_contract_unit').select('lease_contract_unit_id, lease_contract_id, unit:unit_master!inner(property_id, unit_code, unit_name)').eq('unit.property_id', propertyId),
        supabase.from('billing_code_line_item_allocation').select('billing_code_id, line_item:asset_billing_line_item(asset_billing_line_item_id, billing_charge_type_id), group:billing_code_allocation_group(tenant_id)'),
        supabase.from('billing_charge_type').select('billing_charge_type_id, charge_type_name').eq('is_active', true),
        supabase.from('asset_billing_due_date_pattern').select('billing_due_date_pattern_id, pattern_number, month_offset, day_of_month, holiday_adjustment').eq('asset_id', propertyId).order('pattern_number'),
        supabase.from('asset_billing_line_item').select('asset_billing_line_item_id, billing_charge_type_id').eq('asset_id', propertyId).eq('is_active', true),
        supabase.from('billing_invoice_split_setting').select('billing_code_id, split_mode, assignments:billing_invoice_split_assignment(asset_billing_line_item_id, lease_contract_unit_id, invoice_number)').eq('asset_id', propertyId),
        supabase.from('asset_billing_period_pattern').select('billing_period_pattern_id, pattern_name, start_month_offset, start_day_type, start_meter_day_offset, end_month_offset, end_day_type, end_meter_day_offset').eq('asset_id', propertyId).order('sort_order'),
      ]);
      if (cancelled) return;
      if (rentRollResult.error || codeResult.error) { setError(`請求データを読み込めませんでした: ${rentRollResult.error?.message ?? codeResult.error?.message}`); setRows([]); setLoading(false); return; }
      const codes = (codeResult.data ?? []) as BillingCode[]; const codeById = new Map(codes.map((code) => [code.billing_code_id, code])); const primaryCodeByTenant = new Map<string, BillingCode>(); for (const code of codes) if (code.tenant_id && code.is_primary) primaryCodeByTenant.set(code.tenant_id, code);
      const nextDuePatterns = (dueResult.data ?? []) as DuePattern[]; setDuePatterns(nextDuePatterns);
      const nextDueDates = Object.fromEntries(nextDuePatterns.map((pattern) => [pattern.billing_due_date_pattern_id, dueDate(calendarYear, period.month, pattern)]));
      setDueDateByPattern(nextDueDates);
      const nextPeriodPatterns = (periodResult.data ?? []) as PeriodPattern[]; setPeriodPatterns(nextPeriodPatterns);
      setPeriodPatternByRow({}); setPeriodRangeByPattern(Object.fromEntries(nextPeriodPatterns.map((pattern) => [pattern.billing_period_pattern_id, periodRange(calendarYear, period.month, pattern)])));
      const contractUnits = (unitResult.data ?? []) as unknown as ContractUnit[]; const contractByUnit = new Map(contractUnits.map((unit) => [unit.lease_contract_unit_id, unit.lease_contract_id])); const unitIdBySource = new Map(contractUnits.map((unit) => [`${unit.lease_contract_id}:${firstOf(unit.unit)?.unit_code ?? ''}`, unit.lease_contract_unit_id])); const unitLabelById = new Map(contractUnits.map((unit) => [unit.lease_contract_unit_id, firstOf(unit.unit)?.unit_name || firstOf(unit.unit)?.unit_code || '区画名なし'])); const codeByContract = new Map<string, BillingCode>(); for (const allocation of (allocationResult.data ?? []) as ContractAllocation[]) { const contractId = contractByUnit.get(allocation.lease_contract_unit_id); const code = codeById.get(allocation.billing_code_id); if (contractId && code) codeByContract.set(contractId, code); }
      const typeNameById = new Map(((typeResult.data ?? []) as ChargeType[]).map((type) => [type.billing_charge_type_id, type.charge_type_name])); const lineItemIdByChargeName = new Map<string, string>(); for (const item of (assetItemResult.data ?? []) as AssetLineItem[]) { const chargeName = typeNameById.get(item.billing_charge_type_id); if (chargeName && !lineItemIdByChargeName.has(chargeName)) lineItemIdByChargeName.set(chargeName, item.asset_billing_line_item_id); } const codeByTenantItem = new Map<string, BillingCode>(); for (const allocation of (lineAllocationResult.data ?? []) as unknown as LineItemAllocation[]) { const code = codeById.get(allocation.billing_code_id); const name = typeNameById.get(allocation.line_item?.billing_charge_type_id ?? ''); if (code && name && allocation.group?.tenant_id) codeByTenantItem.set(`${allocation.group.tenant_id}:${name}`, code); }
      const splitByCode = new Map(((splitResult.data ?? []) as unknown as InvoiceSplitSetting[]).map((setting) => [setting.billing_code_id, setting]));
      const invoices = new Map<string, { code: string; tenantName: string; displayName: string | null; subject: string | null; unitNames: Set<string>; lines: Map<string, number> }>();
      for (const source of (rentRollResult.data ?? []) as RentRollSource[]) {
        if (!source.tenant_id || !source.tenant_name) continue;
        for (const item of fixedItems) {
          const amount = Number(source[item.field] ?? 0); if (!amount) continue;
          const target = codeByTenantItem.get(`${source.tenant_id}:${item.name}`) ?? (source.lease_contract_id ? codeByContract.get(source.lease_contract_id) : undefined) ?? primaryCodeByTenant.get(source.tenant_id);
          const split = target ? splitByCode.get(target.billing_code_id) : undefined; const lineItemId = lineItemIdByChargeName.get(item.name); const splitAssignment = split?.assignments?.find((assignment) => assignment.asset_billing_line_item_id === lineItemId); const sourceUnitId = source.lease_contract_id ? unitIdBySource.get(`${source.lease_contract_id}:${source.unit_code}`) : undefined; const splitKey = split?.split_mode === 'unit' ? `unit:${splitAssignment?.lease_contract_unit_id ?? sourceUnitId ?? 'unassigned'}` : split?.split_mode === 'line_item' ? `invoice:${splitAssignment?.invoice_number ?? 1}` : 'single';
          const key = `${source.tenant_id}:${target?.billing_code_id ?? 'unassigned'}:${splitKey}`; const invoice = invoices.get(key) ?? { code: target?.issue_code ?? '未採番', tenantName: source.tenant_name, displayName: target?.invoice_display_name ?? null, subject: target?.invoice_subject ?? null, unitNames: new Set<string>(), lines: new Map<string, number>() };
          const assignedUnitLabel = split?.split_mode === 'unit' && splitAssignment?.lease_contract_unit_id ? unitLabelById.get(splitAssignment.lease_contract_unit_id) : null; invoice.unitNames.add(assignedUnitLabel ?? ([source.floor_label, source.unit_name ?? source.unit_code].filter(Boolean).join(' ') || source.unit_code)); invoice.lines.set(item.name, (invoice.lines.get(item.name) ?? 0) + amount); invoices.set(key, invoice);
        }
      }
      const next: InvoiceRow[] = [];
      let invoiceNumber = 0;
      for (const [invoiceKey, invoice] of invoices) {
        invoiceNumber += 1;
        const total = [...invoice.lines.values()].reduce((sum, value) => sum + value, 0); const tax = Math.floor(total * 0.1);
        [...invoice.lines.entries()].forEach(([name, amount], index) => { const values = emptyValues(); if (index === 0) { values[0] = String(invoiceNumber); values[1] = invoice.code; values[2] = invoice.displayName || invoice.tenantName; values[3] = invoice.subject || `${propertyName}${[...invoice.unitNames].join('・')} 御請求書`; values[4] = nextDueDates[nextDuePatterns[0]?.billing_due_date_pattern_id ?? ''] ?? ''; values[5] = yen.format(total); values[6] = yen.format(tax); values[7] = yen.format(total + tax); }
          values[10] = '未設定'; values[11] = name; values[12] = ''; values[13] = ''; values[14] = ''; values[15] = yen.format(amount); values[18] = '課税'; values[19] = '10%（仮）'; next.push({ id: `${invoiceKey}:${index}:${name}`, invoiceKey, values }); });
      }
      setRows(next);
      setDuePatternByInvoice(Object.fromEntries([...invoices.keys()].map((invoiceKey) => [invoiceKey, nextDuePatterns[0]?.billing_due_date_pattern_id ?? ''])));
      setLineItem1Filter('all'); setLineItem2Filter('all'); setLoading(false);
    };
    void load(); return () => { cancelled = true; };
  }, [propertyId, propertyName, period.fiscalYear, period.month, calendarYear]);

  useEffect(() => { localStorage.setItem(columnWidthStorageKey, JSON.stringify(columnWidths)); }, [columnWidths]);

  const lineItem1Options = useMemo(() => [...new Set(rows.map((row) => row.values[10]).filter(Boolean))].sort(), [rows]);
  const lineItem2Options = useMemo(() => [...new Set(rows.map((row) => row.values[11]).filter(Boolean))].sort(), [rows]);
  const filteredRows = useMemo(() => rows.filter((row) => (lineItem1Filter === 'all' || row.values[10] === lineItem1Filter) && (lineItem2Filter === 'all' || row.values[11] === lineItem2Filter)), [lineItem1Filter, lineItem2Filter, rows]);
  const invoiceSummaryByKey = useMemo(() => { const result = new Map<string, InvoiceRow>(); for (const row of rows) if (!result.has(row.invoiceKey)) result.set(row.invoiceKey, row); return result; }, [rows]);
  const firstVisibleRowIds = useMemo(() => { const result = new Set<string>(); const seen = new Set<string>(); for (const row of filteredRows) if (!seen.has(row.invoiceKey)) { seen.add(row.invoiceKey); result.add(row.id); } return result; }, [filteredRows]);
  const visibleInvoiceKeys = useMemo(() => [...new Set(filteredRows.map((row) => row.invoiceKey))], [filteredRows]);
  const totals = useMemo(() => ({
    5: visibleInvoiceKeys.reduce((sum, key) => sum + numberValue(invoiceSummaryByKey.get(key)?.values[5] ?? ''), 0),
    6: visibleInvoiceKeys.reduce((sum, key) => sum + numberValue(invoiceSummaryByKey.get(key)?.values[6] ?? ''), 0),
    7: visibleInvoiceKeys.reduce((sum, key) => sum + numberValue(invoiceSummaryByKey.get(key)?.values[7] ?? ''), 0),
    12: filteredRows.reduce((sum, row) => sum + numberValue(row.values[12]), 0),
    15: filteredRows.reduce((sum, row) => sum + numberValue(row.values[15]), 0),
  }), [filteredRows, invoiceSummaryByKey, visibleInvoiceKeys]);
  const updateCell = (rowId: string, column: number, value: string) => setRows((current) => current.map((row) => row.id === rowId ? { ...row, values: row.values.map((cell, index) => index === column ? value : cell) } : row));
  const updateInvoiceCell = (invoiceKey: string, column: number, value: string) => setRows((current) => { let updated = false; return current.map((row) => { if (updated || row.invoiceKey !== invoiceKey) return row; updated = true; return { ...row, values: row.values.map((cell, index) => index === column ? value : cell) }; }); });
  // 請求書単位でパターンを切り替えると、上部で確認・編集している日付をそのまま取り込みます。
  const selectDuePattern = (invoiceKey: string, patternId: string) => { setDuePatternByInvoice((current) => ({ ...current, [invoiceKey]: patternId })); updateInvoiceCell(invoiceKey, 4, dueDateByPattern[patternId] ?? ''); };
  const setInvoiceValue = (matches: (invoiceKey: string) => boolean, column: number, value: string) => setRows((current) => { const written = new Set<string>(); return current.map((row) => { if (written.has(row.invoiceKey) || !matches(row.invoiceKey)) return row; written.add(row.invoiceKey); return { ...row, values: row.values.map((cell, index) => index === column ? value : cell) }; }); });
  // 上部の入金期限を書き換えると、そのパターンを使う請求書すべてに反映します。
  const changeDueDate = (patternId: string, value: string) => { setDueDateByPattern((current) => ({ ...current, [patternId]: value })); setInvoiceValue((invoiceKey) => (duePatternByInvoice[invoiceKey] ?? '') === patternId, 4, value); };
  // 明細行の請求期間パターンを切り替えると、上部で確認・編集している期間をそのまま取り込みます。
  const selectPeriodPattern = (rowId: string, patternId: string) => { const range = periodRangeByPattern[patternId]; setPeriodPatternByRow((current) => ({ ...current, [rowId]: patternId })); setLineItem1Filter('all'); updateCell(rowId, 10, patternId ? periodText(range?.start ?? '', range?.end ?? '') : '未設定'); };
  // 上部の請求期間を書き換えると、そのパターンを選んでいる明細すべてに反映します。
  const changePeriodRange = (patternId: string, edge: 'start' | 'end', value: string) => {
    const range = { ...(periodRangeByPattern[patternId] ?? { start: '', end: '' }), [edge]: value };
    setPeriodRangeByPattern((current) => ({ ...current, [patternId]: range })); setLineItem1Filter('all');
    setRows((current) => current.map((row) => (periodPatternByRow[row.id] ?? '') === patternId ? { ...row, values: row.values.map((cell, index) => index === 10 ? periodText(range.start, range.end) : cell) } : row));
  };
  const updateInvoiceNote = (value: string) => { setInvoiceNote(value); setRows((current) => { const written = new Set<string>(); return current.map((row) => { if (written.has(row.invoiceKey)) return row; written.add(row.invoiceKey); return { ...row, values: row.values.map((cell, index) => index === 9 ? value : cell) }; }); }); };
  const setInvoiceNoteEnabled = (enabled: boolean) => { setShowInvoiceNote(enabled); if (!enabled) updateInvoiceNote(''); };
  const startColumnResize = (column: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX; const startWidth = columnWidths[column];
    const resize = (moveEvent: PointerEvent) => setColumnWidths((current) => ({ ...current, [column]: Math.max(44, startWidth + moveEvent.clientX - startX) }));
    const stop = () => { window.removeEventListener('pointermove', resize); window.removeEventListener('pointerup', stop); document.body.classList.remove('invoice-column-resizing'); };
    document.body.classList.add('invoice-column-resizing'); window.addEventListener('pointermove', resize); window.addEventListener('pointerup', stop);
  };
  const invoiceLevelColumns = new Set([0, 1, 2, 4, 5, 6, 7, invoiceNoteColumn]);
  const totalColumns = new Set([5, 6, 7, 12, 15]);
  const visibleColumns = showInvoiceNote ? [...baseColumns.slice(0, 7), invoiceNoteColumn, ...baseColumns.slice(7)] : baseColumns;
  const tableWidth = visibleColumns.reduce((sum, column) => sum + columnWidths[column], 0);

  return <section className="invoice-creation-page"><header className="invoice-creation-heading"><div><p className="section-kicker">INVOICE CSV</p><h3>請求書作成</h3><p>{propertyName}・{calendarYear}年{period.month}月分</p></div><div className="invoice-date-panel">
      <section><h4>入金期限</h4>{duePatterns.length ? <ul>{duePatterns.map((pattern) => <li key={pattern.billing_due_date_pattern_id}><span title={duePatternLabel(pattern)}>{duePatternMark(pattern)}</span><input value={dueDateByPattern[pattern.billing_due_date_pattern_id] ?? ''} placeholder="YYYY/MM/DD" aria-label={`入金期限 ${duePatternLabel(pattern)}`} onChange={(event) => changeDueDate(pattern.billing_due_date_pattern_id, event.target.value)} /></li>)}</ul> : <p>請求設定で登録してください</p>}</section>
      <section><h4>請求期間</h4>{periodPatterns.length ? <ul>{periodPatterns.map((pattern) => <li key={pattern.billing_period_pattern_id}><span>{pattern.pattern_name}</span><input value={periodRangeByPattern[pattern.billing_period_pattern_id]?.start ?? ''} placeholder="YYYY/MM/DD" aria-label={`請求期間 ${pattern.pattern_name} 開始日`} onChange={(event) => changePeriodRange(pattern.billing_period_pattern_id, 'start', event.target.value)} /><em>～</em><input value={periodRangeByPattern[pattern.billing_period_pattern_id]?.end ?? ''} placeholder="YYYY/MM/DD" aria-label={`請求期間 ${pattern.pattern_name} 終了日`} onChange={(event) => changePeriodRange(pattern.billing_period_pattern_id, 'end', event.target.value)} /><em>分</em></li>)}</ul> : <p>請求設定で登録してください</p>}</section>
    </div>
    <div className="invoice-creation-actions"><div className="invoice-note-field"><label><input type="checkbox" checked={showInvoiceNote} onChange={(event) => setInvoiceNoteEnabled(event.target.checked)} />請求書備考を表示</label><input value={invoiceNote} disabled={!showInvoiceNote} onChange={(event) => updateInvoiceNote(event.target.value)} placeholder="全請求書共通の備考" /></div><button className="primary-button" disabled>CSVを出力</button></div></header>
    {error && <p className="invoice-creation-notice invoice-creation-error">{error}</p>}
    <div className="invoice-creation-table-wrap invoice-csv-table-wrap"><table className="invoice-csv-table" style={{ width: tableWidth }}><colgroup>{visibleColumns.map((column) => <col key={column} style={{ width: columnWidths[column] }} />)}</colgroup><thead><tr className="invoice-total-row">{visibleColumns.map((column) => <th key={`total-${column}`}>{totalColumns.has(column) ? <><span>表示中合計</span><strong>{yen.format(totals[column as keyof typeof totals])}</strong></> : null}</th>)}</tr><tr>{visibleColumns.map((column) => <th key={column}>{column === 10 || column === 11 ? <label>{screenHeaders[column]}<select value={column === 10 ? lineItem1Filter : lineItem2Filter} onChange={(event) => column === 10 ? setLineItem1Filter(event.target.value) : setLineItem2Filter(event.target.value)}><option value="all">すべて</option>{(column === 10 ? lineItem1Options : lineItem2Options).map((option) => <option key={option} value={option}>{option}</option>)}</select></label> : screenHeaders[column]}<button type="button" className="invoice-column-resizer" aria-label={`${screenHeaders[column]}の列幅を変更`} onPointerDown={(event) => startColumnResize(column, event)} /></th>)}</tr></thead><tbody>{loading ? <tr><td colSpan={visibleColumns.length} className="invoice-creation-empty">レントロールを読み込み中…</td></tr> : !filteredRows.length ? <tr><td colSpan={visibleColumns.length} className="invoice-creation-empty">条件に一致する固定費の契約データがありません。</td></tr> : filteredRows.map((row) => { const firstVisible = firstVisibleRowIds.has(row.id); const summary = invoiceSummaryByKey.get(row.invoiceKey) ?? row; return <tr key={row.id} className={firstVisible ? 'invoice-start-row' : 'invoice-continuation-row'}>{visibleColumns.map((column) => <td key={`${row.id}-${column}`}>{column === 4 && firstVisible ? <select className="invoice-due-pattern" aria-label={`入金期日パターン ${row.invoiceKey}`} title={(() => { const selected = duePatterns.find((pattern) => pattern.billing_due_date_pattern_id === duePatternByInvoice[row.invoiceKey]); return selected ? `${duePatternLabel(selected)}：${dueDateByPattern[selected.billing_due_date_pattern_id] ?? ''}` : '未選択'; })()} value={duePatternByInvoice[row.invoiceKey] ?? ''} onChange={(event) => selectDuePattern(row.invoiceKey, event.target.value)}><option value="">未選択</option>{duePatterns.map((pattern) => <option key={pattern.billing_due_date_pattern_id} value={pattern.billing_due_date_pattern_id}>{duePatternMark(pattern)}</option>)}</select> : column === 10 ? <select className="invoice-due-pattern" aria-label={`請求期間パターン ${row.id}`} title={row.values[10]} value={periodPatternByRow[row.id] ?? ''} onChange={(event) => selectPeriodPattern(row.id, event.target.value)}><option value="">未設定</option>{periodPatterns.map((pattern) => <option key={pattern.billing_period_pattern_id} value={pattern.billing_period_pattern_id}>{pattern.pattern_name}</option>)}</select> : invoiceLevelColumns.has(column) && !firstVisible ? null : <input aria-label={`${screenHeaders[column]} ${row.id}`} value={(invoiceLevelColumns.has(column) ? summary : row).values[column]} readOnly={column === 0} onChange={(event) => invoiceLevelColumns.has(column) ? updateInvoiceCell(row.invoiceKey, column, event.target.value) : updateCell(row.id, column, event.target.value)} />}</td>)}</tr>; })}</tbody></table></div>
  </section>;
}
