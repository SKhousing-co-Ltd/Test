// 検針データ集計の試作用データと計算です。肥後橋の「電気検針データ集計表」R8.8 を写しています。
//
// 構成
//   分類     … 電気・水道・ガスの3つで固定。水道とガスは請求するかどうかを切り替えられます。
//   小分類   … 基本料（固定で用意・請求フラグあり）と、ビルごとに増減できるカスタム小分類。
//              小分類ごとに、請求明細のどの項目に載せるかを設定します。
//   メーター … 小分類に属し、メーター番号・メーター識別（設置位置など）・設置区画を持ちます。
//              請求先は区画の入居テナントから決めます（meterAllocation.ts）。ここでの計算は、
//              区間ごとにテナントへ振り分けたあとの使用量（MeterShare）を受け取ります。
//   増額分   … 小分類ではなく分類全体の使用量にかかるものとして、集計画面で計算します。
// 集計処理は全ビル共通で、ビルごとの違いはこのデータだけで表します。

import type { BasicRatio, InputMode } from './meterAllocation';
import { proratedAmount } from './meterAllocation.ts';

export type RoundingMode = 'floor' | 'ceil' | 'round';
// まとめて計算：全メーターの使用量を合計してから単価をかける
// メーターごと：メーターごとに使用量×単価を出して合計する
export type SumMode = 'aggregate' | 'perMeter';
export const sumModeLabel: Record<SumMode, string> = { aggregate: 'まとめて計算', perMeter: 'メーターごとに計算' };
export const roundingModeLabel: Record<RoundingMode, string> = { floor: '切り捨て', ceil: '切り上げ', round: '四捨五入' };

export type CategoryId = 'electric' | 'water' | 'gas';
export type PriceMode = 'fixed' | 'variable';
export const priceModeLabel: Record<PriceMode, string> = { fixed: '固定', variable: '変動' };
// 変動単価の決め方です。手入力：その月の単価を入れる／請求額から計算：請求額÷使用量で求める
export type VariablePriceMethod = 'manual' | 'billed';
export const variablePriceMethodLabel: Record<VariablePriceMethod, string> = { manual: '手入力', billed: '請求額から計算' };
// 変動単価の月ごとの入力です。税抜は手入力したときだけ持ち、それ以外は税込・消費税から求めます。
export type VariablePriceInput = {
  unitPrice: number | null;
  billedInclusive: number | null;
  billedTax: number | null;
  billedExclusive: number | null;
  billedUsage: number | null;
};
export const emptyVariablePrice = (): VariablePriceInput => ({ unitPrice: null, billedInclusive: null, billedTax: null, billedExclusive: null, billedUsage: null });
// 小分類を新しく作るときの、変動単価・請求書の単価表示の既定値です。
export const subItemDefaults = () => ({
  showUnitPriceOnInvoice: true, inputMode: 'usage' as InputMode,
  variablePriceMethod: 'manual' as VariablePriceMethod, unitPriceRoundingDigits: 2, unitPriceRoundingMode: 'floor' as RoundingMode, monthly: emptyVariablePrice(),
});
export type Category = { id: CategoryId; name: string; unit: string; billable: boolean; fixedBillable: boolean };
export type SubItem = {
  id: string;
  categoryId: CategoryId;
  name: string;
  kind: 'basic' | 'custom';
  lineItemId: string;
  // 固定：設定した単価を使う／変動：月ごとに変わる単価を、単価計算タブで決める
  priceMode: PriceMode;
  // 変動単価の決め方と、請求額から計算した単価の小数点以下の処理（残す桁数と丸め方）です。
  variablePriceMethod: VariablePriceMethod;
  unitPriceRoundingDigits: number;
  unitPriceRoundingMode: RoundingMode;
  // 変動単価の、対象月の入力です。
  monthly: VariablePriceInput;
  // 請求書に単価を出すかどうかです。オフの小分類は、請求書作成で単価を空欄にします。
  showUnitPriceOnInvoice: boolean;
  // 従来のビル既定単価です。画面からは設定しなくなりました（明細項目の既定単価を使います）。計算には使いません。
  defaultUnitPrice: number | null;
  // 変動単価の請求額を税込・税抜のどちらで割るか、契約行の単価が税込かどうかです。
  // 税込の単価は、この丸め方で税抜へ戻します（契約区画の税込単価も同じ丸め方です）。
  // 税抜換算は金額を出す処理なので、必ず小数点以下を処理します。
  taxMode: TaxMode;
  taxRoundingMode: RoundingMode;
  // 使用量の小数点以下の扱いです。
  usageRoundingDigits: number;
  // 使用量を画面に出すときの小数点以下の桁数です（計算の丸めとは別です）。
  usageDisplayDigits: number;
  usageRoundingMode: RoundingMode;
  // 既定の請求期間です。請求設定の請求期間パターンから選びます。
  periodPatternId: string;
  // 検針値の入力方式です。指針入力は、前月指針との差分を使用量にします。
  inputMode: InputMode;
};
// 増額分の仕入（電力会社などからの請求）です。月ごとに手入力します。
export type SurchargePurchase = { periodStart: string; periodEnd: string; amountInclusive: number | null; usage: number | null };
export const emptySurchargePurchase = (): SurchargePurchase => ({ periodStart: '', periodEnd: '', amountInclusive: null, usage: null });
// unitPrice は税抜の増額分単価です。仕入の請求金額を入れた月は、増額分タブで算出した単価に置き換えます。
export type Surcharge = { id: string; name: string; categoryId: CategoryId; unitPrice: number; lineItemId: string; billable: boolean; purchase: SurchargePurchase;
  // 既定の請求期間です。請求設定の請求期間パターンから選びます。
  periodPatternId: string;
};
// 請求設定で登録した明細項目のうち、請求種別に公共料金（電気・水道・ガス）が設定されているものです。
export type LineItem = { id: string; name: string; utilityKind: string | null; chargeTypeName: string };
// テナントの契約行へ振り分けたメーターの使用量です。中間検針のあるメーターは区間ごとに1件になります。
// tenantId が空のものは、未割当・空室のため請求しない使用量です。
export type MeterShare = { id: string; meterId?: string; subItemId: string; code: string; label: string; tenantId: string; rowIndex: number; usage: number; unitPrice?: number; unitId?: string };

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
  // 分割した行を見分けるための名前です（3F など）。空欄なら「分割 n」と表示します。
  splitLabel: string;
  // 分割した行が受け持つ区画です。どの行にも無い区画は1行目で計算します。
  unitIds: string[];
};

