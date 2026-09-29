// 検針データの画面とSupabaseの間の読み書きです。
// 画面が扱う形（BuildingConfig／TenantConfig／AssetMeter）と、テーブルの行を相互に変換します。
//
// 保存は明示的な「保存」ボタンでまとめて行うため、読み込んだ時点のスナップショットを
// 覚えておき、保存時に「消えた行」を削除し、残っている行をupsertします。
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BuildingConfig, Category, CategoryId, ContractRow, PriceMode, RoundingMode, SubItem, SumMode, Surcharge, TaxMode, TenantConfig, TenantResult,
  SurchargePurchase, VariablePriceInput, VariablePriceMethod,
} from './meterReading';
import { calculateAll, emptySurchargePurchase, emptyVariablePrice, meterInvoiceLines, subItemDefaults, type MeterInvoiceLine } from './meterReading.ts';
import type { AssetMeter, InputMode, MeterBreak, Occupancy, Period, UnitAssignment, UnitOption } from './meterAllocation';
import { allocateMeters, basicRatios, monthFirst, occupancyRange, occupantsIn, readingPeriod, totalUsage } from './meterAllocation.ts';
import { loadSavedTenantOrder, orderTenants } from './tenantOrder.ts';

export type MeterReadingSnapshot = {
  building: BuildingConfig;
  tenants: TenantConfig[];
  meters: AssetMeter[];
  // 当月と前月の検針日です。前月の検針日は、検針期間（前回検針日の翌日から）を決めるのに使います。
  meterDate: string;
  previousMeterDate: string;
  status: 'draft' | 'confirmed';
  // 物件の区画と、前月1日から翌月末日までの日ごとの入居状況です。
  units: UnitOption[];
  occupancy: Occupancy;
  // 前月の当月指針（メーターごと）です。前月指針を手入力から自動に戻すときに使います。
  previousMonthReadings: Record<string, number>;
};

export const categoryIds: CategoryId[] = ['electric', 'water', 'gas'];
const categoryNames: Record<CategoryId, string> = { electric: '電気', water: '水道', gas: 'ガス' };
const defaultUnits: Record<CategoryId, string> = { electric: 'kWh', water: '㎥', gas: '㎥' };
// 消費税率です。税込単価を税抜へ戻すときに使います。
const taxRate = 0.1;

