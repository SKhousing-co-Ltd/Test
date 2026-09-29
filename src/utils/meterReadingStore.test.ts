// 保存処理が、画面の状態をどのテーブルの行へ写すかを確かめます。
// Supabaseの代わりに、呼び出しを記録するだけの相手を渡しています。
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeMonth, meterCodeProblems, saveMeterReading, type MeterReadingSnapshot } from './meterReadingStore.ts';
import { floorLabel, subItemDefaults, type ContractRow, type RoundingMode, type SubItem, type SumMode } from './meterReading.ts';
import { addDays, type AssetMeter, type Occupancy } from './meterAllocation.ts';

type Call = { table: string; op: string; rows: unknown; filters: Array<[string, unknown]> };
const calls: Call[] = [];

const recorder = (table: string, op: string, rows: unknown) => {
  const entry: Call = { table, op, rows, filters: [] };
  calls.push(entry);
  const chain = {
    in: (column: string, values: unknown) => { entry.filters.push([column, values]); return chain; },
    eq: (column: string, value: unknown) => { entry.filters.push([column, value]); return chain; },
    select: () => chain,
    // await されたときに、1件更新できた体で返します。
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => resolve({ data: [{}], error: null }),
  };
  return chain;
};

const client = {
  from: (table: string) => ({
    upsert: (rows: unknown) => recorder(table, 'upsert', rows),
    insert: (rows: unknown) => recorder(table, 'insert', rows),
    update: (values: unknown) => recorder(table, 'update', values),
    delete: () => recorder(table, 'delete', null),
  }),
} as unknown as SupabaseClient;

const subItem = (id: string, name: string, kind: 'basic' | 'custom'): SubItem => ({
  id, categoryId: 'electric', name, kind, lineItemId: '', priceMode: 'fixed', defaultUnitPrice: 35,
  taxMode: 'exclusive', taxRoundingMode: 'floor',
  usageRoundingDigits: 1, usageDisplayDigits: 1, usageRoundingMode: 'round', periodPatternId: '', ...subItemDefaults(),
});
const contractRow = (id: string): ContractRow => ({
  id, invoiceNo: 1,
  categoryBillable: { electric: true, water: true, gas: true },
  billable: { basic: true, light: true },
  unitPrices: { light: 31.65 },
  fixedCharges: { basic: 50379 },
  sumMode: { electric: 'aggregate' as SumMode, water: 'aggregate' as SumMode, gas: 'aggregate' as SumMode },
  amountRoundingMode: 'round' as RoundingMode, note: '', splitLabel: '', unitIds: [],
});
const assetMeter = (id: string, code: string, over: Partial<AssetMeter> = {}): AssetMeter => ({
  id, subItemId: 'light', code, label: '', assignments: [{ id: `A-${id}`, unitId: 'U1', from: '1900-01-01', to: null }], usage: 0,
  previousReading: null, currentReading: null, previousReadingManual: false, exchange: null, breaks: [],
  ...over,
});
// 区画 U1 に、期間中ずっとテナント T1 が入居している状態です。
const occupied = (from = '2026-08-01', to = '2026-10-31', unitTenant: Record<string, [string, string]> = { U1: ['T1', 'テナント1'] }): Occupancy => {
  const map: Occupancy = new Map();
  for (let date = from; date <= to; date = addDays(date, 1)) {
    map.set(date, new Map(Object.entries(unitTenant).map(([unitId, [tenantId, tenantName]]) => [unitId, { tenantId, tenantName, unitType: 'office' }])));
  }
  return map;
};
const snapshot = (over: Partial<MeterReadingSnapshot> = {}): MeterReadingSnapshot => ({
  building: {
    categories: [{ id: 'electric', name: '電気', unit: 'kWh', billable: true, fixedBillable: true }],
    subItems: [subItem('basic', '基本料', 'basic'), subItem('light', '電灯', 'custom')],
    surcharges: [], taxRate: 0.1,
  },
  tenants: [{ id: 'T1', name: 'テナント1', splitEnabled: false, rows: [contractRow('C1')], invoiceSplitByUnit: false, expected: 0 }],
  meters: [assetMeter('M1', '223-607-805', { label: '2F', usage: 564.5 })],
  meterDate: '2026-09-02', previousMeterDate: '', status: 'draft',
  units: [{ id: 'U1', code: '201', name: '201', floor: '2F', type: 'office' }], occupancy: occupied(), previousMonthReadings: {},
  savedContracts: {}, invoiceSplitTenantIds: [], persistedContractIds: ['C1'],
  ...over,
});

