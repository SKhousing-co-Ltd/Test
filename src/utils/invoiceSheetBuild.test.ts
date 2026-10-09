// 請求書作成の組み立てで、契約の請求条件（入金期日・請求期間・年払い）が反映されることを確かめます。
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildInvoiceSheet } from './invoiceSheet.ts';

// Supabase のクエリを真似た最小の偽クライアントです。テーブルごとに決めた行を返します。
function fakeClient(tables: Record<string, unknown[]>, rentRoll: unknown[]): SupabaseClient {
  const query = (data: unknown) => {
    const result = { data, error: null };
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'gte', 'lte', 'lt', 'gt', 'is', 'neq', 'limit']) chain[method] = () => chain;
    chain.maybeSingle = async () => ({ data: Array.isArray(data) ? data[0] ?? null : data, error: null });
    chain.single = chain.maybeSingle;
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
    return chain;
  };
  return { from: (table: string) => query(tables[table] ?? []), rpc: (name: string) => query(name === 'rent_roll_list_with_terms_at_date' ? rentRoll : []) } as unknown as SupabaseClient;
}

const source = (contractId: string, tenantId: string, rent: number) => ({ unit_id: `u-${contractId}`, unit_code: `10${contractId}`, unit_name: null, floor_label: '1F', unit_type: 'office', lease_contract_id: contractId, tenant_id: tenantId, tenant_name: `テナント${tenantId}`, monthly_rent_amount: rent, monthly_common_charge_amount: null, monthly_parking_amount: null, other_monthly_amount: null });
const terms = (contractId: string, overrides: Record<string, unknown> = {}) => ({ lease_contract_id: contractId, due_month_offset: 0, due_day_of_month: 0, due_holiday_adjustment: 'previous', period_month_offset: 1, is_annual_billing: false, annual_billing_month: null, annual_start_offset: null, ...overrides });
const code = (tenantId: string, issue: string) => ({ billing_code_id: `bc-${tenantId}`, tenant_id: tenantId, issue_code: issue, is_primary: true, invoice_display_name: null, invoice_subject: null });

test('既定の条件：当月末日（土日祝は前日）・翌月分', async () => {
  const client = fakeClient({ billing_code: [code('A', '1001')], lease_contract: [terms('c1')] }, [source('c1', 'A', 100000)]);
  const { sheet, termsNotice } = await buildInvoiceSheet(client, 'p', '物件', 2026, 10);
  const row = sheet.rows[0];
  assert.equal(row.values[4], '2026/10/30');
  assert.equal(row.values[10], '2026/11/1～2026/11/30分');
  assert.equal(row.values[15], '100,000');
  assert.equal(termsNotice, '');
});

test('年払い（10月請求・翌月～1年分）：10月は月額×12で1年分、他の月は0円・明細項目1は空白', async () => {
  const tables = { billing_code: [code('A', '1001')], lease_contract: [terms('c1', { is_annual_billing: true, annual_billing_month: 10, annual_start_offset: 1 })] };
  const october = (await buildInvoiceSheet(fakeClient(tables, [source('c1', 'A', 100000)]), 'p', '物件', 2026, 10)).sheet.rows[0];
  assert.equal(october.values[10], '2026/11/1～2027/10/31分');
  assert.equal(october.values[15], '1,200,000');
  const november = (await buildInvoiceSheet(fakeClient(tables, [source('c1', 'A', 100000)]), 'p', '物件', 2026, 11)).sheet.rows[0];
  assert.equal(november.values[10], '');
  assert.equal(november.values[15], '0');
});

test('翌々月～1年分・前月分・翌月の入金期日', async () => {
  const annual = { billing_code: [code('A', '1001')], lease_contract: [terms('c1', { is_annual_billing: true, annual_billing_month: 10, annual_start_offset: 2 })] };
  assert.equal((await buildInvoiceSheet(fakeClient(annual, [source('c1', 'A', 1)]), 'p', '物件', 2026, 10)).sheet.rows[0].values[10], '2026/12/1～2027/11/30分');
  const previous = { billing_code: [code('A', '1001')], lease_contract: [terms('c1', { period_month_offset: -1, due_month_offset: 1, due_day_of_month: 5, due_holiday_adjustment: 'next' })] };
  const row = (await buildInvoiceSheet(fakeClient(previous, [source('c1', 'A', 1)]), 'p', '物件', 2026, 10)).sheet.rows[0];
  assert.equal(row.values[10], '2026/9/1～2026/9/30分');
  assert.equal(row.values[4], '2026/11/5');
});

test('1通の請求書に条件の違う契約が混ざると、一番早い入金期日にして警告する', async () => {
  const tables = { billing_code: [code('A', '1001')], lease_contract: [terms('c1', { due_month_offset: 1, due_day_of_month: 10 }), terms('c2')] };
  const { sheet, termsNotice } = await buildInvoiceSheet(fakeClient(tables, [source('c1', 'A', 1), source('c2', 'A', 1)]), 'p', '物件', 2026, 10);
  assert.equal(sheet.rows[0].values[4], '2026/10/30');
  assert.match(termsNotice, /1001/);
});
