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

// ---- 日本の祝日 ----
// 国民の祝日（固定日・ハッピーマンデー・春分/秋分）と振替休日・国民の休日を計算します（1980〜2099年向け）。
const nthMonday = (year: number, month: number, nth: number) => { const first = new Date(year, month - 1, 1).getDay(); return 1 + ((8 - first) % 7) + (nth - 1) * 7; };
const equinoxDay = (year: number, base: number) => Math.floor(base + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
function namedHolidays(year: number): Set<string> {
  const days: Array<[number, number]> = [[1, 1], [1, nthMonday(year, 1, 2)], [2, 11], [2, 23], [3, equinoxDay(year, 20.8431)], [4, 29], [5, 3], [5, 4], [5, 5], [7, nthMonday(year, 7, 3)], [8, 11], [9, nthMonday(year, 9, 3)], [9, equinoxDay(year, 23.2488)], [10, nthMonday(year, 10, 2)], [11, 3], [11, 23]];
  return new Set(days.map(([m, d]) => `${m}-${d}`));
}
const holidayCache = new Map<number, Set<string>>();
function holidaysOf(year: number): Set<string> {
  const cached = holidayCache.get(year); if (cached) return cached;
  const named = namedHolidays(year); const result = new Set(named);
  for (const key of named) {
    const [m, d] = key.split('-').map(Number);
    // 振替休日：祝日が日曜なら、次の祝日でない日が休日です。
    if (new Date(year, m - 1, d).getDay() === 0) { const next = new Date(year, m - 1, d + 1); while (result.has(`${next.getMonth() + 1}-${next.getDate()}`)) next.setDate(next.getDate() + 1); result.add(`${next.getMonth() + 1}-${next.getDate()}`); }
    // 国民の休日：祝日に挟まれた平日です（9月の連休）。
    const after2 = new Date(year, m - 1, d + 2);
    if (named.has(`${after2.getMonth() + 1}-${after2.getDate()}`)) { const between = new Date(year, m - 1, d + 1); if (between.getDay() !== 0) result.add(`${between.getMonth() + 1}-${between.getDate()}`); }
  }
  holidayCache.set(year, result); return result;
}
export const isHoliday = (date: Date) => holidaysOf(date.getFullYear()).has(`${date.getMonth() + 1}-${date.getDate()}`);
export const isNonBusinessDay = (date: Date) => date.getDay() === 0 || date.getDay() === 6 || isHoliday(date);

// ---- 契約（請求コード）ごとの請求条件 ----
// 入金期日：当月/翌月・1日〜末日（0=末日）・土日祝は前日/翌日。
// 請求期間：前月分/当月分/翌月分。年払いは請求月にだけ、翌月または翌々月から1年分を載せます。
export type BillingTerms = {
  due_month_offset: number; due_day_of_month: number; due_holiday_adjustment: 'previous' | 'next';
  period_month_offset: number; is_annual_billing: boolean; annual_billing_month: number | null; annual_start_offset: number | null;
};
export const defaultBillingTerms: BillingTerms = { due_month_offset: 0, due_day_of_month: 0, due_holiday_adjustment: 'previous', period_month_offset: 1, is_annual_billing: false, annual_billing_month: null, annual_start_offset: null };

// 入金期日を土日祝を避けて決めます。
export function termsDueDate(year: number, month: number, terms: Pick<BillingTerms, 'due_month_offset' | 'due_day_of_month' | 'due_holiday_adjustment'>): string {
  const target = new Date(year, month - 1 + terms.due_month_offset, 1);
  const end = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const date = new Date(target.getFullYear(), target.getMonth(), terms.due_day_of_month === 0 ? end : Math.min(terms.due_day_of_month, end));
  const step = terms.due_holiday_adjustment === 'previous' ? -1 : 1;
  while (isNonBusinessDay(date)) date.setDate(date.getDate() + step);
  return formatDate(date);
}

// 請求月の固定費の扱いです。billed=false は年払いの請求月以外（0円・明細項目1は空白）。
// monthsCovered は年払いの請求月で12（月額×12で請求）、それ以外は1です。
export type TermsPeriod = { billed: boolean; monthsCovered: number; startOffset: number; endOffset: number };
export function termsPeriod(month: number, terms: Pick<BillingTerms, 'period_month_offset' | 'is_annual_billing' | 'annual_billing_month' | 'annual_start_offset'>): TermsPeriod {
  if (terms.is_annual_billing) {
    const start = terms.annual_start_offset ?? 1;
    if (terms.annual_billing_month !== month) return { billed: false, monthsCovered: 0, startOffset: start, endOffset: start + 11 };
    return { billed: true, monthsCovered: 12, startOffset: start, endOffset: start + 11 };
  }
  return { billed: true, monthsCovered: 1, startOffset: terms.period_month_offset, endOffset: terms.period_month_offset };
}

const periodMonthNames: Record<string, string> = { '-1': '前月分', '0': '当月分', '1': '翌月分' };
export const termsDueLabel = (terms: Pick<BillingTerms, 'due_month_offset' | 'due_day_of_month' | 'due_holiday_adjustment'>) => `${terms.due_month_offset ? '翌月' : '当月'}${terms.due_day_of_month === 0 ? '末日' : `${terms.due_day_of_month}日`}（土日祝は${terms.due_holiday_adjustment === 'previous' ? '前日' : '翌日'}）`;
export const termsPeriodLabel = (terms: Pick<BillingTerms, 'period_month_offset' | 'is_annual_billing' | 'annual_billing_month' | 'annual_start_offset'>) => terms.is_annual_billing
  ? `年払い（${terms.annual_billing_month ?? '?'}月請求・${(terms.annual_start_offset ?? 1) === 2 ? '翌々月' : '翌月'}～1年分）`
  : periodMonthNames[String(terms.period_month_offset)] ?? '翌月分';