const rowsOf = (table: string, op: string) => {
  const found = calls.find((entry) => entry.table === table && entry.op === op);
  return found?.rows as Record<string, unknown>[] | undefined;
};
const filtersOf = (table: string, op: string) => calls.find((entry) => entry.table === table && entry.op === op)?.filters;
const reset = () => { calls.length = 0; };

test('検針値は対象月の行として保存される', async () => {
  reset();
  await saveMeterReading(client, 'A1', 2026, 9, snapshot(), snapshot());
  assert.deepEqual(rowsOf('meter_reading_entry', 'upsert')?.[0], {
    asset_id: 'A1', billing_month: '2026-09-01', asset_meter_id: 'M1', usage_amount: 564.5,
    previous_reading: null, current_reading: null, previous_reading_manual: false, exchange_removed_reading: null, exchange_installed_reading: null,
  });
  const month = calls.find((entry) => entry.table === 'meter_reading_month' && entry.op === 'upsert')?.rows as Record<string, unknown>;
  assert.equal(month.meter_date, '2026-09-02');
  assert.equal(month.billing_month, '2026-09-01');
});

test('指針入力の小分類は、指針と、指針から求めた使用量を保存する', async () => {
  reset();
  const next = snapshot({ meters: [assetMeter('M1', 'A-1', { usage: 999, previousReading: 1200.5, currentReading: 1500, previousReadingManual: true })] });
  next.building.subItems[1] = { ...next.building.subItems[1], inputMode: 'reading' };
  await saveMeterReading(client, 'A1', 2026, 9, next, next);
  assert.deepEqual(rowsOf('meter_reading_entry', 'upsert')?.[0], {
    asset_id: 'A1', billing_month: '2026-09-01', asset_meter_id: 'M1', usage_amount: 299.5,
    previous_reading: 1200.5, current_reading: 1500, previous_reading_manual: true, exchange_removed_reading: null, exchange_installed_reading: null,
  });
  assert.equal(rowsOf('asset_meter_sub_item', 'upsert')?.find((row) => row.asset_meter_sub_item_id === 'light')?.input_mode, 'reading');
  // 基本料は入力方式を持たないため、使用量のままにします。
  assert.equal(rowsOf('asset_meter_sub_item', 'upsert')?.find((row) => row.asset_meter_sub_item_id === 'basic')?.input_mode, 'usage');
});

test('メーター交換の月は、旧・新メーターの使用量を足して保存する', async () => {
  reset();
  const next = snapshot({ meters: [assetMeter('M1', 'A-1', { previousReading: 1000, currentReading: 30, exchange: { removedReading: 1100, installedReading: 0 } })] });
  next.building.subItems[1] = { ...next.building.subItems[1], inputMode: 'reading' };
  await saveMeterReading(client, 'A1', 2026, 9, next, next);
  const entry = rowsOf('meter_reading_entry', 'upsert')?.[0];
  assert.equal(entry?.usage_amount, 130);
  assert.equal(entry?.exchange_removed_reading, 1100);
  assert.equal(entry?.exchange_installed_reading, 0);
});

