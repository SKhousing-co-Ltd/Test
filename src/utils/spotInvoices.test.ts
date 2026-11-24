import assert from 'node:assert/strict';
import test from 'node:test';
import { beginSpotReissue, changeSpotPostingMonth, issueSpot, spotInvoicesForMonth } from './spotInvoices.ts';
import type { InvoiceRow, InvoiceSheet, SpotInvoice } from './invoiceSheet.ts';

const row = (id: string): InvoiceRow => {
  const values = Array.from({ length: 21 }, () => '');
  values[0] = '1'; values[1] = '1401'; values[2] = 'テナント'; values[3] = '件名'; values[11] = '看板料'; values[15] = '1000'; values[18] = '課税';
  return { id, invoiceKey: id, tenantId: 'tenant', tenantName: 'テナント', floor: '', chargeType: '看板料', values };
};
const spot = (id: string, postingMonth: string): SpotInvoice => ({ id, postingMonth, createdAt: '2026-11-24T00:00:00Z', state: 'draft', rows: [row(id)] });
const sheet = (spotInvoices: SpotInvoice[]): InvoiceSheet => ({ rows: [], spotInvoices, duePatternByInvoice: {}, dueDateByPattern: {}, periodPatternByRow: {}, periodRangeByPattern: {}, invoiceNote: '', showInvoiceNote: false });

test('発行月と異なる計上月にも、スポット請求書を一度だけ集計する', () => {
  const future = issueSpot(spot('future', '2027-02-01'), '2026-11-24T00:00:00Z');
  const november = issueSpot(spot('november', '2026-11-01'), '2026-11-24T00:00:00Z');
  const sheets = [sheet([future]), sheet([november])];
  assert.deepEqual(spotInvoicesForMonth(sheets, '2026-11-01').map((item) => item.id), ['november']);
  assert.deepEqual(spotInvoicesForMonth(sheets, '2027-02-01').map((item) => item.id), ['future']);
  const moved = changeSpotPostingMonth(future, '2026-11-01');
  assert.deepEqual(spotInvoicesForMonth([sheet([moved]), sheet([november])], '2026-11-01').map((item) => item.id), ['future', 'november']);
  assert.deepEqual(spotInvoicesForMonth([sheet([moved])], '2027-02-01'), []);
  assert.equal(moved.rows[0].values[15], future.rows[0].values[15]);
});

test('再発行は件名に接頭辞を付け、請求済みから編集へ戻す', () => {
  const issued = issueSpot(spot('a', '2026-11-01'), '2026-11-24T00:00:00Z');
  const reissuing = beginSpotReissue(issued);
  assert.equal(reissuing.state, 'reissuing');
  assert.equal(reissuing.rows[0].values[3], '【再発行】件名');
  assert.equal(beginSpotReissue(reissuing).rows[0].values[3], '【再発行】件名');
});
