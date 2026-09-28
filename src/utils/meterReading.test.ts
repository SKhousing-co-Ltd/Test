// 変動単価（単価計算タブ）の計算を確かめます。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  billedAmounts, calculateAll, calculateSubItem, meterInvoiceLines, calculateSurchargePrice, emptySurchargePurchase, emptyVariablePrice, subItemDefaults, variableUnitPrice,
  type BuildingConfig, type Category, type ContractRow, type Meter, type SubItem, type TenantConfig, type VariablePriceInput,
} from './meterReading.ts';

const input = (over: Partial<VariablePriceInput>): VariablePriceInput => ({ ...emptyVariablePrice(), ...over });
const water = (over: Partial<SubItem> = {}): SubItem => ({
  id: 'water_usage', categoryId: 'water', name: '水道', kind: 'custom', lineItemId: '', priceMode: 'variable', defaultUnitPrice: 500,
  taxMode: 'exclusive', taxRoundingMode: 'floor', usageRoundingDigits: 1, usageDisplayDigits: 1, usageRoundingMode: 'round', periodPatternId: '',
  ...subItemDefaults(), variablePriceMethod: 'billed',
  ...over,
});

test('税込だけ入れると、消費税を切り捨てで割り戻して税抜を出す', () => {
  assert.deepEqual(billedAmounts(input({ billedInclusive: 110000 }), 0.1), { inclusive: 110000, tax: 10000, exclusive: 100000, exclusiveEntered: false });
  // 12345×10/110＝1122.27… → 消費税1122、税抜11223
  assert.deepEqual(billedAmounts(input({ billedInclusive: 12345 }), 0.1), { inclusive: 12345, tax: 1122, exclusive: 11223, exclusiveEntered: false });
});

test('消費税を入れると、税抜は税込−消費税になる', () => {
  assert.deepEqual(billedAmounts(input({ billedInclusive: 11000, billedTax: 999 }), 0.1), { inclusive: 11000, tax: 999, exclusive: 10001, exclusiveEntered: false });
});

test('税抜を手入力すると、税込・消費税は使わない', () => {
  assert.deepEqual(billedAmounts(input({ billedInclusive: 11000, billedTax: 1000, billedExclusive: 9500 }), 0.1), { inclusive: null, tax: null, exclusive: 9500, exclusiveEntered: true });
});

test('何も入れていなければ税抜は決まらない', () => {
  assert.equal(billedAmounts(input({}), 0.1).exclusive, null);
  assert.equal(billedAmounts(input({ billedTax: 100 }), 0.1).exclusive, null);
});

test('税抜の小分類は、税抜請求額÷使用量を指定の桁・丸め方で処理する', () => {
  // 11223÷33.2＝338.0421…
  const monthly = input({ billedInclusive: 12345, billedUsage: 33.2 });
  assert.equal(variableUnitPrice(water({ monthly }), 0.1), 338.04);
  assert.equal(variableUnitPrice(water({ monthly, unitPriceRoundingDigits: 3, unitPriceRoundingMode: 'ceil' }), 0.1), 338.043);
  assert.equal(variableUnitPrice(water({ monthly, unitPriceRoundingDigits: 0, unitPriceRoundingMode: 'round' }), 0.1), 338);
});

test('税込の小分類は、税込請求額÷使用量で求める（税抜の手入力は使わない）', () => {
  const monthly = input({ billedInclusive: 12345, billedExclusive: 9000, billedUsage: 33.2 });
  // 12345÷33.2＝371.8373…
  assert.equal(variableUnitPrice(water({ taxMode: 'inclusive', monthly }), 0.1), 371.83);
});

test('使用量が未入力・0のとき、請求額が未入力のときは単価が決まらない', () => {
  assert.equal(variableUnitPrice(water({ monthly: input({ billedInclusive: 11000 }) }), 0.1), null);
  assert.equal(variableUnitPrice(water({ monthly: input({ billedInclusive: 11000, billedUsage: 0 }) }), 0.1), null);
  assert.equal(variableUnitPrice(water({ monthly: input({ billedUsage: 10 }) }), 0.1), null);
});

test('手入力のときは、入力した単価をそのまま使う', () => {
  assert.equal(variableUnitPrice(water({ variablePriceMethod: 'manual', monthly: input({ unitPrice: 338.27, billedInclusive: 11000, billedUsage: 10 }) }), 0.1), 338.27);
  assert.equal(variableUnitPrice(water({ variablePriceMethod: 'manual' }), 0.1), null);
});

