import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecurringInvoiceRows, removeManualInvoiceRow } from './recurringInvoiceRows.ts';
import type { InvoiceRow, InvoiceSheet } from './invoiceSheet.ts';

const row = (month: string, manual = false): InvoiceRow => {
  const values = Array.from({ length: 21 }, () => '');
  values[1] = '1401'; values[2] = 'テナント'; values[11] = manual ? '管理費' : '賃料'; values[15] = manual ? '1,000' : '10,000'; values[18] = '課税';
  return { id: manual ? `invoice:manual:abc` : `invoice:${month}:rent`, invoiceKey: 'invoice', values, chargeType: values[11], tenantId: 'tenant', tenantName: 'テナント', floor: '', recurring: manual ? { id: 'abc', startMonth: '2026-11-01' } : undefined };
};
const sheet = (rows: InvoiceRow[]): InvoiceSheet => ({ rows, duePatternByInvoice: {}, dueDateByPattern: {}, periodPatternByRow: {}, periodRangeByPattern: {}, invoiceNote: '', showInvoiceNote: false });

test('継続明細を翌月以降に1行ずつ引き継ぎ、同月に重複させない', () => {
  const november = sheet([row('11'), row('11', true)]);
  const december = mergeRecurringInvoiceRows(sheet([row('12')]), [november], '2026-12-01');
  assert.deepEqual(december.rows.map((item) => item.values[11]), ['賃料', '管理費']);
  assert.equal(december.rows[0].values[5], '11,000');
  assert.equal(december.rows[1].values[16], '100');
  assert.equal(december.rows[1].values[17], '1,100');
  assert.equal(mergeRecurringInvoiceRows(december, [november], '2026-12-01').rows.length, 2);
  assert.equal(mergeRecurringInvoiceRows(sheet([row('10')]), [november], '2026-10-01').rows.length, 1);
});

test('継続明細を削除すると以後の月に再表示しない', () => {
  const november = sheet([row('11'), row('11', true)]);
  const december = mergeRecurringInvoiceRows(sheet([row('12')]), [november], '2026-12-01');
  const cancelled = removeManualInvoiceRow(december, 'invoice:manual:abc');
  assert.equal(cancelled.rows.length, 1);
  assert.deepEqual(cancelled.cancelledRecurringIds, ['abc']);
  const january = mergeRecurringInvoiceRows(sheet([row('01')]), [cancelled, november], '2027-01-01');
  assert.equal(january.rows.length, 1);
});
