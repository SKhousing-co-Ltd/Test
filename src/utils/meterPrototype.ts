// 検針データ集計の試作用データと計算です。肥後橋の「電気検針データ集計表」R8.8 を写しています。
//
// 構成
//   分類     … 電気・水道・ガスの3つで固定。水道とガスは請求するかどうかを切り替えられます。
//   小分類   … 基本料（固定で用意・請求フラグあり）と、ビルごとに増減できるカスタム小分類。
//              小分類ごとに、請求明細のどの項目に載せるかを設定します。
//   メーター … 小分類に属し、メーター番号・メーター識別（設置位置など）・割当テナントを持ちます。
//   増額分   … 小分類ではなく分類全体の使用量にかかるものとして、集計画面で計算します。
// 集計処理は全ビル共通で、ビルごとの違いはこのデータだけで表します。

export type RoundingMode = 'floor' | 'ceil' | 'round';
// まとめて計算：使用量を合計してから単価をかける
// 識別ごと：メーター識別（区画など）ごとに金額を出して合算する／メーターごと：メーター単位で合算する
export type SumMode = 'aggregate' | 'perLabel' | 'perMeter';
export const sumModeLabel: Record<SumMode, string> = { aggregate: 'まとめて計算', perLabel: '識別ごとに計算', perMeter: 'メーターごとに計算' };
export const roundingModeLabel: Record<RoundingMode, string> = { floor: '切り捨て', ceil: '切り上げ', round: '四捨五入' };

export type CategoryId = 'electric' | 'water' | 'gas';
export type Category = { id: CategoryId; name: string; unit: string; billable: boolean; fixedBillable: boolean };
export type SubItem = { id: string; categoryId: CategoryId; name: string; kind: 'basic' | 'custom'; lineItemId: string };
export type Surcharge = { id: string; name: string; categoryId: CategoryId; unitPrice: number; lineItemId: string; billable: boolean };
export type LineItem = { id: string; name: string };
export type Meter = { id: string; subItemId: string; code: string; label: string; tenantId: string; usage: number; unitPrice?: number };

export type TenantConfig = {
  id: string;
  name: string;
  unitPrices: Record<CategoryId, number>;
  fixedCharges: Record<string, number>;
  usageRoundingUnit: number;
  usageRoundingMode: RoundingMode;
  amountRoundingUnit: number;
  amountRoundingMode: RoundingMode;
  sumMode: Record<string, SumMode>;
  expected: number;
};

export type BuildingConfig = { categories: Category[]; subItems: SubItem[]; surcharges: Surcharge[] };

// 請求設定の明細項目です。小分類がどの明細項目として請求されるかを紐づけます。
export const lineItems: LineItem[] = [
  { id: 'electricity', name: '電気代' },
  { id: 'electricity_basic', name: '電気基本料' },
  { id: 'aircon', name: '空調費' },
  { id: 'water', name: '水道代' },
  { id: 'gas', name: 'ガス代' },
];

export const initialBuilding: BuildingConfig = {
  categories: [
    { id: 'electric', name: '電気', unit: 'kWh', billable: true, fixedBillable: true },
    { id: 'water', name: '水道', unit: '㎥', billable: true, fixedBillable: false },
    { id: 'gas', name: 'ガス', unit: '㎥', billable: true, fixedBillable: false },
  ],
  subItems: [
    { id: 'electric_basic', categoryId: 'electric', name: '基本料', kind: 'basic', lineItemId: 'electricity_basic' },
    { id: 'light', categoryId: 'electric', name: '電灯', kind: 'custom', lineItemId: 'electricity' },
    { id: 'ac', categoryId: 'electric', name: '空調', kind: 'custom', lineItemId: 'aircon' },
    { id: 'water_basic', categoryId: 'water', name: '基本料', kind: 'basic', lineItemId: 'water' },
    { id: 'water_usage', categoryId: 'water', name: '水道', kind: 'custom', lineItemId: 'water' },
    { id: 'gas_basic', categoryId: 'gas', name: '基本料', kind: 'basic', lineItemId: 'gas' },
    { id: 'gas_usage', categoryId: 'gas', name: 'ガス', kind: 'custom', lineItemId: 'gas' },
  ],
  surcharges: [{ id: 'surcharge', name: '電気増額分', categoryId: 'electric', unitPrice: 8.02, lineItemId: 'electricity', billable: true }],
};

