// 請求書作成で使う日付計算です。入金期日パターン・請求期間パターンから実日付を組み立てます。
export type DueDatePattern = { month_offset: number; day_of_month: number; holiday_adjustment: 'previous' | 'next' };
export type BillingPeriodPattern = { start_month_offset: number; start_day_type: string; end_month_offset: number; end_day_type: string };

export const formatDate = (date: Date) => `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;

// 請求期間パターンの片側（開始／終了）を実日付へ変換します。検針日基準は実績値が必要なため、ここでは確定できません。
export function periodEdge(year: number, month: number, monthOffset: number, dayType: string): Date | null {
  if (dayType === 'meter') return null;
  const targetMonth = month - 1 + monthOffset;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(targetYear, normalizedMonth + 1, 0).getDate();
  const day = dayType === 'first' ? 1 : dayType === 'last' ? lastDay : Math.min(Number(dayType.replace('day_', '')) || 1, lastDay);
  return new Date(targetYear, normalizedMonth, day);
}

// 明細項目１に入れる「YYYY/MM/DD～YYYY/MM/DD分」を組み立てます。確定できない場合は空にして画面で手入力させます。
export function periodText(year: number, month: number, pattern: BillingPeriodPattern | undefined): string {
  if (!pattern) return '';
  const start = periodEdge(year, month, pattern.start_month_offset, pattern.start_day_type);
  const end = periodEdge(year, month, pattern.end_month_offset, pattern.end_day_type);
  return start && end ? `${formatDate(start)}～${formatDate(end)}分` : '';
}

export function dueDate(year: number, month: number, pattern: DueDatePattern | undefined): string {
  if (!pattern) return '';
  const targetMonth = month - 1 + pattern.month_offset;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const end = new Date(targetYear, normalizedMonth + 1, 0).getDate();
  const date = new Date(targetYear, normalizedMonth, pattern.day_of_month === 0 ? end : Math.min(pattern.day_of_month, end));
  const step = pattern.holiday_adjustment === 'previous' ? -1 : 1;
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + step);
  return formatDate(date);
}
