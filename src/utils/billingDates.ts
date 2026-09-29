// 請求書作成で使う日付計算です。入金期日パターン・請求期間パターンから実日付を組み立てます。
export type DueDatePattern = { month_offset: number; day_of_month: number; holiday_adjustment: 'previous' | 'next' };
export type BillingPeriodPattern = { start_month_offset: number; start_day_type: string; end_month_offset: number; end_day_type: string; start_meter_day_offset?: number; end_meter_day_offset?: number };
// 検針日を参照する期間のための実績値です。当月と前回の検針日を渡します。
export type MeterDates = { current?: string; previous?: string };
const parseDate = (value: string | undefined) => { if (!value) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; };
const shiftDays = (date: Date, days: number) => { const next = new Date(date); next.setDate(next.getDate() + days); return next; };

export const formatDate = (date: Date) => `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
// 請求期間は YYYY/M/D の形（月日はゼロ埋めしない）で出します。
export const formatPeriodDate = formatDate;
// 手入力された請求期間（YYYY/MM/DD や YYYY-MM-DD）を YYYY/M/D にそろえます。日付として読めない値はそのまま返します。
export const normalizePeriodDate = (value: string) => {
  const matched = value.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  return matched ? `${matched[1]}/${Number(matched[2])}/${Number(matched[3])}` : value;
};

// 請求期間パターンの片側（開始／終了）を実日付へ変換します。検針日基準は実績値が必要なため、ここでは確定できません。
export function periodEdge(year: number, month: number, monthOffset: number, dayType: string, meterDates?: MeterDates, meterDayOffset = 0): Date | null {
  if (dayType === 'meter') {
    const base = parseDate(monthOffset < 0 ? meterDates?.previous : meterDates?.current);
    return base ? shiftDays(base, meterDayOffset) : null;
  }
  const targetMonth = month - 1 + monthOffset;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(targetYear, normalizedMonth + 1, 0).getDate();
  const day = dayType === 'first' ? 1 : dayType === 'last' ? lastDay : Math.min(Number(dayType.replace('day_', '')) || 1, lastDay);
  return new Date(targetYear, normalizedMonth, day);
}

// 明細項目１の請求期間です。確定できない場合は空にして画面で手入力させます。
export function periodRange(year: number, month: number, pattern: BillingPeriodPattern | undefined, meterDates?: MeterDates): { start: string; end: string } {
  if (!pattern) return { start: '', end: '' };
  const start = periodEdge(year, month, pattern.start_month_offset, pattern.start_day_type, meterDates, pattern.start_meter_day_offset ?? 0);
  const end = periodEdge(year, month, pattern.end_month_offset, pattern.end_day_type, meterDates, pattern.end_meter_day_offset ?? 0);
  return { start: start ? formatPeriodDate(start) : '', end: end ? formatPeriodDate(end) : '' };
}

// 明細項目１としてCSVへ出す「YYYY/M/D～YYYY/M/D分」を組み立てます。
export const periodText = (start: string, end: string) => start && end ? `${normalizePeriodDate(start)}～${normalizePeriodDate(end)}分` : '';

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
