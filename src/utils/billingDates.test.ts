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

import { isHoliday, termsDueDate, termsPeriod } from './billingDates.ts';

test('祝日（固定・ハッピーマンデー・春分秋分・振替・国民の休日）を判定する', () => {
  assert.equal(isHoliday(new Date(2026, 0, 12)), true); // 成人の日
  assert.equal(isHoliday(new Date(2026, 2, 20)), true); // 春分の日
  assert.equal(isHoliday(new Date(2026, 4, 6)), true); // 振替休日（5/3日曜）
  assert.equal(isHoliday(new Date(2026, 8, 22)), true); // 国民の休日
  assert.equal(isHoliday(new Date(2026, 8, 23)), true); // 秋分の日
  assert.equal(isHoliday(new Date(2026, 9, 9)), false);
});

test('入金期日：当月末日・土日祝は前日（既定）', () => {
  const terms = { due_month_offset: 0, due_day_of_month: 0, due_holiday_adjustment: 'previous' as const };
  assert.equal(termsDueDate(2026, 10, terms), '2026/10/30'); // 10/31は土曜
  assert.equal(termsDueDate(2026, 5, terms), '2026/5/29'); // 5/31日曜
  assert.equal(termsDueDate(2026, 12, { ...terms, due_month_offset: 1, due_day_of_month: 31 }), '2027/1/29');
  assert.equal(termsDueDate(2026, 4, { ...terms, due_month_offset: 1, due_day_of_month: 4, due_holiday_adjustment: 'next' }), '2026/5/7'); // 5/4〜6祝日
});

test('請求期間：通常は1か月、年払いは請求月だけ12か月', () => {
  assert.deepEqual(termsPeriod(10, { period_month_offset: 1, is_annual_billing: false, annual_billing_month: null, annual_start_offset: null }), { billed: true, monthsCovered: 1, startOffset: 1, endOffset: 1 });
  const annual = { period_month_offset: 1, is_annual_billing: true, annual_billing_month: 10, annual_start_offset: 1 };
  assert.deepEqual(termsPeriod(10, annual), { billed: true, monthsCovered: 12, startOffset: 1, endOffset: 12 });
  assert.equal(termsPeriod(11, annual).billed, false);
  const range = periodRange(2026, 10, { start_month_offset: 1, start_day_type: 'first', end_month_offset: 12, end_day_type: 'last' });
  assert.deepEqual(range, { start: '2026/11/1', end: '2027/10/31' });
});
