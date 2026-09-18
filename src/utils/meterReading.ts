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
// まとめて計算：全メーターの使用量を合計してから単価をかける
// メーターごと：メーターごとに使用量×単価を出して合計する
export type SumMode = 'aggregate' | 'perMeter';
export const sumModeLabel: Record<SumMode, string> = { aggregate: 'まとめて計算', perMeter: 'メーターごとに計算' };
export const roundingModeLabel: Record<RoundingMode, string> = { floor: '切り捨て', ceil: '切り上げ', round: '四捨五入' };

export type CategoryId = 'electric' | 'water' | 'gas';
export type Category = { id: CategoryId; name: string; unit: string; billable: boolean; fixedBillable: boolean };
export type SubItem = {
  id: string;
  categoryId: CategoryId;
  name: string;
  kind: 'basic' | 'custom';
  lineItemId: string;
  // ビルの既定単価です。テナントに契約単価が入っていない場合に使います。
  defaultUnitPrice: number | null;
  // 単価が税抜か税込か。税込のときは、下の桁と丸め方で税抜へ戻します。
  taxMode: TaxMode;
  taxRoundingDigits: number;
  taxRoundingMode: RoundingMode;
  // 使用量の小数点以下の扱いです。
  usageRoundingDigits: number;
  usageRoundingMode: RoundingMode;
  // 既定の請求期間です。請求設定の請求期間パターンから選びます。
  periodPatternId: string;
};
export type Surcharge = { id: string; name: string; categoryId: CategoryId; unitPrice: number; lineItemId: string; billable: boolean };
// 請求設定で登録した明細項目のうち、請求種別に公共料金（電気・水道・ガス）が設定されているものです。
export type LineItem = { id: string; name: string; utilityKind: string | null; chargeTypeName: string };
export type Meter = { id: string; subItemId: string; code: string; label: string; tenantId: string; rowIndex: number; usage: number; unitPrice?: number };

export type TenantConfig = {
  id: string;
  name: string;
  // データを分割して扱うかどうかと、その分割数です。
  splitEnabled: boolean;
  rows: ContractRow[];
  // 請求書分割設定で区画ごとに請求書を分けているテナントかどうかです。
  invoiceSplitByUnit: boolean;
  expected: number;
};

// 単価が税込のとき、データ上は税抜へ戻します。戻すときの小数点以下の扱いを選べます。
export type TaxMode = 'exclusive' | 'inclusive';
export const taxModeLabel: Record<TaxMode, string> = { exclusive: '税抜', inclusive: '税込' };
// 同じテナントが複数区画を契約しているとき、検針データを何分割して扱うかです。
// 分割した各行は、請求有無・単価・計算方法・丸めをそれぞれ設定できます。
export type ContractRow = {
  id: string;
  // 請求書分割設定で区画ごとに請求書を分けている場合、この行をどの請求書に載せるかです。
  invoiceNo: number;
  // 分類そのものを請求するかどうかです。
  categoryBillable: Record<CategoryId, boolean>;
  billable: Record<string, boolean>;
  unitPrices: Record<string, number | null>;
  fixedCharges: Record<string, number>;
  sumMode: Record<CategoryId, SumMode>;
  amountRoundingMode: RoundingMode;
  note: string;
};

export type BuildingConfig = { categories: Category[]; subItems: SubItem[]; surcharges: Surcharge[]; taxRate: number };

