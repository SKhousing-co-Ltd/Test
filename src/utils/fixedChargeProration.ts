// 入居月は開始日から、退去月は契約の日割り設定がある場合だけ終了日までとする。
export function fixedChargeServicePeriod(periodStart: string, contractStart: string | null, unitStart: string | null, contractEnd: string | null = null, unitEnd: string | null = null, prorateOnMoveOut = false): { start: string; end: string; daysInMonth: number; chargedDays: number } | null {
  const starts = [contractStart, unitStart].filter((value): value is string => Boolean(value));
  const [year, month] = periodStart.split('-').map(Number);
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  if (starts.some((start) => start > monthEnd) || [contractEnd, unitEnd].some((end) => end && end < monthStart)) return null;
  const sortedStarts = [monthStart, ...starts].sort();
  const start = sortedStarts[sortedStarts.length - 1];
  const ends = [contractEnd, unitEnd].filter((value): value is string => Boolean(value));
  const end = prorateOnMoveOut && ends.length ? [monthEnd, ...ends].sort()[0] : monthEnd;
  if (start > end) return null;
  const daysInMonth = Number(monthEnd.slice(-2));
  const chargedDays = Number(end.slice(-2)) - Number(start.slice(-2)) + 1;
  return { start, end, daysInMonth, chargedDays };
}

export function prorateFixedCharge(monthlyAmount: number, periodStart: string, contractStart: string | null, unitStart: string | null, contractEnd: string | null = null, unitEnd: string | null = null, prorateOnMoveOut = false): number {
  const period = fixedChargeServicePeriod(periodStart, contractStart, unitStart, contractEnd, unitEnd, prorateOnMoveOut);
  if (!period) return 0;
  return period.chargedDays === period.daysInMonth ? monthlyAmount : Math.floor(monthlyAmount * period.chargedDays / period.daysInMonth);
}
