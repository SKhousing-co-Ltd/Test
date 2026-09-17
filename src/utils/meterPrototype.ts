// 検針データ集計の試作用データと計算です。肥後橋の「電気検針データ集計表」R8.8 を写しています。
//
// 構成
//   大分類（カテゴリ） … 集計・電気・水道・ガス。ページの上段タブになります。
//   小分類             … 電気を「基本料・電灯・空調」に分けるなど。カテゴリ内のタブになります。
//   区画               … 借りているテナントを紐づけます。単価の上書きもここです。
//   メーター           … 区画に付けます。テナントは区画を通じて決まります。
//   増額分             … 分類の一部ではなく、カテゴリ全体の使用量にかかるものとして集計画面で計算します。
// 集計処理は全ビル共通で、ビルごとの違いは上のデータだけで表します。

export type RoundingMode = 'floor' | 'ceil' | 'round';
export type SumMode = 'aggregate' | 'perArea' | 'perMeter';
export const sumModeLabel: Record<SumMode, string> = { aggregate: 'まとめて計算', perArea: '区画ごとに計算', perMeter: 'メーターごとに計算' };
export const roundingModeLabel: Record<RoundingMode, string> = { floor: '切り捨て', ceil: '切り上げ', round: '四捨五入' };

export type MeterKind = { id: string; name: string; primaryLabel: string; secondaryLabel?: string };
export type Category = { id: string; name: string; unit: string };
export type SubItem = {
  id: string;
  categoryId: string;
  name: string;
  // meter: メーターの検針値から計算／fixed: テナントごとの固定額（基本料など）
  source: 'meter' | 'fixed';
  meterKindId?: string;
  readingField?: 'primary' | 'secondary';
  // tenant: テナントの契約単価（区画で上書き可）／common: 物件共通の単価
  priceSource: 'tenant' | 'common';
  commonUnitPrice?: number;
};
// カテゴリ全体の使用量にかかる加算です。集計画面で計算します。
export type Surcharge = { id: string; name: string; categoryId: string; unitPrice: number };

export type Area = { id: string; name: string; tenantId: string; unitPrice?: number };
export type Meter = { id: string; code: string; areaId: string; meterKindId: string; primary: number; secondary: number };

export type TenantConfig = {
  id: string;
  name: string;
  unitPrice: number;
  fixedCharges: Record<string, number>;
  usageRoundingUnit: number;
  usageRoundingMode: RoundingMode;
  amountRoundingUnit: number;
  amountRoundingMode: RoundingMode;
  sumMode: Record<string, SumMode>;
  expected: number;
};

export type BuildingConfig = {
  name: string;
  period: string;
  meterDate: string;
  meterKinds: MeterKind[];
  categories: Category[];
  subItems: SubItem[];
  surcharges: Surcharge[];
};

export const initialBuilding: BuildingConfig = {
  name: '三共肥後橋ビル',
  period: '2026年9月分',
  meterDate: '2026/9/2',
  meterKinds: [
    { id: 'light', name: '電灯メーター', primaryLabel: '使用量' },
    { id: 'ac', name: '空調メーター', primaryLabel: '電気', secondaryLabel: 'ガス' },
    { id: 'water', name: '水道メーター', primaryLabel: '使用量' },
  ],
  categories: [
    { id: 'electric', name: '電気', unit: 'kWh' },
    { id: 'water', name: '水道', unit: '㎥' },
    { id: 'gas', name: 'ガス', unit: '㎥' },
  ],
  subItems: [
    { id: 'basic', categoryId: 'electric', name: '基本料', source: 'fixed', priceSource: 'tenant' },
    { id: 'light', categoryId: 'electric', name: '電灯', source: 'meter', meterKindId: 'light', readingField: 'primary', priceSource: 'tenant' },
    { id: 'ac', categoryId: 'electric', name: '空調', source: 'meter', meterKindId: 'ac', readingField: 'primary', priceSource: 'tenant' },
    { id: 'water', categoryId: 'water', name: '水道', source: 'meter', meterKindId: 'water', readingField: 'primary', priceSource: 'common', commonUnitPrice: 338.27 },
    { id: 'gas', categoryId: 'gas', name: 'ガス', source: 'meter', meterKindId: 'ac', readingField: 'secondary', priceSource: 'common', commonUnitPrice: 160 },
  ],
  surcharges: [{ id: 'surcharge', name: '電気増額分', categoryId: 'electric', unitPrice: 8.02 }],
};

