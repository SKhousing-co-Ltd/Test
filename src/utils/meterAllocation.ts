// メーターの使用量を、区画の入居テナントへ振り分ける計算です。
//
// メーターは区画に紐づき、請求先は請求月ごとにレントロールの入居状況から決めます。
//   中間検針がないメーター … 請求月の1日時点の入居テナントに、使用量（全体）を請求します。
//   中間検針があるメーター … 区切りの日までを前の区間、翌日からを次の区間とし、
//                            各区間の最初の日（最初の区間は区切りの日）の入居テナントに請求します。
//                            入居者のいない区間は空室分として残し、請求しません。
// 基本料は、検針期間のうち入居していた日数で日割りします。
import type { MeterShare, RoundingMode, TenantConfig } from './meterReading';

export type InputMode = 'usage' | 'reading';
export const inputModeLabel: Record<InputMode, string> = { usage: '使用量を入力', reading: '指針を入力' };

// 「当初から」を表す適用開始日です。
export const ORIGIN_DATE = '1900-01-01';
export type UnitAssignment = { id: string; unitId: string; from: string; to: string | null };
// 中間検針です。指針入力の小分類は reading、使用量入力の小分類は usage（区切りまでの使用量）を使います。
export type MeterBreak = { date: string; reading: number | null; usage: number | null };
export type MeterExchange = { removedReading: number | null; installedReading: number | null };

// 画面で扱うメーターです。設置区画の履歴と、対象月の検針値を持ちます。
export type AssetMeter = {
  id: string; subItemId: string; code: string; label: string; unitPrice?: number;
  assignments: UnitAssignment[];
  // 使用量入力：入力した使用量／指針入力：指針から求めた使用量（保存用）
  usage: number;
  previousReading: number | null;
  currentReading: number | null;
  // 前月指針を手入力したか。手入力でなければ前月の当月指針を使います。
  previousReadingManual: boolean;
  exchange: MeterExchange | null;
  breaks: MeterBreak[];
};

export type UnitOption = { id: string; code: string; name: string; floor: string; type: string };
// 日ごとの入居状況です。date → unitId → テナント
export type Occupant = { tenantId: string; tenantName: string; unitType: string };
export type Occupancy = Map<string, Map<string, Occupant>>;
export type Period = { start: string; end: string };

// 検針の対象になる貸室の区画種別です（テナント一覧・基本料の日割りに使います）。
// 貸室以外（その他など）の区画でも、メーターを付けている区画は対象にします。
export const roomUnitTypes = new Set(['office', 'residential', 'warehouse']);
export const meteredUnitIds = (meters: AssetMeter[]) => new Set(meters.flatMap((meter) => meter.assignments.map((row) => row.unitId)));
const counted = (unitId: string, occupant: Occupant, metered: Set<string>) => roomUnitTypes.has(occupant.unitType) || metered.has(unitId);

