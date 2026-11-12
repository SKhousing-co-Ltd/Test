import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLineSplitAssignmentRows } from './invoiceSplitAssignments.ts';

test('明細項目＋区画モードは請求書①の明示選択も保存する', () => {
  const rows = buildLineSplitAssignmentRows(
    'setting-1',
    'line_item_unit',
    [{ asset_billing_line_item_id: 'rent' }, { asset_billing_line_item_id: 'electric' }],
    { rent: '1', electric: '' },
  );
  assert.deepEqual(rows, [{
    billing_invoice_split_setting_id: 'setting-1',
    asset_billing_line_item_id: 'rent',
    lease_contract_unit_id: null,
    lease_contract_billing_unit_id: null,
    invoice_number: 1,
  }]);
});
