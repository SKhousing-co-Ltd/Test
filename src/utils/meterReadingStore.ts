// 検針データの画面とSupabaseの間の読み書きです。
// 画面が扱う形（BuildingConfig／TenantConfig／Meter）と、テーブルの行を相互に変換します。
//
// 保存は明示的な「保存」ボタンでまとめて行うため、読み込んだ時点のスナップショットを
// 覚えておき、保存時に「消えた行」を削除し、残っている行をupsertします。
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BuildingConfig, Category, CategoryId, ContractRow, Meter, PriceMode, RoundingMode, SubItem, SumMode, Surcharge, TaxMode, TenantConfig,
} from './meterReading';

export type MeterReadingSnapshot = {
  building: BuildingConfig;
  tenants: TenantConfig[];
  meters: Meter[];
  // 当月と前月の検針日です。前月は表示だけに使います。
  meterDate: string;
  previousMeterDate: string;
  status: 'draft' | 'confirmed';
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
  tax_rounding_digits: number; tax_rounding_mode: RoundingMode; usage_rounding_digits: number; usage_rounding_mode: RoundingMode;
  billing_period_pattern_id: string | null; sort_order: number;
};
type SurchargeRow = { asset_meter_surcharge_id: string; asset_id: string; category: CategoryId; surcharge_name: string; asset_billing_line_item_id: string | null; is_billable: boolean };
type ContractRowRecord = {
  meter_reading_contract_id: string; asset_id: string; tenant_id: string; row_no: number; invoice_number: number;
  electric_billable: boolean; water_billable: boolean; gas_billable: boolean;
  electric_sum_mode: SumMode; water_sum_mode: SumMode; gas_sum_mode: SumMode;
  amount_rounding_mode: RoundingMode; note: string | null;
};
type ContractItemRow = { meter_reading_contract_id: string; asset_meter_sub_item_id: string; is_billable: boolean; unit_price: number | null; fixed_amount: number | null };
type MeterRow = { asset_meter_id: string; asset_id: string; asset_meter_sub_item_id: string; meter_code: string; meter_label: string | null; meter_reading_contract_id: string | null; unit_price_override: number | null; is_active: boolean };
type MonthRow = { asset_id: string; billing_month: string; meter_date: string | null; status: 'draft' | 'confirmed' };
type MonthSurchargeRow = { asset_id: string; billing_month: string; asset_meter_surcharge_id: string; unit_price: number };
type EntryRow = { asset_id: string; billing_month: string; asset_meter_id: string; usage_amount: number };
type RentRollRow = { tenant_id: string | null; tenant_name: string | null };

const firstError = (...results: Array<{ error: { message: string } | null }>) => results.find((row) => row.error)?.error ?? null;

// 物件のテナントを、レントロールと同じフロア順で取り出します。同じテナントが複数区画を
// 契約している場合は1件にまとめます。
async function loadTenantList(client: SupabaseClient, assetId: string, asOfDate: string) {
  const { data, error } = await client.rpc('rent_roll_list_with_terms_at_date', { p_property_id: assetId, p_as_of_date: asOfDate });
  if (error) throw new Error(`テナントを読み込めませんでした: ${error.message}`);
  const found = new Map<string, string>();
  for (const row of (data ?? []) as RentRollRow[]) if (row.tenant_id && row.tenant_name && !found.has(row.tenant_id)) found.set(row.tenant_id, row.tenant_name);
  return [...found.entries()].map(([id, name]) => ({ id, name }));
}

