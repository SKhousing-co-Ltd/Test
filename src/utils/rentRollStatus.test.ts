import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyRentRollEnd, type RentRollEndInfo } from './rentRollStatus.ts';

const base: RentRollEndInfo = { actualEndDate: null, leaseEndDate: null, contractEndDate: null, leaseTermType: 'ordinary', terminationNote: false, pendingTerminationDate: null };
const at = '2026-11-13';

test('定期満了日は退去予定にせず、区画終了日と重複表示しない', () => {
  const result = classifyRentRollEnd({ ...base, leaseTermType: 'fixed_term', contractEndDate: '2027-03-31', leaseEndDate: '2027-03-31' }, at);
  assert.equal(result.scheduled, false); assert.equal(result.fixedTermEndDate, '2027-03-31'); assert.equal(result.unitEndDate, null);
});
test('解約手続き中は満了日があっても解約日を表示する', () => {
  const result = classifyRentRollEnd({ ...base, leaseTermType: 'fixed_term', contractEndDate: '2027-03-31', pendingTerminationDate: '2027-01-31' }, at);
  assert.equal(result.scheduled, true); assert.equal(result.inProgress, true); assert.equal(result.terminationDate, '2027-01-31'); assert.equal(result.fixedTermEndDate, '2027-03-31');
});
test('実終了日と解約予定メモは退去予定として扱う', () => {
  assert.equal(classifyRentRollEnd({ ...base, actualEndDate: '2027-01-31' }, at).terminationDate, '2027-01-31');
  assert.equal(classifyRentRollEnd({ ...base, terminationNote: true }, at).scheduled, true);
});
test('区画利用終了日だけでは退去予定と断定しない', () => {
  const result = classifyRentRollEnd({ ...base, leaseEndDate: '2027-01-31' }, at);
  assert.equal(result.scheduled, false); assert.equal(result.unitEndDate, '2027-01-31');
});
