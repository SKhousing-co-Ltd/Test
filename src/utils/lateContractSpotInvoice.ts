import { fixedChargeServicePeriod, prorateFixedCharge } from './fixedChargeProration.ts';
import { emptyValues } from './invoiceSheet.ts';

export type LateContractFixedCharge = { name: '賃料' | '共益費'; amount: number; periodStart: string; periodEnd: string };

type Input = {
  workflowCreatedAt: string;
  issuedAt: string[];
  contractStart: string | null;
  leaseStart: string | null;
  monthlyRent: number | null;
  monthlyCommonCharge: number | null;
};

// 月次請求書の発行後に新規契約が確定した場合、契約開始月の固定費をスポット請求へ載せます。
export function lateContractFixedCharges(input: Input): LateContractFixedCharge[] {
  const confirmedAt = Date.parse(input.workflowCreatedAt);
  if (!Number.isFinite(confirmedAt) || !input.issuedAt.some((value) => Date.parse(value) < confirmedAt)) return [];
  const starts = [input.contractStart, input.leaseStart].filter((value): value is string => Boolean(value));
  if (!starts.length) return [];
  const serviceStart = [...starts].sort().pop()!;
  const monthStart = `${serviceStart.slice(0, 7)}-01`;
  const period = fixedChargeServicePeriod(monthStart, input.contractStart, input.leaseStart);
  if (!period) return [];
  return ([
    ['賃料', input.monthlyRent],
    ['共益費', input.monthlyCommonCharge],
  ] as const).flatMap(([name, monthly]) => {
    const amount = prorateFixedCharge(Number(monthly ?? 0), monthStart, input.contractStart, input.leaseStart);
    return amount > 0 ? [{ name, amount, periodStart: period.start, periodEnd: period.end }] : [];
  });
}

export function depositInvoiceDetail(amount: number, contractStart: string, label = '敷金', item1 = 'その他', item2 = '敷金'): string[] {
  const values = emptyValues();
  const date = contractStart ? `${Number(contractStart.slice(0, 4))}/${Number(contractStart.slice(5, 7))}/${Number(contractStart.slice(8, 10))}` : '';
  values[10] = item1;
  values[11] = item2;
  values[15] = amount.toLocaleString('ja-JP');
  values[18] = '非課税';
  values[20] = `${label}　※${date}～契約`;
  return values;
}
