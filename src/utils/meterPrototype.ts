// 検針データ集計の試作用データと計算です。肥後橋の「電気検針データ集計表」R8.8 を写しています。
// 画面に出すのは集計結果だけにして、単価・丸め・メーターの紐づけは設定として裏側に置きます。

export type RoundingMode = 'floor' | 'ceil' | 'round';
export type LightMeter = { code: string; usage: number };
export type AcReading = { no: string; electric: number; gas: number };
// 区画です。単価は区画ごとに持ちます。1テナントが複数区画を借りている場合は区画ごとに計算して合算します。
export type BlockConfig = { id: string; location: string; unitPrice: number; lightMeters: LightMeter[]; acReadings: AcReading[] };
export type TenantConfig = {
  id: string;
  name: string;
  basicCharge: number;
  usageRoundingUnit: number;
  usageRoundingMode: RoundingMode;
  amountRoundingUnit: number;
  amountRoundingMode: RoundingMode;
  blocks: BlockConfig[];
  // 元のExcelの値です。計算結果が一致するかを画面で突き合わせます。
  expected: { light: number; ac: number; gas: number; surcharge: number; total: number };
};

export type CommonRates = { surchargeUnitPrice: number; gasUnitPrice: number; meterDate: string; lightPeriod: string; acPeriod: string };

export const initialCommonRates: CommonRates = { surchargeUnitPrice: 8.02, gasUnitPrice: 160, meterDate: '2026/9/2', lightPeriod: '8/7～9/2', acPeriod: '8/1～8/31' };

const floorRounding = { usageRoundingUnit: 0.1, usageRoundingMode: 'round' as RoundingMode, amountRoundingUnit: 1, amountRoundingMode: 'floor' as RoundingMode, basicCharge: 0 };
const roundRounding = { ...floorRounding, amountRoundingMode: 'round' as RoundingMode };

