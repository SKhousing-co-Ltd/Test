import { parseAmount, recalcInvoices, type InvoiceRow, type InvoiceSheet } from './invoiceSheet.ts';

export type RevenueAccount = { charge_type_name: string; is_fixed_charge: boolean; revenue_account_code: string | null; revenue_subaccount_code: string | null };
export type JournalEntry = { postingMonth: string; immediate: boolean; cells: string[] };
export type PostingSource = { sourceKind: 'monthly' | 'spot'; sourceKey: string; rows: InvoiceRow[]; sheet: InvoiceSheet; billingMonth: string; issuedOn: string; propertyCode: string; propertyName: string };
export const mirokuHeaders = ['伝票日付','借方科目コード','借方科目別補助コード','借方部門コード','借方取引先コード','借方銀行コード','借方ｾｸﾞﾒﾝﾄ1コード','(コクヨ)借方消費税コード','(コクヨ)借方消費税率区分','(コクヨ)借方金額','(コクヨ)借方消費税額','期日','貸方科目コード','貸方科目別補助コード','貸方部門コード','貸方取引先コード','貸方銀行コード','貸方ｾｸﾞﾒﾝﾄ1コード','(コクヨ)貸方消費税コード','(コクヨ)貸方消費税率区分','(コクヨ)貸方金額','(コクヨ)貸方消費税額','摘要','ダミー項目','伝票NO','仕訳入力形式','(コクヨ)借方外税同時入力区分','(コクヨ)貸方外税同時入力区分','','','○'];
const month = (date: string) => date.slice(0, 7) + '-01';
const nextMonth = (date: string, offset: number) => { const [y, m] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 10); };
const lastDay = (date: string) => { const [y, m] = date.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const displayDate = (date: string) => date.replace(/-/g, '/');
const quote = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
export const renderRevenueCsv = (entries: JournalEntry[]) => [mirokuHeaders, ...entries.map((entry) => entry.cells)].map((row) => row.map(quote).join(',')).join('\r\n') + '\r\n';

function journal(date: string, debit: string, debitSub: string, credit: string, creditSub: string, amount: number, code: string, propertyCode: string, note: string, immediate: boolean): JournalEntry {
  const cells = Array.from({ length: mirokuHeaders.length }, () => '');
  cells[0] = displayDate(date); cells[1] = debit; cells[2] = debitSub; cells[4] = code; cells[6] = propertyCode;
  cells[9] = String(amount); cells[12] = credit; cells[13] = creditSub; cells[15] = code; cells[17] = propertyCode;
  cells[20] = String(amount); cells[22] = note; cells[30] = '○';
  return { postingMonth: month(date), immediate, cells };
}

function periodOf(row: InvoiceRow, sheet: InvoiceSheet, billingMonth: string): { start: string; end: string } {
  const id = sheet.periodPatternByRow?.[row.id];
  const range = id ? sheet.periodRangeByPattern?.[id] : undefined;
  if (range?.start && range?.end) return range;
  const dates = row.values[10]?.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})～(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (dates) return { start: `${dates[1]}-${dates[2].padStart(2, '0')}-${dates[3].padStart(2, '0')}`, end: `${dates[4]}-${dates[5].padStart(2, '0')}-${dates[6].padStart(2, '0')}` };
  if (row.depositId || row.postingAccountCode) return { start: billingMonth, end: lastDay(billingMonth) };
  throw new Error(`${row.values[11] || row.chargeType}の請求対象期間が不明です。請求書明細を確認してください。`);
}

