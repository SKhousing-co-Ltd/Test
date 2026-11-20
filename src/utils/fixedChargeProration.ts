// 入居月だけ固定費を日割りする。退去月は満額で請求する。
export function prorateFixedCharge(monthlyAmount: number, periodStart: string, contractStart: string | null, unitStart: string | null, contractEnd: string | null = null, unitEnd: string | null = null): number {
  const starts = [contractStart, unitStart].filter((value): value is string => Boolean(value));
  const [year, month] = periodStart.split('-').map(Number);
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  if (starts.some((start) => start > monthEnd) || [contractEnd, unitEnd].some((end) => end && end < monthStart)) return 0;
  if (!starts.length) return monthlyAmount;
  const start = starts.sort()[starts.length - 1];
  if (start <= monthStart) return monthlyAmount;
  const daysInMonth = Number(monthEnd.slice(-2));
  const usedDays = daysInMonth - Number(start.slice(-2)) + 1;
  return Math.floor(monthlyAmount * usedDays / daysInMonth);
}
