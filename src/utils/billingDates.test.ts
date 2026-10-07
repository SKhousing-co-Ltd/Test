// 請求期間の表示形式（YYYY/M/D）を確かめます。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePeriodDate, periodRange, periodText } from './billingDates.ts';

const monthly = { start_month_offset: 0, start_day_type: 'first', end_month_offset: 0, end_day_type: 'last' };

test('請求期間は月日をゼロ埋めせずに出す', () => {
  assert.deepEqual(periodRange(2026, 9, monthly), { start: '2026/9/1', end: '2026/9/30' });
  assert.deepEqual(periodRange(2026, 12, { ...monthly, start_month_offset: 1, end_month_offset: 1 }), { start: '2027/1/1', end: '2027/1/31' });
});

test('検針日基準の請求期間も YYYY/M/D で出す', () => {
  const meterBased = { start_month_offset: -1, start_day_type: 'meter', start_meter_day_offset: 1, end_month_offset: 0, end_day_type: 'meter' };
  assert.deepEqual(periodRange(2026, 9, meterBased, { previous: '2026-08-05', current: '2026-09-04' }), { start: '2026/8/6', end: '2026/9/4' });
});

test('手入力のゼロ埋め・ハイフン区切りも明細項目１では YYYY/M/D にそろえる', () => {
  assert.equal(normalizePeriodDate('2026/09/01'), '2026/9/1');
  assert.equal(normalizePeriodDate('2026-10-05'), '2026/10/5');
  assert.equal(normalizePeriodDate('未定'), '未定');
  assert.equal(periodText('2026/09/01', '2026/09/30'), '2026/9/1～2026/9/30分');
  assert.equal(periodText('', '2026/9/30'), '');
});