// ---- 日付（YYYY-MM-DD の文字列で扱います） ----
const toUtc = (value: string) => { const [y, m, d] = value.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fromUtc = (time: number) => new Date(time).toISOString().slice(0, 10);
export const addDays = (value: string, days: number) => fromUtc(toUtc(value) + days * 86400000);
export const daysBetween = (start: string, end: string) => Math.round((toUtc(end) - toUtc(start)) / 86400000) + 1;
export const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(toUtc(value));
export const monthFirst = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}-01`;
export const monthLast = (year: number, month: number) => fromUtc(Date.UTC(year, month, 0));
export const eachDay = (period: Period) => Array.from({ length: Math.max(daysBetween(period.start, period.end), 0) }, (_, index) => addDays(period.start, index));
export const slashDate = (value: string) => { if (!isDate(value)) return value; const [y, m, d] = value.split('-').map(Number); return `${y}/${m}/${d}`; };

// 検針期間です。前回検針日の翌日から検針日まで。どちらかが無いときは請求月の1日・末日で補います。
export function readingPeriod(year: number, month: number, meterDate: string, previousMeterDate: string): Period {
  const start = isDate(previousMeterDate) ? addDays(previousMeterDate, 1) : monthFirst(year, month);
  const end = isDate(meterDate) ? meterDate : monthLast(year, month);
  return start <= end ? { start, end } : { start: monthFirst(year, month), end: monthLast(year, month) };
}

// 入居状況を読み込む範囲です。前月1日から翌月末日までを読み、検針日を変えても読み直さずに済むようにします。
export function occupancyRange(year: number, month: number): Period {
  const previous = new Date(Date.UTC(year, month - 2, 1));
  return { start: fromUtc(previous.getTime()), end: monthLast(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1) };
}

export const unitAt = (meter: AssetMeter, date: string) =>
  meter.assignments.find((row) => row.from <= date && (row.to === null || date <= row.to))?.unitId ?? '';

// 画面で区画を選び直したときの履歴です。対象月の1日から新しい区画にし、それより前は元の区画のまま残します。
// 対象月より後に始まる紐づけは、選び直した区画で置き換えます。
export function reassignUnit(assignments: UnitAssignment[], unitId: string, from: string, newId: () => string): UnitAssignment[] {
  const kept = assignments
    .filter((row) => row.from < from)
    .map((row) => row.to === null || row.to >= from ? { ...row, to: addDays(from, -1) } : row);
  if (!unitId) return kept;
  const previous = kept.find((row) => row.to === addDays(from, -1));
  // 直前と同じ区画に戻すときは、履歴を分けずにつなげます。
  if (previous && previous.unitId === unitId) return kept.map((row) => row === previous ? { ...row, to: null } : row);
  // 当初からの紐づけしかない場合（初めての割り当て）は、当初からにします。
  return [...kept, { id: newId(), unitId, from: kept.length ? from : ORIGIN_DATE, to: null }];
}

// 月の使用量（全体）です。指針入力は 当月指針−前月指針、メーター交換があれば旧・新メーターの使用量を足します。
export function totalUsage(meter: AssetMeter, mode: InputMode): number {
  if (mode === 'usage') return meter.usage;
  const { previousReading: previous, currentReading: current, exchange } = meter;
  if (previous === null || current === null) return 0;
  if (exchange) return Number((((exchange.removedReading ?? previous) - previous) + (current - (exchange.installedReading ?? 0))).toFixed(6));
  return Number((current - previous).toFixed(6));
}

export type Segment = { from: string; to: string; asOf: string; usage: number };
// メーターの区間です。中間検針が無ければ1区間です。
export function segmentsOf(meter: AssetMeter, mode: InputMode, period: Period, billingFirst: string): Segment[] {
  const total = totalUsage(meter, mode);
  const breaks = [...meter.breaks].filter((row) => isDate(row.date)).sort((left, right) => left.date.localeCompare(right.date));
  if (!breaks.length) return [{ from: period.start, to: period.end, asOf: billingFirst, usage: total }];
  const segments: Segment[] = [];
  let from = period.start;
  let reading = meter.previousReading;
  let used = 0;
  breaks.forEach((row, index) => {
    const usage = mode === 'reading'
      ? (row.reading === null || reading === null ? 0 : Number((row.reading - reading).toFixed(6)))
      : row.usage ?? 0;
    segments.push({ from, to: row.date, asOf: index === 0 ? row.date : from, usage });
    used += usage;
    reading = row.reading;
    from = addDays(row.date, 1);
  });
  const lastUsage = mode === 'reading'
    ? (meter.currentReading === null || reading === null ? 0 : Number((meter.currentReading - reading).toFixed(6)))
    : Number((total - used).toFixed(6));
  segments.push({ from, to: period.end, asOf: from, usage: lastUsage });
  return segments;
}

// 入力の不備です。確定の前に直してもらいます。
export function meterProblems(meter: AssetMeter, mode: InputMode, period: Period): string[] {
  const problems: string[] = [];
  const dates = meter.breaks.map((row) => row.date);
  if (mode === 'reading' && meter.currentReading !== null && meter.previousReading === null) problems.push('前月指針が未入力です');
  if (meter.exchange && meter.breaks.length) problems.push('メーター交換と中間検針は同じ月に入力できません');
  if (dates.some((date) => !isDate(date))) problems.push('中間検針の日付が未入力です');
  if (new Set(dates).size !== dates.length) problems.push('中間検針の日付が重複しています');
  if (dates.some((date) => isDate(date) && (date < period.start || date >= period.end))) problems.push(`中間検針の日付は検針期間（${slashDate(period.start)}～${slashDate(period.end)}）の途中にしてください`);
  if (mode === 'reading' && meter.breaks.some((row) => row.reading === null)) problems.push('中間検針の指針が未入力です');
  if (mode === 'usage' && meter.breaks.some((row) => row.usage === null)) problems.push('中間検針の使用量が未入力です');
  if (!problems.length && segmentsOf(meter, mode, period, period.start).some((row) => row.usage < 0)) problems.push('使用量がマイナスになります。指針を確認してください');
  return problems;
}

// 分割行のうち、区画を受け持つ行です。どの行にも設定されていない区画は1行目で計算します。
export const rowIndexForUnit = (tenant: TenantConfig | undefined, unitId: string) => {
  const index = tenant?.rows.findIndex((row) => row.unitIds.includes(unitId)) ?? -1;
  return index < 0 ? 0 : index;
};

export type AllocatedSegment = Segment & { unitId: string; tenantId: string; tenantName: string };
export type MeterAllocation = { meter: AssetMeter; segments: AllocatedSegment[]; problems: string[]; warnings: string[] };

// 全メーターを振り分けます。計算に使う MeterShare（区間ごと）と、画面に出す区間の内訳を返します。
export function allocateMeters(
  meters: AssetMeter[], modeOf: (subItemId: string) => InputMode, tenants: TenantConfig[], occupancy: Occupancy,
  period: Period, billingFirst: string,
): { shares: MeterShare[]; allocations: MeterAllocation[] } {
  const tenantById = new Map(tenants.map((tenant) => [tenant.id, tenant]));
  const shares: MeterShare[] = [];
  const allocations = meters.map((meter): MeterAllocation => {
    const mode = modeOf(meter.subItemId);
    const segments = segmentsOf(meter, mode, period, billingFirst).map((segment): AllocatedSegment => {
      const unitId = unitAt(meter, segment.asOf);
      const occupant = unitId ? occupancy.get(segment.asOf)?.get(unitId) : undefined;
      return { ...segment, unitId, tenantId: occupant?.tenantId ?? '', tenantName: occupant?.tenantName ?? '' };
    });
    segments.forEach((segment, index) => {
      const tenant = tenantById.get(segment.tenantId);
      shares.push({
        id: segments.length > 1 ? `${meter.id}#${index}` : meter.id, meterId: meter.id, subItemId: meter.subItemId, code: meter.code, label: meter.label,
        tenantId: tenant ? tenant.id : '', rowIndex: rowIndexForUnit(tenant, segment.unitId), usage: segment.usage,
        ...(meter.unitPrice === undefined ? {} : { unitPrice: meter.unitPrice }),
      });
    });
    const warnings: string[] = [];
    if (!meter.breaks.length) {
      const changes = occupantChanges(meter, occupancy, period);
      if (changes.length) warnings.push(`検針期間中に入居テナントが替わっています（${changes.join('、')}）。中間検針を入力してください`);
    }
    if (segments.some((segment) => !segment.unitId)) warnings.push('区画が未割当です');
    return { meter, segments, problems: meterProblems(meter, mode, period), warnings };
  });
  return { shares, allocations };
}

