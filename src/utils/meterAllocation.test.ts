// メーターを区画の入居テナントへ振り分ける計算を確かめます。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, allocateMeters, basicRatios, meterProblems, occupantChanges, proratedAmount, readingPeriod, reassignUnit, segmentsOf, totalUsage, unitAt,
  type AssetMeter, type Occupancy,
} from './meterAllocation.ts';
import type { ContractRow, TenantConfig } from './meterReading.ts';

const meter = (over: Partial<AssetMeter> = {}): AssetMeter => ({
  id: 'M1', subItemId: 'light', code: 'A-1', label: '2F', assignments: [{ id: 'A1', unitId: 'U1', from: '1900-01-01', to: null }], usage: 0,
  previousReading: null, currentReading: null, previousReadingManual: false, exchange: null, breaks: [],
  ...over,
});
const occupancyOf = (days: Array<[string, string, Record<string, string>]>): Occupancy => {
  const map: Occupancy = new Map();
  for (const [from, to, units] of days) {
    for (let date = from; date <= to; date = addDays(date, 1)) {
      map.set(date, new Map(Object.entries(units).map(([unitId, tenantId]) => [unitId, { tenantId, tenantName: `名前${tenantId}`, unitType: 'office' }])));
    }
  }
  return map;
};
const row = (id: string, unitIds: string[] = []): ContractRow => ({
  id, invoiceNo: 1, categoryBillable: { electric: true, water: true, gas: true }, billable: {}, unitPrices: {}, fixedCharges: {},
  sumMode: { electric: 'aggregate', water: 'aggregate', gas: 'aggregate' }, amountRoundingMode: 'floor', note: '', splitLabel: '', unitIds,
});
const tenant = (id: string, rows: ContractRow[] = [row(`${id}-R1`)]): TenantConfig => ({ id, name: id, splitEnabled: rows.length > 1, rows, invoiceSplitByUnit: false, expected: 0 });
const period = { start: '2026-08-06', end: '2026-09-05' };

test('検針期間は前回検針日の翌日から検針日まで、日付が無ければ請求月の1日・末日で補う', () => {
  assert.deepEqual(readingPeriod(2026, 9, '2026-09-05', '2026-08-05'), { start: '2026-08-06', end: '2026-09-05' });
  assert.deepEqual(readingPeriod(2026, 9, '', ''), { start: '2026-09-01', end: '2026-09-30' });
  assert.deepEqual(readingPeriod(2026, 1, '2026-01-06', '2025-12-05'), { start: '2025-12-06', end: '2026-01-06' });
});

test('区画を選び直すと、対象月の1日から新しい区画にし、前の月は元の区画のまま残す', () => {
  let id = 0;
  const next = reassignUnit([{ id: 'A1', unitId: 'U1', from: '1900-01-01', to: null }], 'U2', '2026-09-01', () => `N${++id}`);
  assert.deepEqual(next, [
    { id: 'A1', unitId: 'U1', from: '1900-01-01', to: '2026-08-31' },
    { id: 'N1', unitId: 'U2', from: '2026-09-01', to: null },
  ]);
  assert.equal(unitAt(meter({ assignments: next }), '2026-08-31'), 'U1');
  assert.equal(unitAt(meter({ assignments: next }), '2026-09-01'), 'U2');
});

test('初めての割り当ては当初から、同じ月に選び直したら置き換え、元の区画に戻したらつなげる', () => {
  let id = 0;
  const newId = () => `N${++id}`;
  assert.deepEqual(reassignUnit([], 'U1', '2026-09-01', newId), [{ id: 'N1', unitId: 'U1', from: '1900-01-01', to: null }]);
  const moved = reassignUnit([{ id: 'A1', unitId: 'U1', from: '1900-01-01', to: null }], 'U2', '2026-09-01', newId);
  assert.deepEqual(reassignUnit(moved, 'U3', '2026-09-01', newId).map((item) => [item.unitId, item.from, item.to]), [['U1', '1900-01-01', '2026-08-31'], ['U3', '2026-09-01', null]]);
  assert.deepEqual(reassignUnit(moved, 'U1', '2026-09-01', newId), [{ id: 'A1', unitId: 'U1', from: '1900-01-01', to: null }]);
  // 未割当に戻すと、対象月から紐づけがなくなります。
  assert.deepEqual(reassignUnit(moved, '', '2026-09-01', newId), [{ id: 'A1', unitId: 'U1', from: '1900-01-01', to: '2026-08-31' }]);
});

test('指針入力の使用量は当月−前月、メーター交換があれば旧・新メーター分を足す', () => {
  assert.equal(totalUsage(meter({ previousReading: 100.5, currentReading: 150.2 }), 'reading'), 49.7);
  assert.equal(totalUsage(meter({ previousReading: 100, currentReading: null }), 'reading'), 0);
  assert.equal(totalUsage(meter({ previousReading: 900, currentReading: 20, exchange: { removedReading: 950, installedReading: 5 } }), 'reading'), 65);
  assert.equal(totalUsage(meter({ usage: 12.3, previousReading: 1, currentReading: 2 }), 'usage'), 12.3);
});

