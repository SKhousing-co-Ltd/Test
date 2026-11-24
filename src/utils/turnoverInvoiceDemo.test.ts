import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnoverInvoiceDemo } from './turnoverInvoiceDemo.ts';
import { numberValue } from './invoiceSheet.ts';

test('日本橋601の入退去月は旧テナント満額・新テナント日割り・公共料金を分けて請求する', async () => {
  const { sheet, meterNotice } = await buildTurnoverInvoiceDemo();
  assert.equal(meterNotice, '');
  const amounts = sheet.rows.map((row) => [row.tenantId, row.values[11], numberValue(row.values[15])]);
  assert.deepEqual(amounts, [
    ['demo-former', '賃料', 100000], ['demo-former', '共益費', 20000], ['demo-former', '電気代', 7894],
    ['demo-incoming', '賃料', 35483], ['demo-incoming', '共益費', 7096], ['demo-incoming', '電気代', 7875],
  ]);
  assert.equal(sheet.rows.some((row) => row.tenantId === 'vacant'), false);
  assert.equal(numberValue(sheet.rows[0].values[5]), 127894);
  assert.equal(numberValue(sheet.rows[3].values[5]), 50454);
  assert.match(sheet.rows[3].values[20], /31日のうち11日分/);
  assert.equal(sheet.rows[0].values[10], '2026/10/1～2026/10/31分');
  assert.equal(sheet.rows[3].values[10], '2026/10/21～2026/10/31分');
  assert.equal(sheet.rows[4].values[10], '2026/10/21～2026/10/31分');
  assert.equal(sheet.rows[2].values[10], '2026/10/1～2026/10/10分');
  assert.equal(sheet.rows[5].values[10], '2026/10/21～2026/10/31分');
});
