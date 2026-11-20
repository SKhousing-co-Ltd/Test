import test from 'node:test';
import assert from 'node:assert/strict';
import { prorateFixedCharge } from './fixedChargeProration.ts';

test('入居月の賃料は実使用日数で日割りして切り捨てる', () => {
  assert.equal(prorateFixedCharge(100000, '2026-11-01', '2026-11-20', null), 36666);
  assert.equal(prorateFixedCharge(100000, '2026-11-01', '2026-11-01', null), 100000);
});

test('退去月は満額、入居前と退去後の月は請求しない', () => {
  assert.equal(prorateFixedCharge(100000, '2026-11-01', '2026-01-01', null, '2026-11-10'), 100000);
  assert.equal(prorateFixedCharge(100000, '2026-12-01', '2026-01-01', null, '2026-11-10'), 0);
  assert.equal(prorateFixedCharge(100000, '2026-10-01', '2026-11-20', null), 0);
});