test('使用量入力の中間検針は、区切りまでの使用量を入れ、最後の区間は全体から引く', () => {
  const segments = segmentsOf(meter({ usage: 100, breaks: [{ date: '2026-08-31', reading: null, usage: 30 }, { date: '2026-08-20', reading: null, usage: 45 }] }), 'usage', period, '2026-09-01');
  assert.deepEqual(segments, [
    { from: '2026-08-06', to: '2026-08-20', asOf: '2026-08-20', usage: 45 },
    { from: '2026-08-21', to: '2026-08-31', asOf: '2026-08-21', usage: 30 },
    { from: '2026-09-01', to: '2026-09-05', asOf: '2026-09-01', usage: 25 },
  ]);
});

test('中間検針が無ければ、請求月の1日時点の入居テナントに全体を請求する', () => {
  const occupancy = occupancyOf([['2026-08-01', '2026-10-31', { U1: 'T1' }]]);
  const { shares, allocations } = allocateMeters([meter({ usage: 80 })], () => 'usage', [tenant('T1')], occupancy, period, '2026-09-01');
  assert.deepEqual(shares.map((share) => [share.id, share.tenantId, share.usage]), [['M1', 'T1', 80]]);
  assert.deepEqual(allocations[0].warnings, []);
});

test('分割行の区画に設定した区画のメーターは、その行で計算する', () => {
  const occupancy = occupancyOf([['2026-08-01', '2026-10-31', { U1: 'T1', U2: 'T1' }]]);
  const split = tenant('T1', [row('R1'), row('R2', ['U2'])]);
  const { shares } = allocateMeters([meter({ usage: 1 }), meter({ id: 'M2', usage: 2, assignments: [{ id: 'A2', unitId: 'U2', from: '1900-01-01', to: null }] })], () => 'usage', [split], occupancy, period, '2026-09-01');
  assert.deepEqual(shares.map((share) => [share.id, share.rowIndex]), [['M1', 0], ['M2', 1]]);
});

test('区画が未割当のメーター・空室の区画は、請求先なしになる', () => {
  const occupancy = occupancyOf([['2026-08-01', '2026-10-31', { U9: 'T1' }]]);
  const { shares, allocations } = allocateMeters([meter({ usage: 5 }), meter({ id: 'M2', assignments: [], usage: 3 })], () => 'usage', [tenant('T1')], occupancy, period, '2026-09-01');
  assert.deepEqual(shares.map((share) => share.tenantId), ['', '']);
  assert.deepEqual(allocations[1].warnings, ['区画が未割当です']);
});

test('中間検針を入れていないのに期間中に入居者が替わったら、知らせる', () => {
  const occupancy = occupancyOf([['2026-08-01', '2026-08-20', { U1: 'T1' }], ['2026-08-21', '2026-08-31', {}], ['2026-09-01', '2026-10-31', { U1: 'T2' }]]);
  assert.deepEqual(occupantChanges(meter(), occupancy, period), ['2026/8/21から空室', '2026/9/1から名前T2']);
});

test('入力の不備：期間外・重複・未入力の中間検針、マイナスの使用量', () => {
  assert.deepEqual(meterProblems(meter({ breaks: [{ date: '2026-09-05', reading: null, usage: 1 }] }), 'usage', period), ['中間検針の日付は検針期間（2026/8/6～2026/9/5）の途中にしてください']);
  assert.deepEqual(meterProblems(meter({ breaks: [{ date: '2026-08-20', reading: null, usage: 1 }, { date: '2026-08-20', reading: null, usage: 1 }] }), 'usage', period), ['中間検針の日付が重複しています']);
  assert.deepEqual(meterProblems(meter({ previousReading: 10, currentReading: 20, breaks: [{ date: '2026-08-20', reading: null, usage: null }] }), 'reading', period), ['中間検針の指針が未入力です']);
  assert.deepEqual(meterProblems(meter({ previousReading: 10, currentReading: 5 }), 'reading', period), ['使用量がマイナスになります。指針を確認してください']);
  assert.deepEqual(meterProblems(meter({ previousReading: null, currentReading: 5 }), 'reading', period), ['前月指針が未入力です']);
  assert.deepEqual(meterProblems(meter({ previousReading: 1, currentReading: 5, exchange: { removedReading: 2, installedReading: 0 }, breaks: [{ date: '2026-08-20', reading: 3, usage: null }] }), 'reading', period), ['メーター交換と中間検針は同じ月に入力できません']);
});

test('基本料の日割りは、分割行ごとに入居日数を数え、全日入居なら満額のまま', () => {
  const occupancy = occupancyOf([['2026-08-06', '2026-08-20', { U1: 'T1', U2: 'T1' }], ['2026-08-21', '2026-09-05', { U2: 'T1' }]]);
  const split = tenant('T1', [row('R1'), row('R2', ['U2'])]);
  const ratios = basicRatios([split], occupancy, period);
  assert.deepEqual(ratios.get('R1'), { days: 15, totalDays: 31 });
  assert.deepEqual(ratios.get('R2'), { days: 31, totalDays: 31 });
  assert.equal(proratedAmount(10000, ratios.get('R1'), 'floor'), 4838); // 10000×15/31＝4838.7…
  assert.equal(proratedAmount(10000, ratios.get('R1'), 'ceil'), 4839);
  assert.equal(proratedAmount(10000, ratios.get('R2'), 'floor'), 10000);
});
