// 検針データ集計の試作用データと計算です。肥後橋の「電気検針データ集計表」R8.8 を写しています。
// メーターごとに割当テナントを決め、テナントの契約情報（単価・端数処理）で金額を出します。
// 金額の出し方（まとめて計算するか、メーターごとに計算して合算するか）は項目ごとに選べます。

export type RoundingMode = 'floor' | 'ceil' | 'round';
export type ChargeKind = 'light' | 'ac' | 'gas' | 'surcharge';
// まとめて計算：使用量を合計してから単価をかける
// 区画別：区画ごとに金額を出して合算する／メーター別：メーターごとに金額を出して合算する
export type SumMode = 'aggregate' | 'perArea' | 'perMeter';
export const sumModeLabel: Record<SumMode, string> = { aggregate: 'まとめて計算', perArea: '区画ごとに計算', perMeter: 'メーターごとに計算' };

export type Meter = {
  id: string;
  code: string;
  area: string;
  kind: 'light' | 'ac';
  tenantId: string;
  electric: number;
  gas: number;
  // テナントの契約単価と違う場合だけ設定します。
  unitPrice?: number;
};

export type TenantConfig = {
  id: string;
  name: string;
  unitPrice: number;
  basicCharge: number;
  usageRoundingUnit: number;
  usageRoundingMode: RoundingMode;
  amountRoundingUnit: number;
  amountRoundingMode: RoundingMode;
  sumMode: Record<ChargeKind, SumMode>;
  // 元のExcelの値です。計算結果が一致するかを画面で突き合わせます。
  expected: { light: number; ac: number; gas: number; surcharge: number; total: number };
};

export type CommonRates = { surchargeUnitPrice: number; gasUnitPrice: number; meterDate: string; lightPeriod: string; acPeriod: string };
export const initialCommonRates: CommonRates = { surchargeUnitPrice: 8.02, gasUnitPrice: 160, meterDate: '2026/9/2', lightPeriod: '8/7～9/2', acPeriod: '8/1～8/31' };

const defaultSumMode: Record<ChargeKind, SumMode> = { light: 'aggregate', ac: 'aggregate', gas: 'aggregate', surcharge: 'aggregate' };
const base = (mode: RoundingMode) => ({ usageRoundingUnit: 0.1, usageRoundingMode: 'round' as RoundingMode, amountRoundingUnit: 1, amountRoundingMode: mode, basicCharge: 0, sumMode: defaultSumMode });

export const initialTenants: TenantConfig[] = [
  { id: 'T1', name: "㈱Y'sデンタルサポート", unitPrice: 35, ...base('floor'), expected: { light: 19757, ac: 1795, gas: 48928, surcharge: 4938, total: 75418 } },
  { id: 'T2', name: '錦江シッピングジャパン㈱', unitPrice: 33, ...base('round'), expected: { light: 14246, ac: 1089, gas: 26272, surcharge: 3727, total: 45334 } },
  { id: 'T3', name: 'Genesis(合)', unitPrice: 35, ...base('floor'), expected: { light: 10363, ac: 609, gas: 9440, surcharge: 2514, total: 22926 } },
  { id: 'T4', name: 'メゾンレクシア㈱', unitPrice: 31.65, ...base('round'), sumMode: { light: 'perArea', ac: 'perArea', gas: 'perArea', surcharge: 'perArea' }, expected: { light: 96548, ac: 5807, gas: 281616, surcharge: 25936, total: 409907 } },
  { id: 'T5', name: '結TRUST㈱', unitPrice: 35, ...base('round'), expected: { light: 4515, ac: 595, gas: 17264, surcharge: 1171, total: 23545 } },
  { id: 'T6', name: 'クリエートメディック㈱', unitPrice: 35, ...base('floor'), expected: { light: 14598, ac: 1641, gas: 42240, surcharge: 3721, total: 62200 } },
  { id: 'T7', name: 'ラコンテ', unitPrice: 33, ...base('round'), expected: { light: 7854, ac: 617, gas: 11344, surcharge: 2059, total: 21874 } },
  { id: 'T8', name: '㈱ユニオスパートナーズ', unitPrice: 35, ...base('round'), expected: { light: 8953, ac: 1005, gas: 22560, surcharge: 2282, total: 34800 } },
  { id: 'T9', name: 'ロータスアソシエイツ㈱', unitPrice: 35, ...base('floor'), expected: { light: 10990, ac: 1120, gas: 43552, surcharge: 2774, total: 58436 } },
  { id: 'T10', name: '九州運輸センター協同組合', unitPrice: 35, ...base('floor'), expected: { light: 20142, ac: 1067, gas: 27216, surcharge: 4860, total: 53285 } },
  { id: 'T11', name: '㈱ミタカ', unitPrice: 35, ...base('round'), expected: { light: 7490, ac: 522, gas: 23216, surcharge: 1836, total: 33064 } },
  { id: 'T12', name: 'アイシステム', unitPrice: 33, ...base('round'), expected: { light: 9775, ac: 644, gas: 19312, surcharge: 2532, total: 32263 } },
  { id: 'T13', name: 'コンカレントシステムズ', unitPrice: 15.38, ...base('round'), basicCharge: 50379, expected: { light: 129845, ac: 906, gas: 194016, surcharge: 41071, total: 365838 } },
];

