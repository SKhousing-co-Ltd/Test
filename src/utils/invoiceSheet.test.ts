// 請求書作成の金額の出し直しと、入金明細・請求明細への集計を確かめます。
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyValues, recalcInvoices, statementRows, taxRateOf, type InvoiceRow } from './invoiceSheet.ts';

const line = (invoiceKey: string, index: number, amount: string, category: string, chargeType: string, first: Partial<Record<number, string>> = {}): InvoiceRow => {
  const values = emptyValues();
  values[15] = amount; values[18] = category;
  for (const [column, value] of Object.entries(first)) values[Number(column)] = value ?? '';
  return { id: `${invoiceKey}:${index}`, invoiceKey, values, chargeType, tenantId: invoiceKey.split(':')[0], tenantName: `名前${invoiceKey}`, floor: '2F' };
};

test('消費税は請求書ごとに、課税の明細の合計の10%を切り捨てる', () => {
  const rows = recalcInvoices([
    line('T1:C1', 0, '100,005', '課税', '賃料', { 1: 'A001', 2: 'テナントA', 4: '2026/9/30' }),
    line('T1:C1', 1, '20,000', '非課税', '共益費'),
    line('T1:C1', 2, '1,239', '課税', '電気代'),
    line('T1:C1', 3, '500', '不課税', 'その他'),
    line('T2:C2', 0, '9', '課税', '賃料', { 1: 'B001' }),
  ]);
  // 課税 101,244 → 10,124.4 → 10,124円。税抜は全明細の合計 121,744円。
  assert.deepEqual([rows[0].values[5], rows[0].values[6], rows[0].values[7]], ['121,744', '10,124', '131,868']);
  // 金額は請求書の最初の行だけに入れます。
  assert.deepEqual([rows[1].values[5], rows[1].values[6]], ['', '']);
  assert.deepEqual([rows[4].values[5], rows[4].values[6], rows[4].values[7]], ['9', '0', '9']);
  // 税率は課税の明細だけ10%です。
  assert.deepEqual(rows.map((row) => row.values[19]), ['10%', '', '10%', '', '10%']);
});

test('税区分を変えると、消費税と税率が変わる', () => {
  const rows = recalcInvoices([line('T1:C1', 0, '1,000', '課税', '賃料'), line('T1:C1', 1, '1,000', '課税', '共益費')]);
  assert.equal(rows[0].values[6], '200');
  const changed = recalcInvoices(rows.map((row, index) => index === 1 ? { ...row, values: row.values.map((value, column) => column === 18 ? '非課税' : value) } : row));
  assert.deepEqual([changed[0].values[5], changed[0].values[6], changed[0].values[7], changed[1].values[19]], ['2,000', '100', '2,100', '']);
  assert.equal(taxRateOf('不課税'), '');
});

test('入金明細・請求明細は、請求書1通を1行にして請求種別ごとに合計する', () => {
  const rows = statementRows([
    line('T1:C1', 0, '100,000', '課税', '賃料', { 1: 'A001', 2: 'テナントA（表示名）', 4: '2026/9/30' }),
    line('T1:C1', 1, '1,000', '課税', '電気代'),
    line('T1:C1', 2, '2,000', '課税', '電気代'),
    line('T2:C2', 0, '5,000', '非課税', '共益費', { 1: 'B001', 2: 'テナントB' }),
  ]);
  assert.deepEqual(rows.map((row) => [row.code, row.tenantName, row.amounts, row.subtotal, row.tax, row.total, row.dueDate]), [
    ['A001', 'テナントA（表示名）', { 賃料: 100000, 電気代: 3000 }, 103000, 10300, 113300, '2026/9/30'],
    ['B001', 'テナントB', { 共益費: 5000 }, 5000, 0, 5000, ''],
  ]);
});