const rates = (electric: number, water = 338.27, gas = 160): Record<CategoryId, number> => ({ electric, water, gas });
const base = (rounding: RoundingMode, sum: SumMode = 'aggregate') => ({
  usageRoundingUnit: 0.1, usageRoundingMode: 'round' as RoundingMode, amountRoundingUnit: 1, amountRoundingMode: rounding, fixedCharges: {},
  sumMode: { light: sum, ac: sum, water_usage: sum, gas_usage: sum, surcharge: sum } as Record<string, SumMode>,
});

export const initialTenants: TenantConfig[] = [
  { id: 'T1', name: "㈱Y'sデンタルサポート", unitPrices: rates(35), ...base('floor'), expected: 75418 },
  { id: 'T2', name: '錦江シッピングジャパン㈱', unitPrices: rates(33), ...base('round'), expected: 45334 },
  { id: 'T3', name: 'Genesis(合)', unitPrices: rates(35), ...base('floor'), expected: 22926 },
  { id: 'T4', name: 'メゾンレクシア㈱', unitPrices: rates(31.65), ...base('round', 'perLabel'), expected: 409907 },
  { id: 'T5', name: '結TRUST㈱', unitPrices: rates(35), ...base('round'), expected: 23545 },
  { id: 'T6', name: 'クリエートメディック㈱', unitPrices: rates(35), ...base('floor'), expected: 62200 },
  { id: 'T7', name: 'ラコンテ', unitPrices: rates(33), ...base('round'), expected: 21874 },
  { id: 'T8', name: '㈱ユニオスパートナーズ', unitPrices: rates(35), ...base('round'), expected: 34800 },
  { id: 'T9', name: 'ロータスアソシエイツ㈱', unitPrices: rates(35), ...base('floor'), expected: 58436 },
  { id: 'T10', name: '九州運輸センター協同組合', unitPrices: rates(35), ...base('floor'), expected: 53285 },
  { id: 'T11', name: '㈱ミタカ', unitPrices: rates(35), ...base('round'), expected: 33064 },
  { id: 'T12', name: 'アイシステム', unitPrices: rates(33), ...base('round'), expected: 32263 },
  { id: 'T13', name: 'コンカレントシステムズ', unitPrices: rates(15.38), ...base('round'), fixedCharges: { electric_basic: 50379 }, expected: 365838 },
  { id: 'T14', name: 'セブンイレブン', unitPrices: rates(0), ...base('floor'), expected: 11501 },
];

const meter = (subItemId: string, code: string, label: string, tenantId: string, usage: number, unitPrice?: number): Meter =>
  ({ id: `${subItemId}:${code}`, subItemId, code, label, tenantId, usage, ...(unitPrice ? { unitPrice } : {}) });