const category: Category = { id: 'water', name: '水道', unit: '㎥', billable: true, fixedBillable: false };
const row: ContractRow = {
  id: 'C1', invoiceNo: 1, categoryBillable: { electric: true, water: true, gas: true },
  billable: { water_usage: true }, unitPrices: { water_usage: 400 }, fixedCharges: {},
  sumMode: { electric: 'aggregate', water: 'aggregate', gas: 'aggregate' }, amountRoundingMode: 'floor', note: '', splitLabel: '',
};
const meters: Meter[] = [
  { id: 'M1', subItemId: 'water_usage', code: 'W-1', label: '1F', tenantId: 'T1', rowIndex: 0, usage: 20 },
  { id: 'M2', subItemId: 'water_usage', code: 'W-2', label: '1F', tenantId: 'T1', rowIndex: 0, usage: 14.3, unitPrice: 999 },
];

test('変動単価は、契約単価・メーターの上書きではなくその月の単価を全メーターに使う', () => {
  const result = calculateSubItem(water({ monthly: input({ billedInclusive: 12345, billedUsage: 33.2 }) }), category, row, 'T1', 0, meters, 0.1);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].unitPrice, 338.04);
  // 34.3㎥×338.04＝11594.772 → 切り捨てで11594円
  assert.equal(result.amount, 11594);
});

test('変動単価が決まっていない月は0円になる', () => {
  const result = calculateSubItem(water(), category, row, 'T1', 0, meters, 0.1);
  assert.equal(result.amount, 0);
});

test('税込の変動単価は、税抜換算してから使用料を出す', () => {
  const result = calculateSubItem(water({ taxMode: 'inclusive', variablePriceMethod: 'manual', monthly: input({ unitPrice: 330 }) }), category, row, 'T1', 0, meters, 0.1);
  assert.equal(result.groups[0].unitPrice, 300);
});

// 増額分：仕入と回収の差から単価を出します。
const purchase = (amountInclusive: number | null) => ({ ...emptySurchargePurchase(), periodStart: '2026-08-01', periodEnd: '2026-08-31', amountInclusive, usage: 12000 });

test('増額分は、税込仕入額−税込回収額を使用量計で割り、税抜へ割り戻して小数第3位以下を切り上げる', () => {
  // 回収：電気計 300,000円 → 税込 330,000円。差額 400,000−330,000＝70,000円
  // 70,000÷9,000＝7.7777… → ÷1.1＝7.0707… → 切り上げで7.08
  const result = calculateSurchargePrice(purchase(400000), 9000, 300000, 0.1);
  assert.equal(result.recoveredInclusive, 330000);
  assert.equal(result.difference, 70000);
  assert.ok(Math.abs((result.inclusiveUnitPrice ?? 0) - 7.777777) < 1e-5);
  assert.equal(result.exclusiveUnitPrice, 7.08);
});

test('回収の税込電気代は四捨五入する', () => {
  assert.equal(calculateSurchargePrice(purchase(0), 1, 12345, 0.1).recoveredInclusive, 13580); // 13579.5 → 13580
  assert.equal(calculateSurchargePrice(purchase(0), 1, 12344, 0.1).recoveredInclusive, 13578); // 13578.4 → 13578
});

test('割り切れる単価は切り上げで増えない', () => {
  // 差額 7,700円÷1,000＝7.7 → ÷1.1＝7.00
  assert.equal(calculateSurchargePrice(purchase(117700), 1000, 100000, 0.1).exclusiveUnitPrice, 7);
});

test('差額がマイナスなら増額分の単価は0円', () => {
  const result = calculateSurchargePrice(purchase(300000), 9000, 300000, 0.1);
  assert.equal(result.difference, -30000);
  assert.equal(result.exclusiveUnitPrice, 0);
});

test('仕入が未入力、使用量計が0のときは単価を決めない', () => {
  assert.equal(calculateSurchargePrice(purchase(null), 9000, 300000, 0.1).exclusiveUnitPrice, null);
  assert.equal(calculateSurchargePrice(purchase(400000), 0, 300000, 0.1).exclusiveUnitPrice, null);
});