// メーター識別には階数だけを入れます（2F、B1F など）。全角は半角に直し、英数字以外は取り除きます。
export const floorLabel = (value: string) => value
  .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
  .toUpperCase().replace(/[^0-9A-Z]/g, '');

export const splitName = (row: ContractRow, index: number) => row.splitLabel.trim() || `分割 ${index + 1}`;

// 契約区画・明細項目で持つ単価です。税込のときは計算で税抜へ戻します。
export type PriceSetting = { unitPrice: number; taxMode: TaxMode };
export type BuildingConfig = {
  categories: Category[]; subItems: SubItem[]; surcharges: Surcharge[]; taxRate: number;
  // 契約区画の単価（その検針月の単価に解決済み）です。キーは「区画ID:テナントID」→ 明細項目ID。
  contractPrices?: Record<string, Record<string, PriceSetting>>;
  // 明細項目の既定単価です。契約区画に単価が無いときに使います。キーは明細項目ID。
  lineItemDefaults?: Record<string, PriceSetting>;
  // 単価を分類で共通にした分類です。この分類の固定単価の小分類は、明細項目ではなく分類の単価を使います。
  categoryPriceScopes?: Partial<Record<CategoryId, 'line_item' | 'category'>>;
  // 契約区画の分類共通の単価（その検針月の単価に解決済み）です。キーは「区画ID:テナントID」→ 分類。
  contractCategoryPrices?: Record<string, Partial<Record<CategoryId, PriceSetting>>>;
  // 分類共通の既定単価です。
  categoryDefaults?: Partial<Record<CategoryId, PriceSetting>>;
  // 契約区画の基本料です。キーは「区画ID:テナントID」→ 分類。
  contractBasics?: Record<string, Partial<Record<CategoryId, { amount: number; taxMode: TaxMode }>>>;
};
export const contractPriceKey = (unitId: string, tenantId: string) => `${unitId}:${tenantId}`;