test('中間検針は先に書き込み、消えた区切りだけを後で消す', async () => {
  reset();
  const base = snapshot({ meters: [assetMeter('M1', 'A-1', { breaks: [{ date: '2026-08-25', reading: null, usage: 10 }, { date: '2026-09-01', reading: null, usage: 30 }] })] });
  const next = snapshot({ meters: [assetMeter('M1', 'A-1', { usage: 100, breaks: [{ date: '2026-09-01', reading: 5, usage: 40 }] })] });
  await saveMeterReading(client, 'A1', 2026, 9, next, base);
  // 使用量入力の小分類なので、指針は残しません。
  assert.deepEqual(rowsOf('meter_reading_break', 'upsert'), [{ asset_id: 'A1', billing_month: '2026-09-01', asset_meter_id: 'M1', break_date: '2026-09-01', reading: null, usage_amount: 40 }]);
  assert.deepEqual(filtersOf('meter_reading_break', 'delete'), [['asset_id', 'A1'], ['billing_month', '2026-09-01'], ['asset_meter_id', 'M1'], ['break_date', '2026-08-25']]);
  const order = calls.map((entry) => `${entry.table}:${entry.op}`);
  assert.ok(order.indexOf('meter_reading_month:upsert') < order.indexOf('meter_reading_break:upsert'));
  assert.ok(order.indexOf('meter_reading_break:upsert') < order.indexOf('meter_reading_break:delete'));
});

test('同じメーターで中間検針の日付が重複していると、何も書き込まずに止まる', async () => {
  reset();
  const next = snapshot({ meters: [assetMeter('M1', 'A-1', { breaks: [{ date: '2026-09-01', reading: null, usage: 1 }, { date: '2026-09-01', reading: null, usage: 2 }] })] });
  await assert.rejects(saveMeterReading(client, 'A1', 2026, 9, next, snapshot()), /中間検針の日付が重複/);
  assert.equal(calls.length, 0);
});

test('基本料は固定額、それ以外は契約単価として保存される', async () => {
  reset();
  await saveMeterReading(client, 'A1', 2026, 9, snapshot(), snapshot());
  const items = rowsOf('meter_reading_contract_item', 'upsert') ?? [];
  assert.deepEqual(items.find((item) => item.asset_meter_sub_item_id === 'basic'), { meter_reading_contract_id: 'C1', asset_meter_sub_item_id: 'basic', is_billable: true, unit_price: null, fixed_amount: 50379 });
  assert.deepEqual(items.find((item) => item.asset_meter_sub_item_id === 'light'), { meter_reading_contract_id: 'C1', asset_meter_sub_item_id: 'light', is_billable: true, unit_price: 31.65, fixed_amount: null });
});

test('消えた小分類・契約行だけが削除される', async () => {
  reset();
  const base = snapshot();
  base.building.subItems.push(subItem('ac', '空調', 'custom'));
  base.meters.push(assetMeter('M2', 'AC-1', { subItemId: 'ac', usage: 1 }));
  base.tenants[0].rows.push(contractRow('C2'));
  await saveMeterReading(client, 'A1', 2026, 9, snapshot(), base);
  assert.deepEqual(filtersOf('asset_meter_sub_item', 'delete'), [['asset_meter_sub_item_id', ['ac']]]);
  assert.deepEqual(filtersOf('meter_reading_contract', 'delete'), [['meter_reading_contract_id', ['C2']]]);
  // 小分類と一緒に消えるメーターは、個別には削除しません。
  assert.equal(filtersOf('asset_meter', 'delete'), undefined);
});

test('メーターは契約行ではなく区画の履歴で保存する（旧の割当先は書き換えない）', async () => {
  reset();
  await saveMeterReading(client, 'A1', 2026, 9, snapshot(), snapshot());
  assert.equal('meter_reading_contract_id' in (rowsOf('asset_meter', 'upsert')?.[0] ?? {}), false);
  assert.deepEqual(rowsOf('asset_meter_unit_assignment', 'upsert'), [{ asset_meter_unit_assignment_id: 'A-M1', asset_meter_id: 'M1', unit_id: 'U1', effective_from: '1900-01-01', effective_to: null }]);
  const order = calls.map((entry) => `${entry.table}:${entry.op}`);
  assert.ok(order.indexOf('asset_meter:upsert') < order.indexOf('asset_meter_unit_assignment:upsert'));
});