const modes = (mode: SumMode): Record<string, SumMode> => ({ light: mode, ac: mode, gas: mode, water: mode, surcharge: mode });
const base = (rounding: RoundingMode, sum: SumMode = 'aggregate') => ({
  usageRoundingUnit: 0.1, usageRoundingMode: 'round' as RoundingMode, amountRoundingUnit: 1, amountRoundingMode: rounding, fixedCharges: {}, sumMode: modes(sum),
});

export const initialTenants: TenantConfig[] = [
  { id: 'T1', name: "㈱Y'sデンタルサポート", unitPrice: 35, ...base('floor'), expected: 75418 },
  { id: 'T2', name: '錦江シッピングジャパン㈱', unitPrice: 33, ...base('round'), expected: 45334 },
  { id: 'T3', name: 'Genesis(合)', unitPrice: 35, ...base('floor'), expected: 22926 },
  { id: 'T4', name: 'メゾンレクシア㈱', unitPrice: 31.65, ...base('round', 'perArea'), expected: 409907 },
  { id: 'T5', name: '結TRUST㈱', unitPrice: 35, ...base('round'), expected: 23545 },
  { id: 'T6', name: 'クリエートメディック㈱', unitPrice: 35, ...base('floor'), expected: 62200 },
  { id: 'T7', name: 'ラコンテ', unitPrice: 33, ...base('round'), expected: 21874 },
  { id: 'T8', name: '㈱ユニオスパートナーズ', unitPrice: 35, ...base('round'), expected: 34800 },
  { id: 'T9', name: 'ロータスアソシエイツ㈱', unitPrice: 35, ...base('floor'), expected: 58436 },
  { id: 'T10', name: '九州運輸センター協同組合', unitPrice: 35, ...base('floor'), expected: 53285 },
  { id: 'T11', name: '㈱ミタカ', unitPrice: 35, ...base('round'), expected: 33064 },
  { id: 'T12', name: 'アイシステム', unitPrice: 33, ...base('round'), expected: 32263 },
  { id: 'T13', name: 'コンカレントシステムズ', unitPrice: 15.38, ...base('round'), fixedCharges: { basic: 50379 }, expected: 365838 },
  { id: 'T14', name: 'セブンイレブン', unitPrice: 0, ...base('floor'), expected: 11501 },
];

export const initialAreas: Area[] = [
  { id: 'A0', name: '1F', tenantId: 'T14' },
  { id: 'A1', name: '2F 南', tenantId: 'T1' },
  { id: 'A2', name: '2F 北', tenantId: 'T2' },
  { id: 'A3', name: '2F 中', tenantId: 'T3' },
  { id: 'A4', name: '3F 南・北', tenantId: 'T4' },
  { id: 'A5', name: '4F 南・北', tenantId: 'T4' },
  { id: 'A6', name: '5F 南西', tenantId: 'T5' },
  { id: 'A7', name: '5F 南東', tenantId: 'T6' },
  { id: 'A8', name: '5F 中', tenantId: 'T7' },
  { id: 'A9', name: '5F 北', tenantId: 'T8' },
  { id: 'A10', name: '6F 南西', tenantId: 'T9' },
  { id: 'A11', name: '6F 南東', tenantId: 'T10' },
  { id: 'A12', name: '6F 中北', tenantId: 'T11' },
  { id: 'A13', name: '6F 北', tenantId: 'T12' },
  { id: 'A14', name: '7F 南・中', tenantId: 'T13' },
  { id: 'A15', name: '7F 北', tenantId: 'T13', unitPrice: 33 },
];

const lightMeter = (id: string, code: string, areaId: string, primary: number): Meter => ({ id, code, areaId, meterKindId: 'light', primary, secondary: 0 });
const acMeter = (no: string, areaId: string, primary: number, secondary: number): Meter => ({ id: no, code: no, areaId, meterKindId: 'ac', primary, secondary });