export const initialTenants: TenantConfig[] = [
  {
    id: 'T1', name: "㈱Y'sデンタルサポート", ...floorRounding,
    blocks: [{ id: 'B1', location: '2F 南', unitPrice: 35, lightMeters: [{ code: '223-607-805', usage: 564.5 }], acReadings: [{ no: '1：4-07', electric: 9.816, gas: 20.392 }, { no: '1：4-08', electric: 9.931, gas: 41.479 }, { no: '1：4-09', electric: 11.55, gas: 62.76 }, { no: '1：4-10', electric: 20.047, gas: 181.182 }] }],
    expected: { light: 19757, ac: 1795, gas: 48928, surcharge: 4938, total: 75418 },
  },
  {
    id: 'T2', name: '錦江シッピングジャパン㈱', ...roundRounding,
    blocks: [{ id: 'B2', location: '2F 北', unitPrice: 33, lightMeters: [{ code: '223-607-995', usage: 431.7 }], acReadings: [{ no: '1：4-02', electric: 8.859, gas: 26.682 }, { no: '1：4-03', electric: 7.369, gas: 10.039 }, { no: '1：4-04', electric: 16.746, gas: 127.443 }] }],
    expected: { light: 14246, ac: 1089, gas: 26272, surcharge: 3727, total: 45334 },
  },
  {
    id: 'T3', name: 'Genesis(合)', ...floorRounding,
    blocks: [{ id: 'B3', location: '2F 中', unitPrice: 35, lightMeters: [{ code: '224-603-349', usage: 296.1 }], acReadings: [{ no: '1：4-05', electric: 8.317, gas: 22.329 }, { no: '1：4-06', electric: 9.106, gas: 36.699 }] }],
    expected: { light: 10363, ac: 609, gas: 9440, surcharge: 2514, total: 22926 },
  },
  {
    id: 'T4', name: 'メゾンレクシア㈱', ...roundRounding,
    blocks: [
      {
        id: 'B4', location: '3F 南・北', unitPrice: 31.65,
        lightMeters: [{ code: '223-607-843', usage: 290.7 }, { code: '224-602-118', usage: 402.9 }],
        acReadings: [
          { no: '1：3-08', electric: 10.936, gas: 24.426 }, { no: '1：3-09', electric: 9.851, gas: 4.489 }, { no: '1：3-10', electric: 12.085, gas: 49.372 }, { no: '1：3-11', electric: 10.427, gas: 16.72 },
          { no: '1：3-12', electric: 16.866, gas: 108.549 }, { no: '1：3-13', electric: 11.641, gas: 11.118 }, { no: '1：3-14', electric: 13.5, gas: 51.599 }, { no: '1：3-15', electric: 13.476, gas: 46.551 },
          { no: '1：4-00', electric: 14.614, gas: 75.322 }, { no: '1：4-01', electric: 13.545, gas: 45.546 },
        ],
      },
      {
        id: 'B5', location: '4F 南・北', unitPrice: 31.65,
        lightMeters: [{ code: '223-607-982', usage: 1253 }, { code: '224-602-989', usage: 1103.9 }],
        acReadings: [
          { no: '1：2-14', electric: 14.058, gas: 336.335 }, { no: '1：2-15', electric: 1.012, gas: 23.633 }, { no: '1：3-00', electric: 6.543, gas: 127.033 }, { no: '1：3-01', electric: 0.695, gas: 13.799 },
          { no: '1：3-02', electric: 7.007, gas: 144.478 }, { no: '1：3-03', electric: 3.556, gas: 90.634 }, { no: '1：3-04', electric: 5.301, gas: 149.234 }, { no: '1：3-05', electric: 7.564, gas: 127.121 },
          { no: '1：3-06', electric: 2.851, gas: 95.433 }, { no: '1：3-07', electric: 8.011, gas: 218.711 },
        ],
      },
    ],
    expected: { light: 96548, ac: 5807, gas: 281616, surcharge: 25936, total: 409907 },
  },
  {
    id: 'T5', name: '結TRUST㈱', ...roundRounding,
    blocks: [{ id: 'B6', location: '5F 南西', unitPrice: 35, lightMeters: [{ code: '244-583', usage: 129 }], acReadings: [{ no: '1：2-11', electric: 17.01, gas: 107.876 }] }],
    expected: { light: 4515, ac: 595, gas: 17264, surcharge: 1171, total: 23545 },
  },
  {
    id: 'T6', name: 'クリエートメディック㈱', ...floorRounding,
    blocks: [{ id: 'B7', location: '5F 南東', unitPrice: 35, lightMeters: [{ code: '223-607-967', usage: 269 }, { code: '223-607-820', usage: 148.1 }], acReadings: [{ no: '1：2-09', electric: 9.261, gas: 11.468 }, { no: '1：2-10', electric: 10.391, gas: 49.481 }, { no: '1：2-12', electric: 12.441, gas: 83.829 }, { no: '1：2-13', electric: 14.776, gas: 119.191 }] }],
    expected: { light: 14598, ac: 1641, gas: 42240, surcharge: 3721, total: 62200 },
  },
  {
    id: 'T7', name: 'ラコンテ', ...roundRounding,
    blocks: [{ id: 'B8', location: '5F 中', unitPrice: 33, lightMeters: [{ code: '223-607-852', usage: 238 }], acReadings: [{ no: '1：2-07', electric: 8.396, gas: 18.284 }, { no: '1：2-08', electric: 10.263, gas: 52.64 }] }],
    expected: { light: 7854, ac: 617, gas: 11344, surcharge: 2059, total: 21874 },
  },
  {
    id: 'T8', name: '㈱ユニオスパートナーズ', ...roundRounding,
    blocks: [{ id: 'B9', location: '5F 北', unitPrice: 35, lightMeters: [{ code: '223-607-809', usage: 255.8 }], acReadings: [{ no: '1：2-04', electric: 10.209, gas: 63.688 }, { no: '1：2-05', electric: 8.528, gas: 23.484 }, { no: '1：2-06', electric: 9.954, gas: 53.783 }] }],
    expected: { light: 8953, ac: 1005, gas: 22560, surcharge: 2282, total: 34800 },
  },
  {
    id: 'T9', name: 'ロータスアソシエイツ㈱', ...floorRounding,
    blocks: [{ id: 'B10', location: '6F 南西', unitPrice: 35, lightMeters: [{ code: '259-403', usage: 314 }], acReadings: [{ no: '1：2-01', electric: 11.195, gas: 102.052 }, { no: '1：2-02', electric: 11.808, gas: 105.699 }, { no: '1：2-03', electric: 9.037, gas: 64.446 }] }],
    expected: { light: 10990, ac: 1120, gas: 43552, surcharge: 2774, total: 58436 },
  },
  {
    id: 'T10', name: '九州運輸センター協同組合', ...floorRounding,
    blocks: [{ id: 'B11', location: '6F 南東', unitPrice: 35, lightMeters: [{ code: '222-604-409', usage: 575.5 }], acReadings: [{ no: '1：1-14', electric: 8.134, gas: 28.626 }, { no: '1：1-15', electric: 10.164, gas: 55.612 }, { no: '1：2-00', electric: 12.192, gas: 85.89 }] }],
    expected: { light: 20142, ac: 1067, gas: 27216, surcharge: 4860, total: 53285 },
  },
  {
    id: 'T11', name: '㈱ミタカ', ...roundRounding,
    blocks: [{ id: 'B12', location: '6F 中北', unitPrice: 35, lightMeters: [{ code: '165-031', usage: 214 }], acReadings: [{ no: '1：1-13', electric: 14.86, gas: 145.1 }] }],
    expected: { light: 7490, ac: 522, gas: 23216, surcharge: 1836, total: 33064 },
  },
  {
    id: 'T12', name: 'アイシステム', ...roundRounding,
    blocks: [{ id: 'B13', location: '6F 北', unitPrice: 33, lightMeters: [{ code: '223-607-828', usage: 296.2 }], acReadings: [{ no: '1：1-11', electric: 11.214, gas: 87.967 }, { no: '1：1-12', electric: 8.255, gas: 32.726 }] }],
    expected: { light: 9775, ac: 644, gas: 19312, surcharge: 2532, total: 32263 },
  },
  {
    id: 'T13', name: 'コンカレントシステムズ', ...roundRounding, basicCharge: 50379,
    blocks: [
      {
        id: 'B14', location: '7F 南・中', unitPrice: 15.38,
        lightMeters: [{ code: '223-607-973', usage: 1474.8 }, { code: '223-607-819', usage: 3500 }],
        acReadings: [
          { no: '1：1-03', electric: 14.799, gas: 334.61 }, { no: '1：1-04', electric: 17.042, gas: 397.201 }, { no: '1：1-05', electric: 0.371, gas: 10.448 }, { no: '1：1-06', electric: 1.795, gas: 33.708 },
          { no: '1：1-07', electric: 3.872, gas: 84.222 }, { no: '1：1-08', electric: 2.113, gas: 42.935 }, { no: '1：1-09', electric: 5.535, gas: 95.157 }, { no: '1：1-10', electric: 9.356, gas: 162.876 },
        ],
      },
      {
        id: 'B15', location: '7F 北', unitPrice: 33,
        lightMeters: [{ code: '223-607-983', usage: 89.5 }],
        acReadings: [{ no: '1：1-00', electric: 0.586, gas: 16.978 }, { no: '1：1-01', electric: 0.497, gas: 11.018 }, { no: '1：1-02', electric: 0.796, gas: 23.476 }],
      },
    ],
    expected: { light: 129845, ac: 906, gas: 194016, surcharge: 41071, total: 365838 },
  },
];