test('区画を選び直して消えた紐づけは、入れ直す前に削除する', async () => {
  reset();
  const base = snapshot();
  const next = snapshot({ meters: [assetMeter('M1', 'A-1', { assignments: [
    { id: 'A-M1', unitId: 'U1', from: '1900-01-01', to: '2026-08-31' },
    { id: 'A-NEW', unitId: 'U2', from: '2026-09-01', to: null },
  ] })] });
  base.meters[0].assignments.push({ id: 'A-OLD', unitId: 'U3', from: '2026-09-01', to: null });
  await saveMeterReading(client, 'A1', 2026, 9, next, base);
  assert.deepEqual(filtersOf('asset_meter_unit_assignment', 'delete'), [['asset_meter_unit_assignment_id', ['A-OLD']]]);
  const order = calls.map((entry) => `${entry.table}:${entry.op}`);
  assert.ok(order.indexOf('asset_meter_unit_assignment:delete') < order.indexOf('asset_meter_unit_assignment:upsert'));
});

test('分割したテナントだけ分割行の区画を書き込み、外れた区画は後で消す', async () => {
  reset();
  const next = snapshot({ tenants: [
    { id: 'T1', name: 'テナント1', splitEnabled: true, rows: [{ ...contractRow('C1'), unitIds: ['U1'] }, { ...contractRow('C2'), unitIds: ['U2', 'U2'] }], invoiceSplitByUnit: false, expected: 0 },
    // 分割をやめたテナントの区画は、残っていても消します。
    { id: 'T2', name: 'テナント2', splitEnabled: false, rows: [{ ...contractRow('C3'), unitIds: ['U9'] }], invoiceSplitByUnit: false, expected: 0 },
  ] });
  await saveMeterReading(client, 'A1', 2026, 9, next, next);
  assert.deepEqual(rowsOf('meter_reading_contract_unit', 'upsert'), [
    { meter_reading_contract_id: 'C1', unit_id: 'U1' },
    { meter_reading_contract_id: 'C2', unit_id: 'U2' },
  ]);
  assert.deepEqual(filtersOf('meter_reading_contract_unit', 'delete'), [['meter_reading_contract_id', 'C3'], ['unit_id', 'U9']]);
});

test('一覧に居ないテナントが中間検針で出てきたら、保存済みの契約行の設定で加える', () => {
  const occupancy = new Map([...occupied('2026-08-01', '2026-08-20'), ...occupied('2026-08-21', '2026-10-31', { U1: ['T2', 'テナント2'] })]);
  const saved = { ...contractRow('C-T2'), unitPrices: { light: 40 } };
  const next = snapshot({
    meterDate: '2026-09-05', previousMeterDate: '2026-08-05', occupancy, savedContracts: { T2: [saved] }, invoiceSplitTenantIds: ['T2'],
    meters: [assetMeter('M1', 'A-1', { usage: 100, breaks: [{ date: '2026-08-20', reading: null, usage: 60 }] })],
  });
  const month = computeMonth(next, 2026, 9);
  const added = month.tenants.find((row) => row.id === 'T2');
  assert.equal(added?.rows[0].id, 'C-T2');
  assert.equal(added?.invoiceSplitByUnit, true);
  // 40kWh×40円＝1,600円
  assert.equal(month.results.find((row) => row.tenant.id === 'T2')?.rows[0].categories[0].subItems.find((item) => item.subItem.id === 'light')?.amount, 1600);
});

const meter = (id: string, code: string, subItemId = 'light') => assetMeter(id, code, { subItemId });

test('同じ小分類でメーター番号が空欄・重複していると、何も書き込まずに止まる', async () => {
  reset();
  const next = snapshot({ meters: [meter('M1', '223-607-805'), meter('M2', ''), meter('M3', ' '), meter('M4', '223-607-805 ')] });
  await assert.rejects(saveMeterReading(client, 'A1', 2026, 9, next, snapshot()), /電灯：メーター番号が未入力のメーターが2件.*電灯：メーター番号「223-607-805」が2件重複/);
  assert.equal(calls.length, 0);
});

test('別の小分類なら同じメーター番号でも保存できる', () => {
  assert.deepEqual(meterCodeProblems([meter('M1', 'A-1', 'light'), meter('M2', 'A-1', 'basic')], snapshot().building.subItems), []);
});