const light = (id: string, code: string, area: string, tenantId: string, electric: number, unitPrice?: number): Meter => ({ id, code, area, tenantId, kind: 'light', electric, gas: 0, ...(unitPrice ? { unitPrice } : {}) });
const ac = (no: string, area: string, tenantId: string, electric: number, gas: number, unitPrice?: number): Meter => ({ id: no, code: no, area, tenantId, kind: 'ac', electric, gas, ...(unitPrice ? { unitPrice } : {}) });

export const initialMeters: Meter[] = [
  light('L1', '223-607-805', '2F 南', 'T1', 564.5),
  light('L2', '223-607-995', '2F 北', 'T2', 431.7),
  light('L3', '224-603-349', '2F 中', 'T3', 296.1),
  light('L4', '223-607-843', '3F 南・北', 'T4', 290.7),
  light('L5', '224-602-118', '3F 南・北', 'T4', 402.9),
  light('L6', '223-607-982', '4F 南・北', 'T4', 1253),
  light('L7', '224-602-989', '4F 南・北', 'T4', 1103.9),
  light('L8', '244-583', '5F 南西', 'T5', 129),
  light('L9', '223-607-967', '5F 南東', 'T6', 269),
  light('L10', '223-607-820', '5F 南東', 'T6', 148.1),
  light('L11', '223-607-852', '5F 中', 'T7', 238),
  light('L12', '223-607-809', '5F 北', 'T8', 255.8),
  light('L13', '259-403', '6F 南西', 'T9', 314),
  light('L14', '222-604-409', '6F 南東', 'T10', 575.5),
  light('L15', '165-031', '6F 中北', 'T11', 214),
  light('L16', '223-607-828', '6F 北', 'T12', 296.2),
  light('L17', '223-607-973', '7F 南・中', 'T13', 1474.8),
  light('L18', '223-607-819', '7F 南・中', 'T13', 3500),
  light('L19', '223-607-983', '7F 北', 'T13', 89.5, 33),

  ac('1：4-07', '2F 南', 'T1', 9.816, 20.392), ac('1：4-08', '2F 南', 'T1', 9.931, 41.479), ac('1：4-09', '2F 南', 'T1', 11.55, 62.76), ac('1：4-10', '2F 南', 'T1', 20.047, 181.182),
  ac('1：4-02', '2F 北', 'T2', 8.859, 26.682), ac('1：4-03', '2F 北', 'T2', 7.369, 10.039), ac('1：4-04', '2F 北', 'T2', 16.746, 127.443),
  ac('1：4-05', '2F 中', 'T3', 8.317, 22.329), ac('1：4-06', '2F 中', 'T3', 9.106, 36.699),
  ac('1：3-08', '3F 南・北', 'T4', 10.936, 24.426), ac('1：3-09', '3F 南・北', 'T4', 9.851, 4.489), ac('1：3-10', '3F 南・北', 'T4', 12.085, 49.372), ac('1：3-11', '3F 南・北', 'T4', 10.427, 16.72),
  ac('1：3-12', '3F 南・北', 'T4', 16.866, 108.549), ac('1：3-13', '3F 南・北', 'T4', 11.641, 11.118), ac('1：3-14', '3F 南・北', 'T4', 13.5, 51.599), ac('1：3-15', '3F 南・北', 'T4', 13.476, 46.551),
  ac('1：4-00', '3F 南・北', 'T4', 14.614, 75.322), ac('1：4-01', '3F 南・北', 'T4', 13.545, 45.546),
  ac('1：2-14', '4F 南・北', 'T4', 14.058, 336.335), ac('1：2-15', '4F 南・北', 'T4', 1.012, 23.633), ac('1：3-00', '4F 南・北', 'T4', 6.543, 127.033), ac('1：3-01', '4F 南・北', 'T4', 0.695, 13.799),
  ac('1：3-02', '4F 南・北', 'T4', 7.007, 144.478), ac('1：3-03', '4F 南・北', 'T4', 3.556, 90.634), ac('1：3-04', '4F 南・北', 'T4', 5.301, 149.234), ac('1：3-05', '4F 南・北', 'T4', 7.564, 127.121),
  ac('1：3-06', '4F 南・北', 'T4', 2.851, 95.433), ac('1：3-07', '4F 南・北', 'T4', 8.011, 218.711),
  ac('1：2-11', '5F 南西', 'T5', 17.01, 107.876),
  ac('1：2-09', '5F 南東', 'T6', 9.261, 11.468), ac('1：2-10', '5F 南東', 'T6', 10.391, 49.481), ac('1：2-12', '5F 南東', 'T6', 12.441, 83.829), ac('1：2-13', '5F 南東', 'T6', 14.776, 119.191),
  ac('1：2-07', '5F 中', 'T7', 8.396, 18.284), ac('1：2-08', '5F 中', 'T7', 10.263, 52.64),
  ac('1：2-04', '5F 北', 'T8', 10.209, 63.688), ac('1：2-05', '5F 北', 'T8', 8.528, 23.484), ac('1：2-06', '5F 北', 'T8', 9.954, 53.783),
  ac('1：2-01', '6F 南西', 'T9', 11.195, 102.052), ac('1：2-02', '6F 南西', 'T9', 11.808, 105.699), ac('1：2-03', '6F 南西', 'T9', 9.037, 64.446),
  ac('1：1-14', '6F 南東', 'T10', 8.134, 28.626), ac('1：1-15', '6F 南東', 'T10', 10.164, 55.612), ac('1：2-00', '6F 南東', 'T10', 12.192, 85.89),
  ac('1：1-13', '6F 中北', 'T11', 14.86, 145.1),
  ac('1：1-11', '6F 北', 'T12', 11.214, 87.967), ac('1：1-12', '6F 北', 'T12', 8.255, 32.726),
  ac('1：1-03', '7F 南・中', 'T13', 14.799, 334.61), ac('1：1-04', '7F 南・中', 'T13', 17.042, 397.201), ac('1：1-05', '7F 南・中', 'T13', 0.371, 10.448), ac('1：1-06', '7F 南・中', 'T13', 1.795, 33.708),
  ac('1：1-07', '7F 南・中', 'T13', 3.872, 84.222), ac('1：1-08', '7F 南・中', 'T13', 2.113, 42.935), ac('1：1-09', '7F 南・中', 'T13', 5.535, 95.157), ac('1：1-10', '7F 南・中', 'T13', 9.356, 162.876),
  ac('1：1-00', '7F 北', 'T13', 0.586, 16.978, 33), ac('1：1-01', '7F 北', 'T13', 0.497, 11.018, 33), ac('1：1-02', '7F 北', 'T13', 0.796, 23.476, 33),
];

