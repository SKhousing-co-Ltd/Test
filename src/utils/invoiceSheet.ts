// 請求書作成の内容（請求書の行）を組み立て・再計算・保存する処理です。
// 請求書作成画面と、入金明細・請求明細の両方で使います。
//   組み立て … レントロールの固定費と検針データの明細を、請求コード・請求書分割設定に従って請求書にまとめます。
//   再計算   … 請求書ごとに、明細の金額から税抜合計・消費税（課税の明細の合計×10%、切り捨て）・税込合計を出します。
//   保存     … 手で直した内容も含めて、物件・請求月ごとに tenant_invoice_sheet へ保存します。
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadSavedTenantOrder, orderTenants, tenantComparator } from './tenantOrder.ts';
import { defaultBillingTerms, periodRange, periodText, termsDueDate, termsPeriod, termsPeriodLabel, type BillingTerms } from './billingDates.ts';
import { loadMeterInvoiceData } from './meterReadingStore.ts';
import type { MeterInvoiceLine } from './meterReading';

type RentRollSource = { unit_id: string | null; unit_code: string; unit_name: string | null; floor_label: string | null; unit_type: string | null; lease_contract_id: string | null; tenant_id: string | null; tenant_name: string | null; monthly_rent_amount: number | null; monthly_common_charge_amount: number | null; monthly_parking_amount: number | null; other_monthly_amount: number | null; };
type BillingCode = { billing_code_id: string; tenant_id: string | null; issue_code: string; is_primary: boolean; invoice_display_name: string | null; invoice_subject: string | null };
export type DuePattern = { billing_due_date_pattern_id: string; pattern_number: number; month_offset: number; day_of_month: number; holiday_adjustment: 'previous' | 'next' };
type ContractAllocation = { lease_contract_unit_id: string; billing_code_id: string };
type ContractUnit = { lease_contract_unit_id: string; lease_contract_id: string; unit: { unit_code: string; unit_name: string | null } | { unit_code: string; unit_name: string | null }[] | null };
type LineItemAllocation = { billing_code_id: string; line_item: { asset_billing_line_item_id: string; billing_charge_type_id: string } | null; group: { tenant_id: string | null } | null };
type ChargeType = { billing_charge_type_id: string; charge_type_name: string };
type AssetLineItem = { asset_billing_line_item_id: string; billing_charge_type_id: string; line_item_name: string; display_name: string | null };
// 検針データから載せる明細です。数量に使用量、単位に kWh など、単価を出します。
type MeterLine = { name: string; chargeType: string; usage: number | null; unit: string; unitPrice: number | null; amount: number; periodPatternId: string };
type InvoiceSplitAssignment = { asset_billing_line_item_id: string; lease_contract_unit_id: string | null; invoice_number: number | null };
type InvoiceSplitSetting = { billing_code_id: string; split_mode: 'unit' | 'line_item'; assignments: InvoiceSplitAssignment[] | null };
export type PeriodPattern = { billing_period_pattern_id: string; pattern_name: string; start_month_offset: number; start_day_type: string; start_meter_day_offset: number; end_month_offset: number; end_day_type: string; end_meter_day_offset: number };

// 請求書の1行（明細1行）です。values はCSVの列順の値です。
// chargeType は入金明細・請求明細でどの請求種別の列に入れるか、tenantId・tenantName・floor は明細の行の見出しに使います。
export type InvoiceRow = { id: string; invoiceKey: string; values: string[]; chargeType: string; tenantId: string; tenantName: string; floor: string };

// CSV出力時の列順です。請求書番号は画面生成時に請求書単位で採番し、編集はできません。
export const csvHeaders = ['請求書番号', '発行先コード', '会社名', '件名', '入金期限', '今回請求金額（税抜）', '今回消費税額', '今回請求金額（税込）', '締日', '備考', '明細項目１', '明細項目２', '数量', '単位', '単価', '金額', '消費税額', '請求金額', '税区分', '税率', '備考'];
export const emptyValues = () => Array.from({ length: csvHeaders.length }, () => '');