export const initialMeters: Meter[] = [
  { id: 'W1', code: '60R-141-19-009', areaId: 'A0', meterKindId: 'water', primary: 34, secondary: 0 },

  lightMeter('L1', '223-607-805', 'A1', 564.5), lightMeter('L2', '223-607-995', 'A2', 431.7), lightMeter('L3', '224-603-349', 'A3', 296.1),
  lightMeter('L4', '223-607-843', 'A4', 290.7), lightMeter('L5', '224-602-118', 'A4', 402.9),
  lightMeter('L6', '223-607-982', 'A5', 1253), lightMeter('L7', '224-602-989', 'A5', 1103.9),
  lightMeter('L8', '244-583', 'A6', 129), lightMeter('L9', '223-607-967', 'A7', 269), lightMeter('L10', '223-607-820', 'A7', 148.1),
  lightMeter('L11', '223-607-852', 'A8', 238), lightMeter('L12', '223-607-809', 'A9', 255.8), lightMeter('L13', '259-403', 'A10', 314),
  lightMeter('L14', '222-604-409', 'A11', 575.5), lightMeter('L15', '165-031', 'A12', 214), lightMeter('L16', '223-607-828', 'A13', 296.2),
  lightMeter('L17', '223-607-973', 'A14', 1474.8), lightMeter('L18', '223-607-819', 'A14', 3500), lightMeter('L19', '223-607-983', 'A15', 89.5),

  acMeter('1：4-07', 'A1', 9.816, 20.392), acMeter('1：4-08', 'A1', 9.931, 41.479), acMeter('1：4-09', 'A1', 11.55, 62.76), acMeter('1：4-10', 'A1', 20.047, 181.182),
  acMeter('1：4-02', 'A2', 8.859, 26.682), acMeter('1：4-03', 'A2', 7.369, 10.039), acMeter('1：4-04', 'A2', 16.746, 127.443),
  acMeter('1：4-05', 'A3', 8.317, 22.329), acMeter('1：4-06', 'A3', 9.106, 36.699),
  acMeter('1：3-08', 'A4', 10.936, 24.426), acMeter('1：3-09', 'A4', 9.851, 4.489), acMeter('1：3-10', 'A4', 12.085, 49.372), acMeter('1：3-11', 'A4', 10.427, 16.72),
  acMeter('1：3-12', 'A4', 16.866, 108.549), acMeter('1：3-13', 'A4', 11.641, 11.118), acMeter('1：3-14', 'A4', 13.5, 51.599), acMeter('1：3-15', 'A4', 13.476, 46.551),
  acMeter('1：4-00', 'A4', 14.614, 75.322), acMeter('1：4-01', 'A4', 13.545, 45.546),
  acMeter('1：2-14', 'A5', 14.058, 336.335), acMeter('1：2-15', 'A5', 1.012, 23.633), acMeter('1：3-00', 'A5', 6.543, 127.033), acMeter('1：3-01', 'A5', 0.695, 13.799),
  acMeter('1：3-02', 'A5', 7.007, 144.478), acMeter('1：3-03', 'A5', 3.556, 90.634), acMeter('1：3-04', 'A5', 5.301, 149.234), acMeter('1：3-05', 'A5', 7.564, 127.121),
  acMeter('1：3-06', 'A5', 2.851, 95.433), acMeter('1：3-07', 'A5', 8.011, 218.711),
  acMeter('1：2-11', 'A6', 17.01, 107.876),
  acMeter('1：2-09', 'A7', 9.261, 11.468), acMeter('1：2-10', 'A7', 10.391, 49.481), acMeter('1：2-12', 'A7', 12.441, 83.829), acMeter('1：2-13', 'A7', 14.776, 119.191),
  acMeter('1：2-07', 'A8', 8.396, 18.284), acMeter('1：2-08', 'A8', 10.263, 52.64),
  acMeter('1：2-04', 'A9', 10.209, 63.688), acMeter('1：2-05', 'A9', 8.528, 23.484), acMeter('1：2-06', 'A9', 9.954, 53.783),
  acMeter('1：2-01', 'A10', 11.195, 102.052), acMeter('1：2-02', 'A10', 11.808, 105.699), acMeter('1：2-03', 'A10', 9.037, 64.446),
  acMeter('1：1-14', 'A11', 8.134, 28.626), acMeter('1：1-15', 'A11', 10.164, 55.612), acMeter('1：2-00', 'A11', 12.192, 85.89),
  acMeter('1：1-13', 'A12', 14.86, 145.1),
  acMeter('1：1-11', 'A13', 11.214, 87.967), acMeter('1：1-12', 'A13', 8.255, 32.726),
  acMeter('1：1-03', 'A14', 14.799, 334.61), acMeter('1：1-04', 'A14', 17.042, 397.201), acMeter('1：1-05', 'A14', 0.371, 10.448), acMeter('1：1-06', 'A14', 1.795, 33.708),
  acMeter('1：1-07', 'A14', 3.872, 84.222), acMeter('1：1-08', 'A14', 2.113, 42.935), acMeter('1：1-09', 'A14', 5.535, 95.157), acMeter('1：1-10', 'A14', 9.356, 162.876),
  acMeter('1：1-00', 'A15', 0.586, 16.978), acMeter('1：1-01', 'A15', 0.497, 11.018), acMeter('1：1-02', 'A15', 0.796, 23.476),
];

