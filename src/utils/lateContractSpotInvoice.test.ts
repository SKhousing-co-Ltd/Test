import test from 'node:test';
import assert from 'node:assert/strict';
import { depositInvoiceDetail, lateContractFixedCharges } from './lateContractSpotInvoice.ts';

test('月次発行後に確定した10月20日入居は、10月20～31日の賃料・共益費をスポット請求にする', () => {
  const lines = lateContractFixedCharges({
    workflowCreatedAt: '2026-10-15T03:00:00Z', issuedAt: ['2026-10-10T03:00:00Z'],
    contractStart: '2026-10-20', leaseStart: '2026-10-20', monthlyRent: 100000, monthlyCommonCharge: 20000,
  });
  assert.deepEqual(lines, [
    { name: '賃料', amount: 38709, periodStart: '2026-10-20', periodEnd: '2026-10-31' },
    { name: '共益費', amount: 7741, periodStart: '2026-10-20', periodEnd: '2026-10-31' },
  ]);
});

test('契約確定後に月次発行した場合はスポット固定費を作らない', () => {
  assert.deepEqual(lateContractFixedCharges({ workflowCreatedAt: '2026-10-15T03:00:00Z', issuedAt: ['2026-10-16T03:00:00Z'], contractStart: '2026-10-20', leaseStart: '2026-10-20', monthlyRent: 100000, monthlyCommonCharge: 20000 }), []);
});

test('敷金行は参考CSVと同じく「その他」・非課税・契約開始日の備考にする', () => {
  const values = depositInvoiceDetail(75000, '2026-09-01', '駐車場敷金');
  assert.equal(values[11], 'その他');
  assert.equal(values[15], '75,000');
  assert.equal(values[18], '非課税');
  assert.equal(values[20], '駐車場敷金　※2026/9/1～契約');
  assert.equal(values[12], ''); assert.equal(values[13], ''); assert.equal(values[14], '');
});