export async function loadMeterReading(client: SupabaseClient, assetId: string, year: number, month: number): Promise<MeterReadingSnapshot> {
  const billingMonth = monthStart(year, month);
  const previous = previousMonthOf(year, month);
  const previousMonth = monthStart(previous.year, previous.month);

  const tenantList = await loadTenantList(client, assetId, billingMonth);

  const [settingResult, subItemResult, surchargeResult, contractResult, meterResult, monthResult, monthSurchargeResult, entryResult, splitResult] = await Promise.all([
    client.from('asset_meter_category_setting').select('asset_id, category, usage_unit, is_billable, is_basic_billable').eq('asset_id', assetId),
    client.from('asset_meter_sub_item').select('asset_meter_sub_item_id, asset_id, category, sub_item_name, sub_item_kind, asset_billing_line_item_id, price_mode, default_unit_price, tax_mode, tax_rounding_digits, tax_rounding_mode, usage_rounding_digits, usage_rounding_mode, billing_period_pattern_id, sort_order').eq('asset_id', assetId).order('sort_order'),
    client.from('asset_meter_surcharge').select('asset_meter_surcharge_id, asset_id, category, surcharge_name, asset_billing_line_item_id, is_billable').eq('asset_id', assetId).order('surcharge_name'),
    client.from('meter_reading_contract').select('meter_reading_contract_id, asset_id, tenant_id, row_no, invoice_number, electric_billable, water_billable, gas_billable, electric_sum_mode, water_sum_mode, gas_sum_mode, amount_rounding_mode, note').eq('asset_id', assetId).order('row_no'),
    client.from('asset_meter').select('asset_meter_id, asset_id, asset_meter_sub_item_id, meter_code, meter_label, meter_reading_contract_id, unit_price_override, is_active').eq('asset_id', assetId).order('meter_code'),
    client.from('meter_reading_month').select('asset_id, billing_month, meter_date, status').eq('asset_id', assetId).in('billing_month', [billingMonth, previousMonth]),
    client.from('meter_reading_month_surcharge').select('asset_id, billing_month, asset_meter_surcharge_id, unit_price').eq('asset_id', assetId).eq('billing_month', billingMonth),
    client.from('meter_reading_entry').select('asset_id, billing_month, asset_meter_id, usage_amount').eq('asset_id', assetId).eq('billing_month', billingMonth),
    client.from('billing_invoice_split_setting').select('split_mode, code:billing_code!inner(tenant_id)').eq('asset_id', assetId).eq('split_mode', 'unit'),
  ]);

  const failed = firstError(settingResult, subItemResult, surchargeResult, contractResult, meterResult, monthResult, monthSurchargeResult, entryResult, splitResult);
  if (failed) throw new Error(`検針データを読み込めませんでした: ${failed.message}`);

  const settingRows = (settingResult.data ?? []) as CategorySettingRow[];
  const subItemRows = (subItemResult.data ?? []) as SubItemRow[];
  const surchargeRows = (surchargeResult.data ?? []) as SurchargeRow[];
  const contractRows = (contractResult.data ?? []) as ContractRowRecord[];
  const meterRows = (meterResult.data ?? []) as MeterRow[];
  const monthRows = (monthResult.data ?? []) as MonthRow[];
  const monthSurchargeRows = (monthSurchargeResult.data ?? []) as MonthSurchargeRow[];
  const entryRows = (entryResult.data ?? []) as EntryRow[];

  // 契約行の小分類設定は契約行が決まってからでないと引けません。
  const contractIds = contractRows.map((row) => row.meter_reading_contract_id);
  let contractItemRows: ContractItemRow[] = [];
  if (contractIds.length) {
    const { data, error } = await client.from('meter_reading_contract_item').select('meter_reading_contract_id, asset_meter_sub_item_id, is_billable, unit_price, fixed_amount').in('meter_reading_contract_id', contractIds);
    if (error) throw new Error(`契約行の設定を読み込めませんでした: ${error.message}`);
    contractItemRows = (data ?? []) as ContractItemRow[];
  }

  // 分類・基本料・増額分は分類ごとに1つずつ必ず必要なので、未登録なら画面上で作ります。
  // 新しい行はここでidを採番しておき、保存時にそのままinsertできるようにします。
  const categories: Category[] = categoryIds.map((id) => {
    const found = settingRows.find((row) => row.category === id);
    return { id, name: categoryNames[id], unit: found?.usage_unit ?? defaultUnits[id], billable: found?.is_billable ?? true, fixedBillable: found?.is_basic_billable ?? false };
  });

  const subItems: SubItem[] = [];
  for (const id of categoryIds) {
    const own = subItemRows.filter((row) => row.category === id);
    if (!own.some((row) => row.sub_item_kind === 'basic')) {
      subItems.push({ id: newId(), categoryId: id, name: '基本料', kind: 'basic', lineItemId: '', priceMode: 'fixed', defaultUnitPrice: null, taxMode: 'exclusive', taxRoundingDigits: 2, taxRoundingMode: 'floor', usageRoundingDigits: 1, usageRoundingMode: 'round', periodPatternId: '' });
    }
    for (const row of own) {
      subItems.push({
        id: row.asset_meter_sub_item_id, categoryId: row.category, name: row.sub_item_name, kind: row.sub_item_kind,
        lineItemId: row.asset_billing_line_item_id ?? '', priceMode: row.price_mode, defaultUnitPrice: row.default_unit_price,
        taxMode: row.tax_mode, taxRoundingDigits: row.tax_rounding_digits, taxRoundingMode: row.tax_rounding_mode,
        usageRoundingDigits: row.usage_rounding_digits, usageRoundingMode: row.usage_rounding_mode,
        periodPatternId: row.billing_period_pattern_id ?? '',
      });
    }
  }
  // 基本料が先、その後は登録順に並べます。
  subItems.sort((left, right) => categoryIds.indexOf(left.categoryId) - categoryIds.indexOf(right.categoryId) || (left.kind === right.kind ? 0 : left.kind === 'basic' ? -1 : 1));

  const priceBySurcharge = new Map(monthSurchargeRows.map((row) => [row.asset_meter_surcharge_id, Number(row.unit_price)]));
  const surcharges: Surcharge[] = [];
  for (const id of categoryIds) {
    const own = surchargeRows.filter((row) => row.category === id);
    if (!own.length) {
      surcharges.push({ id: newId(), name: `${categoryNames[id]}増額分`, categoryId: id, unitPrice: 0, lineItemId: '', billable: false });
      continue;
    }
    for (const row of own) surcharges.push({ id: row.asset_meter_surcharge_id, name: row.surcharge_name, categoryId: row.category, unitPrice: priceBySurcharge.get(row.asset_meter_surcharge_id) ?? 0, lineItemId: row.asset_billing_line_item_id ?? '', billable: row.is_billable });
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
      amountRoundingMode: record.amount_rounding_mode, note: record.note ?? '',
    };
  };

  const emptyContractRow = (): ContractRow => ({
    id: newId(), invoiceNo: 1,
    categoryBillable: { electric: true, water: true, gas: true },
    billable: Object.fromEntries(subItems.map((row) => [row.id, row.kind !== 'basic'])),
    unitPrices: Object.fromEntries(subItems.map((row) => [row.id, null])),
    fixedCharges: {},
    sumMode: { electric: 'aggregate', water: 'aggregate', gas: 'aggregate' },
    amountRoundingMode: 'floor', note: '',
  });

  const tenants: TenantConfig[] = tenantList.map(({ id, name }) => {
    const own = contractRows.filter((row) => row.tenant_id === id).sort((left, right) => left.row_no - right.row_no);
    const rows = own.length ? own.map(toContractRow) : [emptyContractRow()];
    // 元表との突き合わせはサンプルデータのときだけ使う項目なので、実データでは0にしています。
    return { id, name, splitEnabled: rows.length > 1, rows, invoiceSplitByUnit: splitTenants.has(id), expected: 0 };
  });

  const rowIndexByContract = new Map<string, { tenantId: string; rowIndex: number }>();
  for (const tenant of tenants) tenant.rows.forEach((row, index) => rowIndexByContract.set(row.id, { tenantId: tenant.id, rowIndex: index }));

  const usageByMeter = new Map(entryRows.map((row) => [row.asset_meter_id, Number(row.usage_amount)]));
  const meters: Meter[] = meterRows.filter((row) => row.is_active).map((row) => {
    const assigned = row.meter_reading_contract_id ? rowIndexByContract.get(row.meter_reading_contract_id) : undefined;
    const unitPrice = numberOrNull(row.unit_price_override);
    return {
      id: row.asset_meter_id, subItemId: row.asset_meter_sub_item_id, code: row.meter_code, label: row.meter_label ?? '',
      tenantId: assigned?.tenantId ?? '', rowIndex: assigned?.rowIndex ?? 0, usage: usageByMeter.get(row.asset_meter_id) ?? 0,
      ...(unitPrice === null ? {} : { unitPrice }),
    };
  });

  const currentMonth = monthRows.find((row) => row.billing_month === billingMonth);
  const previousRow = monthRows.find((row) => row.billing_month === previousMonth);

  return {
    building: { categories, subItems, surcharges, taxRate },
    tenants, meters,
    meterDate: currentMonth?.meter_date ?? '',
    previousMeterDate: previousRow?.meter_date ?? '',
    status: currentMonth?.status ?? 'draft',
  };
}

