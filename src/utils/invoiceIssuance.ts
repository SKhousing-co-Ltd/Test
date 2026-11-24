import type { InvoiceRow, InvoiceSheet } from './invoiceSheet.ts';

export const reissuePrefix = '【再発行】';

export function exportableInvoiceKeys(sheet: InvoiceSheet): string[] {
  return [...new Set(sheet.rows.map((row) => row.invoiceKey))].filter((key) => !sheet.invoiceStatuses?.[key] || sheet.invoiceStatuses[key].state === 'reissuing');
}

export function beginInvoiceReissue(sheet: InvoiceSheet, invoiceKey: string): InvoiceSheet {
  const status = sheet.invoiceStatuses?.[invoiceKey];
  if (status?.state !== 'issued') return sheet;
  let written = false;
  return {
    ...sheet,
    invoiceStatuses: { ...sheet.invoiceStatuses, [invoiceKey]: { ...status, state: 'reissuing' } },
    rows: sheet.rows.map((row) => {
      if (row.invoiceKey !== invoiceKey || written) return row;
      written = true;
      const values = [...row.values];
      values[3] = values[3].startsWith(reissuePrefix) ? values[3] : `${reissuePrefix}${values[3]}`;
      return { ...row, values };
    }),
  };
}

export function markInvoicesIssued(sheet: InvoiceSheet, keys: string[], issuedAt: string): InvoiceSheet {
  const statuses = { ...sheet.invoiceStatuses };
  for (const key of keys) statuses[key] = { state: 'issued', issuedAt };
  return { ...sheet, invoiceStatuses: statuses };
}

export function rowsForInvoiceKeys(rows: InvoiceRow[], keys: string[]): InvoiceRow[] {
  const included = new Set(keys);
  return rows.filter((row) => included.has(row.invoiceKey));
}