export const applyRounding = (value: number, unit: number, mode: RoundingMode) => {
  if (!unit) return value;
  const scaled = Number((value / unit).toFixed(9));
  const rounded = mode === 'floor' ? Math.floor(scaled) : mode === 'ceil' ? Math.ceil(scaled) : Math.round(scaled);
  return Number((rounded * unit).toFixed(6));
};

export type BlockResult = { block: BlockConfig; lightUsage: number; lightAmount: number; acUsage: number; acAmount: number; gasUsage: number; surchargeUsage: number; surchargeAmount: number };
export type TenantResult = ReturnType<typeof calculateTenant>;

export function calculateTenant(tenant: TenantConfig, rates: CommonRates) {
  const roundUsage = (value: number) => applyRounding(value, tenant.usageRoundingUnit, tenant.usageRoundingMode);
  const roundAmount = (value: number) => applyRounding(value, tenant.amountRoundingUnit, tenant.amountRoundingMode);

  // 電灯・空調・電気増額分は区画ごとに丸め、ガスは単価が共通なのでテナント単位でまとめます。
  const blocks: BlockResult[] = tenant.blocks.map((block) => {
    const lightUsage = roundUsage(block.lightMeters.reduce((sum, meter) => sum + meter.usage, 0));
    const acUsage = roundUsage(block.acReadings.reduce((sum, reading) => sum + reading.electric, 0));
    const gasUsage = block.acReadings.reduce((sum, reading) => sum + reading.gas, 0);
    const surchargeUsage = roundUsage(lightUsage + acUsage);
    return {
      block, lightUsage, acUsage, gasUsage, surchargeUsage,
      lightAmount: roundAmount(lightUsage * block.unitPrice),
      acAmount: roundAmount(acUsage * block.unitPrice),
      surchargeAmount: roundAmount(surchargeUsage * rates.surchargeUnitPrice),
    };
  });

  const lightUsage = roundUsage(blocks.reduce((sum, row) => sum + row.lightUsage, 0));
  const lightAmount = blocks.reduce((sum, row) => sum + row.lightAmount, 0) + tenant.basicCharge;
  const acUsage = roundUsage(blocks.reduce((sum, row) => sum + row.acUsage, 0));
  const acAmount = blocks.reduce((sum, row) => sum + row.acAmount, 0);
  const gasUsage = roundUsage(blocks.reduce((sum, row) => sum + row.gasUsage, 0));
  const gasAmount = roundAmount(gasUsage * rates.gasUnitPrice);
  const surchargeUsage = roundUsage(blocks.reduce((sum, row) => sum + row.surchargeUsage, 0));
  const surchargeAmount = blocks.reduce((sum, row) => sum + row.surchargeAmount, 0);
  const total = lightAmount + acAmount + gasAmount + surchargeAmount;

  return {
    tenant, blocks, lightUsage, lightAmount, acUsage, acAmount, gasUsage, gasAmount, surchargeUsage, surchargeAmount, total,
    electricAmount: lightAmount + acAmount,
    difference: {
      light: lightAmount - tenant.expected.light,
      ac: acAmount - tenant.expected.ac,
      gas: gasAmount - tenant.expected.gas,
      surcharge: surchargeAmount - tenant.expected.surcharge,
      total: total - tenant.expected.total,
    },
  };
}
