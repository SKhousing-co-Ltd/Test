import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnoverInvoiceDemo } from './turnoverInvoiceDemo.ts';
import { buildBtobInvoiceCsv } from './btobInvoiceCsv.ts';
import { csvHeaders } from './invoiceSheet.ts';
import Encoding from 'encoding-japanese';

test('日本橋601の入退去請求をTRUE列なしの21列CSVへ出力する', async () => {
  const { sheet } = await buildTurnoverInvoiceDemo();
  const csv = buildBtobInvoiceCsv(sheet.rows);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, 7);
  assert.equal(lines[0], csvHeaders.join(','));
  assert.match(lines[1], /"100,000"/);
  assert.match(lines[3], /2026\/10\/1～2026\/10\/10分/);
  assert.match(lines[4], /2026\/10\/21～2026\/10\/31分/);
  assert.match(lines[5], /^2,検証002,【検証】入居テナント,,/);
  assert.ok(lines.slice(1).every((line) => !line.endsWith(',TRUE')));
  const bytes = Uint8Array.from(Encoding.convert(Encoding.stringToCode(csv), { to: 'SJIS', from: 'UNICODE', type: 'array', fallback: 'error' }));
  assert.equal(new TextDecoder('shift_jis').decode(bytes), csv);
});

test('未採番の請求先コードは出力前に止める', async () => {
  const { sheet } = await buildTurnoverInvoiceDemo();
  const rows = sheet.rows.map((row, index) => index === 0 ? { ...row, values: row.values.map((value, column) => column === 1 ? '未採番' : value) } : row);
  assert.throws(() => buildBtobInvoiceCsv(rows), /発行先コード/);
});

test('水道の単位 m³ は参考CSVと同じ m3 で出力する', async () => {
  const { sheet } = await buildTurnoverInvoiceDemo();
  const rows = sheet.rows.map((row, index) => index === 0 ? { ...row, values: row.values.map((value, column) => column === 13 ? 'm³' : value) } : row);
  const csv = buildBtobInvoiceCsv(rows);
  assert.match(csv, /,m3,/);
  assert.doesNotMatch(csv, /m³/);
  const bytes = Uint8Array.from(Encoding.convert(Encoding.stringToCode(csv), { to: 'SJIS', from: 'UNICODE', type: 'array', fallback: 'error' }));
  assert.equal(new TextDecoder('shift_jis').decode(bytes), csv);
});
