import { recalcInvoices, type InvoiceSheet, type SpotInvoice } from './invoiceSheet.ts';
import { reissuePrefix } from './invoiceIssuance.ts';

export const monthStart = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}-01`;

export function spotInvoicesForMonth(sheets: InvoiceSheet[], postingMonth: string): SpotInvoice[] {
  return sheets.flatMap((sheet) => sheet.spotInvoices ?? []).filter((spot) => spot.postingMonth === postingMonth);
}

export function changeSpotPostingMonth(spot: SpotInvoice, postingMonth: string): SpotInvoice {
  return { ...spot, postingMonth };
}

export function beginSpotReissue(spot: SpotInvoice): SpotInvoice {
  if (spot.state !== 'issued') return spot;
  return {
    ...spot, state: 'reissuing',
    rows: spot.rows.map((row, index) => index === 0 ? {
      ...row, values: row.values.map((cell, column) => column === 3 && !cell.startsWith(reissuePrefix) ? `${reissuePrefix}${cell}` : cell),
    } : row),
  };
}

export function issueSpot(spot: SpotInvoice, issuedAt: string): SpotInvoice {
  return { ...spot, state: 'issued', issuedAt, rows: recalcInvoices(spot.rows) };
}