// 税区分です。課税のときだけ税率10%を表示し、消費税の対象にします。
export const taxCategories = ['課税', '非課税', '不課税'] as const;
export const taxRateOf = (category: string) => category === '課税' ? '10%' : '';
const taxRate = 0.1;

const yen = new Intl.NumberFormat('ja-JP');
const usageText = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 3 });
const unitPriceText = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 4 });
// 金額の文字列を数値にします。全角数字・全角カンマ・マイナス記号（－ − △）・円記号も受け付けます。
// 数値として読めないとき（1-2 など）は null を返します。空欄は0です。
export const parseAmount = (value: string): number | null => {
  const text = String(value ?? '').normalize('NFKC').replace(/[−–—△▲]/g, '-').replace(/[,\s円¥￥]/g, '');
  if (!text) return 0;
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
};
export const numberValue = (value: string) => parseAmount(value) ?? 0;
// 金額・数量・単価の列に、数値として読めない値が入っている明細です（保存の前に直してもらいます）。
export const invalidAmountRows = (rows: InvoiceRow[]) => rows.filter((row) => parseAmount(row.values[15]) === null);
const fixedItems: Array<{ name: string; field: keyof Pick<RentRollSource, 'monthly_rent_amount' | 'monthly_common_charge_amount' | 'monthly_parking_amount' | 'other_monthly_amount'> }> = [
  { name: '賃料', field: 'monthly_rent_amount' }, { name: '共益費', field: 'monthly_common_charge_amount' }, { name: '駐車料', field: 'monthly_parking_amount' }, { name: 'その他', field: 'other_monthly_amount' },
];
// 駐輪場の区画はレントロール上「その他」に入るため、明細では駐輪場利用料として分けます。
const lineItemName = (source: RentRollSource, item: (typeof fixedItems)[number]) => item.field === 'other_monthly_amount' && source.unit_type === 'bicycle_parking' ? '駐輪場利用料' : item.name;
// 駐車場・駐輪場は区画ごとの契約なので、数量に台数、単位に「台」を出します。
const countedItems = new Set(['駐車料', '駐輪場利用料']);
const firstOf = <T,>(value: T | T[] | null) => Array.isArray(value) ? value[0] ?? null : value;

// 請求書ごとの金額を明細から出し直します。
//   今回請求金額（税抜）＝明細の金額の合計
//   今回消費税額　　　　＝税区分が課税の明細の金額の合計×10%（切り捨て）
//   今回請求金額（税込）＝税抜＋消費税
// 税率の列は、課税の明細だけ10%にします。金額は請求書の最初の行に入れます。
export function recalcInvoices(rows: InvoiceRow[]): InvoiceRow[] {
  const sums = new Map<string, { subtotal: number; taxable: number }>();
  for (const row of rows) {
    const sum = sums.get(row.invoiceKey) ?? { subtotal: 0, taxable: 0 };
    const amount = numberValue(row.values[15]);
    sum.subtotal += amount;
    if (row.values[18] === '課税') sum.taxable += amount;
    sums.set(row.invoiceKey, sum);
  }
  const written = new Set<string>();
  return rows.map((row) => {
    const values = [...row.values];
    values[19] = taxRateOf(values[18]);
    if (!written.has(row.invoiceKey)) {
      written.add(row.invoiceKey);
      const sum = sums.get(row.invoiceKey)!;
      const tax = Math.floor(Number((sum.taxable * taxRate).toFixed(6)));
      values[5] = yen.format(sum.subtotal); values[6] = yen.format(tax); values[7] = yen.format(sum.subtotal + tax);
    }
    return values.every((value, index) => value === row.values[index]) ? row : { ...row, values };
  });
}

