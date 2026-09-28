// 保存処理が、画面の状態をどのテーブルの行へ写すかを確かめます。
// Supabaseの代わりに、呼び出しを記録するだけの相手を渡しています。
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { meterCodeProblems, saveMeterReading, type MeterReadingSnapshot } from './meterReadingStore.ts';
import type { ContractRow, RoundingMode, SubItem, SumMode } from './meterReading.ts';

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
  usageRoundingDigits: 1, usageRoundingMode: 'round', periodPatternId: '',
});
const contractRow = (id: string): ContractRow => ({
  id, invoiceNo: 1,
  categoryBillable: { electric: true, water: true, gas: true },
  billable: { basic: true, light: true },
  unitPrices: { light: 31.65 },
  fixedCharges: { basic: 50379 },
  sumMode: { electric: 'aggregate' as SumMode, water: 'aggregate' as SumMode, gas: 'aggregate' as SumMode },
  amountRoundingMode: 'round' as RoundingMode, note: '', splitLabel: '',
});
const snapshot = (over: Partial<MeterReadingSnapshot> = {}): MeterReadingSnapshot => ({
  building: {
    categories: [{ id: 'electric', name: '電気', unit: 'kWh', billable: true, fixedBillable: true }],
    subItems: [subItem('basic', '基本料', 'basic'), subItem('light', '電灯', 'custom')],
    surcharges: [], taxRate: 0.1,
  },
  tenants: [{ id: 'T1', name: 'テナント1', splitEnabled: false, rows: [contractRow('C1')], invoiceSplitByUnit: false, expected: 0 }],
  meters: [{ id: 'M1', subItemId: 'light', code: '223-607-805', label: '2F 南', tenantId: 'T1', rowIndex: 0, usage: 564.5 }],
  meterDate: '2026-09-02', previousMeterDate: '', status: 'draft', unresolvedContracts: {},
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
  assert.deepEqual(rowsOf('meter_reading_entry', 'upsert')?.[0], { asset_id: 'A1', billing_month: '2026-09-01', asset_meter_id: 'M1', usage_amount: 564.5 });
  const month = calls.find((entry) => entry.table === 'meter_reading_month' && entry.op === 'upsert')?.rows as Record<string, unknown>;
  assert.equal(month.meter_date, '2026-09-02');
  assert.equal(month.billing_month, '2026-09-01');
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
  base.meters.push({ id: 'M2', subItemId: 'ac', code: 'AC-1', label: '', tenantId: 'T1', rowIndex: 0, usage: 1 });
  base.tenants[0].rows.push(contractRow('C2'));
  await saveMeterReading(client, 'A1', 2026, 9, snapshot(), base);
  assert.deepEqual(filtersOf('asset_meter_sub_item', 'delete'), [['asset_meter_sub_item_id', ['ac']]]);
  assert.deepEqual(filtersOf('meter_reading_contract', 'delete'), [['meter_reading_contract_id', ['C2']]]);
  // 小分類と一緒に消えるメーターは、個別には削除しません。
  assert.equal(filtersOf('asset_meter', 'delete'), undefined);
});

test('対象月に居ないテナントのメーターは、割り当てを保ったまま保存される', async () => {
  reset();
  const next = snapshot({
    meters: [{ id: 'M9', subItemId: 'light', code: 'OLD-1', label: '', tenantId: '', rowIndex: 0, usage: 0 }],
    unresolvedContracts: { M9: 'C-OLD' },
  });
  await saveMeterReading(client, 'A1', 2026, 9, next, next);
  assert.equal(rowsOf('asset_meter', 'upsert')?.[0].meter_reading_contract_id, 'C-OLD');
});

test('画面で未割当にしたメーターは、割り当てなしで保存される', async () => {
  reset();
  const next = snapshot({ meters: [{ id: 'M1', subItemId: 'light', code: 'NEW-1', label: '', tenantId: '', rowIndex: 0, usage: 0 }] });
  await saveMeterReading(client, 'A1', 2026, 9, next, next);
  assert.equal(rowsOf('asset_meter', 'upsert')?.[0].meter_reading_contract_id, null);
});

const meter = (id: string, code: string, subItemId = 'light') => ({ id, subItemId, code, label: '', tenantId: 'T1', rowIndex: 0, usage: 0 });

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
