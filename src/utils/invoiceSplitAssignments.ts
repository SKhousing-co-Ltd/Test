export type InvoiceSplitMode = 'unit' | 'line_item' | 'line_item_unit';

type LineItem = { asset_billing_line_item_id: string };

export function buildLineSplitAssignmentRows(
  settingId: string,
  mode: InvoiceSplitMode,
  lineItems: LineItem[],
  assignments: Record<string, string>,
) {
  if (mode === 'unit') return [];
  return lineItems.flatMap((item) => {
    const selected = assignments[item.asset_billing_line_item_id];
    // 複合モードでは空欄だけが「区画に従う」です。
    // 請求書①も明細項目の明示的な割当てなので保存します。
    if (mode === 'line_item_unit' && !selected) return [];
    const invoiceNumber = Number(selected ?? 1);
    if (!Number.isInteger(invoiceNumber) || invoiceNumber < 1) return [];
    if (mode === 'line_item' && invoiceNumber === 1) return [];
    return [{
      billing_invoice_split_setting_id: settingId,
      asset_billing_line_item_id: item.asset_billing_line_item_id,
      lease_contract_unit_id: null,
      lease_contract_billing_unit_id: null,
      invoice_number: invoiceNumber,
    }];
  });
}