export const initialBuilding: BuildingConfig = {
  categories: [
    { id: 'electric', name: '電気', unit: 'kWh', billable: true, fixedBillable: true },
    { id: 'water', name: '水道', unit: '㎥', billable: true, fixedBillable: false },
    { id: 'gas', name: 'ガス', unit: '㎥', billable: true, fixedBillable: false },
  ],
  subItems: [
    { id: 'electric_basic', categoryId: 'electric', name: '基本料', kind: 'basic', lineItemId: '', defaultUnitPrice: null, periodPatternId: '', taxMode: 'exclusive' as TaxMode, taxRoundingDigits: 2, taxRoundingMode: 'floor' as RoundingMode, usageRoundingDigits: 1, usageRoundingMode: 'round' as RoundingMode },
    { id: 'light', categoryId: 'electric', name: '電灯', kind: 'custom', lineItemId: '', defaultUnitPrice: 35, periodPatternId: '', taxMode: 'exclusive' as TaxMode, taxRoundingDigits: 2, taxRoundingMode: 'floor' as RoundingMode, usageRoundingDigits: 1, usageRoundingMode: 'round' as RoundingMode },
    { id: 'ac', categoryId: 'electric', name: '空調', kind: 'custom', lineItemId: '', defaultUnitPrice: 35, periodPatternId: '', taxMode: 'exclusive' as TaxMode, taxRoundingDigits: 2, taxRoundingMode: 'floor' as RoundingMode, usageRoundingDigits: 1, usageRoundingMode: 'round' as RoundingMode },
    { id: 'water_basic', categoryId: 'water', name: '基本料', kind: 'basic', lineItemId: '', defaultUnitPrice: null, periodPatternId: '', taxMode: 'exclusive' as TaxMode, taxRoundingDigits: 2, taxRoundingMode: 'floor' as RoundingMode, usageRoundingDigits: 1, usageRoundingMode: 'round' as RoundingMode },
    { id: 'water_usage', categoryId: 'water', name: '水道', kind: 'custom', lineItemId: '', defaultUnitPrice: 338.27, periodPatternId: '', taxMode: 'exclusive' as TaxMode, taxRoundingDigits: 2, taxRoundingMode: 'floor' as RoundingMode, usageRoundingDigits: 1, usageRoundingMode: 'round' as RoundingMode },
    { id: 'gas_basic', categoryId: 'gas', name: '基本料', kind: 'basic', lineItemId: '', defaultUnitPrice: null, periodPatternId: '', taxMode: 'exclusive' as TaxMode, taxRoundingDigits: 2, taxRoundingMode: 'floor' as RoundingMode, usageRoundingDigits: 1, usageRoundingMode: 'round' as RoundingMode },
    { id: 'gas_usage', categoryId: 'gas', name: 'ガス', kind: 'custom', lineItemId: '', defaultUnitPrice: 160, periodPatternId: '', taxMode: 'exclusive' as TaxMode, taxRoundingDigits: 2, taxRoundingMode: 'floor' as RoundingMode, usageRoundingDigits: 1, usageRoundingMode: 'round' as RoundingMode },
  ],
  taxRate: 0.1,
  surcharges: [{ id: 'surcharge', name: '電気増額分', categoryId: 'electric', unitPrice: 8.02, lineItemId: '', billable: true }],
};

// 水道とガスは全テナント共通なので、契約単価は持たせず小分類の既定単価を使います。
const subItemIds = ['electric_basic', 'light', 'ac', 'water_basic', 'water_usage', 'gas_basic', 'gas_usage'];
const contractRow = (id: string, electric: number | null, options: { invoiceNo?: number; basic?: number; rounding?: RoundingMode; billable?: Record<string, boolean> } = {}): ContractRow => ({
  id,
  invoiceNo: options.invoiceNo ?? 1,
  categoryBillable: { electric: true, water: true, gas: true },
  // 水道とガスの単価は小分類のビル既定単価を使うため、契約側は未設定にしています。
  unitPrices: { light: electric, ac: electric, water_usage: null, gas_usage: null },
  billable: Object.fromEntries(subItemIds.map((subItemId) => [subItemId, options.billable?.[subItemId] ?? (subItemId === 'electric_basic' ? Boolean(options.basic) : !subItemId.endsWith('_basic'))])),
  fixedCharges: options.basic ? { electric_basic: options.basic } : {},
  sumMode: { electric: 'aggregate', water: 'aggregate', gas: 'aggregate' },
  amountRoundingMode: options.rounding ?? 'floor',
  note: '',
});

const tenant = (id: string, name: string, electric: number | null, expected: number, options: { rounding?: RoundingMode; basic?: number; rows?: number; invoiceSplit?: boolean } = {}): TenantConfig => ({
  id, name, expected,
  splitEnabled: (options.rows ?? 1) > 1,
  invoiceSplitByUnit: options.invoiceSplit ?? false,
  rows: Array.from({ length: options.rows ?? 1 }, (_, index) => contractRow(`${id}-R${index + 1}`, electric, { invoiceNo: index + 1, basic: index === 0 ? options.basic : undefined, rounding: options.rounding })),
});

