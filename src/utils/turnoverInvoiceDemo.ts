import type { SupabaseClient } from '@supabase/supabase-js';
import { buildInvoiceSheet } from './invoiceSheet.ts';

// 日本橋601の10月検針分割を11月請求へ連携した想定。共通DBにはアクセスしない。
const tenant = (id: string, name: string, start: string, end: string | null) => ({
  unit_id: 'demo-601', lease_contract_unit_id: `demo-unit-${id}`, unit_code: '601', unit_name: null,
  floor_label: '6F', unit_type: 'office', lease_contract_id: `demo-contract-${id}`,
  contract_start_date: start, contract_end_date: end, actual_end_date: end,
  lease_start_date: start, lease_end_date: end, tenant_id: id, tenant_name: name,
  monthly_rent_amount: 100000, monthly_common_charge_amount: 20000,
  monthly_parking_amount: null, other_monthly_amount: null,
});

const confirmed = (id: string, name: string, sourceId: string, sourceName: string, usage: number, amount: number) => ({
  meter_reading_contract_id: null, tenant_id: id, tenant_name: name, row_no: 1, invoice_number: 1,
  category: 'electric', source_kind: 'subItem', source_id: sourceId, source_name: sourceName,
  asset_billing_line_item_id: 'demo-electric-line', line_item_name: '電気代', usage_amount: usage,
  usage_unit: 'kWh', unit_price: 39, show_unit_price_on_invoice: true, show_usage_on_invoice: true,
  amount, service_month: null, line_sequence: 1,
});

export const turnoverInvoiceDemoAmounts = {
  former: { rent: 100000, common: 20000, electric: 7894 },
  incoming: { rent: 35483, common: 7096, electric: 7875 },
};

function demoClient(): SupabaseClient {
  const former = tenant('demo-former', '【検証】退去テナント', '2025-01-01', '2026-10-10');
  const incoming = tenant('demo-incoming', '【検証】入居テナント', '2026-10-21', null);
  const tables: Record<string, unknown[]> = {
    billing_code: [
      { billing_code_id: 'demo-code-former', tenant_id: 'demo-former', issue_code: '検証001', is_primary: true, invoice_display_name: former.tenant_name, invoice_subject: '日本橋601 10月分' },
      { billing_code_id: 'demo-code-incoming', tenant_id: 'demo-incoming', issue_code: '検証002', is_primary: true, invoice_display_name: incoming.tenant_name, invoice_subject: '日本橋601 10月分' },
    ],
    lease_contract: ['former', 'incoming'].map((id) => ({ lease_contract_id: `demo-contract-demo-${id}`, due_month_offset: 0, due_day_of_month: 0, due_holiday_adjustment: 'previous', period_month_offset: -1, is_annual_billing: false, annual_billing_month: null, annual_start_offset: null })),
    meter_reading_month: [{ billing_month: '2026-11-01', status: 'confirmed', meter_date_electric: '2026-10-31', meter_date_water: null, meter_date_gas: null, meter_date: '2026-10-31' }],
    meter_reading_confirmed_amount: [
      confirmed('demo-former', former.tenant_name, 'demo-light', '電灯', 163.9, 6389),
      confirmed('demo-former', former.tenant_name, 'demo-power', '動力', 38.5, 1505),
      confirmed('demo-incoming', incoming.tenant_name, 'demo-light', '電灯', 163.6, 6389),
      confirmed('demo-incoming', incoming.tenant_name, 'demo-power', '動力', 38.3, 1486),
    ],
    asset_meter_sub_item: [
      { asset_meter_sub_item_id: 'demo-light', category: 'electric', sub_item_kind: 'custom', sort_order: 1, billing_period_pattern_id: 'demo-october', show_unit_price_on_invoice: true, show_usage_on_invoice: true, is_monthly_fixed: false },
      { asset_meter_sub_item_id: 'demo-power', category: 'electric', sub_item_kind: 'custom', sort_order: 2, billing_period_pattern_id: 'demo-october', show_unit_price_on_invoice: true, show_usage_on_invoice: true, is_monthly_fixed: false },
    ],
    asset_billing_period_pattern: [{ billing_period_pattern_id: 'demo-october', pattern_name: '10月分', start_month_offset: -1, start_day_type: 'first', start_meter_day_offset: 0, end_month_offset: -1, end_day_type: 'last', end_meter_day_offset: 0 }],
    billing_charge_type: [{ billing_charge_type_id: 'demo-electric-type', charge_type_name: '電気代' }],
    asset_billing_line_item: [{ asset_billing_line_item_id: 'demo-electric-line', billing_charge_type_id: 'demo-electric-type', line_item_name: '電気代', display_name: '電気代' }],
  };
  const query = (data: unknown) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'gte', 'lte', 'lt', 'gt', 'is', 'neq', 'limit']) chain[method] = () => chain;
    chain.maybeSingle = async () => ({ data: Array.isArray(data) ? data[0] ?? null : data, error: null });
    chain.single = chain.maybeSingle;
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve, reject);
    return chain;
  };
  return { from: (table: string) => query(tables[table] ?? []), rpc: (name: string) => query(name === 'rent_roll_list_with_terms_at_date' ? [former, incoming] : []) } as unknown as SupabaseClient;
}

export async function buildTurnoverInvoiceDemo() {
  const built = await buildInvoiceSheet(demoClient(), 'demo-nihonbashi', '日本橋', 2026, 11);
  return {
    ...built,
    sheet: {
      ...built.sheet,
      rows: built.sheet.rows.map((row) => {
        if (row.tenantId !== 'demo-incoming' || !['賃料', '共益費'].includes(row.values[11])) return row;
        const values = [...row.values];
        values[20] = '10/21入居・10月31日のうち11日分（日割り・小数点以下切り捨て）';
        return { ...row, values };
      }),
    },
  };
}