export const newId = () => crypto.randomUUID();
const monthStart = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}-01`;
export const previousMonthOf = (year: number, month: number) => {
  const date = new Date(year, month - 2, 1);
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
};
const numberOrNull = (value: unknown) => value === null || value === undefined || value === '' ? null : Number(value);

type CategorySettingRow = { asset_id: string; category: CategoryId; usage_unit: string; is_billable: boolean; is_basic_billable: boolean };
type SubItemRow = {
  asset_meter_sub_item_id: string; asset_id: string; category: CategoryId; sub_item_name: string; sub_item_kind: 'basic' | 'custom';
  asset_billing_line_item_id: string | null; price_mode: PriceMode; default_unit_price: number | null; tax_mode: TaxMode;
  tax_rounding_mode: RoundingMode; usage_rounding_digits: number; usage_rounding_mode: RoundingMode; usage_display_digits: number;
  billing_period_pattern_id: string | null; sort_order: number;
  variable_price_method: VariablePriceMethod; unit_price_rounding_digits: number; unit_price_rounding_mode: RoundingMode;
  show_unit_price_on_invoice: boolean; input_mode: InputMode | null;
};
type MonthSubItemRow = {
  asset_meter_sub_item_id: string; unit_price: number | null;
  billed_inclusive: number | null; billed_tax: number | null; billed_exclusive: number | null; billed_usage: number | null;
};
type SurchargeRow = { asset_meter_surcharge_id: string; asset_id: string; category: CategoryId; surcharge_name: string; asset_billing_line_item_id: string | null; is_billable: boolean; billing_period_pattern_id: string | null };
type ContractRowRecord = {
  meter_reading_contract_id: string; asset_id: string; tenant_id: string; row_no: number; invoice_number: number;
  electric_billable: boolean; water_billable: boolean; gas_billable: boolean;
  electric_sum_mode: SumMode; water_sum_mode: SumMode; gas_sum_mode: SumMode;
  amount_rounding_mode: RoundingMode; note: string | null; split_label: string | null;
};
type ContractItemRow = { meter_reading_contract_id: string; asset_meter_sub_item_id: string; is_billable: boolean; unit_price: number | null; fixed_amount: number | null };
type MeterRow = { asset_meter_id: string; asset_id: string; asset_meter_sub_item_id: string; meter_code: string; meter_label: string | null; unit_price_override: number | null; is_active: boolean };
type AssignmentRow = { asset_meter_unit_assignment_id: string; asset_meter_id: string; unit_id: string; effective_from: string; effective_to: string | null };
type BreakRow = { asset_meter_id: string; break_date: string; reading: number | null; usage_amount: number | null };
type OccupancyRow = { occupancy_date: string; unit_id: string; unit_type: string; tenant_id: string; tenant_name: string };
type UnitRow = { unit_id: string; unit_code: string; unit_name: string | null; floor_label: string | null; unit_type: string };
type MonthRow = { asset_id: string; billing_month: string; meter_date: string | null; status: 'draft' | 'confirmed' };
type MonthSurchargeRow = {
  asset_id: string; billing_month: string; asset_meter_surcharge_id: string; unit_price: number;
  purchase_period_start: string | null; purchase_period_end: string | null; purchase_amount_inclusive: number | null; purchase_usage: number | null;
};
type EntryRow = {
  asset_id: string; billing_month: string; asset_meter_id: string; usage_amount: number;
  previous_reading: number | null; current_reading: number | null; previous_reading_manual: boolean | null;
  exchange_removed_reading: number | null; exchange_installed_reading: number | null;
};
type RentRollRow = { tenant_id: string | null; tenant_name: string | null; unit_id: string | null; unit_type: string | null; floor_label: string | null; unit_name: string | null; unit_code: string | null };

// 検針の対象になる貸室の区画種別です。駐車場・駐輪場・アンテナなどだけを契約しているテナントは出しません。
const roomUnitTypes = new Set(['office', 'residential', 'warehouse']);
// メーターを付けられる区画です。駐車場などの区画は選択肢に出しません。
const meterUnitExcluded = new Set(['parking', 'bicycle_parking', 'antenna', 'signage']);

const firstError = (...results: Array<{ error: { message: string } | null }>) => results.find((row) => row.error)?.error ?? null;

// 物件のテナントを、請求設定のテナント並び順（未設定ならレントロールの階順）で取り出します。
// 同じテナントが複数区画を契約している場合は1件にまとめます。貸室の契約があるテナントだけを対象にします。
async function loadTenantList(client: SupabaseClient, assetId: string, asOfDate: string) {
  const [{ data, error }, saved] = await Promise.all([
    client.rpc('rent_roll_list_with_terms_at_date', { p_property_id: assetId, p_as_of_date: asOfDate }),
    loadSavedTenantOrder(client, assetId),
  ]);
  if (error) throw new Error(`テナントを読み込めませんでした: ${error.message}`);
  const rows = (data ?? []) as RentRollRow[];
  const found = new Map<string, string>();
  for (const row of rows) {
    if (row.tenant_id && row.tenant_name && roomUnitTypes.has(row.unit_type ?? '') && !found.has(row.tenant_id)) found.set(row.tenant_id, row.tenant_name);
  }
  return orderTenants(rows, saved).filter((id) => found.has(id)).map((id) => ({ id, name: found.get(id)! }));
}

export async function loadMeterReading(client: SupabaseClient, assetId: string, year: number, month: number): Promise<MeterReadingSnapshot> {
  const billingMonth = monthStart(year, month);
  const previous = previousMonthOf(year, month);
  const previousMonth = monthStart(previous.year, previous.month);
  const range = occupancyRange(year, month);

  const tenantList = await loadTenantList(client, assetId, billingMonth);

  const [settingResult, subItemResult, surchargeResult, contractResult, meterResult, monthResult, monthSurchargeResult, entryResult, splitResult, monthSubItemResult, assignmentResult, breakResult, occupancyResult, unitResult] = await Promise.all([
    client.from('asset_meter_category_setting').select('asset_id, category, usage_unit, is_billable, is_basic_billable').eq('asset_id', assetId),
    client.from('asset_meter_sub_item').select('asset_meter_sub_item_id, asset_id, category, sub_item_name, sub_item_kind, asset_billing_line_item_id, price_mode, default_unit_price, tax_mode, tax_rounding_mode, usage_rounding_digits, usage_rounding_mode, usage_display_digits, billing_period_pattern_id, sort_order, variable_price_method, unit_price_rounding_digits, unit_price_rounding_mode, show_unit_price_on_invoice, input_mode').eq('asset_id', assetId).order('sort_order'),
    client.from('asset_meter_surcharge').select('asset_meter_surcharge_id, asset_id, category, surcharge_name, asset_billing_line_item_id, is_billable, billing_period_pattern_id').eq('asset_id', assetId).order('surcharge_name'),
    client.from('meter_reading_contract').select('meter_reading_contract_id, asset_id, tenant_id, row_no, invoice_number, electric_billable, water_billable, gas_billable, electric_sum_mode, water_sum_mode, gas_sum_mode, amount_rounding_mode, note, split_label').eq('asset_id', assetId).order('row_no'),
    client.from('asset_meter').select('asset_meter_id, asset_id, asset_meter_sub_item_id, meter_code, meter_label, unit_price_override, is_active').eq('asset_id', assetId).order('sort_order').order('meter_code'),
    client.from('meter_reading_month').select('asset_id, billing_month, meter_date, status').eq('asset_id', assetId).in('billing_month', [billingMonth, previousMonth]),
    client.from('meter_reading_month_surcharge').select('asset_id, billing_month, asset_meter_surcharge_id, unit_price, purchase_period_start, purchase_period_end, purchase_amount_inclusive, purchase_usage').eq('asset_id', assetId).eq('billing_month', billingMonth),
    // 前月の当月指針を今月の前月指針として使うため、前月分もあわせて読みます。
    client.from('meter_reading_entry').select('asset_id, billing_month, asset_meter_id, usage_amount, previous_reading, current_reading, previous_reading_manual, exchange_removed_reading, exchange_installed_reading').eq('asset_id', assetId).in('billing_month', [billingMonth, previousMonth]),
    client.from('billing_invoice_split_setting').select('split_mode, code:billing_code!inner(tenant_id)').eq('asset_id', assetId).eq('split_mode', 'unit'),
    client.from('meter_reading_month_sub_item').select('asset_meter_sub_item_id, unit_price, billed_inclusive, billed_tax, billed_exclusive, billed_usage').eq('asset_id', assetId).eq('billing_month', billingMonth),
    client.from('asset_meter_unit_assignment').select('asset_meter_unit_assignment_id, asset_meter_id, unit_id, effective_from, effective_to, meter:asset_meter!inner(asset_id)').eq('meter.asset_id', assetId).order('effective_from'),
    client.from('meter_reading_break').select('asset_meter_id, break_date, reading, usage_amount').eq('asset_id', assetId).eq('billing_month', billingMonth).order('break_date'),
    client.rpc('meter_unit_occupancy', { p_property_id: assetId, p_from: range.start, p_to: range.end }),
    client.from('unit_master').select('unit_id, unit_code, unit_name, floor_label, unit_type').eq('property_id', assetId).eq('is_active', true).order('floor_label').order('unit_code'),
  ]);

  const failed = firstError(settingResult, subItemResult, surchargeResult, contractResult, meterResult, monthResult, monthSurchargeResult, entryResult, splitResult, monthSubItemResult, assignmentResult, breakResult, occupancyResult, unitResult);
  if (failed) throw new Error(`検針データを読み込めませんでした: ${failed.message}`);

  const settingRows = (settingResult.data ?? []) as CategorySettingRow[];
  const subItemRows = (subItemResult.data ?? []) as SubItemRow[];
  const surchargeRows = (surchargeResult.data ?? []) as SurchargeRow[];
  const contractRows = (contractResult.data ?? []) as ContractRowRecord[];
  const meterRows = (meterResult.data ?? []) as MeterRow[];
  const monthRows = (monthResult.data ?? []) as MonthRow[];
  const monthSurchargeRows = (monthSurchargeResult.data ?? []) as MonthSurchargeRow[];
  const allEntryRows = (entryResult.data ?? []) as EntryRow[];
  const entryRows = allEntryRows.filter((row) => row.billing_month === billingMonth);
  const previousEntryRows = allEntryRows.filter((row) => row.billing_month === previousMonth);

  // 契約行の小分類設定・分割行の区画は、契約行が決まってからでないと引けません。
  const contractIds = contractRows.map((row) => row.meter_reading_contract_id);
  let contractItemRows: ContractItemRow[] = [];
  const unitIdsByContract = new Map<string, string[]>();
  if (contractIds.length) {
    const [itemResult, contractUnitResult] = await Promise.all([
      client.from('meter_reading_contract_item').select('meter_reading_contract_id, asset_meter_sub_item_id, is_billable, unit_price, fixed_amount').in('meter_reading_contract_id', contractIds),
      client.from('meter_reading_contract_unit').select('meter_reading_contract_id, unit_id').in('meter_reading_contract_id', contractIds),
    ]);
    if (itemResult.error) throw new Error(`契約行の設定を読み込めませんでした: ${itemResult.error.message}`);
    if (contractUnitResult.error) throw new Error(`分割行の区画を読み込めませんでした: ${contractUnitResult.error.message}`);
    contractItemRows = (itemResult.data ?? []) as ContractItemRow[];
    for (const row of (contractUnitResult.data ?? []) as Array<{ meter_reading_contract_id: string; unit_id: string }>) {
      unitIdsByContract.set(row.meter_reading_contract_id, [...(unitIdsByContract.get(row.meter_reading_contract_id) ?? []), row.unit_id]);
    }
  }

  // 分類・基本料・増額分は分類ごとに1つずつ必ず必要なので、未登録なら画面上で作ります。
  // 新しい行はここでidを採番しておき、保存時にそのままinsertできるようにします。
  const categories: Category[] = categoryIds.map((id) => {
    const found = settingRows.find((row) => row.category === id);
    return { id, name: categoryNames[id], unit: found?.usage_unit ?? defaultUnits[id], billable: found?.is_billable ?? true, fixedBillable: found?.is_basic_billable ?? false };
  });

  const monthlyBySubItem = new Map(((monthSubItemResult.data ?? []) as MonthSubItemRow[]).map((row): [string, VariablePriceInput] => [row.asset_meter_sub_item_id, {
    unitPrice: numberOrNull(row.unit_price), billedInclusive: numberOrNull(row.billed_inclusive), billedTax: numberOrNull(row.billed_tax),
    billedExclusive: numberOrNull(row.billed_exclusive), billedUsage: numberOrNull(row.billed_usage),
  }]));
  const subItems: SubItem[] = [];
  for (const id of categoryIds) {
    const own = subItemRows.filter((row) => row.category === id);
    if (!own.some((row) => row.sub_item_kind === 'basic')) {
      subItems.push({ id: newId(), categoryId: id, name: '基本料', kind: 'basic', lineItemId: '', priceMode: 'fixed', defaultUnitPrice: null, taxMode: 'exclusive', taxRoundingMode: 'floor', usageRoundingDigits: 1, usageDisplayDigits: 1, usageRoundingMode: 'round', periodPatternId: '', ...subItemDefaults() });
    }
    for (const row of own) {
      subItems.push({
        id: row.asset_meter_sub_item_id, categoryId: row.category, name: row.sub_item_name, kind: row.sub_item_kind,
        lineItemId: row.asset_billing_line_item_id ?? '', priceMode: row.price_mode, defaultUnitPrice: row.default_unit_price,
        taxMode: row.tax_mode, taxRoundingMode: row.tax_rounding_mode,
        usageRoundingDigits: row.usage_rounding_digits, usageRoundingMode: row.usage_rounding_mode, usageDisplayDigits: row.usage_display_digits,
        periodPatternId: row.billing_period_pattern_id ?? '',
        variablePriceMethod: row.variable_price_method, unitPriceRoundingDigits: row.unit_price_rounding_digits, unitPriceRoundingMode: row.unit_price_rounding_mode,
        monthly: monthlyBySubItem.get(row.asset_meter_sub_item_id) ?? emptyVariablePrice(),
        showUnitPriceOnInvoice: row.show_unit_price_on_invoice,
        inputMode: row.input_mode ?? 'usage',
      });
    }
  }
  // 基本料が先、その後は登録順に並べます。
  subItems.sort((left, right) => categoryIds.indexOf(left.categoryId) - categoryIds.indexOf(right.categoryId) || (left.kind === right.kind ? 0 : left.kind === 'basic' ? -1 : 1));

  const monthBySurcharge = new Map(monthSurchargeRows.map((row) => [row.asset_meter_surcharge_id, row]));
  const purchaseOf = (row: MonthSurchargeRow | undefined): SurchargePurchase => row ? {
    periodStart: row.purchase_period_start ?? '', periodEnd: row.purchase_period_end ?? '',
    amountInclusive: numberOrNull(row.purchase_amount_inclusive), usage: numberOrNull(row.purchase_usage),
  } : emptySurchargePurchase();
  const surcharges: Surcharge[] = [];
  for (const id of categoryIds) {
    const own = surchargeRows.filter((row) => row.category === id);
    if (!own.length) {
      surcharges.push({ id: newId(), name: `${categoryNames[id]}増額分`, categoryId: id, unitPrice: 0, lineItemId: '', billable: false, purchase: emptySurchargePurchase(), periodPatternId: '' });
      continue;
    }
    for (const row of own) {
      const month = monthBySurcharge.get(row.asset_meter_surcharge_id);
      surcharges.push({ id: row.asset_meter_surcharge_id, name: row.surcharge_name, categoryId: row.category, unitPrice: month ? Number(month.unit_price) : 0, lineItemId: row.asset_billing_line_item_id ?? '', billable: row.is_billable, purchase: purchaseOf(month), periodPatternId: row.billing_period_pattern_id ?? '' });
    }
  }

  const splitTenants = new Set<string>();
  for (const row of (splitResult.data ?? []) as Array<{ code: { tenant_id: string | null } | Array<{ tenant_id: string | null }> | null }>) {
    const code = Array.isArray(row.code) ? row.code[0] : row.code;
    if (code?.tenant_id) splitTenants.add(code.tenant_id);
  }

  const itemsByContract = new Map<string, ContractItemRow[]>();
  for (const row of contractItemRows) itemsByContract.set(row.meter_reading_contract_id, [...(itemsByContract.get(row.meter_reading_contract_id) ?? []), row]);

  const toContractRow = (record: ContractRowRecord): ContractRow => {
    const items = itemsByContract.get(record.meter_reading_contract_id) ?? [];
    const billable: Record<string, boolean> = {};
    const unitPrices: Record<string, number | null> = {};
    const fixedCharges: Record<string, number> = {};
    for (const subItem of subItems) {
      const found = items.find((row) => row.asset_meter_sub_item_id === subItem.id);
      // 未登録の小分類は、基本料以外は請求する扱いにします。
      billable[subItem.id] = found ? found.is_billable : subItem.kind !== 'basic';
      unitPrices[subItem.id] = found ? numberOrNull(found.unit_price) : null;
      if (found?.fixed_amount !== null && found?.fixed_amount !== undefined) fixedCharges[subItem.id] = Number(found.fixed_amount);
    }
    return {
      id: record.meter_reading_contract_id, invoiceNo: record.invoice_number,
      categoryBillable: { electric: record.electric_billable, water: record.water_billable, gas: record.gas_billable },
      billable, unitPrices, fixedCharges,
      sumMode: { electric: record.electric_sum_mode, water: record.water_sum_mode, gas: record.gas_sum_mode },
      amountRoundingMode: record.amount_rounding_mode, note: record.note ?? '', splitLabel: record.split_label ?? '',
      unitIds: unitIdsByContract.get(record.meter_reading_contract_id) ?? [],
    };
  };

  // メーターです。設置区画の履歴と、対象月の検針値（指針・中間検針）をまとめます。
  const assignmentsByMeter = new Map<string, UnitAssignment[]>();
  for (const row of (assignmentResult.data ?? []) as unknown as AssignmentRow[]) {
    assignmentsByMeter.set(row.asset_meter_id, [...(assignmentsByMeter.get(row.asset_meter_id) ?? []), { id: row.asset_meter_unit_assignment_id, unitId: row.unit_id, from: row.effective_from, to: row.effective_to }]);
  }
  const breaksByMeter = new Map<string, MeterBreak[]>();
  for (const row of (breakResult.data ?? []) as BreakRow[]) {
    breaksByMeter.set(row.asset_meter_id, [...(breaksByMeter.get(row.asset_meter_id) ?? []), { date: row.break_date, reading: numberOrNull(row.reading), usage: numberOrNull(row.usage_amount) }]);
  }
  const entryByMeter = new Map(entryRows.map((row) => [row.asset_meter_id, row]));
  const previousReadingByMeter = new Map(previousEntryRows.filter((row) => row.current_reading !== null).map((row) => [row.asset_meter_id, Number(row.current_reading)]));
  const meters: AssetMeter[] = meterRows.filter((row) => row.is_active).map((row) => {
    const entry = entryByMeter.get(row.asset_meter_id);
    const unitPrice = numberOrNull(row.unit_price_override);
    const manual = entry?.previous_reading_manual ?? false;
    const removed = numberOrNull(entry?.exchange_removed_reading);
    const installed = numberOrNull(entry?.exchange_installed_reading);
    return {
      id: row.asset_meter_id, subItemId: row.asset_meter_sub_item_id, code: row.meter_code, label: row.meter_label ?? '',
      ...(unitPrice === null ? {} : { unitPrice }),
      assignments: assignmentsByMeter.get(row.asset_meter_id) ?? [],
      usage: entry ? Number(entry.usage_amount) : 0,
      // 前月指針は、手入力していなければ前月の当月指針を使います。
      previousReading: manual ? numberOrNull(entry?.previous_reading) : previousReadingByMeter.get(row.asset_meter_id) ?? numberOrNull(entry?.previous_reading),
      currentReading: numberOrNull(entry?.current_reading),
      previousReadingManual: manual,
      exchange: removed === null && installed === null ? null : { removedReading: removed, installedReading: installed },
      breaks: breaksByMeter.get(row.asset_meter_id) ?? [],
    };
  });

  const occupancy: Occupancy = new Map();
  for (const row of (occupancyResult.data ?? []) as OccupancyRow[]) {
    const day = occupancy.get(row.occupancy_date) ?? new Map();
    day.set(row.unit_id, { tenantId: row.tenant_id, tenantName: row.tenant_name, unitType: row.unit_type });
    occupancy.set(row.occupancy_date, day);
  }
  const units: UnitOption[] = ((unitResult.data ?? []) as UnitRow[]).filter((row) => !meterUnitExcluded.has(row.unit_type))
    .map((row) => ({ id: row.unit_id, code: row.unit_code, name: row.unit_name ?? '', floor: row.floor_label ?? '', type: row.unit_type }));

  const currentMonth = monthRows.find((row) => row.billing_month === billingMonth);
  const previousRow = monthRows.find((row) => row.billing_month === previousMonth);
  const meterDate = currentMonth?.meter_date ?? '';
  const previousMeterDate = previousRow?.meter_date ?? '';

  // テナントは、請求月の1日時点の入居テナントに、検針期間中に入居・退去したテナントを加えます。
  const period = readingPeriod(year, month, meterDate, previousMeterDate);
  const listed = new Set(tenantList.map((row) => row.id));
  const allTenants = [...tenantList, ...occupantsIn(occupancy, period).filter((row) => !listed.has(row.id))];
  const tenants: TenantConfig[] = allTenants.map(({ id, name }) => {
    const own = contractRows.filter((row) => row.tenant_id === id).sort((left, right) => left.row_no - right.row_no);
    return tenantConfig(id, name, own.length ? own.map(toContractRow) : [emptyContractRow(subItems)], splitTenants.has(id));
  });

  return {
    building: { categories, subItems, surcharges, taxRate },
    tenants, meters, meterDate, previousMeterDate,
    status: currentMonth?.status ?? 'draft',
    units, occupancy,
    previousMonthReadings: Object.fromEntries(previousReadingByMeter),
  };
}

export const emptyContractRow = (subItems: SubItem[]): ContractRow => ({
  id: newId(), invoiceNo: 1,
  categoryBillable: { electric: true, water: true, gas: true },
  billable: Object.fromEntries(subItems.map((row) => [row.id, row.kind !== 'basic'])),
  unitPrices: Object.fromEntries(subItems.map((row) => [row.id, null])),
  fixedCharges: {},
  sumMode: { electric: 'aggregate', water: 'aggregate', gas: 'aggregate' },
  amountRoundingMode: 'floor', note: '', splitLabel: '', unitIds: [],
});
// 元表との突き合わせはサンプルデータのときだけ使う項目なので、実データでは0にしています。
const tenantConfig = (id: string, name: string, rows: ContractRow[], invoiceSplitByUnit: boolean): TenantConfig =>
  ({ id, name, splitEnabled: rows.length > 1, rows, invoiceSplitByUnit, expected: 0 });

// 対象月の計算です。メーターを区間ごとに入居テナントへ振り分け、基本料を日割りして金額を出します。
// 中間検針の区切りで、テナント一覧に居ないテナント（期間中に退去・入居したテナント）が出てきた場合は、
// 空の契約行で一覧に加えます（tenants として返すので、画面はそれを一覧に取り込みます）。
export type MonthInput = Pick<MeterReadingSnapshot, 'building' | 'tenants' | 'meters' | 'meterDate' | 'previousMeterDate' | 'occupancy'>;
export function computeMonth(input: MonthInput, year: number, month: number) {
  const period: Period = readingPeriod(year, month, input.meterDate, input.previousMeterDate);
  const billingFirst = monthFirst(year, month);
  const modeOf = (subItemId: string): InputMode => input.building.subItems.find((row) => row.id === subItemId)?.inputMode ?? 'usage';
  let tenants = input.tenants;
  let allocated = allocateMeters(input.meters, modeOf, tenants, input.occupancy, period, billingFirst);
  const known = new Set(tenants.map((row) => row.id));
  const missing = new Map<string, string>();
  for (const allocation of allocated.allocations) for (const segment of allocation.segments) if (segment.tenantId && !known.has(segment.tenantId)) missing.set(segment.tenantId, segment.tenantName);
  if (missing.size) {
    tenants = [...tenants, ...[...missing].map(([id, name]) => tenantConfig(id, name, [emptyContractRow(input.building.subItems)], false))];
    allocated = allocateMeters(input.meters, modeOf, tenants, input.occupancy, period, billingFirst);
  }
  const ratios = basicRatios(tenants, input.occupancy, period);
  const calculated = calculateAll(tenants, input.building, allocated.shares, ratios);
  return { ...calculated, tenants, period, shares: allocated.shares, allocations: allocated.allocations, ratios };
}

const removedIds = (base: string[], next: string[]) => { const keep = new Set(next); return base.filter((id) => !keep.has(id)); };

// メーター番号は小分類の中で一意です（uq_asset_meter_code）。空欄や重複のまま保存すると
// DBの一意制約エラーになり、途中まで書き込まれた状態で止まるため、書き込む前に確かめます。
export function meterCodeProblems(meters: Array<Pick<AssetMeter, 'subItemId' | 'code'>>, subItems: SubItem[]): string[] {
  const nameOf = (id: string) => subItems.find((row) => row.id === id)?.name ?? '小分類';
  const problems: string[] = [];
  const blank = new Map<string, number>();
  const seen = new Map<string, Map<string, number>>();
  for (const meter of meters) {
    const code = meter.code.trim();
    if (!code) { blank.set(meter.subItemId, (blank.get(meter.subItemId) ?? 0) + 1); continue; }
    const codes = seen.get(meter.subItemId) ?? new Map<string, number>();
    codes.set(code, (codes.get(code) ?? 0) + 1);
    seen.set(meter.subItemId, codes);
  }
  for (const [subItemId, count] of blank) problems.push(`${nameOf(subItemId)}：メーター番号が未入力のメーターが${count}件あります`);
  for (const [subItemId, codes] of seen) {
    for (const [code, count] of codes) if (count > 1) problems.push(`${nameOf(subItemId)}：メーター番号「${code}」が${count}件重複しています`);
  }
  return problems;
}

// 中間検針は、同じメーターで同じ日付を2回入れると一意制約エラーになるため、書き込む前に確かめます。
export function breakProblems(meters: AssetMeter[]): string[] {
  return meters.flatMap((meter) => {
    const dates = meter.breaks.map((row) => row.date).filter(Boolean);
    return new Set(dates).size !== dates.length ? [`メーター「${meter.code}」：中間検針の日付が重複しています`] : [];
  });
}

export async function saveMeterReading(
  client: SupabaseClient, assetId: string, year: number, month: number,
  next: MeterReadingSnapshot, base: MeterReadingSnapshot,
) {
  const problems = meterCodeProblems(next.meters, next.building.subItems);
  if (problems.length) throw new Error(`メーター番号を確認してください。${problems.join('／')}`);
  const duplicated = breakProblems(next.meters);
  if (duplicated.length) throw new Error(duplicated.join('／'));
  const billingMonth = monthStart(year, month);
  const check = (result: { error: { message: string } | null }, label: string) => { if (result.error) throw new Error(`${label}を保存できませんでした: ${result.error.message}`); };
  const modeOf = (subItemId: string): InputMode => next.building.subItems.find((row) => row.id === subItemId)?.inputMode ?? 'usage';

  // 1. 分類の設定
  check(await client.from('asset_meter_category_setting').upsert(next.building.categories.map((row) => ({
    asset_id: assetId, category: row.id, usage_unit: row.unit, is_billable: row.billable, is_basic_billable: row.fixedBillable,
  })), { onConflict: 'asset_id,category' }), '分類の設定');

  // 2. 小分類（消えたものを先に消してから、順番つきで入れ直します）
  const goneSubItems = removedIds(base.building.subItems.map((row) => row.id), next.building.subItems.map((row) => row.id));
  if (goneSubItems.length) check(await client.from('asset_meter_sub_item').delete().in('asset_meter_sub_item_id', goneSubItems), '小分類');
  const sortOrders = new Map<CategoryId, number>();
  check(await client.from('asset_meter_sub_item').upsert(next.building.subItems.map((row) => {
    const order = sortOrders.get(row.categoryId) ?? 0;
    sortOrders.set(row.categoryId, order + 1);
    return {
      asset_meter_sub_item_id: row.id, asset_id: assetId, category: row.categoryId, sub_item_name: row.name, sub_item_kind: row.kind,
      asset_billing_line_item_id: row.lineItemId || null,
      // 基本料は固定額で請求するため、単価は持ちません。
      price_mode: row.kind === 'basic' ? 'fixed' : row.priceMode,
      default_unit_price: row.kind === 'basic' ? null : row.defaultUnitPrice,
      tax_mode: row.taxMode, tax_rounding_mode: row.taxRoundingMode,
      usage_rounding_digits: row.usageRoundingDigits, usage_rounding_mode: row.usageRoundingMode, usage_display_digits: row.usageDisplayDigits,
      billing_period_pattern_id: row.periodPatternId || null, sort_order: order,
      variable_price_method: row.variablePriceMethod,
      unit_price_rounding_digits: row.unitPriceRoundingDigits, unit_price_rounding_mode: row.unitPriceRoundingMode,
      show_unit_price_on_invoice: row.showUnitPriceOnInvoice,
      input_mode: row.kind === 'basic' ? 'usage' : row.inputMode,
    };
  })), '小分類');

  // 3. 増額分（単価は月ごとなので、単価だけ月次テーブルへ入れます）
  check(await client.from('asset_meter_surcharge').upsert(next.building.surcharges.map((row) => ({
    asset_meter_surcharge_id: row.id, asset_id: assetId, category: row.categoryId, surcharge_name: row.name,
    asset_billing_line_item_id: row.lineItemId || null, is_billable: row.billable,
    billing_period_pattern_id: row.periodPatternId || null,
  })), { onConflict: 'asset_meter_surcharge_id' }), '増額分');

  // 4. 契約行
  const baseContracts = base.tenants.flatMap((tenant) => tenant.rows.map((row) => row.id));
  const nextContracts = next.tenants.flatMap((tenant) => tenant.rows.map((row) => row.id));
  const goneContracts = removedIds(baseContracts, nextContracts);
  if (goneContracts.length) check(await client.from('meter_reading_contract').delete().in('meter_reading_contract_id', goneContracts), '契約行');
  check(await client.from('meter_reading_contract').upsert(next.tenants.flatMap((tenant) => tenant.rows.map((row, index) => ({
    meter_reading_contract_id: row.id, asset_id: assetId, tenant_id: tenant.id, row_no: index + 1,
    invoice_number: tenant.invoiceSplitByUnit ? row.invoiceNo : 1,
    electric_billable: row.categoryBillable.electric, water_billable: row.categoryBillable.water, gas_billable: row.categoryBillable.gas,
    electric_sum_mode: row.sumMode.electric, water_sum_mode: row.sumMode.water, gas_sum_mode: row.sumMode.gas,
    amount_rounding_mode: row.amountRoundingMode, note: row.note || null,
    // 分割していない行は識別名を持ちません。
    split_label: tenant.rows.length > 1 ? row.splitLabel.trim() || null : null,
  })))), '契約行');

  // 分割行の区画です。入れ直します。分割していないテナントは1行目だけなので持ちません。
  if (nextContracts.length) check(await client.from('meter_reading_contract_unit').delete().in('meter_reading_contract_id', nextContracts), '分割行の区画');
  const contractUnits = next.tenants.filter((tenant) => tenant.rows.length > 1)
    .flatMap((tenant) => tenant.rows.flatMap((row) => [...new Set(row.unitIds)].map((unitId) => ({ meter_reading_contract_id: row.id, unit_id: unitId }))));
  if (contractUnits.length) check(await client.from('meter_reading_contract_unit').insert(contractUnits), '分割行の区画');

  // 5. 契約行ごとの小分類設定
  const subItemIds = new Set(next.building.subItems.map((row) => row.id));
  check(await client.from('meter_reading_contract_item').upsert(next.tenants.flatMap((tenant) => tenant.rows.flatMap((row) =>
    next.building.subItems.map((subItem) => ({
      meter_reading_contract_id: row.id, asset_meter_sub_item_id: subItem.id,
      is_billable: row.billable[subItem.id] ?? false,
      unit_price: subItem.kind === 'basic' ? null : row.unitPrices[subItem.id] ?? null,
      fixed_amount: subItem.kind === 'basic' ? row.fixedCharges[subItem.id] ?? null : null,
    })),
  ))), '契約行の小分類設定');

  // 6. メーター（小分類ごと削除はカスケードで消えるため、残っているものだけ整理します）
  const goneMeters = removedIds(base.meters.filter((row) => subItemIds.has(row.subItemId)).map((row) => row.id), next.meters.map((row) => row.id));
  if (goneMeters.length) check(await client.from('asset_meter').delete().in('asset_meter_id', goneMeters), 'メーター');
  if (next.meters.length) check(await client.from('asset_meter').upsert(next.meters.map((row, index) => ({
    asset_meter_id: row.id, asset_id: assetId, asset_meter_sub_item_id: row.subItemId, meter_code: row.code.trim(), meter_label: row.label || null,
    unit_price_override: row.unitPrice ?? null, is_active: true,
    // 画面に並んでいる順番をそのまま残します。
    sort_order: index,
  }))), 'メーター');

  // メーターの設置区画（履歴）です。消えた紐づけを先に消してから入れ直します（適用開始日の一意制約のため）。
  const liveMeters = new Set(next.meters.map((row) => row.id));
  const goneAssignments = removedIds(
    base.meters.filter((row) => liveMeters.has(row.id)).flatMap((row) => row.assignments.map((item) => item.id)),
    next.meters.flatMap((row) => row.assignments.map((item) => item.id)),
  );
  if (goneAssignments.length) check(await client.from('asset_meter_unit_assignment').delete().in('asset_meter_unit_assignment_id', goneAssignments), 'メーターの区画');
  const assignments = next.meters.flatMap((row) => row.assignments.map((item) => ({
    asset_meter_unit_assignment_id: item.id, asset_meter_id: row.id, unit_id: item.unitId, effective_from: item.from, effective_to: item.to,
  })));
  if (assignments.length) check(await client.from('asset_meter_unit_assignment').upsert(assignments), 'メーターの区画');

  // 7. 月次のヘッダーは、検針値と増額分の単価より先に作ります（参照先になるため）。
  check(await client.from('meter_reading_month').upsert({
    asset_id: assetId, billing_month: billingMonth, meter_date: next.meterDate || null, status: next.status,
  }, { onConflict: 'asset_id,billing_month' }), '検針日');

  // 仕入の請求金額を入れた増額分は、増額分タブで算出した単価を保存します。
  const effectiveSurcharges = computeMonth(next, year, month).building.surcharges;
  check(await client.from('meter_reading_month_surcharge').upsert(effectiveSurcharges.map((row) => ({
    asset_id: assetId, billing_month: billingMonth, asset_meter_surcharge_id: row.id, unit_price: row.unitPrice,
    purchase_period_start: row.purchase.periodStart || null, purchase_period_end: row.purchase.periodEnd || null,
    purchase_amount_inclusive: row.purchase.amountInclusive, purchase_usage: row.purchase.usage,
  })), { onConflict: 'asset_id,billing_month,asset_meter_surcharge_id' }), '増額分の単価');

  // 変動単価の月次入力です。決め方を切り替えても、もう一方の入力は消さずに残します。
  const variableSubItems = next.building.subItems.filter((row) => row.kind === 'custom' && row.priceMode === 'variable');
  if (variableSubItems.length) check(await client.from('meter_reading_month_sub_item').upsert(variableSubItems.map((row) => ({
    asset_id: assetId, billing_month: billingMonth, asset_meter_sub_item_id: row.id,
    unit_price: row.monthly.unitPrice,
    billed_inclusive: row.monthly.billedInclusive, billed_tax: row.monthly.billedTax, billed_exclusive: row.monthly.billedExclusive,
    billed_usage: row.monthly.billedUsage,
  })), { onConflict: 'asset_id,billing_month,asset_meter_sub_item_id' }), '単価計算');

  // 検針値です。指針入力の小分類は、指針から求めた使用量（全体）も usage_amount に残します。
  if (next.meters.length) check(await client.from('meter_reading_entry').upsert(next.meters.map((row) => {
    const reading = modeOf(row.subItemId) === 'reading';
    return {
      asset_id: assetId, billing_month: billingMonth, asset_meter_id: row.id, usage_amount: totalUsage(row, modeOf(row.subItemId)),
      previous_reading: reading ? row.previousReading : null, current_reading: reading ? row.currentReading : null,
      previous_reading_manual: reading && row.previousReadingManual,
      exchange_removed_reading: reading ? row.exchange?.removedReading ?? null : null,
      exchange_installed_reading: reading ? row.exchange?.installedReading ?? null : null,
    };
  }), { onConflict: 'asset_id,billing_month,asset_meter_id' }), '検針値');

  // 中間検針です。この月の分を入れ直します。
  check(await client.from('meter_reading_break').delete().eq('asset_id', assetId).eq('billing_month', billingMonth), '中間検針');
  const breaks = next.meters.flatMap((row) => row.breaks.filter((item) => item.date).map((item) => ({
    asset_id: assetId, billing_month: billingMonth, asset_meter_id: row.id, break_date: item.date,
    reading: modeOf(row.subItemId) === 'reading' ? item.reading : null,
    usage_amount: modeOf(row.subItemId) === 'usage' ? item.usage : null,
  })));
  if (breaks.length) check(await client.from('meter_reading_break').insert(breaks), '中間検針');
}

// 月次確定です。確定した金額は、そのときの使用量・単価・丸めごと残します。
// 単価や丸めの設定を後から変えても、確定済みの月の金額は動きません。
export type ConfirmedAmount = {
  tenantId: string; tenantName: string; rowNo: number; invoiceNo: number; category: CategoryId;
  sourceKind: 'subItem' | 'surcharge'; sourceId: string; sourceName: string; lineItemId: string | null; lineItemName: string | null;
  usage: number; usageUnit: string; unitPrice: number | null; amount: number;
};

export async function loadConfirmedAmounts(client: SupabaseClient, assetId: string, year: number, month: number): Promise<ConfirmedAmount[]> {
  const { data, error } = await client.from('meter_reading_confirmed_amount')
    .select('tenant_id, tenant_name, row_no, invoice_number, category, source_kind, source_id, source_name, asset_billing_line_item_id, line_item_name, usage_amount, usage_unit, unit_price, amount')
    .eq('asset_id', assetId).eq('billing_month', monthStart(year, month))
    .order('tenant_name').order('row_no');
  if (error) throw new Error(`確定した金額を読み込めませんでした: ${error.message}`);
  return (data ?? []).map((row) => ({
    tenantId: row.tenant_id, tenantName: row.tenant_name, rowNo: row.row_no, invoiceNo: row.invoice_number, category: row.category,
    sourceKind: row.source_kind, sourceId: row.source_id, sourceName: row.source_name, lineItemId: row.asset_billing_line_item_id, lineItemName: row.line_item_name,
    usage: Number(row.usage_amount), usageUnit: row.usage_unit ?? '', unitPrice: numberOrNull(row.unit_price), amount: Number(row.amount),
  }));
}

// 請求書作成で使う、検針データの明細です。保存済みの検針データから計算し、
// 確定済みの月は確定したときの金額を使います。検針日は請求期間の計算に使います。
export async function loadMeterInvoiceData(client: SupabaseClient, assetId: string, year: number, month: number) {
  const snapshot = await loadMeterReading(client, assetId, year, month);
  const meterDates = { current: snapshot.meterDate, previous: snapshot.previousMeterDate };
  if (snapshot.status !== 'confirmed') {
    const { results, building } = computeMonth(snapshot, year, month);
    return { lines: meterInvoiceLines(results, building), meterDates, status: snapshot.status };
  }
  const confirmed = await loadConfirmedAmounts(client, assetId, year, month);
  // 確定した金額は、画面と同じテナント・契約行の順に並べます。
  const tenantOrder = new Map(snapshot.tenants.map((tenant, index) => [tenant.id, index]));
  const lines: MeterInvoiceLine[] = [...confirmed]
    .sort((left, right) => (tenantOrder.get(left.tenantId) ?? 9999) - (tenantOrder.get(right.tenantId) ?? 9999) || left.rowNo - right.rowNo)
    .filter((row) => row.amount)
    .map((row) => {
      const subItem = row.sourceKind === 'subItem' ? snapshot.building.subItems.find((item) => item.id === row.sourceId) : undefined;
      const surcharge = row.sourceKind === 'surcharge' ? snapshot.building.surcharges.find((item) => item.id === row.sourceId) : undefined;
      const basic = subItem?.kind === 'basic' || (row.sourceKind === 'subItem' && row.unitPrice === null && !row.usage);
      return {
        tenantId: row.tenantId, tenantName: row.tenantName, invoiceNo: row.invoiceNo, lineItemId: row.lineItemId, sourceName: row.sourceName,
        usage: basic ? null : row.usage, unit: basic ? '' : row.usageUnit,
        // 請求書に単価を出すかどうかは、確定後も今の小分類の設定に従います。
        unitPrice: subItem && !subItem.showUnitPriceOnInvoice ? null : row.unitPrice, amount: row.amount,
        periodPatternId: subItem?.periodPatternId ?? surcharge?.periodPatternId ?? '',
      };
    });
  return { lines, meterDates, status: snapshot.status };
}

export async function confirmMeterReading(
  client: SupabaseClient, assetId: string, year: number, month: number,
  snapshot: MeterReadingSnapshot, results: TenantResult[], lineItemNames: Map<string, string>,
) {
  const billingMonth = monthStart(year, month);
  const unitOf = (id: CategoryId) => snapshot.building.categories.find((row) => row.id === id)?.unit ?? '';
  const rows = results.flatMap((result) => result.rows.flatMap((row) => {
    const shared = {
      asset_id: assetId, billing_month: billingMonth, meter_reading_contract_id: row.row.id,
      tenant_id: result.tenant.id, tenant_name: result.tenant.name, row_no: row.index + 1,
      invoice_number: result.tenant.invoiceSplitByUnit ? row.row.invoiceNo : 1,
      amount_rounding_mode: row.row.amountRoundingMode,
    };
    const subItemRows = row.categories.flatMap((category) => category.subItems
      .filter((item) => item.amount)
      .map((item) => ({
        ...shared, category: category.category.id, source_kind: 'subItem', source_id: item.subItem.id, source_name: item.subItem.name,
        asset_billing_line_item_id: item.subItem.lineItemId || null,
        line_item_name: item.subItem.lineItemId ? lineItemNames.get(item.subItem.lineItemId) ?? null : null,
        usage_amount: item.usage, usage_unit: unitOf(category.category.id),
        // 単価が違うメーターが混ざっている行は、単価を1つに決められないため残しません。
        unit_price: item.groups.length === 1 && item.subItem.kind !== 'basic' ? item.groups[0].unitPrice : null,
        amount: item.amount,
        usage_rounding_digits: item.subItem.usageRoundingDigits, usage_rounding_mode: item.subItem.usageRoundingMode,
        tax_mode: item.subItem.taxMode, tax_rate: snapshot.building.taxRate,
      })));
    const surchargeRows = row.surcharges.filter((item) => item.amount).map((item) => ({
      ...shared, category: item.surcharge.categoryId, source_kind: 'surcharge', source_id: item.surcharge.id, source_name: item.surcharge.name,
      asset_billing_line_item_id: item.surcharge.lineItemId || null,
      line_item_name: item.surcharge.lineItemId ? lineItemNames.get(item.surcharge.lineItemId) ?? null : null,
      usage_amount: item.usage, usage_unit: unitOf(item.surcharge.categoryId), unit_price: item.surcharge.unitPrice, amount: item.amount,
      usage_rounding_digits: null, usage_rounding_mode: null, tax_mode: null, tax_rate: snapshot.building.taxRate,
    }));
    return [...subItemRows, ...surchargeRows];
  }));

  // 確定し直したときに古い金額が残らないよう、入れ直します。
  const removed = await client.from('meter_reading_confirmed_amount').delete().eq('asset_id', assetId).eq('billing_month', billingMonth);
  if (removed.error) throw new Error(`確定した金額を入れ直せませんでした: ${removed.error.message}`);
  if (rows.length) {
    const inserted = await client.from('meter_reading_confirmed_amount').insert(rows);
    if (inserted.error) throw new Error(`確定した金額を保存できませんでした: ${inserted.error.message}`);
  }
  // 検針日を保存していない月は月次データが無く、確定を記録できません。
  const updated = await client.from('meter_reading_month')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('asset_id', assetId).eq('billing_month', billingMonth).select('asset_id');
  if (updated.error) throw new Error(`確定できませんでした: ${updated.error.message}`);
  if (!updated.data?.length) throw new Error('この月の検針データがまだ保存されていません。先に保存してください。');
}

export async function releaseMeterReading(client: SupabaseClient, assetId: string, year: number, month: number) {
  const billingMonth = monthStart(year, month);
  const removed = await client.from('meter_reading_confirmed_amount').delete().eq('asset_id', assetId).eq('billing_month', billingMonth);
  if (removed.error) throw new Error(`確定を解除できませんでした: ${removed.error.message}`);
  const updated = await client.from('meter_reading_month').update({ status: 'draft', confirmed_at: null })
    .eq('asset_id', assetId).eq('billing_month', billingMonth);
  if (updated.error) throw new Error(`確定を解除できませんでした: ${updated.error.message}`);
}