// 並び順はレントロール（入金明細・請求明細）と同じフロア順にしています。
export const initialTenants: TenantConfig[] = [
  tenant('T14', 'セブンイレブン', null, 11501),
  tenant('T1', "㈱Y'sデンタルサポート", 35, 75418),
  tenant('T2', '錦江シッピングジャパン㈱', 33, 45334, { rounding: 'round' }),
  tenant('T3', 'Genesis(合)', 35, 22926),
  // 3Fと4Fで別々に計算しているため、データを2分割しています。
  tenant('T4', 'メゾンレクシア㈱', 31.65, 409907, { rounding: 'round', rows: 2, invoiceSplit: true }),
  tenant('T5', '結TRUST㈱', 35, 23545, { rounding: 'round' }),
  tenant('T6', 'クリエートメディック㈱', 35, 62200),
  tenant('T7', 'ラコンテ', 33, 21874, { rounding: 'round' }),
  tenant('T8', '㈱ユニオスパートナーズ', 35, 34800, { rounding: 'round' }),
  tenant('T9', 'ロータスアソシエイツ㈱', 35, 58436),
  tenant('T10', '九州運輸センター協同組合', 35, 53285),
  tenant('T11', '㈱ミタカ', 35, 33064, { rounding: 'round' }),
  tenant('T12', 'アイシステム', 33, 32263, { rounding: 'round' }),
  tenant('T13', 'コンカレントシステムズ', 15.38, 365838, { rounding: 'round', basic: 50379 }),
];

const meter = (subItemId: string, code: string, label: string, tenantId: string, usage: number, unitPrice?: number): Meter =>
  // メゾンレクシアの4F分は2行目の契約として扱います。
  ({ id: `${subItemId}:${code}`, subItemId, code, label, tenantId, rowIndex: tenantId === 'T4' && label.startsWith('4F') ? 1 : 0, usage, ...(unitPrice ? { unitPrice } : {}) });

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

// 小数点第n位で丸めます。
export const roundDigits = (value: number, digits: number, mode: RoundingMode) =>
  applyRounding(value, Number(Math.pow(10, -digits).toFixed(Math.max(digits, 0))), mode);

export const applyRounding = (value: number, unit: number, mode: RoundingMode) => {
  if (!unit) return value;
  const scaled = Number((value / unit).toFixed(9));
  const rounded = mode === 'floor' ? Math.floor(scaled) : mode === 'ceil' ? Math.ceil(scaled) : Math.round(scaled);
  return Number((rounded * unit).toFixed(6));
};

export type ChargeGroup = { key: string; label: string; usage: number; unitPrice: number; amount: number };
export type SubItemResult = { subItem: SubItem; meters: Meter[]; usage: number; amount: number; groups: ChargeGroup[] };
export type SurchargeResult = { surcharge: Surcharge; usage: number; amount: number };
export type CategoryResult = { category: Category; subItems: SubItemResult[]; usage: number; amount: number };
export type RowResult = { row: ContractRow; index: number; categories: CategoryResult[]; surcharges: SurchargeResult[]; total: number };

export const metersFor = (subItemId: string, tenantId: string, rowIndex: number, meters: Meter[]) =>
  meters.filter((row) => row.subItemId === subItemId && row.tenantId === tenantId && row.rowIndex === rowIndex);

export function toExclusive(price: number, subItem: SubItem, taxRate: number) {
  if (subItem.taxMode !== 'inclusive' || !price) return price;
  return roundDigits(price / (1 + taxRate), subItem.taxRoundingDigits, subItem.taxRoundingMode);
}