const removedIds = (base: string[], next: string[]) => { const keep = new Set(next); return base.filter((id) => !keep.has(id)); };

export async function saveMeterReading(
  client: SupabaseClient, assetId: string, year: number, month: number,
  next: MeterReadingSnapshot, base: MeterReadingSnapshot,
) {
  const billingMonth = monthStart(year, month);
  const check = (result: { error: { message: string } | null }, label: string) => { if (result.error) throw new Error(`${label}を保存できませんでした: ${result.error.message}`); };

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
      tax_mode: row.taxMode, tax_rounding_digits: row.taxRoundingDigits, tax_rounding_mode: row.taxRoundingMode,
      usage_rounding_digits: row.usageRoundingDigits, usage_rounding_mode: row.usageRoundingMode,
      billing_period_pattern_id: row.periodPatternId || null, sort_order: order,
    };
  })), '小分類');

  // 3. 増額分（単価は月ごとなので、単価だけ月次テーブルへ入れます）
  check(await client.from('asset_meter_surcharge').upsert(next.building.surcharges.map((row) => ({
    asset_meter_surcharge_id: row.id, asset_id: assetId, category: row.categoryId, surcharge_name: row.name,
    asset_billing_line_item_id: row.lineItemId || null, is_billable: row.billable,
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
  })))), '契約行');

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
  const contractIdOf = (meter: Meter) => next.tenants.find((tenant) => tenant.id === meter.tenantId)?.rows[meter.rowIndex]?.id ?? null;
  if (next.meters.length) check(await client.from('asset_meter').upsert(next.meters.map((row) => ({
    asset_meter_id: row.id, asset_id: assetId, asset_meter_sub_item_id: row.subItemId, meter_code: row.code, meter_label: row.label || null,
    meter_reading_contract_id: contractIdOf(row), unit_price_override: row.unitPrice ?? null, is_active: true,
  }))), 'メーター');

  // 7. 月次のヘッダーは、検針値と増額分の単価より先に作ります（参照先になるため）。
  check(await client.from('meter_reading_month').upsert({
    asset_id: assetId, billing_month: billingMonth, meter_date: next.meterDate || null, status: next.status,
  }, { onConflict: 'asset_id,billing_month' }), '検針日');

  check(await client.from('meter_reading_month_surcharge').upsert(next.building.surcharges.map((row) => ({
    asset_id: assetId, billing_month: billingMonth, asset_meter_surcharge_id: row.id, unit_price: row.unitPrice,
  })), { onConflict: 'asset_id,billing_month,asset_meter_surcharge_id' }), '増額分の単価');

  if (next.meters.length) check(await client.from('meter_reading_entry').upsert(next.meters.map((row) => ({
    asset_id: assetId, billing_month: billingMonth, asset_meter_id: row.id, usage_amount: row.usage,
  })), { onConflict: 'asset_id,billing_month,asset_meter_id' }), '検針値');
}