export const applyRounding = (value: number, unit: number, mode: RoundingMode) => {
  if (!unit) return value;
  const scaled = Number((value / unit).toFixed(9));
  const rounded = mode === 'floor' ? Math.floor(scaled) : mode === 'ceil' ? Math.ceil(scaled) : Math.round(scaled);
  return Number((rounded * unit).toFixed(6));
};

export type ChargeInput = { meterId: string; label: string; area: string; usage: number; unitPrice: number };
export type ChargeResult = { usage: number; amount: number; groups: Array<{ label: string; usage: number; unitPrice: number; amount: number }> };

// 項目ごとの金額計算です。まとめて計算する場合も、単価が違うメーターは分けて計算します。
export function calculateCharge(tenant: TenantConfig, inputs: ChargeInput[], mode: SumMode): ChargeResult {
  const roundUsage = (value: number) => applyRounding(value, tenant.usageRoundingUnit, tenant.usageRoundingMode);
  const roundAmount = (value: number) => applyRounding(value, tenant.amountRoundingUnit, tenant.amountRoundingMode);
  const usage = roundUsage(inputs.reduce((sum, input) => sum + input.usage, 0));

  // 同じまとまりに入れる単位を決めます。単価が違うものは、どの方式でも必ず分けて計算します。
  const keyOf = (input: ChargeInput) => mode === 'perMeter' ? input.meterId : mode === 'perArea' ? `${input.area}｜${input.unitPrice}` : String(input.unitPrice);
  const labelOf = (input: ChargeInput, size: number) => mode === 'perMeter' ? input.label : mode === 'perArea' ? input.area : size > 1 ? `単価${input.unitPrice}円` : 'まとめて計算';

  const buckets = new Map<string, ChargeInput[]>();
  for (const input of inputs) buckets.set(keyOf(input), [...(buckets.get(keyOf(input)) ?? []), input]);
  const groups = [...buckets.values()].map((rows) => {
    const groupUsage = roundUsage(rows.reduce((sum, row) => sum + row.usage, 0));
    return { label: labelOf(rows[0], buckets.size), usage: groupUsage, unitPrice: rows[0].unitPrice, amount: roundAmount(groupUsage * rows[0].unitPrice) };
  });
  return { usage, amount: groups.reduce((sum, group) => sum + group.amount, 0), groups };
}