export function buildRevenueEntries(source: PostingSource, accounts: RevenueAccount[]): JournalEntry[] {
  if (!source.rows.length) throw new Error('請求明細がありません。');
  const calculated = recalcInvoices(source.rows);
  const invoice = calculated[0];
  const code = invoice.values[1]?.trim();
  if (!code || code === '未採番' || !/^\d+$/.test(code)) throw new Error('取引先コードが未登録です。');
  if (!/^\d+$/.test(source.propertyCode)) throw new Error('物件のアセットコードが未登録です。');
  const billMonth = source.billingMonth;
  const issueDate = source.issuedOn;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) throw new Error('請求書の発行日を確認してください。');
  const accountMap = new Map(accounts.map((account) => [account.charge_type_name, account]));
  const taxes = calculated.map((row) => {
    const net = parseAmount(row.values[15]);
    if (net === null || !Number.isInteger(net) || net < 0) throw new Error('明細金額を確認してください。');
    return row.values[18] === '課税' ? Math.floor(net * 0.1) : 0;
  });
  const invoiceTax = parseAmount(invoice.values[6]);
  if (invoiceTax === null) throw new Error('請求書の消費税額を確認してください。');
  const taxableIndex = calculated.findIndex((row) => row.values[18] === '課税');
  const difference = invoiceTax - taxes.reduce((sum, value) => sum + value, 0);
  if (taxableIndex >= 0) taxes[taxableIndex] += difference;
  else if (difference !== 0) throw new Error('消費税額と明細の税区分が一致しません。');
  const entries: JournalEntry[] = [];
  calculated.forEach((row, index) => {
    const net = parseAmount(row.values[15])!;
    const gross = net + taxes[index];
    if (!gross) return;
    const account = accountMap.get(row.chargeType);
    const credit = row.postingAccountCode || (row.depositId ? '3600' : account?.revenue_account_code);
    const creditSub = row.postingSubaccountCode ?? (row.depositId ? '' : account?.revenue_subaccount_code ?? '');
    if (!credit) throw new Error(`${row.values[11] || row.chargeType}の計上科目が未設定です。`);
    const range = periodOf(row, source.sheet, billMonth);
    const start = month(range.start);
    const span = (Number(range.end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(range.end.slice(5, 7)) - Number(start.slice(5, 7)) + 1;
    const note = `${source.propertyName} ${invoice.values[2] || row.tenantName} ${row.values[11] || row.chargeType}`.trim();
    if (row.depositId) { entries.push(journal(issueDate, '1530', '', credit, creditSub, gross, code, source.propertyCode, note, true)); return; }
    if (span < 1 || (span > 1 && (span !== 12 || start <= billMonth))) throw new Error(`${row.values[11] || row.chargeType}の対象期間は計上ルールを確認してください。`);
    if (span === 12 && start > billMonth) {
      entries.push(journal(issueDate, '1530', '', '3160', '', gross, code, source.propertyCode, note, true));
      const baseNet = Math.floor(net / 12); const baseTax = Math.floor(taxes[index] / 12);
      for (let offset = 0; offset < 12; offset += 1) {
        const amount = offset === 0 ? gross - (baseNet + baseTax) * 11 : baseNet + baseTax;
        entries.push(journal(nextMonth(start, offset), '3160', '', credit, creditSub, amount, code, source.propertyCode, note, false));
      }
    } else if (start > billMonth) {
      entries.push(journal(issueDate, '1530', '', '3160', '', gross, code, source.propertyCode, note, true));
      entries.push(journal(start, '3160', '', credit, creditSub, gross, code, source.propertyCode, note, true));
    } else {
      if (start < billMonth && account?.is_fixed_charge) {
        entries.push(journal(lastDay(start), '1530', '', credit, creditSub, gross, code, source.propertyCode, note, true));
        entries.push(journal(issueDate, credit, creditSub, '1530', '', gross, code, source.propertyCode, `${note} 前月計上戻し`, true));
      }
      entries.push(journal(issueDate, '1530', '', credit, creditSub, gross, code, source.propertyCode, note, true));
    }
  });
  const expected = parseAmount(invoice.values[7]);
  if (expected === null || calculated.reduce((sum, row, index) => sum + parseAmount(row.values[15])! + taxes[index], 0) !== expected) throw new Error('明細合計と請求金額が一致しません。');
  return entries;
}