const acReadings: Array<[string, string, string, number, number, number?]> = [
  ['1：4-07', '2F 南', 'T1', 9.816, 20.392], ['1：4-08', '2F 南', 'T1', 9.931, 41.479], ['1：4-09', '2F 南', 'T1', 11.55, 62.76], ['1：4-10', '2F 南', 'T1', 20.047, 181.182],
  ['1：4-02', '2F 北', 'T2', 8.859, 26.682], ['1：4-03', '2F 北', 'T2', 7.369, 10.039], ['1：4-04', '2F 北', 'T2', 16.746, 127.443],
  ['1：4-05', '2F 中', 'T3', 8.317, 22.329], ['1：4-06', '2F 中', 'T3', 9.106, 36.699],
  ['1：3-08', '3F 南・北', 'T4', 10.936, 24.426], ['1：3-09', '3F 南・北', 'T4', 9.851, 4.489], ['1：3-10', '3F 南・北', 'T4', 12.085, 49.372], ['1：3-11', '3F 南・北', 'T4', 10.427, 16.72],
  ['1：3-12', '3F 南・北', 'T4', 16.866, 108.549], ['1：3-13', '3F 南・北', 'T4', 11.641, 11.118], ['1：3-14', '3F 南・北', 'T4', 13.5, 51.599], ['1：3-15', '3F 南・北', 'T4', 13.476, 46.551],
  ['1：4-00', '3F 南・北', 'T4', 14.614, 75.322], ['1：4-01', '3F 南・北', 'T4', 13.545, 45.546],
  ['1：2-14', '4F 南・北', 'T4', 14.058, 336.335], ['1：2-15', '4F 南・北', 'T4', 1.012, 23.633], ['1：3-00', '4F 南・北', 'T4', 6.543, 127.033], ['1：3-01', '4F 南・北', 'T4', 0.695, 13.799],
  ['1：3-02', '4F 南・北', 'T4', 7.007, 144.478], ['1：3-03', '4F 南・北', 'T4', 3.556, 90.634], ['1：3-04', '4F 南・北', 'T4', 5.301, 149.234], ['1：3-05', '4F 南・北', 'T4', 7.564, 127.121],
  ['1：3-06', '4F 南・北', 'T4', 2.851, 95.433], ['1：3-07', '4F 南・北', 'T4', 8.011, 218.711],
  ['1：2-11', '5F 南西', 'T5', 17.01, 107.876],
  ['1：2-09', '5F 南東', 'T6', 9.261, 11.468], ['1：2-10', '5F 南東', 'T6', 10.391, 49.481], ['1：2-12', '5F 南東', 'T6', 12.441, 83.829], ['1：2-13', '5F 南東', 'T6', 14.776, 119.191],
  ['1：2-07', '5F 中', 'T7', 8.396, 18.284], ['1：2-08', '5F 中', 'T7', 10.263, 52.64],
  ['1：2-04', '5F 北', 'T8', 10.209, 63.688], ['1：2-05', '5F 北', 'T8', 8.528, 23.484], ['1：2-06', '5F 北', 'T8', 9.954, 53.783],
  ['1：2-01', '6F 南西', 'T9', 11.195, 102.052], ['1：2-02', '6F 南西', 'T9', 11.808, 105.699], ['1：2-03', '6F 南西', 'T9', 9.037, 64.446],
  ['1：1-14', '6F 南東', 'T10', 8.134, 28.626], ['1：1-15', '6F 南東', 'T10', 10.164, 55.612], ['1：2-00', '6F 南東', 'T10', 12.192, 85.89],
  ['1：1-13', '6F 中北', 'T11', 14.86, 145.1],
  ['1：1-11', '6F 北', 'T12', 11.214, 87.967], ['1：1-12', '6F 北', 'T12', 8.255, 32.726],
  ['1：1-03', '7F 南・中', 'T13', 14.799, 334.61], ['1：1-04', '7F 南・中', 'T13', 17.042, 397.201], ['1：1-05', '7F 南・中', 'T13', 0.371, 10.448], ['1：1-06', '7F 南・中', 'T13', 1.795, 33.708],
  ['1：1-07', '7F 南・中', 'T13', 3.872, 84.222], ['1：1-08', '7F 南・中', 'T13', 2.113, 42.935], ['1：1-09', '7F 南・中', 'T13', 5.535, 95.157], ['1：1-10', '7F 南・中', 'T13', 9.356, 162.876],
  ['1：1-00', '7F 北', 'T13', 0.586, 16.978, 33], ['1：1-01', '7F 北', 'T13', 0.497, 11.018, 33], ['1：1-02', '7F 北', 'T13', 0.796, 23.476, 33],
];

