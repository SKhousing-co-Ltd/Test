import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRevenueEntries, mirokuHeaders, renderRevenueCsv, type PostingSource, type RevenueAccount } from './revenuePostingCsv.ts';
import { emptyValues, type InvoiceRow, type InvoiceSheet } from './invoiceSheet.ts';

const accounts: RevenueAccount[] = [{ charge_type_name: '賃料', is_fixed_charge: true, revenue_account_code: '4100', revenue_subaccount_code: '1' }];
function source(net: number, periodStart: string, periodEnd: string, tax = true): PostingSource {
  const values = emptyValues(); values[1] = '1401'; values[2] = 'テストテナント'; values[11] = '賃料'; values[15] = String(net); values[18] = tax ? '課税' : '非課税';
  const row: InvoiceRow = { id: 'row-1', invoiceKey: 'invoice-1', values, chargeType: '賃料', tenantId: 'tenant-1', tenantName: 'テストテナント', floor: '1F' };
  const sheet: InvoiceSheet = { rows: [row], duePatternByInvoice: {}, dueDateByPattern: {}, periodPatternByRow: { 'row-1': 'period-1' }, periodRangeByPattern: { 'period-1': { start: periodStart, end: periodEnd } }, invoiceNote: '', showInvoiceNote: false };
  return { sourceKind: 'monthly', sourceKey: 'invoice-1', rows: [row], sheet, billingMonth: '2026-11-01', issuedOn: '2026-11-01', propertyCode: '14', propertyName: '日本橋' };
}
const simplified = (entries: ReturnType<typeof buildRevenueEntries>) => entries.map((entry) => ({ date: entry.cells[0], debit: entry.cells[1], credit: entry.cells[12], sub: entry.cells[13], amount: Number(entry.cells[9]), immediate: entry.immediate }));

test('ミロク CSV は見本と同じ31列で、取引先と物件コードを両側に出す', () => {
  const entries = buildRevenueEntries(source(10000, '2026-11-01', '2026-11-30'), accounts);
  assert.equal(mirokuHeaders.length, 31);
  assert.equal(entries[0].cells.length, 31);
  assert.equal(entries[0].cells[4], '1401'); assert.equal(entries[0].cells[15], '1401');
  assert.equal(entries[0].cells[6], '14'); assert.equal(entries[0].cells[17], '14');
  assert.equal(entries[0].cells[9], '11000'); assert.equal(entries[0].cells[20], '11000');
  assert.equal(entries[0].cells[24], ''); assert.equal(entries[0].cells[25], '');
  assert.equal(renderRevenueCsv(entries).split('\r\n').length, 3);
});
test('翌月分は請求時の前受金と翌月の売上振替を同時出力する', () => {
  assert.deepEqual(simplified(buildRevenueEntries(source(10000, '2026-12-01', '2026-12-31'), accounts)), [
    { date: '2026/11/01', debit: '1530', credit: '3160', sub: '', amount: 11000, immediate: true },
    { date: '2026/12/01', debit: '3160', credit: '4100', sub: '1', amount: 11000, immediate: true },
  ]);
});
test('請求日の仕訳には実際の発行日を使い、振替は対象月1日とする', () => {
  const input = source(10000, '2026-12-01', '2026-12-31'); input.issuedOn = '2026-11-15';
  const entries = buildRevenueEntries(input, accounts);
  assert.equal(entries[0].cells[0], '2026/11/15'); assert.equal(entries[1].cells[0], '2026/12/01');
});
test('前月分の固定費は前月末に先行計上し、請求日に同額を戻す', () => {
  assert.deepEqual(simplified(buildRevenueEntries(source(10000, '2026-10-01', '2026-10-31'), accounts)), [
    { date: '2026/10/31', debit: '1530', credit: '4100', sub: '1', amount: 11000, immediate: true },
    { date: '2026/11/01', debit: '4100', credit: '1530', sub: '', amount: 11000, immediate: true },
    { date: '2026/11/01', debit: '1530', credit: '4100', sub: '1', amount: 11000, immediate: true },
  ]);
});
test('固定費ではない前月分は請求日の売上だけを出す', () => {
  const variable = [{ ...accounts[0], is_fixed_charge: false }];
  const entries = buildRevenueEntries(source(10000, '2026-10-01', '2026-10-31'), variable);
  assert.equal(entries.length, 1); assert.equal(entries[0].cells[0], '2026/11/01');
});
test('未定義の複数月期間は誤計上を避けて停止する', () => {
  assert.throws(() => buildRevenueEntries(source(10000, '2026-10-01', '2026-11-30'), accounts), /計上ルール/);
});
test('年払いの税抜・消費税・税込端数は初月で調整し、後続振替を別月に送る', () => {
  const entries = buildRevenueEntries(source(100001, '2026-12-01', '2027-11-30'), accounts);
  assert.equal(entries.length, 13); assert.equal(entries[0].immediate, true);
  assert.equal(entries[1].cells[0], '2026/12/01'); assert.equal(entries[1].cells[9], '9175'); assert.equal(entries[1].immediate, false);
  assert.equal(entries[2].cells[9], '9166'); assert.equal(entries[12].cells[0], '2027/11/01');
  assert.equal(entries.slice(1).reduce((sum, row) => sum + Number(row.cells[9]), 0), 110001);
});
test('敷金は管理表の貸方科目を使い前受金・賃貸売上にしない', () => {
  const input = source(75000, '2026-11-01', '2026-11-30', false);
  input.rows[0].depositId = 'deposit-1'; input.rows[0].postingAccountCode = '3600'; input.rows[0].postingSubaccountCode = '';
  const rows = buildRevenueEntries(input, accounts);
  assert.equal(rows.length, 1); assert.equal(rows[0].cells[12], '3600'); assert.equal(rows[0].cells[9], '75000');
});