export const applyRounding = (value: number, unit: number, mode: RoundingMode) => {
  if (!unit) return value;
  const scaled = Number((value / unit).toFixed(9));
  const rounded = mode === 'floor' ? Math.floor(scaled) : mode === 'ceil' ? Math.ceil(scaled) : Math.round(scaled);
  return Number((rounded * unit).toFixed(6));
};

export type ChargeInput = { meterId: string; meterCode: string; areaId: string; areaName: string; usage: number; unitPrice: number };
export type ChargeGroup = { key: string; label: string; usage: number; unitPrice: number; amount: number };
export type SubItemResult = { subItem: SubItem; inputs: ChargeInput[]; usage: number; amount: number; groups: ChargeGroup[] };
export type SurchargeResult = { surcharge: Surcharge; usage: number; amount: number; groups: Array<{ label: string; usage: number; amount: number }> };
export type AreaUsage = { areaId: string; areaName: string; usage: number };
export type CategoryResult = { category: Category; subItems: SubItemResult[]; usage: number; usageByArea: AreaUsage[]; usageByMeter: ChargeInput[]; amount: number };

export function collectInputs(subItem: SubItem, tenant: TenantConfig, areas: Area[], meters: Meter[]): ChargeInput[] {
  if (subItem.source === 'fixed') return [];
  return areas.filter((area) => area.tenantId === tenant.id).flatMap((area) => meters
    .filter((meter) => meter.areaId === area.id && meter.meterKindId === subItem.meterKindId)
    .map((meter) => ({
      meterId: meter.id, meterCode: meter.code, areaId: area.id, areaName: area.name,
      usage: subItem.readingField === 'secondary' ? meter.secondary : meter.primary,
      unitPrice: subItem.priceSource === 'common' ? subItem.commonUnitPrice ?? 0 : area.unitPrice ?? tenant.unitPrice,
    })));
}

