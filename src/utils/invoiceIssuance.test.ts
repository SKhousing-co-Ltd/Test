import assert from 'node:assert/strict';
import test from 'node:test';
import { beginInvoiceReissue, exportableInvoiceKeys, markInvoicesIssued, rowsForInvoiceKeys } from './invoiceIssuance.ts';
import type { InvoiceRow, InvoiceSheet } from './invoiceSheet.ts';

const row = (invoiceKey: string, subject: string): InvoiceRow => ({
  id: invoiceKey, invoiceKey, tenantId: invoiceKey, tenantName: invoiceKey, floor: '', chargeType: '',
  values: Array.from({ length: 21 }, (_, index) => index === 3 ? subject : ''),
});
const sheet = (): InvoiceSheet => ({
  rows: [row('a', '通常'), row('b', '別の件名')], duePatternByInvoice: {}, dueDateByPattern: {},
  periodPatternByRow: {}, periodRangeByPattern: {}, invoiceNote: '', showInvoiceNote: false,
});

test('CSVに含めた請求書だけを請求済みにし、次回の出力から除外する', () => {
  const issued = markInvoicesIssued(sheet(), ['a'], '2026-11-24T00:00:00Z');
  assert.deepEqual(exportableInvoiceKeys(issued), ['b']);
  assert.deepEqual(rowsForInvoiceKeys(issued.rows, exportableInvoiceKeys(issued)).map((item) => item.invoiceKey), ['b']);
  assert.equal(issued.invoiceStatuses?.a?.issuedAt, '2026-11-24T00:00:00Z');
});

test('再発行は指定した請求書だけ解除し、件名の接頭辞を重複させない', () => {
  const issued = markInvoicesIssued(sheet(), ['a', 'b'], '2026-11-24T00:00:00Z');
  const reissuing = beginInvoiceReissue(issued, 'a');
  assert.equal(reissuing.rows[0].values[3], '【再発行】通常');
  assert.equal(reissuing.rows[1].values[3], '別の件名');
  assert.deepEqual(exportableInvoiceKeys(reissuing), ['a']);
  assert.equal(beginInvoiceReissue(reissuing, 'a').rows[0].values[3], '【再発行】通常');
  assert.deepEqual(exportableInvoiceKeys(markInvoicesIssued(reissuing, ['a'], '2026-11-25T00:00:00Z')), []);
});
