import { csvHeaders, invalidAmountRows, parseAmount, recalcInvoices, type InvoiceRow } from './invoiceSheet.ts';

const numericColumns = new Set([0, 5, 6, 7, 12, 14, 15, 16, 17]);
const quote = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

// 請求書作成画面の21列を、請求書・明細の表示順のまま出力する。
export function buildBtobInvoiceCsv(rows: InvoiceRow[]): string {
  if (!rows.length) throw new Error('出力する請求明細がありません。');
  if (invalidAmountRows(rows).length) throw new Error('金額が数値として読めない明細があります。修正してから出力してください。');
  const calculated = recalcInvoices(rows);
  const invoiceCodes = new Map<string, string>();
  const invoiceSummaries = new Map<string, InvoiceRow>();
  for (const row of calculated) {
    if (!invoiceCodes.has(row.invoiceKey)) {
      invoiceCodes.set(row.invoiceKey, row.values[1]?.trim() ?? '');
      invoiceSummaries.set(row.invoiceKey, row);
    }
  }
  if ([...invoiceCodes.values()].some((code) => !code || code === '未採番')) throw new Error('発行先コードが未登録の請求書があります。コードを登録してから出力してください。');
  const records = [csvHeaders, ...calculated.map((row) => {
    const summary = invoiceSummaries.get(row.invoiceKey)!;
    const values = csvHeaders.map((_, index) => {
      const value = [0, 1, 2, 4].includes(index) ? summary.values[index] ?? '' : row.values[index] ?? '';
      if (numericColumns.has(index) && value.trim() && parseAmount(value) === null) throw new Error(`${summary.values[0] || '明細'}の数値を確認してください。`);
      // BtoBの参考CSVでは立方メートルの単位を m3 と表記する。³ はCP932で表現できない。
      return index === 13 ? value.replace(/m³/g, 'm3') : value;
    });
    return values;
  })];
  return records.map((record) => record.map(quote).join(',')).join('\r\n') + '\r\n';
}