export const initialMeters: Meter[] = [
  meter('light', '223-607-805', '2F 南', 'T1', 564.5), meter('light', '223-607-995', '2F 北', 'T2', 431.7), meter('light', '224-603-349', '2F 中', 'T3', 296.1),
  meter('light', '223-607-843', '3F 南・北', 'T4', 290.7), meter('light', '224-602-118', '3F 南・北', 'T4', 402.9),
  meter('light', '223-607-982', '4F 南・北', 'T4', 1253), meter('light', '224-602-989', '4F 南・北', 'T4', 1103.9),
  meter('light', '244-583', '5F 南西', 'T5', 129), meter('light', '223-607-967', '5F 南東', 'T6', 269), meter('light', '223-607-820', '5F 南東', 'T6', 148.1),
  meter('light', '223-607-852', '5F 中', 'T7', 238), meter('light', '223-607-809', '5F 北', 'T8', 255.8), meter('light', '259-403', '6F 南西', 'T9', 314),
  meter('light', '222-604-409', '6F 南東', 'T10', 575.5), meter('light', '165-031', '6F 中北', 'T11', 214), meter('light', '223-607-828', '6F 北', 'T12', 296.2),
  meter('light', '223-607-973', '7F 南・中', 'T13', 1474.8), meter('light', '223-607-819', '7F 南・中', 'T13', 3500), meter('light', '223-607-983', '7F 北', 'T13', 89.5, 33),

  ...acReadings.map(([code, label, tenantId, electric, , unitPrice]) => meter('ac', code, label, tenantId, electric, unitPrice)),
  ...acReadings.map(([code, label, tenantId, , gas]) => meter('gas_usage', code, label, tenantId, gas)),

  meter('water_usage', '60R-141-19-009', '1F', 'T14', 34),
];

export const applyRounding = (value: number, unit: number, mode: RoundingMode) => {
  if (!unit) return value;
  const scaled = Number((value / unit).toFixed(9));
  const rounded = mode === 'floor' ? Math.floor(scaled) : mode === 'ceil' ? Math.ceil(scaled) : Math.round(scaled);
  return Number((rounded * unit).toFixed(6));
};

export type ChargeGroup = { key: string; label: string; usage: number; unitPrice: number; amount: number };
export type SubItemResult = { subItem: SubItem; meters: Meter[]; usage: number; amount: number; groups: ChargeGroup[] };
export type SurchargeResult = { surcharge: Surcharge; usage: number; amount: number; groups: ChargeGroup[] };
export type CategoryResult = { category: Category; subItems: SubItemResult[]; usage: number; amount: number };

export const metersFor = (subItemId: string, tenantId: string, meters: Meter[]) => meters.filter((row) => row.subItemId === subItemId && row.tenantId === tenantId);

export function calculateSubItem(subItem: SubItem, category: Category, tenant: TenantConfig, meters: Meter[]): SubItemResult {
  const roundUsage = (value: number) => applyRounding(value, tenant.usageRoundingUnit, tenant.usageRoundingMode);
  const roundAmount = (value: number) => applyRounding(value, tenant.amountRoundingUnit, tenant.amountRoundingMode);

  if (subItem.kind === 'basic') {
    const fixed = category.fixedBillable ? tenant.fixedCharges[subItem.id] ?? 0 : 0;
    return { subItem, meters: [], usage: 0, amount: fixed, groups: fixed ? [{ key: 'fixed', label: '固定額', usage: 0, unitPrice: 0, amount: fixed }] : [] };
  }

  const own = metersFor(subItem.id, tenant.id, meters);
  const mode = tenant.sumMode[subItem.id] ?? 'aggregate';
  const priceOf = (row: Meter) => row.unitPrice ?? tenant.unitPrices[category.id];
  const usage = roundUsage(own.reduce((sum, row) => sum + row.usage, 0));

  // 単価が違うメーターは、どの方式でも必ず分けて計算します。
  const keyOf = (row: Meter) => mode === 'perMeter' ? row.id : mode === 'perLabel' ? `${row.label}｜${priceOf(row)}` : String(priceOf(row));
  const labelOf = (row: Meter, size: number) => mode === 'perMeter' ? row.code : mode === 'perLabel' ? row.label : size > 1 ? `単価${priceOf(row)}円` : 'まとめて計算';

  const buckets = new Map<string, Meter[]>();
  for (const row of own) buckets.set(keyOf(row), [...(buckets.get(keyOf(row)) ?? []), row]);
  const groups = [...buckets.entries()].map(([key, rows]) => {
    const groupUsage = roundUsage(rows.reduce((sum, row) => sum + row.usage, 0));
    return { key, label: labelOf(rows[0], buckets.size), usage: groupUsage, unitPrice: priceOf(rows[0]), amount: roundAmount(groupUsage * priceOf(rows[0])) };
  });
  return { subItem, meters: own, usage, amount: groups.reduce((sum, group) => sum + group.amount, 0), groups };
}