export const initialBuilding: BuildingConfig = {
  categories: [
    { id: 'electric', name: '電気', unit: 'kWh', billable: true, fixedBillable: true },
    { id: 'water', name: '水道', unit: '㎥', billable: true, fixedBillable: false },
    { id: 'gas', name: 'ガス', unit: '㎥', billable: true, fixedBillable: false },
  ],
  subItems: [
    { id: 'electric_basic', categoryId: 'electric', name: '基本料', kind: 'basic', lineItemId: '', priceMode: 'fixed' as PriceMode, defaultUnitPrice: null, periodPatternId: '', taxMode: 'exclusive' as TaxMode, taxRoundingMode: 'floor' as RoundingMode, usageRoundingDigits: 1, usageDisplayDigits: 1, usageRoundingMode: 'round' as RoundingMode, ...subItemDefaults() },
    { id: 'light', categoryId: 'electric', name: '電灯', kind: 'custom', lineItemId: '', priceMode: 'fixed' as PriceMode, defaultUnitPrice: 35, periodPatternId: '', taxMode: 'exclusive' as TaxMode, taxRoundingMode: 'floor' as RoundingMode, usageRoundingDigits: 1, usageDisplayDigits: 1, usageRoundingMode: 'round' as RoundingMode, ...subItemDefaults() },
    { id: 'ac', categoryId: 'electric', name: '空調', kind: 'custom', lineItemId: '', priceMode: 'fixed' as PriceMode, defaultUnitPrice: 35, periodPatternId: '', taxMode: 'exclusive' as TaxMode, taxRoundingMode: 'floor' as RoundingMode, usageRoundingDigits: 1, usageDisplayDigits: 1, usageRoundingMode: 'round' as RoundingMode, ...subItemDefaults() },
    { id: 'water_basic', categoryId: 'water', name: '基本料', kind: 'basic', lineItemId: '', priceMode: 'fixed' as PriceMode, defaultUnitPrice: null, periodPatternId: '', taxMode: 'exclusive' as TaxMode, taxRoundingMode: 'floor' as RoundingMode, usageRoundingDigits: 1, usageDisplayDigits: 1, usageRoundingMode: 'round' as RoundingMode, ...subItemDefaults() },
    { id: 'water_usage', categoryId: 'water', name: '水道', kind: 'custom', lineItemId: '', priceMode: 'fixed' as PriceMode, defaultUnitPrice: 338.27, periodPatternId: '', taxMode: 'exclusive' as TaxMode, taxRoundingMode: 'floor' as RoundingMode, usageRoundingDigits: 1, usageDisplayDigits: 1, usageRoundingMode: 'round' as RoundingMode, ...subItemDefaults() },
    { id: 'gas_basic', categoryId: 'gas', name: '基本料', kind: 'basic', lineItemId: '', priceMode: 'fixed' as PriceMode, defaultUnitPrice: null, periodPatternId: '', taxMode: 'exclusive' as TaxMode, taxRoundingMode: 'floor' as RoundingMode, usageRoundingDigits: 1, usageDisplayDigits: 1, usageRoundingMode: 'round' as RoundingMode, ...subItemDefaults() },
    { id: 'gas_usage', categoryId: 'gas', name: 'ガス', kind: 'custom', lineItemId: '', priceMode: 'fixed' as PriceMode, defaultUnitPrice: 160, periodPatternId: '', taxMode: 'exclusive' as TaxMode, taxRoundingMode: 'floor' as RoundingMode, usageRoundingDigits: 1, usageDisplayDigits: 1, usageRoundingMode: 'round' as RoundingMode, ...subItemDefaults() },
  ],
  taxRate: 0.1,
  surcharges: [{ id: 'surcharge', name: '電気増額分', categoryId: 'electric', unitPrice: 8.02, lineItemId: '', billable: true, purchase: emptySurchargePurchase(), periodPatternId: '' }],
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
  splitLabel: '',
  unitIds: [],
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

const meter = (subItemId: string, code: string, label: string, tenantId: string, usage: number, unitPrice?: number): MeterShare =>
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

export const initialMeters: MeterShare[] = [
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
export type SubItemResult = { subItem: SubItem; meters: MeterShare[]; usage: number; amount: number; groups: ChargeGroup[] };
export type SurchargeResult = { surcharge: Surcharge; usage: number; amount: number };
export type CategoryResult = { category: Category; subItems: SubItemResult[]; usage: number; amount: number };
export type RowResult = { row: ContractRow; index: number; categories: CategoryResult[]; surcharges: SurchargeResult[]; total: number };

export const metersFor = (subItemId: string, tenantId: string, rowIndex: number, meters: MeterShare[]) =>
  meters.filter((row) => row.subItemId === subItemId && row.tenantId === tenantId && row.rowIndex === rowIndex);

export function toExclusive(price: number, subItem: SubItem, taxRate: number, taxMode: TaxMode = subItem.taxMode) {
  if (taxMode !== 'inclusive' || !price) return price;
  return roundDigits(price / (1 + taxRate), 0, subItem.taxRoundingMode);
}

// 固定単価の小分類の単価（税抜）です。次の順で決めます。
//   メーターの割り当てで上書きした単価 → メーターの区画の契約単価 → 契約行の単価（従来の設定） → 既定単価 → 0
// 契約単価・既定単価は、単価を分類で共通にした分類では分類の単価、それ以外は小分類の明細項目の単価です。
// 単価の税区分は、契約単価・既定単価はそれぞれの設定、メーター・契約行の単価は小分類の設定に従います。
export type PriceSources = Pick<BuildingConfig, 'contractPrices' | 'lineItemDefaults' | 'categoryPriceScopes' | 'contractCategoryPrices' | 'categoryDefaults'>;
export function resolveUnitPrice(subItem: SubItem, share: MeterShare, row: ContractRow, building: PriceSources): { price: number; taxMode: TaxMode } {
  if (share.unitPrice !== undefined) return { price: share.unitPrice, taxMode: subItem.taxMode };
  const key = share.unitId ? contractPriceKey(share.unitId, share.tenantId) : '';
  if (building.categoryPriceScopes?.[subItem.categoryId] === 'category') {
    const shared = key ? building.contractCategoryPrices?.[key]?.[subItem.categoryId] : undefined;
    if (shared) return { price: shared.unitPrice, taxMode: shared.taxMode };
    const legacyShared = row.unitPrices[subItem.id];
    if (legacyShared !== null && legacyShared !== undefined) return { price: legacyShared, taxMode: subItem.taxMode };
    const sharedDefault = building.categoryDefaults?.[subItem.categoryId];
    return sharedDefault ? { price: sharedDefault.unitPrice, taxMode: sharedDefault.taxMode } : { price: 0, taxMode: 'exclusive' };
  }
  const contract = key && subItem.lineItemId ? building.contractPrices?.[key]?.[subItem.lineItemId] : undefined;
  if (contract) return { price: contract.unitPrice, taxMode: contract.taxMode };
  const legacy = row.unitPrices[subItem.id];
  if (legacy !== null && legacy !== undefined) return { price: legacy, taxMode: subItem.taxMode };
  const fallback = subItem.lineItemId ? building.lineItemDefaults?.[subItem.lineItemId] : undefined;
  if (fallback) return { price: fallback.unitPrice, taxMode: fallback.taxMode };
  return { price: 0, taxMode: 'exclusive' };
}

// 請求額の3つの欄（税込・消費税・税抜）から、計算に使う税抜・税込を求めます。
//   税抜を手入力した場合　　　　…その税抜を使い、税込・消費税は使いません（画面ではグレーアウト）
//   税込と消費税を入れた場合　　…税抜＝税込−消費税
//   税込だけを入れた場合　　　　…消費税＝税込×税率÷(1＋税率) を切り捨て、税抜＝税込−消費税
export type BilledAmounts = { inclusive: number | null; tax: number | null; exclusive: number | null; exclusiveEntered: boolean };
export function billedAmounts(input: VariablePriceInput, taxRate: number): BilledAmounts {
  if (input.billedExclusive !== null) return { inclusive: null, tax: null, exclusive: input.billedExclusive, exclusiveEntered: true };
  if (input.billedInclusive === null) return { inclusive: null, tax: input.billedTax, exclusive: null, exclusiveEntered: false };
  const tax = input.billedTax ?? roundDigits(input.billedInclusive * taxRate / (1 + taxRate), 0, 'floor');
  return { inclusive: input.billedInclusive, tax, exclusive: input.billedInclusive - tax, exclusiveEntered: false };
}

// 変動単価の、その月の単価です。決まらないとき（未入力・使用量0）は null を返します。
// 請求額から計算する場合、小分類の税区分が税込なら税込請求額、税抜なら税抜請求額を使用量で割り、
// 小分類で決めた桁・丸め方で処理します。
export function variableUnitPrice(subItem: SubItem, taxRate: number): number | null {
  if (subItem.variablePriceMethod === 'manual') return subItem.monthly.unitPrice;
  const usage = subItem.monthly.billedUsage;
  if (!usage) return null;
  // 税込の小分類は税込の欄だけを出すため、税込の入力をそのまま使います。
  const billed = subItem.taxMode === 'inclusive' ? subItem.monthly.billedInclusive : billedAmounts(subItem.monthly, taxRate).exclusive;
  if (billed === null) return null;
  return roundDigits(billed / usage, subItem.unitPriceRoundingDigits, subItem.unitPriceRoundingMode);
}

// 基本料は、検針期間の途中で入居・退去したテナントだけ入居日数で日割りします（丸めは契約行の小数点の設定）。
export function calculateSubItem(subItem: SubItem, category: Category, row: ContractRow, tenantId: string, rowIndex: number, meters: MeterShare[], taxRate: number, basicRatio?: BasicRatio, prices: PriceSources = {}): SubItemResult {
  const roundUsage = (value: number) => roundDigits(value, subItem.usageRoundingDigits, subItem.usageRoundingMode);
  const roundAmount = (value: number) => applyRounding(value, 1, row.amountRoundingMode);
  const empty = { subItem, meters: [], usage: 0, amount: 0, groups: [] as ChargeGroup[] };
  if (!row.billable[subItem.id]) return empty;

  if (subItem.kind === 'basic') {
    const monthly = category.fixedBillable ? row.fixedCharges[subItem.id] ?? 0 : 0;
    const fixed = proratedAmount(monthly, basicRatio, row.amountRoundingMode);
    const label = fixed !== monthly && basicRatio ? `日割り（${basicRatio.days}／${basicRatio.totalDays}日）` : '固定額';
    return { ...empty, amount: fixed, groups: fixed ? [{ key: 'fixed', label, usage: 0, unitPrice: 0, amount: fixed }] : [] };
  }

  const own = metersFor(subItem.id, tenantId, rowIndex, meters);
  const mode = row.sumMode[category.id] ?? 'aggregate';
  // 単価は resolveUnitPrice の順で決めます。税込単価は税抜へ戻します。
  // 変動単価は単価計算タブで決めたその月の単価を、全メーター共通で使います（未決定なら0円）。
  const monthPrice = subItem.priceMode === 'variable' ? toExclusive(variableUnitPrice(subItem, taxRate) ?? 0, subItem, taxRate) : 0;
  const priceOf = (target: MeterShare) => subItem.priceMode === 'variable' ? monthPrice
    : (() => { const resolved = resolveUnitPrice(subItem, target, row, prices); return toExclusive(resolved.price, subItem, taxRate, resolved.taxMode); })();
  const usage = roundUsage(own.reduce((sum, target) => sum + target.usage, 0));

  // 単価が違うメーターは、まとめて計算の場合も分けて計算します。
  const buckets = new Map<string, MeterShare[]>();
  // 中間検針で区間に分かれたメーターも、メーターごとに計算する場合は同じメーターを1つにまとめます。
  for (const target of own) { const key = mode === 'perMeter' ? target.meterId ?? target.id : String(priceOf(target)); buckets.set(key, [...(buckets.get(key) ?? []), target]); }
  const groups = [...buckets.entries()].map(([key, rows]) => {
    const groupUsage = roundUsage(rows.reduce((sum, target) => sum + target.usage, 0));
    return { key, label: mode === 'perMeter' ? rows[0].code : buckets.size > 1 ? `単価${priceOf(rows[0])}円` : 'まとめて計算', usage: groupUsage, unitPrice: priceOf(rows[0]), amount: roundAmount(groupUsage * priceOf(rows[0])) };
  });
  return { subItem, meters: own, usage, amount: groups.reduce((sum, group) => sum + group.amount, 0), groups };
}

export function calculateRow(row: ContractRow, index: number, tenantId: string, building: BuildingConfig, meters: MeterShare[], basicRatio?: BasicRatio): RowResult {
  const roundAmount = (value: number) => applyRounding(value, 1, row.amountRoundingMode);
  const categories: CategoryResult[] = building.categories.filter((category) => category.billable).map((category) => {
    // 小分類が1つだけの分類は、小分類ごとの請求フラグを持たず、分類の請求有無だけで決めます。
    const singleCustom = building.subItems.filter((item) => item.categoryId === category.id && item.kind === 'custom').length === 1;
    const subItems = building.subItems.filter((subItem) => subItem.categoryId === category.id)
      .map((subItem) => row.categoryBillable[category.id] === false
        ? { subItem, meters: [], usage: 0, amount: 0, groups: [] }
        : calculateSubItem(subItem, category, singleCustom && subItem.kind === 'custom' ? { ...row, billable: { ...row.billable, [subItem.id]: true } } : row, tenantId, index, meters, building.taxRate, basicRatio, building));
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

// 請求書作成へ渡す明細です。小分類・増額分ごと、テナントの契約行ごとに1行にします。
// invoiceNo は、請求書分割設定で区画ごとに分けているテナントの、何番目の請求書に載せるかです。
export type MeterInvoiceLine = {
  tenantId: string; tenantName: string; invoiceNo: number; lineItemId: string | null; sourceName: string;
  usage: number | null; unit: string; unitPrice: number | null; amount: number; periodPatternId: string;
};
// 請求書に載せる順番です。分類（電気→水道→ガス）ごとに、小分類の並び順、その後に増額分を並べます。
export function meterSourceOrder(building: BuildingConfig): Map<string, number> {
  const categoryOrder: CategoryId[] = ['electric', 'water', 'gas'];
  const ids = categoryOrder.flatMap((categoryId) => [
    ...building.subItems.filter((row) => row.categoryId === categoryId).map((row) => row.id),
    ...building.surcharges.filter((row) => row.categoryId === categoryId).map((row) => row.id),
  ]);
  return new Map(ids.map((id, index) => [id, index]));
}
export function meterInvoiceLines(results: TenantResult[], building: BuildingConfig): MeterInvoiceLine[] {
  const order = meterSourceOrder(building);
  // テナントの中では、分割行をまたいでも小分類の順に並べます（同じ小分類は分割行の順）。
  return results.flatMap((result) => {
    const lines = tenantInvoiceLines(result, building).map((line, index) => ({ line, index }));
    return lines.sort((left, right) => (order.get(left.line.sourceId) ?? 9999) - (order.get(right.line.sourceId) ?? 9999) || left.index - right.index)
      .map(({ line: { sourceId: _sourceId, ...line } }) => line);
  });
}
function tenantInvoiceLines(result: TenantResult, building: BuildingConfig): Array<MeterInvoiceLine & { sourceId: string }> {
  const unitOf = (id: CategoryId) => building.categories.find((row) => row.id === id)?.unit ?? '';
  return result.rows.flatMap((row) => {
    const shared = { tenantId: result.tenant.id, tenantName: result.tenant.name, invoiceNo: result.tenant.invoiceSplitByUnit ? row.row.invoiceNo : 1 };
    const subItems = row.categories.flatMap((category) => category.subItems.filter((item) => item.amount).map((item) => ({
      ...shared, sourceId: item.subItem.id, lineItemId: item.subItem.lineItemId || null, sourceName: item.subItem.name,
      // 基本料は固定額なので、数量・単価は出しません。単価が違うメーターが混ざる行と、
      // 請求書に単価を出さない設定の小分類も、単価は空欄にします。
      usage: item.subItem.kind === 'basic' ? null : item.usage, unit: item.subItem.kind === 'basic' ? '' : unitOf(category.category.id),
      unitPrice: item.subItem.kind !== 'basic' && item.subItem.showUnitPriceOnInvoice && item.groups.length === 1 ? item.groups[0].unitPrice : null,
      amount: item.amount, periodPatternId: item.subItem.periodPatternId,
    })));
    const surcharges = row.surcharges.filter((item) => item.amount).map((item) => ({
      ...shared, sourceId: item.surcharge.id, lineItemId: item.surcharge.lineItemId || null, sourceName: item.surcharge.name,
      // 増額分は請求しますが、単価は請求書に載せません（数量・金額だけ出します）。
      usage: item.usage, unit: unitOf(item.surcharge.categoryId), unitPrice: null, amount: item.amount, periodPatternId: item.surcharge.periodPatternId,
    }));
    return [...subItems, ...surcharges];
  });
}

// 増額分の単価計算です。
//   回収の税込電気代＝回収額（分類の合計）×(1＋税率) を四捨五入
//   差額＝税込仕入額−税込回収額（マイナスなら0）
//   税込増額分単価＝差額÷回収使用量計
//   税抜増額分単価＝税込増額分単価÷(1＋税率) を小数第3位以下切り上げ
// 仕入の請求金額が未入力、または回収使用量計が0のときは単価を決めません（null）。
export type SurchargeCalculation = {
  recoveredUsage: number; recoveredAmount: number; recoveredInclusive: number;
  difference: number | null; inclusiveUnitPrice: number | null; exclusiveUnitPrice: number | null;
};
export function calculateSurchargePrice(purchase: SurchargePurchase, recoveredUsage: number, recoveredAmount: number, taxRate: number): SurchargeCalculation {
  const recoveredInclusive = applyRounding(recoveredAmount * (1 + taxRate), 1, 'round');
  const base = { recoveredUsage, recoveredAmount, recoveredInclusive };
  if (purchase.amountInclusive === null) return { ...base, difference: null, inclusiveUnitPrice: null, exclusiveUnitPrice: null };
  const difference = purchase.amountInclusive - recoveredInclusive;
  if (!recoveredUsage) return { ...base, difference, inclusiveUnitPrice: null, exclusiveUnitPrice: null };
  const inclusiveUnitPrice = Math.max(difference, 0) / recoveredUsage;
  return { ...base, difference, inclusiveUnitPrice, exclusiveUnitPrice: roundDigits(inclusiveUnitPrice / (1 + taxRate), 2, 'ceil') };
}

// 全テナントを計算します。増額分は、まず増額分を除いた分類の合計（回収）を出し、
// 仕入の請求金額が入っている増額分は算出した税抜単価に置き換えてから、もう一度計算します。
// 増額分は分類の金額に含まれないため、置き換えても回収額は変わりません。
export function calculateAll(tenants: TenantConfig[], building: BuildingConfig, meters: MeterShare[], ratios: Map<string, BasicRatio> = new Map()) {
  const first = tenants.map((tenant) => calculateTenant(tenant, building, meters, ratios));
  const recovered = (categoryId: CategoryId) => {
    const rows = first.flatMap((result) => result.rows.map((row) => row.categories.find((item) => item.category.id === categoryId)));
    return { usage: rows.reduce((sum, row) => sum + (row?.usage ?? 0), 0), amount: rows.reduce((sum, row) => sum + (row?.amount ?? 0), 0) };
  };
  const calculations = new Map<string, SurchargeCalculation>();
  for (const surcharge of building.surcharges) {
    const total = recovered(surcharge.categoryId);
    calculations.set(surcharge.id, calculateSurchargePrice(surcharge.purchase, total.usage, total.amount, building.taxRate));
  }
  const surcharges = building.surcharges.map((surcharge) => {
    const calculated = calculations.get(surcharge.id)?.exclusiveUnitPrice;
    return surcharge.purchase.amountInclusive === null ? surcharge : { ...surcharge, unitPrice: calculated ?? 0 };
  });
  const effective = { ...building, surcharges };
  const results = surcharges.some((row, index) => row !== building.surcharges[index])
    ? tenants.map((tenant) => calculateTenant(tenant, effective, meters, ratios)) : first;
  return { results, building: effective, calculations };
}

export function calculateTenant(tenant: TenantConfig, building: BuildingConfig, meters: MeterShare[], ratios: Map<string, BasicRatio> = new Map()) {
  const rows = tenant.rows.map((row, index) => calculateRow(row, index, tenant.id, building, meters, ratios.get(row.id)));
  const total = rows.reduce((sum, row) => sum + row.total, 0);

  // 請求明細の項目ごとにまとめた金額です。請求書作成へ渡す単位になります。
  const byLineItem = new Map<string, number>();
  for (const row of rows) {
    for (const category of row.categories) for (const subItem of category.subItems) if (subItem.amount && subItem.subItem.lineItemId) byLineItem.set(subItem.subItem.lineItemId, (byLineItem.get(subItem.subItem.lineItemId) ?? 0) + subItem.amount);
    for (const surcharge of row.surcharges) if (surcharge.amount && surcharge.surcharge.lineItemId) byLineItem.set(surcharge.surcharge.lineItemId, (byLineItem.get(surcharge.surcharge.lineItemId) ?? 0) + surcharge.amount);
  }

  return { tenant, rows, total, byLineItem, difference: total - tenant.expected };
}