test('メーター番号は前後の空白を除いて保存される', async () => {
  reset();
  const next = snapshot({ meters: [meter('M1', ' A-1 ')] });
  await saveMeterReading(client, 'A1', 2026, 9, next, next);
  assert.equal(rowsOf('asset_meter', 'upsert')?.[0].meter_code, 'A-1');
});

test('分割した行だけ識別名を保存する', async () => {
  reset();
  const split = { ...contractRow('C1'), splitLabel: ' 3F ' };
  const next = snapshot({ tenants: [
    { id: 'T1', name: 'テナント1', splitEnabled: true, rows: [split, { ...contractRow('C2'), splitLabel: '' }], invoiceSplitByUnit: false, expected: 0 },
    { id: 'T2', name: 'テナント2', splitEnabled: false, rows: [{ ...contractRow('C3'), splitLabel: '残っていた名前' }], invoiceSplitByUnit: false, expected: 0 },
  ] });
  await saveMeterReading(client, 'A1', 2026, 9, next, next);
  assert.deepEqual(rowsOf('meter_reading_contract', 'upsert')?.map((row) => row.split_label), ['3F', null, null]);
});

test('メーターは画面の並び順を保存する', async () => {
  reset();
  const next = snapshot({ meters: [meter('M2', 'B-1'), meter('M1', 'A-1')] });
  await saveMeterReading(client, 'A1', 2026, 9, next, next);
  assert.deepEqual(rowsOf('asset_meter', 'upsert')?.map((row) => [row.meter_code, row.sort_order]), [['B-1', 0], ['A-1', 1]]);
});

test('変動単価の小分類だけ、決め方・単価の丸めと月次の入力を保存する', async () => {
  reset();
  const next = snapshot();
  next.building.subItems[1] = {
    ...next.building.subItems[1], priceMode: 'variable', variablePriceMethod: 'billed', unitPriceRoundingDigits: 3, unitPriceRoundingMode: 'round',
    monthly: { unitPrice: 300, billedInclusive: 110000, billedTax: null, billedExclusive: null, billedUsage: 325 },
  };
  await saveMeterReading(client, 'A1', 2026, 9, next, next);
  const saved = rowsOf('asset_meter_sub_item', 'upsert')?.find((row) => row.asset_meter_sub_item_id === 'light');
  assert.equal(saved?.variable_price_method, 'billed');
  assert.equal(saved?.unit_price_rounding_digits, 3);
  assert.equal(saved?.unit_price_rounding_mode, 'round');
  assert.equal(saved?.show_unit_price_on_invoice, true);
  // 手入力の単価も、切り替えて戻したときのために残します。
  assert.deepEqual(rowsOf('meter_reading_month_sub_item', 'upsert'), [{
    asset_id: 'A1', billing_month: '2026-09-01', asset_meter_sub_item_id: 'light',
    unit_price: 300, billed_inclusive: 110000, billed_tax: null, billed_exclusive: null, billed_usage: 325,
  }]);
  // 月次の入力は、検針日のヘッダーより後に書き込みます（外部キーの参照先のため）。
  const order = calls.map((entry) => entry.table);
  assert.ok(order.indexOf('meter_reading_month') < order.indexOf('meter_reading_month_sub_item'));
});

test('固定単価だけなら、単価計算の月次入力は書き込まない', async () => {
  reset();
  await saveMeterReading(client, 'A1', 2026, 9, snapshot(), snapshot());
  assert.equal(rowsOf('meter_reading_month_sub_item', 'upsert'), undefined);
});