// 中間検針を入れていないメーターで、検針期間中に区画の入居者が替わった日です。
export function occupantChanges(meter: AssetMeter, occupancy: Occupancy, period: Period): string[] {
  const changes: string[] = [];
  let previous: string | null = null;
  for (const date of eachDay(period)) {
    if (!occupancy.has(date)) continue;
    const unitId = unitAt(meter, date);
    const current = unitId ? occupancy.get(date)?.get(unitId)?.tenantId ?? '' : '';
    if (previous !== null && current !== previous) changes.push(`${slashDate(date)}から${current ? occupancy.get(date)?.get(unitId)?.tenantName ?? '' : '空室'}`);
    previous = current;
  }
  return changes;
}

// 基本料の日割りです。検針期間のうち、テナントがその分割行の区画に入居していた日数を数えます。
export type BasicRatio = { days: number; totalDays: number };
export function basicRatios(tenants: TenantConfig[], occupancy: Occupancy, period: Period, metered: Set<string> = new Set()): Map<string, BasicRatio> {
  const days = eachDay(period);
  const ratios = new Map<string, BasicRatio>();
  for (const tenant of tenants) {
    tenant.rows.forEach((row, index) => {
      const occupied = days.filter((date) => [...(occupancy.get(date)?.entries() ?? [])].some(([unitId, occupant]) =>
        occupant.tenantId === tenant.id && counted(unitId, occupant, metered) && rowIndexForUnit(tenant, unitId) === index)).length;
      ratios.set(row.id, { days: occupied, totalDays: days.length });
    });
  }
  return ratios;
}

export const proratedAmount = (amount: number, ratio: BasicRatio | undefined, rounding: RoundingMode) => {
  if (!ratio || !ratio.totalDays || ratio.days >= ratio.totalDays) return amount;
  const value = amount * ratio.days / ratio.totalDays;
  const scaled = Number(value.toFixed(9));
  return rounding === 'floor' ? Math.floor(scaled) : rounding === 'ceil' ? Math.ceil(scaled) : Math.round(scaled);
};

// 期間中に貸室へ入居していたテナントです（入居日順）。テナント一覧に加えるために使います。
export function occupantsIn(occupancy: Occupancy, period: Period, metered: Set<string> = new Set()): Array<{ id: string; name: string }> {
  const found = new Map<string, string>();
  for (const date of eachDay(period)) {
    for (const [unitId, occupant] of occupancy.get(date) ?? []) {
      if (counted(unitId, occupant, metered) && !found.has(occupant.tenantId)) found.set(occupant.tenantId, occupant.tenantName);
    }
  }
  return [...found].map(([id, name]) => ({ id, name }));
}
