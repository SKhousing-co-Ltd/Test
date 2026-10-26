// 契約区画の公共料金（単価・基本料）を検針データの計算へ取り込む処理を確かめます。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyContractBasics, contractUtilityTerms } from './meterReadingStore.ts';
import { subItemDefaults, type BuildingConfig, type ContractRow, type TenantConfig } from './meterReading.ts';
import type { Occupancy } from './meterAllocation.ts';

const contractUnits = [
  { unit_id: 'U1', contract: { tenant_id: 'T1' }, prices: [{ asset_billing_line_item_id: 'L1', unit_price: 30, tax_mode: 'exclusive' as const, billing_month_prices: [{ start_month: 8, end_month: 10, unit_price: 35 }] }], basics: [{ category: 'electric' as const, amount: 11000, tax_mode: 'inclusive' as const }] },
  { unit_id: 'U2', contract: [{ tenant_id: 'T1' }], prices: [], basics: [{ category: 'electric' as const, amount: 5000, tax_mode: 'exclusive' as const }] },
];

test('請求月が期間内なら期間単価、期間外なら通常単価を使う。既定単価は明細項目から取る', () => {
  const lineItems = [{ asset_billing_line_item_id: 'L1', default_unit_price: 25, default_tax_mode: 'inclusive' as const }, { asset_billing_line_item_id: 'L2', default_unit_price: null, default_tax_mode: 'exclusive' as const }];
  assert.deepEqual(contractUtilityTerms(lineItems, contractUnits, '2026-08').contractPrices, { 'U1:T1': { L1: { unitPrice: 35, taxMode: 'exclusive' } } });
  const november = contractUtilityTerms(lineItems, contractUnits, '2026-11');
  assert.equal(november.contractPrices?.['U1:T1'].L1.unitPrice, 30);
  assert.deepEqual(november.lineItemDefaults, { L1: { unitPrice: 25, taxMode: 'inclusive' } });
  assert.equal(contractUtilityTerms(lineItems, contractUnits, '2027-08').contractPrices?.['U1:T1'].L1.unitPrice, 35);
  const winterUnits = [{ ...contractUnits[0], prices: [{ ...contractUnits[0].prices[0], billing_month_prices: [{ start_month: 11, end_month: 2, unit_price: 40 }] }] }];
  assert.equal(contractUtilityTerms(lineItems, winterUnits, '2026-12').contractPrices?.['U1:T1'].L1.unitPrice, 40);
  assert.equal(contractUtilityTerms(lineItems, winterUnits, '2027-02').contractPrices?.['U1:T1'].L1.unitPrice, 40);
  assert.equal(contractUtilityTerms(lineItems, winterUnits, '2027-03').contractPrices?.['U1:T1'].L1.unitPrice, 30);
});

const row = (unitIds: string[]): ContractRow => ({ id: 'R', invoiceNo: 1, categoryBillable: { electric: true, water: true, gas: true }, billable: { basic: true }, fixedCharges: { basic: 999 }, sumMode: { electric: 'aggregate', water: 'aggregate', gas: 'aggregate' }, amountRoundingMode: 'floor', note: '', splitLabel: '', unitIds });
const building = (): BuildingConfig => ({
  categories: [{ id: 'electric', name: '電気', unit: 'kWh', billable: true, fixedBillable: true }],
  subItems: [{ id: 'basic', categoryId: 'electric', name: '基本料', kind: 'basic', lineItemId: '', priceMode: 'fixed', defaultUnitPrice: null, taxMode: 'exclusive', taxRoundingMode: 'floor', usageRoundingDigits: 0, usageDisplayDigits: 0, usageRoundingMode: 'round', periodPatternId: '', ...subItemDefaults() }],
  surcharges: [], taxRate: 0.1, ...contractUtilityTerms([], contractUnits, '2026-10'),
});
const occupancyOf = (units: string[]): Occupancy => new Map([['2026-10-01', new Map(units.map((unit) => [unit, { tenantId: 'T1', tenantName: 'A', unitType: 'office' }]))]]);
const period = { start: '2026-10-01', end: '2026-10-01' };

test('契約区画の基本料は、入居している区画を契約行ごとに合計し、税込は税抜へ戻す', () => {
  const tenants: TenantConfig[] = [{ id: 'T1', name: 'A', splitEnabled: true, rows: [row(['U1']), row(['U2'])], invoiceSplitByUnit: false, expected: 0 }];
  const [tenant] = applyContractBasics(tenants, building(), occupancyOf(['U1', 'U2']), period);
  assert.deepEqual(tenant.rows.map((target) => target.fixedCharges.basic), [10000, 5000]);
  const single = applyContractBasics([{ ...tenants[0], splitEnabled: false, rows: [row([])] }], building(), occupancyOf(['U1', 'U2']), period);
  assert.equal(single[0].rows[0].fixedCharges.basic, 15000);
});

test('入居していない区画の基本料は含めず、契約区画に基本料が無いテナントには基本料を請求しない', () => {
  const tenants: TenantConfig[] = [{ id: 'T1', name: 'A', splitEnabled: false, rows: [row([])], invoiceSplitByUnit: false, expected: 0 }];
  assert.equal(applyContractBasics(tenants, building(), occupancyOf(['U2']), period)[0].rows[0].fixedCharges.basic, 5000);
  const other: TenantConfig[] = [{ ...tenants[0], id: 'T9' }];
  const none = applyContractBasics(other, building(), occupancyOf(['U1']), period)[0].rows[0];
  assert.equal(none.fixedCharges.basic, 0);
  assert.equal(none.billable.basic, false);
});

test('分類で共通の単価は、請求月の期間単価と分類の既定単価を取り込む', () => {
  const units = [{ unit_id: 'U1', contract: { tenant_id: 'T1' }, prices: [], basics: [], categoryPrices: [{ category: 'electric' as const, unit_price: 20, tax_mode: 'exclusive' as const, billing_month_prices: [{ start_month: 8, end_month: 10, unit_price: 24 }] }] }];
  const settings = [{ category: 'electric' as const, price_scope: 'category' as const, default_unit_price: 18, default_tax_mode: 'exclusive' as const }, { category: 'water' as const, price_scope: 'line_item' as const, default_unit_price: 300, default_tax_mode: 'exclusive' as const }];
  const august = contractUtilityTerms([], units, '2026-08', settings);
  assert.deepEqual(august.contractCategoryPrices, { 'U1:T1': { electric: { unitPrice: 24, taxMode: 'exclusive' } } });
  assert.deepEqual(august.categoryPriceScopes, { electric: 'category', water: 'line_item' });
  assert.deepEqual(august.categoryDefaults, { electric: { unitPrice: 18, taxMode: 'exclusive' } });
  assert.equal(contractUtilityTerms([], units, '2026-11', settings).contractCategoryPrices?.['U1:T1'].electric?.unitPrice, 20);
});