// 請求書作成画面の状態です。保存・読み込みはこの形で行います。
export type InvoiceSheet = {
  rows: InvoiceRow[];
  duePatternByInvoice: Record<string, string>;
  dueDateByPattern: Record<string, string>;
  periodPatternByRow: Record<string, string>;
  periodRangeByPattern: Record<string, { start: string; end: string }>;
  invoiceNote: string;
  showInvoiceNote: boolean;
};
export type BuiltInvoiceSheet = { sheet: InvoiceSheet; duePatterns: DuePattern[]; periodPatterns: PeriodPattern[]; meterNotice: string; termsNotice: string };
const termsColumns = 'lease_contract_id, due_month_offset, due_day_of_month, due_holiday_adjustment, period_month_offset, is_annual_billing, annual_billing_month, annual_start_offset';
const dueKey = (terms: BillingTerms) => `${terms.due_month_offset}:${terms.due_day_of_month}:${terms.due_holiday_adjustment}`;
const periodKey = (terms: BillingTerms) => `${terms.period_month_offset}:${terms.is_annual_billing}:${terms.annual_billing_month}:${terms.annual_start_offset}`;

// レントロールの固定費と検針データから、請求書作成の内容を組み立てます（保存した内容は使いません）。
export async function buildInvoiceSheet(client: SupabaseClient, propertyId: string, propertyName: string, calendarYear: number, month: number): Promise<BuiltInvoiceSheet> {
  const referenceDate = `${calendarYear}-${String(month).padStart(2, '0')}-01`;
  // 検針データは開くたびに保存済みの内容から計算し直すため、検針データ画面で保存した変更がそのまま反映されます。
  // 読み込めなくても固定費の請求書は作れるよう、失敗はお知らせだけにします。
  const meterPromise = loadMeterInvoiceData(client, propertyId, calendarYear, month)
    .then((data) => ({ data, error: '' }))
    .catch((meterError: unknown) => ({ data: null, error: meterError instanceof Error ? meterError.message : '検針データを読み込めませんでした' }));
  const [rentRollResult, codeResult, allocationResult, unitResult, lineAllocationResult, typeResult, assetItemResult, splitResult, periodResult, savedOrder, meterResult] = await Promise.all([
    client.rpc('rent_roll_list_with_terms_at_date', { p_property_id: propertyId, p_as_of_date: referenceDate }),
    client.from('billing_code').select('billing_code_id, tenant_id, issue_code, is_primary, invoice_display_name, invoice_subject').eq('property_id', propertyId).eq('is_active', true),
    client.from('billing_code_contract_allocation').select('lease_contract_unit_id, billing_code_id'),
    client.from('lease_contract_unit').select('lease_contract_unit_id, lease_contract_id, unit:unit_master!inner(property_id, unit_code, unit_name)').eq('unit.property_id', propertyId),
    client.from('billing_code_line_item_allocation').select('billing_code_id, line_item:asset_billing_line_item(asset_billing_line_item_id, billing_charge_type_id), group:billing_code_allocation_group(tenant_id)'),
    client.from('billing_charge_type').select('billing_charge_type_id, charge_type_name').eq('is_active', true),
    client.from('asset_billing_line_item').select('asset_billing_line_item_id, billing_charge_type_id, line_item_name, display_name').eq('asset_id', propertyId).eq('is_active', true),
    client.from('billing_invoice_split_setting').select('billing_code_id, split_mode, assignments:billing_invoice_split_assignment(asset_billing_line_item_id, lease_contract_unit_id, invoice_number)').eq('asset_id', propertyId),
    client.from('asset_billing_period_pattern').select('billing_period_pattern_id, pattern_name, start_month_offset, start_day_type, start_meter_day_offset, end_month_offset, end_day_type, end_meter_day_offset').eq('asset_id', propertyId).order('sort_order'),
    loadSavedTenantOrder(client, propertyId),
    meterPromise,
  ]);
  if (rentRollResult.error || codeResult.error) throw new Error(`請求データを読み込めませんでした: ${rentRollResult.error?.message ?? codeResult.error?.message}`);
  const codes = (codeResult.data ?? []) as BillingCode[]; const codeById = new Map(codes.map((code) => [code.billing_code_id, code])); const primaryCodeByTenant = new Map<string, BillingCode>(); for (const code of codes) if (code.tenant_id && code.is_primary) primaryCodeByTenant.set(code.tenant_id, code);
  // 入金期日・請求期間は契約の請求条件から決めます。契約に紐づかない明細（検針データなど）は既定値です。
  const contractIds = [...new Set(((rentRollResult.data ?? []) as RentRollSource[]).map((source) => source.lease_contract_id).filter((id): id is string => Boolean(id)))];
  const termsResult = contractIds.length ? await client.from('lease_contract').select(termsColumns).in('lease_contract_id', contractIds) : { data: [], error: null };
  if (termsResult.error) throw new Error(`契約の請求条件を読み込めませんでした: ${termsResult.error.message}`);
  const termsByContract = new Map(((termsResult.data ?? []) as Array<BillingTerms & { lease_contract_id: string }>).map((row) => [row.lease_contract_id, row as BillingTerms]));
  const termsOf = (contractId: string | null) => (contractId ? termsByContract.get(contractId) : undefined) ?? defaultBillingTerms;
  // 同じ入金期日の条件の請求書は、同じ入金期日パターンにまとめます。同じ条件の請求書は同じ入金期日パターンにまとめます。
  const duePatterns: DuePattern[] = [];
  const duePatternIdOf = (terms: BillingTerms) => {
    const id = `terms:${terms.due_month_offset}:${terms.due_day_of_month}:${terms.due_holiday_adjustment}`;
    if (!duePatterns.some((pattern) => pattern.billing_due_date_pattern_id === id)) duePatterns.push({ billing_due_date_pattern_id: id, pattern_number: duePatterns.length + 1, month_offset: terms.due_month_offset, day_of_month: terms.due_day_of_month, holiday_adjustment: terms.due_holiday_adjustment });
    return id;
  };
  const periodPatterns = (periodResult.data ?? []) as PeriodPattern[];
  // 検針日から決まる請求期間もあるため、検針データの検針日を使って期間を求めます。
  const meterData = meterResult.data;
  const meterNotice = meterResult.error ? `検針データを読み込めませんでした（公共料金は載っていません）: ${meterResult.error}` : '';
  const periodRangeByPattern = Object.fromEntries(periodPatterns.map((pattern) => [pattern.billing_period_pattern_id, periodRange(calendarYear, month, pattern, meterData?.meterDates)]));
  const contractUnits = (unitResult.data ?? []) as unknown as ContractUnit[]; const contractByUnit = new Map(contractUnits.map((unit) => [unit.lease_contract_unit_id, unit.lease_contract_id])); const unitIdBySource = new Map(contractUnits.map((unit) => [`${unit.lease_contract_id}:${firstOf(unit.unit)?.unit_code ?? ''}`, unit.lease_contract_unit_id])); const unitLabelById = new Map(contractUnits.map((unit) => [unit.lease_contract_unit_id, firstOf(unit.unit)?.unit_name || firstOf(unit.unit)?.unit_code || '区画名なし'])); const codeByContract = new Map<string, BillingCode>(); for (const allocation of (allocationResult.data ?? []) as ContractAllocation[]) { const contractId = contractByUnit.get(allocation.lease_contract_unit_id); const code = codeById.get(allocation.billing_code_id); if (contractId && code) codeByContract.set(contractId, code); }
  const typeNameById = new Map(((typeResult.data ?? []) as ChargeType[]).map((type) => [type.billing_charge_type_id, type.charge_type_name])); const assetItemById = new Map(((assetItemResult.data ?? []) as AssetLineItem[]).map((item) => [item.asset_billing_line_item_id, item])); const lineItemIdByChargeName = new Map<string, string>(); for (const item of (assetItemResult.data ?? []) as AssetLineItem[]) { const chargeName = typeNameById.get(item.billing_charge_type_id); if (chargeName && !lineItemIdByChargeName.has(chargeName)) lineItemIdByChargeName.set(chargeName, item.asset_billing_line_item_id); } const codeByTenantItem = new Map<string, BillingCode>(); for (const allocation of (lineAllocationResult.data ?? []) as unknown as LineItemAllocation[]) { const code = codeById.get(allocation.billing_code_id); const name = typeNameById.get(allocation.line_item?.billing_charge_type_id ?? ''); if (code && name && allocation.group?.tenant_id) codeByTenantItem.set(`${allocation.group.tenant_id}:${name}`, code); }
  const splitByCode = new Map(((splitResult.data ?? []) as unknown as InvoiceSplitSetting[]).map((setting) => [setting.billing_code_id, setting]));
  type Invoice = { contractTerms: BillingTerms[]; lineTerms: Map<string, BillingTerms>; code: string; tenantName: string; floor: string; displayName: string | null; subject: string | null; unitNames: Set<string>; lines: Map<string, number>; counts: Map<string, number>; meterLines: MeterLine[] };
  const invoices = new Map<string, Invoice>();
  for (const source of (rentRollResult.data ?? []) as RentRollSource[]) {
    if (!source.tenant_id || !source.tenant_name) continue;
    for (const item of fixedItems) {
      const amount = Number(source[item.field] ?? 0); if (!amount) continue;
      const itemName = lineItemName(source, item);
      const target = codeByTenantItem.get(`${source.tenant_id}:${itemName}`) ?? (source.lease_contract_id ? codeByContract.get(source.lease_contract_id) : undefined) ?? primaryCodeByTenant.get(source.tenant_id);
      const split = target ? splitByCode.get(target.billing_code_id) : undefined; const lineItemId = lineItemIdByChargeName.get(itemName); const splitAssignment = split?.assignments?.find((assignment) => assignment.asset_billing_line_item_id === lineItemId); const sourceUnitId = source.lease_contract_id ? unitIdBySource.get(`${source.lease_contract_id}:${source.unit_code}`) : undefined; const splitKey = split?.split_mode === 'unit' ? `unit:${splitAssignment?.lease_contract_unit_id ?? sourceUnitId ?? 'unassigned'}` : split?.split_mode === 'line_item' ? `invoice:${splitAssignment?.invoice_number ?? 1}` : 'single';
      const key = `${source.tenant_id}:${target?.billing_code_id ?? 'unassigned'}:${splitKey}`; const invoice = invoices.get(key) ?? { contractTerms: [], lineTerms: new Map<string, BillingTerms>(), code: target?.issue_code ?? '未採番', tenantName: source.tenant_name, floor: source.floor_label ?? '', displayName: target?.invoice_display_name ?? null, subject: target?.invoice_subject ?? null, unitNames: new Set<string>(), lines: new Map<string, number>(), counts: new Map<string, number>(), meterLines: [] };
      const assignedUnitLabel = split?.split_mode === 'unit' && splitAssignment?.lease_contract_unit_id ? unitLabelById.get(splitAssignment.lease_contract_unit_id) : null; invoice.unitNames.add(assignedUnitLabel ?? ([source.floor_label, source.unit_name ?? source.unit_code].filter(Boolean).join(' ') || source.unit_code)); const sourceTerms = termsOf(source.lease_contract_id); invoice.contractTerms.push(sourceTerms); if (!invoice.lineTerms.has(itemName)) invoice.lineTerms.set(itemName, sourceTerms); invoice.lines.set(itemName, (invoice.lines.get(itemName) ?? 0) + amount); if (countedItems.has(itemName)) invoice.counts.set(itemName, (invoice.counts.get(itemName) ?? 0) + 1); invoices.set(key, invoice);
    }
  }
  // 検針データの明細を、請求種別の割当と請求書分割設定に従って請求書へ振り分けます。
  for (const line of (meterData?.lines ?? []) as MeterInvoiceLine[]) {
    const assetItem = line.lineItemId ? assetItemById.get(line.lineItemId) : undefined;
    const chargeName = assetItem ? typeNameById.get(assetItem.billing_charge_type_id) : undefined;
    const target = (chargeName ? codeByTenantItem.get(`${line.tenantId}:${chargeName}`) : undefined) ?? primaryCodeByTenant.get(line.tenantId);
    const split = target ? splitByCode.get(target.billing_code_id) : undefined;
    const splitAssignment = split?.assignments?.find((assignment) => assignment.asset_billing_line_item_id === line.lineItemId);
    const prefix = `${line.tenantId}:${target?.billing_code_id ?? 'unassigned'}:`;
    let splitKey = 'single';
    if (split?.split_mode === 'line_item') splitKey = `invoice:${splitAssignment?.invoice_number ?? 1}`;
    else if (split?.split_mode === 'unit') {
      // 区画ごとに分けている場合、明細項目に区画の割当があればその区画、なければ検針データで選んだ「請求書 n」を
      // そのテナントの区画の請求書の n 番目（レントロールの順）に載せます。
      const unitKeys = [...invoices.keys()].filter((key) => key.startsWith(`${prefix}unit:`)).map((key) => key.slice(prefix.length));
      splitKey = splitAssignment?.lease_contract_unit_id ? `unit:${splitAssignment.lease_contract_unit_id}` : unitKeys[line.invoiceNo - 1] ?? unitKeys[0] ?? 'unit:unassigned';
    }
    const key = `${prefix}${splitKey}`;
    const invoice = invoices.get(key) ?? { contractTerms: [], lineTerms: new Map<string, BillingTerms>(), code: target?.issue_code ?? '未採番', tenantName: line.tenantName, floor: '', displayName: target?.invoice_display_name ?? null, subject: target?.invoice_subject ?? null, unitNames: new Set<string>(), lines: new Map<string, number>(), counts: new Map<string, number>(), meterLines: [] };
    // 明細の名前は、請求設定の明細項目名を使います。明細項目が未設定の小分類は小分類名のまま載せます。
    invoice.meterLines.push({ name: assetItem ? assetItem.display_name || assetItem.line_item_name : line.sourceName, chargeType: chargeName ?? '', usage: line.usage, unit: line.unit, unitPrice: line.unitPrice, amount: line.amount, periodPatternId: line.periodPatternId });
    invoices.set(key, invoice);
  }
  const periodPatternByRow: Record<string, string> = {};
  const rows: InvoiceRow[] = [];
  let invoiceNumber = 0;
  // 請求書は請求設定のテナント並び順で並べ、その順に請求書番号を振ります。同じテナントの請求書はレントロールの順のままです。
  const compareTenant = tenantComparator(orderTenants((rentRollResult.data ?? []) as RentRollSource[], savedOrder));
  const tenantOfKey = (key: string) => key.slice(0, key.indexOf(':'));
  const duePatternByInvoice: Record<string, string> = {};
  const mixedInvoices: string[] = [];
  const dueTime = (terms: BillingTerms) => { const [y, m, d] = termsDueDate(calendarYear, month, terms).split('/').map(Number); return new Date(y, m - 1, d).getTime(); };
  // 固定費の請求期間も請求条件から決めます（前月分・当月分・翌月分、年払いは請求月だけ1年分）。
  const termsPeriodIdOf = (terms: BillingTerms) => {
    const period = termsPeriod(month, terms);
    if (!period.billed) return null;
    const id = `terms-period:${period.startOffset}:${period.endOffset}`;
    if (!periodPatterns.some((pattern) => pattern.billing_period_pattern_id === id)) {
      const pattern = { billing_period_pattern_id: id, pattern_name: termsPeriodLabel(terms), start_month_offset: period.startOffset, start_day_type: 'first', start_meter_day_offset: 0, end_month_offset: period.endOffset, end_day_type: 'last', end_meter_day_offset: 0 };
      periodPatterns.push(pattern);
      periodRangeByPattern[id] = periodRange(calendarYear, month, pattern);
    }
    return { id, monthsCovered: period.monthsCovered };
  };
  for (const [invoiceKey, invoice] of [...invoices].sort(([left], [right]) => compareTenant(tenantOfKey(left), tenantOfKey(right)))) {
    invoiceNumber += 1;
    // 1通の請求書の契約は同じ条件の想定です。違う条件が混ざったときは、一番早い入金期日を使って警告を出します。
    const termsList = invoice.contractTerms.length ? invoice.contractTerms : [defaultBillingTerms];
    const dueTerms = termsList.reduce((earliest, terms) => dueTime(terms) < dueTime(earliest) ? terms : earliest);
    if (new Set(termsList.map(dueKey)).size > 1 || new Set(termsList.map(periodKey)).size > 1) mixedInvoices.push(`${invoice.code} ${invoice.displayName || invoice.tenantName}`);
    duePatternByInvoice[invoiceKey] = duePatternIdOf(dueTerms);
    // 固定費の明細のあとに、検針データの明細を続けます。金額はどちらも税抜です。
    const lineSpecs = [
      ...[...invoice.lines.entries()].map(([name, amount]) => { const count = invoice.counts.get(name) ?? 0; const fixedPeriod = termsPeriodIdOf(invoice.lineTerms.get(name) ?? dueTerms); return { id: name, name, chargeType: name, amount: fixedPeriod ? amount * fixedPeriod.monthsCovered : 0, quantity: count ? String(count) : '', unit: count ? '台' : '', unitPrice: '', periodPatternId: fixedPeriod?.id ?? '', blankPeriod: !fixedPeriod }; }),
      ...invoice.meterLines.map((line, index) => ({ id: `meter${index}:${line.name}`, name: line.name, chargeType: line.chargeType, amount: line.amount, quantity: line.usage === null ? '' : usageText.format(line.usage), unit: line.unit, unitPrice: line.unitPrice === null ? '' : unitPriceText.format(line.unitPrice), periodPatternId: line.periodPatternId, blankPeriod: false })),
    ];
    lineSpecs.forEach((line, index) => {
      const values = emptyValues();
      if (index === 0) { values[0] = String(invoiceNumber); values[1] = invoice.code; values[2] = invoice.displayName || invoice.tenantName; values[3] = invoice.subject || `${propertyName}${[...invoice.unitNames].join('・')} 御請求書`; values[4] = termsDueDate(calendarYear, month, dueTerms); }
      const rowId = `${invoiceKey}:${index}:${line.id}`;
      // 検針データの明細は、小分類で設定した請求期間パターンを最初から選んでおきます。
      const range = line.periodPatternId ? periodRangeByPattern[line.periodPatternId] : undefined;
      if (range) periodPatternByRow[rowId] = line.periodPatternId;
      // 年払いの請求月以外は0円で、明細項目1（請求期間）は空白にします。
      values[10] = line.blankPeriod ? '' : range ? periodText(range.start, range.end) || '未設定' : '未設定'; values[11] = line.name; values[12] = line.quantity; values[13] = line.unit; values[14] = line.unitPrice; values[15] = yen.format(line.amount); values[18] = '課税';
      rows.push({ id: rowId, invoiceKey, values, chargeType: line.chargeType, tenantId: tenantOfKey(invoiceKey), tenantName: invoice.tenantName, floor: invoice.floor });
    });
  }
  // 入金期限の欄は期日の早い順に並べます。
  duePatterns.sort((left, right) => dueTime({ due_month_offset: left.month_offset, due_day_of_month: left.day_of_month, due_holiday_adjustment: left.holiday_adjustment } as BillingTerms) - dueTime({ due_month_offset: right.month_offset, due_day_of_month: right.day_of_month, due_holiday_adjustment: right.holiday_adjustment } as BillingTerms));
  duePatterns.forEach((pattern, index) => { pattern.pattern_number = index + 1; });
  return {
    sheet: {
      rows: recalcInvoices(rows), duePatternByInvoice,
      dueDateByPattern: Object.fromEntries(duePatterns.map((pattern) => [pattern.billing_due_date_pattern_id, termsDueDate(calendarYear, month, { due_month_offset: pattern.month_offset, due_day_of_month: pattern.day_of_month, due_holiday_adjustment: pattern.holiday_adjustment })])), periodPatternByRow, periodRangeByPattern, invoiceNote: '', showInvoiceNote: false,
    },
    duePatterns, periodPatterns, meterNotice,
    termsNotice: mixedInvoices.length ? `入金期日・請求期間の条件が異なる契約が同じ請求書に含まれています（一番早い入金期日で作成しました。確認してください）: ${mixedInvoices.join('、')}` : '',
  };
}