const electricBuilding = (amountInclusive: number | null, unitPrice = 5): BuildingConfig => ({
  categories: [{ id: 'electric', name: '電気', unit: 'kWh', billable: true, fixedBillable: true }],
  subItems: [
    { id: 'basic', categoryId: 'electric', name: '基本料', kind: 'basic', lineItemId: '', priceMode: 'fixed', defaultUnitPrice: null, taxMode: 'exclusive', taxRoundingMode: 'floor', usageRoundingDigits: 1, usageDisplayDigits: 1, usageRoundingMode: 'round', periodPatternId: '', ...subItemDefaults() },
    { id: 'light', categoryId: 'electric', name: '電灯', kind: 'custom', lineItemId: '', priceMode: 'fixed', defaultUnitPrice: 30, taxMode: 'exclusive', taxRoundingMode: 'floor', usageRoundingDigits: 1, usageDisplayDigits: 1, usageRoundingMode: 'round', periodPatternId: '', ...subItemDefaults() },
  ],
  surcharges: [{ id: 'S1', name: '電気増額分', categoryId: 'electric', unitPrice, lineItemId: '', billable: true, purchase: purchase(amountInclusive), periodPatternId: '' }],
  taxRate: 0.1,
});
const electricRow = (id: string, basic: number): ContractRow => ({
  id, invoiceNo: 1, categoryBillable: { electric: true, water: true, gas: true },
  billable: { basic: true, light: true }, unitPrices: {}, fixedCharges: { basic },
  sumMode: { electric: 'aggregate', water: 'aggregate', gas: 'aggregate' }, amountRoundingMode: 'floor', note: '', splitLabel: '',
});
const electricTenants: TenantConfig[] = [
  { id: 'T1', name: 'A', splitEnabled: false, rows: [electricRow('C1', 10000)], invoiceSplitByUnit: false, expected: 0 },
  { id: 'T2', name: 'B', splitEnabled: false, rows: [electricRow('C2', 0)], invoiceSplitByUnit: false, expected: 0 },
];
const electricMeters: Meter[] = [
  { id: 'E1', subItemId: 'light', code: 'E-1', label: '2F', tenantId: 'T1', rowIndex: 0, usage: 600 },
  { id: 'E2', subItemId: 'light', code: 'E-2', label: '3F', tenantId: 'T2', rowIndex: 0, usage: 400 },
];

test('回収は基本料込みの電気計と使用量計で、算出した税抜単価を各テナントの増額分に使う', () => {
  // 電気計：基本料10,000＋電灯1,000kWh×30円＝40,000円 → 税込44,000円
  // 差額 55,000−44,000＝11,000円 ÷1,000kWh＝11円 → 税抜10.00円
  const { results, calculations, building } = calculateAll(electricTenants, electricBuilding(55000), electricMeters);
  const calc = calculations.get('S1');
  assert.equal(calc?.recoveredAmount, 40000);
  assert.equal(calc?.recoveredUsage, 1000);
  assert.equal(calc?.exclusiveUnitPrice, 10);
  assert.equal(building.surcharges[0].unitPrice, 10);
  assert.deepEqual(results.map((result) => result.rows[0].surcharges[0].amount), [6000, 4000]);
});

test('仕入が未入力の月は、保存済みの増額分単価をそのまま使う', () => {
  const { results } = calculateAll(electricTenants, electricBuilding(null, 5), electricMeters);
  assert.deepEqual(results.map((result) => result.rows[0].surcharges[0].amount), [3000, 2000]);
});

test('請求書作成へは、小分類・増額分ごとに使用量・単価・金額と請求期間パターンを渡す', () => {
  const building = electricBuilding(55000);
  building.subItems[0].lineItemId = 'L-basic';
  building.subItems[1] = { ...building.subItems[1], lineItemId: 'L-light', periodPatternId: 'P1' };
  building.surcharges[0].lineItemId = 'L-up';
  building.surcharges[0].periodPatternId = 'P2';
  const split = [{ ...electricTenants[0], invoiceSplitByUnit: true, rows: [{ ...electricRow('C1', 10000), invoiceNo: 2 }] }, electricTenants[1]];
  const { results, building: effective } = calculateAll(split, building, electricMeters);
  const lines = meterInvoiceLines(results, effective);
  assert.deepEqual(lines.filter((line) => line.tenantId === 'T1').map((line) => [line.sourceName, line.lineItemId, line.invoiceNo, line.usage, line.unit, line.unitPrice, line.amount, line.periodPatternId]), [
    ['基本料', 'L-basic', 2, null, '', null, 10000, ''],
    ['電灯', 'L-light', 2, 600, 'kWh', 30, 18000, 'P1'],
    ['電気増額分', 'L-up', 2, 600, 'kWh', 10, 6000, 'P2'],
  ]);
  // 金額0の小分類（T2の基本料）は載せません。
  assert.deepEqual(lines.filter((line) => line.tenantId === 'T2').map((line) => line.sourceName), ['電灯', '電気増額分']);
});

test('請求書に単価を出さない小分類は、単価を空欄にして渡す（数量・金額は出す）', () => {
  const building = electricBuilding(null);
  building.subItems[1] = { ...building.subItems[1], showUnitPriceOnInvoice: false };
  const { results, building: effective } = calculateAll(electricTenants, building, electricMeters);
  const light = meterInvoiceLines(results, effective).find((line) => line.tenantId === 'T1' && line.sourceName === '電灯');
  assert.deepEqual([light?.usage, light?.unitPrice, light?.amount], [600, null, 18000]);
});