export function calculateSubItem(subItem: SubItem, category: Category, row: ContractRow, tenantId: string, rowIndex: number, meters: Meter[], taxRate: number): SubItemResult {
  const roundUsage = (value: number) => roundDigits(value, subItem.usageRoundingDigits, subItem.usageRoundingMode);
  const roundAmount = (value: number) => applyRounding(value, 1, row.amountRoundingMode);
  const empty = { subItem, meters: [], usage: 0, amount: 0, groups: [] as ChargeGroup[] };
  if (!row.billable[subItem.id]) return empty;

  if (subItem.kind === 'basic') {
    const fixed = category.fixedBillable ? row.fixedCharges[subItem.id] ?? 0 : 0;
    return { ...empty, amount: fixed, groups: fixed ? [{ key: 'fixed', label: '固定額', usage: 0, unitPrice: 0, amount: fixed }] : [] };
  }

  const own = metersFor(subItem.id, tenantId, rowIndex, meters);
  const mode = row.sumMode[category.id] ?? 'aggregate';
  // 単価はメーターの上書き、契約行の単価、小分類のビル既定単価の順で決めます。税込単価は税抜へ戻します。
  const priceOf = (target: Meter) => toExclusive(target.unitPrice ?? row.unitPrices[subItem.id] ?? subItem.defaultUnitPrice ?? 0, subItem, taxRate);
  const usage = roundUsage(own.reduce((sum, target) => sum + target.usage, 0));

  // 単価が違うメーターは、まとめて計算の場合も分けて計算します。
  const buckets = new Map<string, Meter[]>();
  for (const target of own) { const key = mode === 'perMeter' ? target.id : String(priceOf(target)); buckets.set(key, [...(buckets.get(key) ?? []), target]); }
  const groups = [...buckets.entries()].map(([key, rows]) => {
    const groupUsage = roundUsage(rows.reduce((sum, target) => sum + target.usage, 0));
    return { key, label: mode === 'perMeter' ? rows[0].code : buckets.size > 1 ? `単価${priceOf(rows[0])}円` : 'まとめて計算', usage: groupUsage, unitPrice: priceOf(rows[0]), amount: roundAmount(groupUsage * priceOf(rows[0])) };
  });
  return { subItem, meters: own, usage, amount: groups.reduce((sum, group) => sum + group.amount, 0), groups };
}

export function calculateRow(row: ContractRow, index: number, tenantId: string, building: BuildingConfig, meters: Meter[]): RowResult {
  const roundAmount = (value: number) => applyRounding(value, 1, row.amountRoundingMode);
  const categories: CategoryResult[] = building.categories.filter((category) => category.billable).map((category) => {
    // 小分類が1つだけの分類は、小分類ごとの請求フラグを持たず、分類の請求有無だけで決めます。
    const singleCustom = building.subItems.filter((item) => item.categoryId === category.id && item.kind === 'custom').length === 1;
    const subItems = building.subItems.filter((subItem) => subItem.categoryId === category.id)
      .map((subItem) => row.categoryBillable[category.id] === false
        ? { subItem, meters: [], usage: 0, amount: 0, groups: [] }
        : calculateSubItem(subItem, category, singleCustom && subItem.kind === 'custom' ? { ...row, billable: { ...row.billable, [subItem.id]: true } } : row, tenantId, index, meters, building.taxRate));
    return { category, subItems, usage: subItems.reduce((sum, item) => sum + item.usage, 0), amount: subItems.reduce((sum, item) => sum + item.amount, 0) };
  });

  // 増額分は小分類ではなく、分類全体の使用量にかかります。
  const surcharges: SurchargeResult[] = building.surcharges.filter((surcharge) => surcharge.billable).map((surcharge) => {
    const category = categories.find((item) => item.category.id === surcharge.categoryId);
    const usage = category?.usage ?? 0;
    return { surcharge, usage, amount: roundAmount(usage * surcharge.unitPrice) };
  });

  const total = categories.reduce((sum, item) => sum + item.amount, 0) + surcharges.reduce((sum, item) => sum + item.amount, 0);
  return { row, index, categories, surcharges, total };
}

export type TenantResult = ReturnType<typeof calculateTenant>;

export function calculateTenant(tenant: TenantConfig, building: BuildingConfig, meters: Meter[]) {
  const rows = tenant.rows.map((row, index) => calculateRow(row, index, tenant.id, building, meters));
  const total = rows.reduce((sum, row) => sum + row.total, 0);

  // 請求明細の項目ごとにまとめた金額です。請求書作成へ渡す単位になります。
  const byLineItem = new Map<string, number>();
  for (const row of rows) {
    for (const category of row.categories) for (const subItem of category.subItems) if (subItem.amount && subItem.subItem.lineItemId) byLineItem.set(subItem.subItem.lineItemId, (byLineItem.get(subItem.subItem.lineItemId) ?? 0) + subItem.amount);
    for (const surcharge of row.surcharges) if (surcharge.amount && surcharge.surcharge.lineItemId) byLineItem.set(surcharge.surcharge.lineItemId, (byLineItem.get(surcharge.surcharge.lineItemId) ?? 0) + surcharge.amount);
  }

  return { tenant, rows, total, byLineItem, difference: total - tenant.expected };
}
