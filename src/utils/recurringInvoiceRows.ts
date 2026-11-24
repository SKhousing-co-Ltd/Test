import { recalcInvoices, type InvoiceRow, type InvoiceSheet } from './invoiceSheet.ts';

// 新しい月から順に渡された保存済みシートから、繰り返し明細の最新内容を引き継ぐ。
export function mergeRecurringInvoiceRows(sheet: InvoiceSheet, earlierSheets: InvoiceSheet[], targetMonth: string): InvoiceSheet {
  const rows = [...sheet.rows];
  const known = new Set([...(sheet.cancelledRecurringIds ?? []), ...rows.flatMap((row) => row.recurring ? [row.recurring.id] : [])]);
  for (const earlier of earlierSheets) {
    for (const id of earlier.cancelledRecurringIds ?? []) known.add(id);
    for (const source of earlier.rows) {
    if (!source.recurring || source.recurring.startMonth >= targetMonth || known.has(source.recurring.id)) continue;
    known.add(source.recurring.id);
    const target = rows.find((row) => row.invoiceKey === source.invoiceKey)
      ?? rows.find((row) => row.values[1] && row.values[1] === earlier.rows.find((item) => item.invoiceKey === source.invoiceKey)?.values[1]);
    if (!target) continue;
    if (sheet.invoiceStatuses?.[target.invoiceKey]?.state === 'issued') continue;
    const values = [...source.values];
    for (let column = 0; column <= 9; column += 1) values[column] = '';
    const row: InvoiceRow = { ...source, id: `${target.invoiceKey}:manual:${source.recurring.id}`, invoiceKey: target.invoiceKey, tenantId: target.tenantId, tenantName: target.tenantName, floor: target.floor, values };
    const insertAfter = rows.reduce((found, item, index) => item.invoiceKey === target.invoiceKey ? index : found, -1);
    rows.splice(insertAfter + 1, 0, row);
    }
  }
  return { ...sheet, rows: recalcInvoices(rows) };
}

export function removeManualInvoiceRow(sheet: InvoiceSheet, rowId: string): InvoiceSheet {
  const target = sheet.rows.find((row) => row.id === rowId);
  if (!target?.id.includes(':manual:')) return sheet;
  return {
    ...sheet,
    rows: recalcInvoices(sheet.rows.filter((row) => row.id !== rowId)),
    cancelledRecurringIds: target.recurring ? [...new Set([...(sheet.cancelledRecurringIds ?? []), target.recurring.id])] : sheet.cancelledRecurringIds,
  };
}