export type TenantResult = ReturnType<typeof calculateTenant>;

export function calculateTenant(tenant: TenantConfig, building: BuildingConfig, meters: Meter[]) {
  const roundUsage = (value: number) => applyRounding(value, tenant.usageRoundingUnit, tenant.usageRoundingMode);
  const roundAmount = (value: number) => applyRounding(value, tenant.amountRoundingUnit, tenant.amountRoundingMode);

  const categories: CategoryResult[] = building.categories.filter((category) => category.billable).map((category) => {
    const subItems = building.subItems.filter((subItem) => subItem.categoryId === category.id)
      .map((subItem) => calculateSubItem(subItem, category, tenant, meters));
    return {
      category, subItems,
      usage: roundUsage(subItems.reduce((sum, row) => sum + row.usage, 0)),
      amount: subItems.reduce((sum, row) => sum + row.amount, 0),
    };
  });

  const surcharges: SurchargeResult[] = building.surcharges.filter((surcharge) => surcharge.billable).map((surcharge) => {
    const category = categories.find((row) => row.category.id === surcharge.categoryId);
    const usage = category?.usage ?? 0;
    const mode = tenant.sumMode[surcharge.id] ?? 'aggregate';
    const allMeters = (category?.subItems ?? []).flatMap((row) => row.meters);
    const parts = mode === 'aggregate' ? [{ key: 'all', label: 'まとめて計算', usage }] : (() => {
      const buckets = new Map<string, Meter[]>();
      for (const row of allMeters) { const key = mode === 'perMeter' ? row.id : row.label; buckets.set(key, [...(buckets.get(key) ?? []), row]); }
      return [...buckets.entries()].map(([key, rows]) => ({ key, label: mode === 'perMeter' ? rows[0].code : rows[0].label, usage: roundUsage(rows.reduce((sum, row) => sum + row.usage, 0)) }));
    })();
    const groups = parts.map((part) => ({ ...part, unitPrice: surcharge.unitPrice, amount: roundAmount(part.usage * surcharge.unitPrice) }));
    return { surcharge, usage, groups, amount: groups.reduce((sum, group) => sum + group.amount, 0) };
  });

  const total = categories.reduce((sum, row) => sum + row.amount, 0) + surcharges.reduce((sum, row) => sum + row.amount, 0);

  // 請求明細の項目ごとにまとめた金額です。請求書作成へ渡す単位になります。
  const byLineItem = new Map<string, number>();
  for (const category of categories) for (const subItem of category.subItems) if (subItem.amount) byLineItem.set(subItem.subItem.lineItemId, (byLineItem.get(subItem.subItem.lineItemId) ?? 0) + subItem.amount);
  for (const surcharge of surcharges) if (surcharge.amount) byLineItem.set(surcharge.surcharge.lineItemId, (byLineItem.get(surcharge.surcharge.lineItemId) ?? 0) + surcharge.amount);

  return { tenant, categories, surcharges, total, byLineItem, difference: total - tenant.expected };
}