// ---- 保存 ----
const monthStart = (calendarYear: number, month: number) => `${calendarYear}-${String(month).padStart(2, '0')}-01`;
export type SavedInvoiceSheet = { sheet: InvoiceSheet; savedAt: string };

export async function loadSavedInvoiceSheet(client: SupabaseClient, propertyId: string, calendarYear: number, month: number): Promise<SavedInvoiceSheet | null> {
  const { data, error } = await client.from('tenant_invoice_sheet').select('sheet, saved_at').eq('asset_id', propertyId).eq('billing_month', monthStart(calendarYear, month)).maybeSingle();
  if (error) throw new Error(`保存した請求書作成の内容を読み込めませんでした: ${error.message}`);
  if (!data) return null;
  const sheet = data.sheet as InvoiceSheet;
  // 保存した内容の金額は、明細から出し直してそろえます（保存時点の計算と同じ結果になります）。
  return { sheet: { ...sheet, rows: recalcInvoices(sheet.rows ?? []) }, savedAt: data.saved_at as string };
}

export async function saveInvoiceSheet(client: SupabaseClient, propertyId: string, calendarYear: number, month: number, sheet: InvoiceSheet): Promise<string> {
  const savedAt = new Date().toISOString();
  const { error } = await client.from('tenant_invoice_sheet').upsert({
    asset_id: propertyId, billing_month: monthStart(calendarYear, month), sheet: { ...sheet, rows: recalcInvoices(sheet.rows) }, saved_at: savedAt,
  }, { onConflict: 'asset_id,billing_month' });
  if (error) throw new Error(`請求書作成の内容を保存できませんでした: ${error.message}`);
  return savedAt;
}

// ---- 入金明細・請求明細 ----
// 請求書1通を明細の1行にします。請求種別ごとの金額は明細の金額を請求種別で合計し、税抜・消費税・税込は請求書の金額を使います。
export type StatementRow = {
  key: string; tenantId: string; code: string; floor: string; tenantName: string;
  amounts: Record<string, number>; subtotal: number; tax: number; total: number; dueDate: string;
};
export function statementRows(rows: InvoiceRow[]): StatementRow[] {
  const result = new Map<string, StatementRow>();
  for (const row of recalcInvoices(rows)) {
    let statement = result.get(row.invoiceKey);
    if (!statement) {
      statement = {
        key: row.invoiceKey, tenantId: row.tenantId, code: row.values[1], floor: row.floor, tenantName: row.values[2] || row.tenantName,
        amounts: {}, subtotal: numberValue(row.values[5]), tax: numberValue(row.values[6]), total: numberValue(row.values[7]), dueDate: row.values[4],
      };
      result.set(row.invoiceKey, statement);
    }
    const chargeType = row.chargeType ?? '';
    statement.amounts[chargeType] = (statement.amounts[chargeType] ?? 0) + numberValue(row.values[15]);
  }
  return [...result.values()];
}