export function calculateSubItem(subItem: SubItem, tenant: TenantConfig, inputs: ChargeInput[]): SubItemResult {
  if (subItem.source === 'fixed') {
    const fixed = tenant.fixedCharges[subItem.id] ?? 0;
    return { subItem, inputs: [], usage: 0, amount: fixed, groups: fixed ? [{ key: 'fixed', label: '固定額', usage: 0, unitPrice: 0, amount: fixed }] : [] };
  }
  const roundUsage = (value: number) => applyRounding(value, tenant.usageRoundingUnit, tenant.usageRoundingMode);
  const roundAmount = (value: number) => applyRounding(value, tenant.amountRoundingUnit, tenant.amountRoundingMode);
  const mode = tenant.sumMode[subItem.id] ?? 'aggregate';
  const usage = roundUsage(inputs.reduce((sum, input) => sum + input.usage, 0));

  // 単価が違うものは、どの方式でも必ず分けて計算します。
  const keyOf = (input: ChargeInput) => mode === 'perMeter' ? input.meterId : mode === 'perArea' ? `${input.areaId}｜${input.unitPrice}` : String(input.unitPrice);
  const labelOf = (input: ChargeInput, size: number) => mode === 'perMeter' ? input.meterCode : mode === 'perArea' ? input.areaName : size > 1 ? `単価${input.unitPrice}円` : 'まとめて計算';

  const buckets = new Map<string, ChargeInput[]>();
  for (const input of inputs) buckets.set(keyOf(input), [...(buckets.get(keyOf(input)) ?? []), input]);
  const groups = [...buckets.entries()].map(([key, rows]) => {
    const groupUsage = roundUsage(rows.reduce((sum, row) => sum + row.usage, 0));
    return { key, label: labelOf(rows[0], buckets.size), usage: groupUsage, unitPrice: rows[0].unitPrice, amount: roundAmount(groupUsage * rows[0].unitPrice) };
  });
  return { subItem, inputs, usage, amount: groups.reduce((sum, group) => sum + group.amount, 0), groups };
}

export type TenantResult = ReturnType<typeof calculateTenant>;

export function calculateTenant(tenant: TenantConfig, building: BuildingConfig, areas: Area[], meters: Meter[]) {
  const roundUsage = (value: number) => applyRounding(value, tenant.usageRoundingUnit, tenant.usageRoundingMode);
  const roundAmount = (value: number) => applyRounding(value, tenant.amountRoundingUnit, tenant.amountRoundingMode);

  const categories: CategoryResult[] = building.categories.map((category) => {
    const subItems = building.subItems.filter((subItem) => subItem.categoryId === category.id)
      .map((subItem) => calculateSubItem(subItem, tenant, collectInputs(subItem, tenant, areas, meters)));
    // 増額分を区画ごとやメーターごとに計算する場合に備えて、内訳も持たせます。
    const usageByMeter = subItems.flatMap((row) => row.inputs);
    const areaTotals = new Map<string, AreaUsage>();
    for (const row of subItems) {
      const perArea = new Map<string, ChargeInput[]>();
      for (const input of row.inputs) perArea.set(input.areaId, [...(perArea.get(input.areaId) ?? []), input]);
      for (const [areaId, rows] of perArea) {
        const current = areaTotals.get(areaId) ?? { areaId, areaName: rows[0].areaName, usage: 0 };
        areaTotals.set(areaId, { ...current, usage: current.usage + roundUsage(rows.reduce((sum, input) => sum + input.usage, 0)) });
      }
    }
    return {
      category, subItems, usageByMeter, usageByArea: [...areaTotals.values()],
      usage: roundUsage(subItems.reduce((sum, row) => sum + row.usage, 0)),
      amount: subItems.reduce((sum, row) => sum + row.amount, 0),
    };
  });

  // 増額分はカテゴリ全体の使用量にかかります。
  const surcharges: SurchargeResult[] = building.surcharges.map((surcharge) => {
    const category = categories.find((row) => row.category.id === surcharge.categoryId);
    const usage = category?.usage ?? 0;
    const mode = tenant.sumMode[surcharge.id] ?? 'aggregate';
    const parts = mode === 'perArea' ? (category?.usageByArea ?? []).map((row) => ({ label: row.areaName, usage: roundUsage(row.usage) }))
      : mode === 'perMeter' ? (category?.usageByMeter ?? []).map((row) => ({ label: row.meterCode, usage: roundUsage(row.usage) }))
      : [{ label: 'まとめて計算', usage }];
    const groups = parts.map((part) => ({ ...part, amount: roundAmount(part.usage * surcharge.unitPrice) }));
    return { surcharge, usage, groups, amount: groups.reduce((sum, group) => sum + group.amount, 0) };
  });

  const total = categories.reduce((sum, row) => sum + row.amount, 0) + surcharges.reduce((sum, row) => sum + row.amount, 0);
  return { tenant, categories, surcharges, total, difference: total - tenant.expected };
}