export function chargeInputs(meters: Meter[], tenant: TenantConfig, kind: ChargeKind, rates: CommonRates): ChargeInput[] {
  const own = meters.filter((meter) => meter.tenantId === tenant.id);
  const toInput = (meter: Meter, usage: number, unitPrice: number): ChargeInput => ({ meterId: meter.id, label: meter.code, area: meter.area, usage, unitPrice });
  if (kind === 'light') return own.filter((meter) => meter.kind === 'light').map((meter) => toInput(meter, meter.electric, meter.unitPrice ?? tenant.unitPrice));
  if (kind === 'ac') return own.filter((meter) => meter.kind === 'ac').map((meter) => toInput(meter, meter.electric, meter.unitPrice ?? tenant.unitPrice));
  if (kind === 'gas') return own.filter((meter) => meter.kind === 'ac').map((meter) => toInput(meter, meter.gas, rates.gasUnitPrice));
  return own.map((meter) => toInput(meter, meter.electric, rates.surchargeUnitPrice));
}

export type TenantResult = ReturnType<typeof calculateTenant>;

export function calculateTenant(tenant: TenantConfig, meters: Meter[], rates: CommonRates) {
  const charge = (kind: ChargeKind) => calculateCharge(tenant, chargeInputs(meters, tenant, kind, rates), tenant.sumMode[kind]);
  const lightCharge = charge('light');
  const acCharge = charge('ac');
  const gasCharge = charge('gas');
  const surchargeCharge = charge('surcharge');
  const lightAmount = lightCharge.amount + tenant.basicCharge;
  const total = lightAmount + acCharge.amount + gasCharge.amount + surchargeCharge.amount;
  return {
    tenant, lightCharge, acCharge, gasCharge, surchargeCharge, lightAmount, total,
    difference: {
      light: lightAmount - tenant.expected.light,
      ac: acCharge.amount - tenant.expected.ac,
      gas: gasCharge.amount - tenant.expected.gas,
      surcharge: surchargeCharge.amount - tenant.expected.surcharge,
      total: total - tenant.expected.total,
    },
  };
}