test('仕入を入れた増額分は、算出した税抜単価と仕入の情報を保存する', async () => {
  reset();
  const next = snapshot();
  next.building.surcharges = [{
    id: 'S1', name: '電気増額分', categoryId: 'electric', unitPrice: 99, lineItemId: '', billable: true,
    purchase: { periodStart: '2026-08-01', periodEnd: '2026-08-31', amountInclusive: 100000, usage: 3000 }, periodPatternId: 'P1',
  }];
  await saveMeterReading(client, 'A1', 2026, 9, next, next);
  // 回収：基本料50,379＋564.5kWh×31.65＝17,866（四捨五入）→ 68,245円 → 税込75,070円（75069.5を四捨五入）
  // 差額 24,930円 ÷564.5kWh＝44.163… → ÷1.1＝40.148… → 切り上げで40.15
  assert.deepEqual(rowsOf('meter_reading_month_surcharge', 'upsert'), [{
    asset_id: 'A1', billing_month: '2026-09-01', asset_meter_surcharge_id: 'S1', unit_price: 40.15,
    purchase_period_start: '2026-08-01', purchase_period_end: '2026-08-31', purchase_amount_inclusive: 100000, purchase_usage: 3000,
  }]);
  assert.equal(rowsOf('asset_meter_surcharge', 'upsert')?.[0].billing_period_pattern_id, 'P1');
});

test('メーター識別は階数の英数字だけにする', () => {
  assert.equal(floorLabel('２Ｆ 南'), '2F');
  assert.equal(floorLabel('b1f'), 'B1F');
  assert.equal(floorLabel('7F・北'), '7F');
});

// ---- 対象月の計算（区画の入居テナントへの振り分け） ----

test('区画の入居テナントに請求する', () => {
  const { results } = computeMonth(snapshot(), 2026, 9);
  // 564.5kWh×31.65＝17,866.4 → 四捨五入で17,866円、基本料50,379円
  assert.equal(results[0].total, 17866 + 50379);
});

test('月途中の退去：中間検針までを前テナント、以降を次テナントに請求し、一覧に居ないテナントは加える', () => {
  // 検針期間 8/6～9/5。8/20に T1 が退去、8/21～8/31 は空室、9/1から T2 が入居。
  const occupancy = new Map([...occupied('2026-08-01', '2026-08-20'), ...occupied('2026-09-01', '2026-10-31', { U1: ['T2', 'テナント2'] })]);
  const next = snapshot({
    meterDate: '2026-09-05', previousMeterDate: '2026-08-05', occupancy,
    meters: [assetMeter('M1', 'A-1', { usage: 0, previousReading: 1000, currentReading: 1300, breaks: [
      { date: '2026-08-20', reading: 1150, usage: null },
      { date: '2026-08-31', reading: 1200, usage: null },
    ] })],
  });
  next.building.subItems[1] = { ...next.building.subItems[1], inputMode: 'reading' };
  const month = computeMonth(next, 2026, 9);
  assert.deepEqual(month.allocations[0].segments.map((row) => [row.from, row.to, row.tenantId, row.usage]), [
    ['2026-08-06', '2026-08-20', 'T1', 150],
    ['2026-08-21', '2026-08-31', '', 50],
    ['2026-09-01', '2026-09-05', 'T2', 100],
  ]);
  assert.deepEqual(month.tenants.map((row) => row.id), ['T1', 'T2']);
  const light = (tenantId: string) => month.results.find((row) => row.tenant.id === tenantId)?.rows[0].categories[0].subItems.find((item) => item.subItem.id === 'light');
  assert.equal(light('T1')?.usage, 150);
  assert.equal(light('T2')?.usage, 100);
  assert.deepEqual(month.allocations[0].problems, []);
});

test('基本料は検針期間のうち入居していた日数で日割りする', () => {
  // 検針期間 8/6～9/4（30日）のうち、T1 は 8/6～8/20 の15日だけ入居。
  const next = snapshot({ meterDate: '2026-09-04', previousMeterDate: '2026-08-05', occupancy: occupied('2026-08-01', '2026-08-20') });
  const month = computeMonth(next, 2026, 9);
  assert.deepEqual(month.ratios.get('C1'), { days: 15, totalDays: 30 });
  const basic = month.results[0].rows[0].categories[0].subItems.find((item) => item.subItem.id === 'basic');
  // 50,379×15/30＝25,189.5 → テナントの小数点（四捨五入）で25,190円
  assert.equal(basic?.amount, 25190);
  assert.equal(basic?.groups[0].label, '日割り（15／30日）');
});
