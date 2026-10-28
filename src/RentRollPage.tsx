import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ContractDetailModal } from "./ContractDetailModal";
import type { ContractCapabilities } from "./lib/contract-capabilities";
import {
  allProductCategories,
  normalizeProductCategory,
  productCategories,
  productCategoryLabel,
  type ProductCategory,
} from "./lib/product-categories";
import { supabase } from "./lib/supabase";

type RentRollStatus =
  | "occupied"
  | "scheduled"
  | "move_in_scheduled"
  | "vacant"
  | "applied"
  | "unavailable";

type PropertyOption = {
  propertyId: string;
  propertyName: string;
  shortName: string | null;
};

type RentRollSource = {
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  floor_label: string | null;
  unit_type: string;
  rentable_area_sqm: number | null;
  source_discriminator: string | null;
  leasing_status: string | null;
  lease_contract_unit_id: string | null;
  lease_contract_id: string | null;
  contract_status: string | null;
  contract_start_date: string | null;
  contract_end_date: string | null;
  lease_end_date: string | null;
  lease_term_type: "ordinary" | "fixed_term" | null;
  renewal_due_date: string | null;
  actual_end_date: string | null;
  contract_notes: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  leased_area_sqm: number | null;
  monthly_rent_amount: number;
  monthly_common_charge_amount: number;
  rent_common_total_amount: number;
  monthly_parking_amount: number;
  other_monthly_amount: number;
  monthly_total_amount: number;
  deposit_amount: number;
  security_deposit_amount: number;
  key_money_amount: number;
  renewal_fee_amount: number;
  space_status: "occupied" | "vacant" | "unavailable" | null;
  space_number: string | null;
  parking_scope: "internal" | "external" | null;
  access_code: string | null;
  vehicle_model: string | null;
  registration_number: string | null;
  incoming_contracts?: Array<{
    lease_contract_id: string;
    lease_contract_unit_id: string;
    contract_start_date: string;
    tenant_name: string;
    monthly_total_amount: number;
  }>;
  pending_terminations?: Array<{
    appsuite_record_id: string;
    termination_date: string;
    target_scope: "contract" | "unit" | "parking";
  }>;
};

type RentRollRow = {
  unitId: string;
  leaseContractUnitId: string | null;
  unitType: string;
  displayType: string;
  status: RentRollStatus;
  productCategory: ProductCategory;
  floor: string;
  unitCode: string;
  unitName: string;
  discriminator: string | null;
  tenantName: string;
  leaseTermLabel: string;
  contractPeriod: string;
  area: number | null;
  rent: number;
  commonCharge: number;
  rentCommonTotal: number;
  parkingAmount: number;
  otherMonthlyAmount: number;
  total: number;
  deposit: number;
  securityDeposit: number;
  keyMoney: number;
  renewalFee: number;
  parkingScope: "internal" | "external" | null;
  parkingSpaceNumber: string;
  parkingAccessCode: string;
  parkingVehicle: string;
  areaTsubo?: number | null;
  sourceFileName?: string;
  sourceSheetName?: string;
  sourceRowNumber?: number | null;
  terminationScheduled?: boolean;
  terminationInProgress?: boolean;
  terminationDate?: string;
  snapshotAsOfDate?: string;
  incomingContracts?: RentRollSource["incoming_contracts"];
};

type SnapshotSource = {
  rent_roll_snapshot_row_id: string;
  source_sheet_name: string;
  source_row_number: number | null;
  floor_label: string | null;
  unit_code: string | null;
  unit_type: string | null;
  tenant_name: string | null;
  source_status: string | null;
  occupancy_status: "occupied" | "vacant";
  area_sqm: number | null;
  area_tsubo: number | null;
  monthly_rent_amount: number | null;
  monthly_common_charge_amount: number | null;
  monthly_parking_amount: number | null;
  other_monthly_amount: number | null;
  deposit_amount: number | null;
  security_deposit_amount: number | null;
  key_money_amount: number | null;
  renewal_fee_amount: number | null;
  review_flags: string | null;
};

const today = new Date().toISOString().slice(0, 10);
const currencyFormatter = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
});
const numberFormatter = new Intl.NumberFormat("ja-JP", {
  maximumFractionDigits: 2,
});
const collator = new Intl.Collator("ja-JP", {
  numeric: true,
  sensitivity: "base",
});

function parkingFacilityDisplayType(code: string, masterType: string | null | undefined): string {
  const normalizedCode = code.normalize("NFKC").toUpperCase().replace(/[\s　_-]/g, "");
  if (normalizedCode.includes("BIKE")) return "駐輪場";
  if (normalizedCode.startsWith("MACHINE")) return "機械式駐車場";
  if (normalizedCode === "FLAT") return "平面駐車場";
  return masterType || code || "駐車場";
}

const statusLabel: Record<RentRollStatus, string> = {
  occupied: "入居中",
  scheduled: "退去予定",
  move_in_scheduled: "入居予定",
  vacant: "空室",
  applied: "申込中",
  unavailable: "使用不可",
};

function formatJapaneseDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match
    ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日`
    : value;
}

function storedProductCategories(propertyId: string): ProductCategory[] {
  if (!propertyId) return allProductCategories;
  try {
    const stored = localStorage.getItem(
      `rent-roll-product-filters:v1:${propertyId}`,
    );
    if (!stored) return allProductCategories;
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return allProductCategories;
    return allProductCategories.filter((category) => parsed.includes(category));
  } catch {
    return allProductCategories;
  }
}

function summarizeRows(targetRows: RentRollRow[]) {
  return {
    units: targetRows.length,
    occupied: targetRows.filter(
      (row) => row.status === "occupied" || row.status === "scheduled",
    ).length,
    vacant: targetRows.filter(
      (row) => row.status === "vacant" || row.status === "move_in_scheduled",
    ).length,
    monthlyTotal: targetRows.reduce((total, row) => total + row.total, 0),
  };
}

function sumRentRollColumns(targetRows: RentRollRow[]) {
  return targetRows.reduce(
    (totals, row) => ({
      area: totals.area + (row.area ?? 0),
      rent: totals.rent + row.rent,
      commonCharge: totals.commonCharge + row.commonCharge,
      rentCommonTotal: totals.rentCommonTotal + row.rentCommonTotal,
      parkingAmount: totals.parkingAmount + row.parkingAmount,
      otherMonthlyAmount: totals.otherMonthlyAmount + row.otherMonthlyAmount,
      deposit: totals.deposit + row.deposit,
      securityDeposit: totals.securityDeposit + row.securityDeposit,
      keyMoney: totals.keyMoney + row.keyMoney,
      renewalFee: totals.renewalFee + row.renewalFee,
    }),
    {
      area: 0,
      rent: 0,
      commonCharge: 0,
      rentCommonTotal: 0,
      parkingAmount: 0,
      otherMonthlyAmount: 0,
      deposit: 0,
      securityDeposit: 0,
      keyMoney: 0,
      renewalFee: 0,
    },
  );
}

function floorOrder(label: string): number {
  const normalized = label.normalize("NFKC").trim().toUpperCase();
  const basement = normalized.match(/^B(\d+)/);
  if (basement) return -Number(basement[1]);
  const numeric = normalized.match(/-?\d+(?:\.\d+)?/);
  if (numeric) return Number(numeric[0]);
  if (normalized.includes("PH") || normalized.includes("屋上")) return 10000;
  return 5000;
}

function toRentRollRow(source: RentRollSource, asOfDate: string): RentRollRow {
  const parkingUnavailable =
    source.unit_type === "parking" && source.space_status === "unavailable";
  const isParking = source.unit_type === "parking";
  const incomingContracts = (source.incoming_contracts ?? []).filter(
    (incoming) => incoming.contract_start_date > asOfDate,
  );
  const inProgressTermination = source.pending_terminations?.[0] ?? null;
  const futureTermination =
    source.pending_terminations?.find(
      (termination) => termination.termination_date > asOfDate,
    ) ?? null;
  const futureContractEndDate = [
    source.actual_end_date,
    source.lease_end_date,
    source.lease_term_type === "fixed_term" ? source.contract_end_date : null,
  ]
    .filter((date): date is string => !!date && date > asOfDate)
    .sort()[0] ?? null;
  const leaseTermLabel = isParking
    ? "—"
    : source.lease_term_type === "ordinary"
      ? "普通"
      : source.lease_term_type === "fixed_term"
        ? "定期"
        : "未確認";
  const contractPeriod =
    !source.lease_contract_id || isParking
      ? "—"
      : source.lease_term_type === "ordinary"
        ? `${source.contract_start_date ?? "開始日未設定"} ～ 無期限`
        : source.lease_term_type === "fixed_term"
          ? `${source.contract_start_date ?? "開始日未設定"} ～ ${source.contract_end_date ?? "終了日未設定"}`
          : `${source.contract_start_date ?? "開始日未設定"} ～ ${source.contract_end_date ?? "未確認"}`;
  const isTerminationScheduled = Boolean(
    source.contract_notes?.includes("解約予定"),
  );
  const status: RentRollStatus = parkingUnavailable
    ? "unavailable"
    : source.leasing_status === "unavailable"
      ? source.leasing_status
      : source.lease_contract_id
        ? isTerminationScheduled || !!futureTermination || !!futureContractEndDate
          ? "scheduled"
          : "occupied"
        : incomingContracts.length > 0
          ? "move_in_scheduled"
          : source.leasing_status === "applied"
            ? "applied"
            : "vacant";

  return {
    unitId: source.unit_id,
    leaseContractUnitId: source.lease_contract_unit_id,
    unitType: source.unit_type,
    displayType: source.unit_type === "parking" ? "駐車場" : source.unit_type === "bicycle_parking" ? "駐輪場" : "貸室等",
    status,
    productCategory: ["parking", "bicycle_parking"].includes(source.unit_type) ? "parking" : normalizeProductCategory(source.unit_type),
    floor: source.unit_type === "parking" ? "駐車場" : source.unit_type === "bicycle_parking" ? "駐輪場" : source.floor_label ?? "",
    unitCode: source.unit_code,
    unitName: source.unit_name ?? source.unit_code,
    discriminator: source.source_discriminator,
    tenantName: parkingUnavailable ? "" : (source.tenant_name ?? ""),
    leaseTermLabel,
    contractPeriod,
    area: source.leased_area_sqm ?? source.rentable_area_sqm,
    rent: parkingUnavailable ? 0 : Number(source.monthly_rent_amount ?? 0),
    commonCharge: parkingUnavailable
      ? 0
      : Number(source.monthly_common_charge_amount ?? 0),
    rentCommonTotal: parkingUnavailable
      ? 0
      : Number(source.rent_common_total_amount ?? 0),
    parkingAmount: parkingUnavailable
      ? 0
      : Number(source.monthly_parking_amount ?? 0),
    otherMonthlyAmount: parkingUnavailable
      ? 0
      : Number(source.other_monthly_amount ?? 0),
    total: parkingUnavailable ? 0 : Number(source.monthly_total_amount ?? 0),
    deposit: parkingUnavailable ? 0 : Number(source.deposit_amount ?? 0),
    securityDeposit: parkingUnavailable
      ? 0
      : Number(source.security_deposit_amount ?? 0),
    keyMoney: parkingUnavailable ? 0 : Number(source.key_money_amount ?? 0),
    renewalFee: parkingUnavailable ? 0 : Number(source.renewal_fee_amount ?? 0),
    parkingScope: parkingUnavailable ? null : source.parking_scope,
    parkingSpaceNumber: source.space_number ?? "",
    parkingAccessCode: parkingUnavailable ? "" : (source.access_code ?? ""),
    parkingVehicle: parkingUnavailable
      ? ""
      : [source.vehicle_model, source.registration_number]
          .filter(Boolean)
          .join(" / "),
    incomingContracts,
    terminationInProgress: !!inProgressTermination,
    terminationDate: futureTermination?.termination_date ?? futureContractEndDate ?? undefined,
  };
}

function toSnapshotRow(
  source: SnapshotSource,
  sourceFileName: string,
  snapshotAsOfDate: string,
): RentRollRow {
  const terminationScheduled =
    (source.review_flags ?? "").includes("termination") ||
    (source.source_status ?? "").includes("解約");
  const status: RentRollStatus =
    source.occupancy_status === "vacant"
      ? "vacant"
      : terminationScheduled
        ? "scheduled"
        : "occupied";
  const rent = Number(source.monthly_rent_amount ?? 0);
  const commonCharge = Number(source.monthly_common_charge_amount ?? 0);
  const parkingAmount = Number(source.monthly_parking_amount ?? 0);
  const otherMonthlyAmount = Number(source.other_monthly_amount ?? 0);
  const occupied = status !== "vacant";
  return {
    unitId: source.rent_roll_snapshot_row_id,
    leaseContractUnitId: null,
    unitType: source.unit_type ?? "office",
    displayType: source.unit_type === "parking" ? "駐車場" : source.unit_type === "bicycle_parking" ? "駐輪場" : "貸室等",
    status,
    productCategory: ["parking", "bicycle_parking"].includes(source.unit_type ?? "") ? "parking" : normalizeProductCategory(source.unit_type ?? "office"),
    floor: source.unit_type === "parking" ? "駐車場" : source.unit_type === "bicycle_parking" ? "駐輪場" : source.floor_label ?? "",
    unitCode: source.unit_code ?? "",
    unitName: source.unit_code ?? "",
    discriminator: null,
    tenantName: source.tenant_name ?? "",
    leaseTermLabel: "—",
    contractPeriod: "—",
    area: source.area_sqm,
    areaTsubo: source.area_tsubo,
    rent: occupied ? rent : 0,
    commonCharge: occupied ? commonCharge : 0,
    rentCommonTotal: occupied ? rent + commonCharge : 0,
    parkingAmount: occupied ? parkingAmount : 0,
    otherMonthlyAmount: occupied ? otherMonthlyAmount : 0,
    total: occupied
      ? rent + commonCharge + parkingAmount + otherMonthlyAmount
      : 0,
    deposit: Number(source.deposit_amount ?? 0),
    securityDeposit: Number(source.security_deposit_amount ?? 0),
    keyMoney: Number(source.key_money_amount ?? 0),
    renewalFee: Number(source.renewal_fee_amount ?? 0),
    parkingScope: null,
    parkingSpaceNumber: "",
    parkingAccessCode: "",
    parkingVehicle: "",
    sourceFileName,
    sourceSheetName: source.source_sheet_name,
    sourceRowNumber: source.source_row_number,
    terminationScheduled,
    snapshotAsOfDate,
  };
}

function formatCurrency(value: number): string {
  return value === 0 ? "—" : currencyFormatter.format(value);
}

// 公共料金の列です。検針設定で基本料を請求する分類の基本料と、請求設定で「単価をレントロールに載せる」明細項目の単価を出します。
// 見出しは2行で、1行目に分類（電気・水道・ガス）、2行目に「基本料」「（請求内容）単価」を出します。
type UtilityColumn = { key: string; group: string; label: string; kind: 'basic' | 'price' | 'fixed'; id: string; fallback: { value: number; taxMode: string } | null };
type UtilityValue = { value: number; taxMode: string; isDefault: boolean };
const utilityCategoryNames: Record<string, string> = { electric: '電気', water: '水道', gas: 'ガス' };
const utilityCategoryOrder = ['electric', 'water', 'gas', 'other'];
const unitPriceFormatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 4 });

export function RentRollPage({ capabilities }: { capabilities: ContractCapabilities }) {
  const navigate = useNavigate();
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [propertyId, setPropertyId] = useState("");
  const [rows, setRows] = useState<RentRollRow[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | RentRollStatus | "occupied_group" | "vacant_group">(
    "all",
  );
  const [monthlyTotalSort, setMonthlyTotalSort] = useState(false);
  const [selectedProductCategories, setSelectedProductCategories] =
    useState<ProductCategory[]>(allProductCategories);
  const [unitTypeFilter, setUnitTypeFilter] = useState<
    "all" | "space" | "parking"
  >("all");
  const [asOfDate, setAsOfDate] = useState(today);
  const [loadingProperties, setLoadingProperties] = useState(true);
  const [loadingRows, setLoadingRows] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedLeaseContractUnitId, setSelectedLeaseContractUnitId] =
    useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [viewMode, setViewMode] = useState<"current" | "snapshot">("current");
  const [snapshotDates, setSnapshotDates] = useState<string[]>([]);
  const [utilityColumns, setUtilityColumns] = useState<UtilityColumn[]>([]);
  const [utilityValues, setUtilityValues] = useState<Record<string, Record<string, { value: number; taxMode: string }>>>({});
  const [tableScrollPosition, setTableScrollPosition] = useState<"left" | "middle" | "right">("left");
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const totalsWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!propertyId || !supabase) { setUtilityColumns([]); setUtilityValues({}); return; }
    let cancelled = false;
    const client = supabase;
    const loadUtility = async () => {
      const [settingResult, lineItemResult, contractResult, priceSettingResult, billingGroupResult, monthlyFixedResult] = await Promise.all([
        client.from('asset_meter_category_setting').select('category, is_billable, is_basic_billable').eq('asset_id', propertyId),
        client.from('asset_meter_sub_item').select('asset_meter_sub_item_id, category, sub_item_name, asset_billing_line_item_id, default_unit_price, tax_mode, sort_order, is_monthly_fixed').eq('asset_id', propertyId).eq('sub_item_kind', 'custom').order('sort_order'),
        client.from('lease_contract_unit').select('lease_contract_unit_id, unit_id, unit:unit_master!inner(property_id), contract:lease_contract!inner(tenant_id), prices:lease_contract_unit_utility_price(asset_billing_line_item_id, unit_price, tax_mode), categoryPrices:lease_contract_unit_category_price(category, unit_price, tax_mode), basics:lease_contract_unit_basic_charge(category, amount, tax_mode)').eq('unit.property_id', propertyId),
        client.from('asset_utility_price_setting').select('category, price_scope, default_unit_price, default_tax_mode, show_in_rent_roll').eq('asset_id', propertyId),
        client.from('meter_reading_contract').select('meter_reading_contract_id, tenant_id, units:meter_reading_contract_unit(unit_id), items:meter_reading_contract_item(asset_meter_sub_item_id, is_billable)').eq('asset_id', propertyId),
        client.from('meter_reading_month_fixed_charge').select('billing_month, meter_reading_contract_id, asset_meter_sub_item_id, amount').eq('asset_id', propertyId).order('billing_month', { ascending: false }),
      ]);
      if (cancelled) return;
      // 読み込めないとき（未適用の環境など）は公共料金の列を出さないだけにします。
      if (settingResult.error || lineItemResult.error || contractResult.error || priceSettingResult.error || billingGroupResult.error || monthlyFixedResult.error) { setUtilityColumns([]); setUtilityValues({}); return; }
      const settings = (settingResult.data ?? []) as Array<{ category: string; is_billable: boolean; is_basic_billable: boolean }>;
      const basicColumns: UtilityColumn[] = ['electric', 'water', 'gas']
        .filter((category) => settings.some((row) => row.category === category && row.is_basic_billable && (category === 'electric' || row.is_billable)))
        .map((category) => ({ key: `basic:${category}`, group: category, label: '基本料', kind: 'basic', id: category, fallback: null }));
      const subItems = (lineItemResult.data ?? []) as Array<{ asset_meter_sub_item_id: string; category: string; sub_item_name: string; asset_billing_line_item_id: string | null; default_unit_price: number | null; tax_mode: string; is_monthly_fixed: boolean }>;
      const fixedColumns: UtilityColumn[] = subItems.filter((item) => item.is_monthly_fixed)
        .map((item) => ({ key: `fixed:${item.asset_meter_sub_item_id}`, group: item.category, label: item.sub_item_name, kind: 'fixed' as const, id: item.asset_meter_sub_item_id, fallback: null }));
      const priceColumns: UtilityColumn[] = subItems
        .filter((item) => !item.is_monthly_fixed)
        .filter((item) => item.asset_billing_line_item_id !== null)
        .map((item) => ({ key: `price:${item.asset_billing_line_item_id}`, group: item.category, label: `${item.sub_item_name}単価`, kind: 'price' as const, id: item.asset_billing_line_item_id!, fallback: item.default_unit_price === null ? null : { value: Number(item.default_unit_price), taxMode: item.tax_mode } }));
      // 単価を分類で共通にした分類は、明細項目ごとの列の代わりに分類の「単価」を1列出します。
      // 設定が無い分類は「分類で共通・レントロールに載せる」です。
      const priceSettings = (priceSettingResult.data ?? []) as Array<{ category: string; price_scope: string; default_unit_price: number | null; default_tax_mode: string; show_in_rent_roll: boolean }>;
      const settingOf = (category: string) => priceSettings.find((row) => row.category === category);
      const sharedGroups = new Set(['electric', 'water', 'gas'].filter((category) => settingOf(category)?.price_scope !== 'line_item'));
      // 単価の列は、検針設定で請求している分類だけ出します。
      const sharedColumns: UtilityColumn[] = [...sharedGroups].filter((category) => (settingOf(category)?.show_in_rent_roll ?? true) && settings.some((row) => row.category === category && (category === 'electric' || row.is_billable)))
        .map((category) => { const row = settingOf(category); return { key: `category:${category}`, group: category, label: '単価', kind: 'price' as const, id: category, fallback: row?.default_unit_price == null ? null : { value: Number(row.default_unit_price), taxMode: row.default_tax_mode } }; });
      const values: Record<string, Record<string, { value: number; taxMode: string }>> = {};
      const fixedTaxMode = new Map(subItems.map((item) => [item.asset_meter_sub_item_id, item.tax_mode]));
      const billingGroups = (billingGroupResult.data ?? []) as unknown as Array<{ meter_reading_contract_id: string; tenant_id: string; units: Array<{ unit_id: string }>; items: Array<{ asset_meter_sub_item_id: string; is_billable: boolean }> }>;
      const latestFixed = new Map<string, number>();
      for (const row of (monthlyFixedResult.data ?? []) as Array<{ meter_reading_contract_id: string; asset_meter_sub_item_id: string; amount: number }>) {
        const key = `${row.meter_reading_contract_id}|${row.asset_meter_sub_item_id}`;
        if (!latestFixed.has(key)) latestFixed.set(key, Number(row.amount));
      }
      for (const unit of (contractResult.data ?? []) as unknown as Array<{ lease_contract_unit_id: string; unit_id: string; contract: { tenant_id: string } | null; prices: Array<{ asset_billing_line_item_id: string; unit_price: number; tax_mode: string }> | null; categoryPrices: Array<{ category: string; unit_price: number; tax_mode: string }> | null; basics: Array<{ category: string; amount: number; tax_mode: string }> | null }>) {
        const target: Record<string, { value: number; taxMode: string }> = {};
        for (const price of unit.categoryPrices ?? []) target[`category:${price.category}`] = { value: Number(price.unit_price), taxMode: price.tax_mode };
        for (const price of unit.prices ?? []) target[`price:${price.asset_billing_line_item_id}`] = { value: Number(price.unit_price), taxMode: price.tax_mode };
        for (const basic of unit.basics ?? []) target[`basic:${basic.category}`] = { value: Number(basic.amount), taxMode: basic.tax_mode };
        for (const group of billingGroups.filter((row) => row.tenant_id === unit.contract?.tenant_id && (!row.units.length || row.units.some((linked) => linked.unit_id === unit.unit_id)))) {
          for (const item of group.items.filter((row) => row.is_billable)) {
            const key = `fixed:${item.asset_meter_sub_item_id}`;
            const amount = latestFixed.get(`${group.meter_reading_contract_id}|${item.asset_meter_sub_item_id}`);
            if (amount != null) target[key] = { value: (target[key]?.value ?? 0) + amount, taxMode: fixedTaxMode.get(item.asset_meter_sub_item_id) ?? 'exclusive' };
          }
        }
        values[unit.lease_contract_unit_id] = target;
      }
      // 分類ごとに、基本料・単価（明細項目の並び順）の順に並べます。
      const ordered = [...basicColumns, ...fixedColumns, ...sharedColumns, ...priceColumns.filter((column) => !sharedGroups.has(column.group) && (settingOf(column.group)?.show_in_rent_roll ?? true))].map((column, index) => ({ column, index }))
        .sort((left, right) => utilityCategoryOrder.indexOf(left.column.group) - utilityCategoryOrder.indexOf(right.column.group) || left.index - right.index).map(({ column }) => column);
      setUtilityColumns(ordered);
      setUtilityValues(values);
    };
    void loadUtility();
    return () => { cancelled = true; };
  }, [propertyId, refreshVersion]);

  // 契約区画の単価が無い入居区画は、明細項目の既定単価を「既定」として出します。
  // 水道は契約ごとに請求有無・単価が異なるため、既定単価では補完しません。
  const utilityValueOf = (row: RentRollRow, column: UtilityColumn): UtilityValue | null => {
    if (!row.leaseContractUnitId) return null;
    const own = utilityValues[row.leaseContractUnitId]?.[column.key];
    if (own) return { ...own, isDefault: false };
    if (column.group === 'water') return null;
    return column.fallback ? { ...column.fallback, isDefault: true } : null;
  };
  const shownUtilityColumns = viewMode === 'current' ? utilityColumns : [];
  const utilityGroups = shownUtilityColumns.reduce<Array<{ group: string; count: number }>>((groups, column) => {
    const last = groups[groups.length - 1];
    if (last?.group === column.group) last.count += 1; else groups.push({ group: column.group, count: 1 });
    return groups;
  }, []);
  const twoRowHeader = shownUtilityColumns.length > 0;

  useEffect(() => {
    let cancelled = false;
    const loadProperties = async () => {
      setLoadingProperties(true);
      setError(null);
      if (!supabase) {
        setError("Supabaseの接続設定が見つかりません。");
        setLoadingProperties(false);
        return;
      }
      const { data, error: loadError } = await supabase
        .from("asset_master")
        .select("asset_id, asset_name, short_name")
        .eq("is_rent_roll_visible", true)
        .order("asset_code");

      if (cancelled) return;
      if (loadError) {
        setError(`物件の取得に失敗しました: ${loadError.message}`);
        setLoadingProperties(false);
        return;
      }

      const options = (
        (data ?? []) as Array<{
          asset_id: string;
          asset_name: string;
          short_name: string | null;
        }>
      ).map((asset) => ({
        propertyId: asset.asset_id,
        propertyName: asset.asset_name,
        shortName: asset.short_name,
      }));
      setProperties(options);
      setPropertyId((current) => current || options[0]?.propertyId || "");
      setLoadingProperties(false);
    };
    void loadProperties();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSelectedProductCategories(storedProductCategories(propertyId));
  }, [propertyId]);

  useEffect(() => {
    if (!propertyId) {
      setRows([]);
      return;
    }
    let cancelled = false;
    const loadRows = async () => {
      setLoadingRows(true);
      setError(null);
      if (!supabase) {
        setError("Supabaseの接続設定が見つかりません。");
        setLoadingRows(false);
        return;
      }
      let loadedRows: RentRollRow[] = [];
      let loadError: { message: string } | null = null;
      if (viewMode === "snapshot") {
        const batch = await supabase
          .from("rent_roll_snapshot_batch")
          .select("rent_roll_snapshot_batch_id, source_file_name")
          .eq("as_of_date", asOfDate)
          .order("source_file_updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (batch.error) loadError = batch.error;
        else if (batch.data) {
          const detail = await supabase
            .from("rent_roll_snapshot_row")
            .select("*")
            .eq(
              "rent_roll_snapshot_batch_id",
              batch.data.rent_roll_snapshot_batch_id,
            )
            .eq("property_id", propertyId)
            .order("floor_label")
            .order("source_row_number");
          if (detail.error) loadError = detail.error;
          else
            loadedRows = ((detail.data as SnapshotSource[]) ?? []).map((row) =>
              toSnapshotRow(row, batch.data!.source_file_name, asOfDate),
            );
        }
      } else {
        const result = await supabase.rpc("rent_roll_list_with_terms_at_date", {
          p_property_id: propertyId,
          p_as_of_date: asOfDate,
        });
        loadError = result.error;
        const sourceRows = (result.data ?? []) as RentRollSource[];
        loadedRows = sourceRows.map(
          (row) => toRentRollRow(row, asOfDate),
        );
        const parkingUnitIds = sourceRows.filter((row) => row.unit_type === "parking").map((row) => row.unit_id);
        if (!loadError && parkingUnitIds.length) {
          const facilityResult = await supabase.from("parking_space_master")
            .select("unit_id, facility:parking_facility_master(facility_code, parking_type:parking_type_master(parking_type_name))")
            .in("unit_id", parkingUnitIds);
          if (facilityResult.error) loadError = facilityResult.error;
          else {
            const facilityRows = (facilityResult.data ?? []) as unknown as Array<{
              unit_id: string;
              facility: { facility_code: string; parking_type?: { parking_type_name?: string } | { parking_type_name?: string }[] | null } | null;
            }>;
            const facilityByUnitId = new Map(facilityRows.map((entry) => {
              const parkingType = Array.isArray(entry.facility?.parking_type) ? entry.facility?.parking_type[0] : entry.facility?.parking_type;
              const facilityCode = entry.facility?.facility_code ?? "";
              return [entry.unit_id, { code: facilityCode, type: parkingFacilityDisplayType(facilityCode, parkingType?.parking_type_name) }] as const;
            }));
            loadedRows = loadedRows.map((row) => {
              if (row.unitType !== "parking") return row;
              const facility = facilityByUnitId.get(row.unitId);
              return { ...row, displayType: facility?.type ?? "駐車場", floor: facility?.code.toUpperCase().includes("BIKE") ? "駐輪場" : "駐車場" };
            });
          }
        }
      }

      if (cancelled) return;
      const result = { error: loadError! };
      if (loadError) {
        setRows([]);
        setError(`レントロールの取得に失敗しました: ${result.error.message}`);
      } else {
        setRows(loadedRows);
      }
      setLoadingRows(false);
    };
    void loadRows();
    return () => {
      cancelled = true;
    };
  }, [propertyId, asOfDate, refreshVersion, viewMode]);

  useEffect(() => {
    if (!supabase) return;
    void supabase
      .from("rent_roll_snapshot_batch")
      .select("as_of_date")
      .order("as_of_date", { ascending: false })
      .then(({ data }) =>
        setSnapshotDates([
          ...new Set((data ?? []).map((row) => String(row.as_of_date))),
        ]),
      );
  }, []);

  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const floorDifference = floorOrder(a.floor) - floorOrder(b.floor);
        return (
          floorDifference ||
          collator.compare(a.floor, b.floor) ||
          collator.compare(a.unitName, b.unitName) ||
          collator.compare(a.unitCode, b.unitCode)
        );
      }),
    [rows],
  );

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("ja-JP");
    const selectedCategories = new Set(selectedProductCategories);
    const matchedRows = sortedRows.filter((row) => {
      const matchesProductCategory = selectedCategories.has(
        row.productCategory,
      );
      const matchesStatus = statusFilter === "all"
        || (statusFilter === "occupied_group" && (row.status === "occupied" || row.status === "scheduled"))
        || (statusFilter === "vacant_group" && (row.status === "vacant" || row.status === "move_in_scheduled"))
        || row.status === statusFilter;
      const matchesType =
        unitTypeFilter === "all" ||
        (unitTypeFilter === "parking"
          ? row.productCategory === "parking"
          : row.productCategory !== "parking");
      const matchesQuery =
        !normalizedQuery ||
        [
          row.floor,
          row.unitCode,
          row.unitName,
          row.tenantName,
          row.leaseTermLabel,
          row.contractPeriod,
          row.parkingSpaceNumber,
          row.parkingAccessCode,
          row.parkingVehicle,
        ].some((value) =>
          value.toLocaleLowerCase("ja-JP").includes(normalizedQuery),
        );
      return (
        matchesProductCategory && matchesStatus && matchesType && matchesQuery
      );
    });
    return monthlyTotalSort
      ? [...matchedRows].sort((a, b) => b.total - a.total || collator.compare(a.unitName, b.unitName))
      : matchedRows;
  }, [
    query,
    selectedProductCategories,
    sortedRows,
    statusFilter,
    unitTypeFilter,
    monthlyTotalSort,
  ]);

  const summary = useMemo(() => summarizeRows(filteredRows), [filteredRows]);
  const columnTotals = useMemo(
    () => sumRentRollColumns(filteredRows),
    [filteredRows],
  );
  const overallSummary = useMemo(() => summarizeRows(rows), [rows]);
  const productCounts = useMemo(
    () =>
      Object.fromEntries(
        allProductCategories.map((category) => [
          category,
          rows.filter((row) => row.productCategory === category).length,
        ]),
      ) as Record<ProductCategory, number>,
    [rows],
  );

  const selectedProperty = properties.find(
    (property) => property.propertyId === propertyId,
  );

  const saveSelectedProductCategories = (categories: ProductCategory[]) => {
    setSelectedProductCategories(categories);
    if (!propertyId) return;
    try {
      localStorage.setItem(
        `rent-roll-product-filters:v1:${propertyId}`,
        JSON.stringify(categories),
      );
    } catch {
      // The filter still works for the current page when browser storage is unavailable.
    }
  };

  const toggleProductCategory = (category: ProductCategory) => {
    const nextCategories = selectedProductCategories.includes(category)
      ? selectedProductCategories.filter((item) => item !== category)
      : allProductCategories.filter(
          (item) =>
            item === category || selectedProductCategories.includes(item),
        );
    saveSelectedProductCategories(nextCategories);
  };

  return (
    <section className="rent-roll-page">
      <div className="rent-roll-heading">
        <div>
          <p className="section-kicker">RENT ROLL</p>
          <h2>レントロール</h2>
          <p>
            取り込み済みの区画・賃貸借情報を、指定した基準日時点で確認できます。
          </p>
        </div>
      </div>

      <div
        className="rent-roll-mode-switch"
        role="group"
        aria-label="表示モード"
      >
        <button
          type="button"
          className={viewMode === "current" ? "active" : ""}
          onClick={() => setViewMode("current")}
        >
          現在のレントロール
        </button>
        <button
          type="button"
          className={viewMode === "snapshot" ? "active" : ""}
          onClick={() => {
            setViewMode("snapshot");
            if (snapshotDates[0]) setAsOfDate(snapshotDates[0]);
          }}
        >
          過去スナップショット
        </button>
      </div>
      {viewMode === "snapshot" && (
        <p className="rent-roll-snapshot-banner">
          {asOfDate} 時点の過去スナップショット
        </p>
      )}

      <div className="rent-roll-toolbar">
        <label>
          基準日
          {viewMode === "snapshot" ? (
            <select
              value={asOfDate}
              onChange={(event) => setAsOfDate(event.target.value)}
            >
              {snapshotDates.map((date) => (
                <option key={date} value={date}>
                  {date}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="date"
              value={asOfDate}
              onChange={(event) => setAsOfDate(event.target.value)}
            />
          )}
        </label>
        <label>
          物件
          <select
            value={propertyId}
            onChange={(event) => setPropertyId(event.target.value)}
            disabled={loadingProperties}
          >
            {properties.map((property) => (
              <option key={property.propertyId} value={property.propertyId}>
                {property.shortName || property.propertyName}
              </option>
            ))}
          </select>
        </label>
        <label className="rent-roll-search">
          テナント・区画を検索
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="室名、テナント名、契約形態"
          />
        </label>
        <label>
          状態
          <select
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as typeof statusFilter)
            }
          >
            <option value="all">全件</option>
            <option value="occupied_group">入居中（退去予定を含む）</option>
            <option value="vacant_group">空室（入居予定を含む）</option>
            <option value="occupied">入居中</option>
            <option value="scheduled">退去予定</option>
            <option value="move_in_scheduled">入居予定</option>
            <option value="vacant">空室</option>
            <option value="unavailable">使用不可</option>
          </select>
        </label>
        <label>
          区画種別
          <select
            value={unitTypeFilter}
            onChange={(event) =>
              setUnitTypeFilter(event.target.value as typeof unitTypeFilter)
            }
          >
            <option value="all">すべて</option>
            <option value="space">貸室等</option>
            <option value="parking">駐車場</option>
          </select>
        </label>
      </div>

      <section
        className="rent-roll-product-filter"
        aria-labelledby="rent-roll-product-filter-title"
      >
        <div className="rent-roll-product-filter-heading">
          <div>
            <h3 id="rent-roll-product-filter-title">商品区分</h3>
            <p>表示する商品を複数選択できます。</p>
          </div>
          <div className="rent-roll-product-filter-actions">
            <button
              type="button"
              onClick={() =>
                saveSelectedProductCategories(allProductCategories)
              }
            >
              全選択
            </button>
            <button
              type="button"
              onClick={() => saveSelectedProductCategories([])}
            >
              全解除
            </button>
          </div>
        </div>
        <div className="rent-roll-product-options">
          {productCategories.map(({ code, label }) => (
            <label
              key={code}
              className={
                selectedProductCategories.includes(code) ? "selected" : ""
              }
            >
              <input
                type="checkbox"
                checked={selectedProductCategories.includes(code)}
                onChange={() => toggleProductCategory(code)}
              />
              <span>{label}</span>
              <small>{numberFormatter.format(productCounts[code])}</small>
            </label>
          ))}
        </div>
        <div className="rent-roll-selected-products">
          <strong>選択中</strong>
          {selectedProductCategories.length > 0 ? (
            selectedProductCategories.map((category) => (
              <span key={category}>{productCategoryLabel[category]}</span>
            ))
          ) : (
            <em>選択されている商品はありません</em>
          )}
        </div>
      </section>

      {error && <p className="rent-roll-notice">{error}</p>}
      {!loadingProperties && properties.length === 0 && !error && (
        <p className="rent-roll-notice">
          表示できるレントロール物件がありません。
        </p>
      )}

      {selectedProperty && (
        <div
          className="rent-roll-metrics"
          aria-label={`${selectedProperty.propertyName} の集計`}
        >
          <button type="button" className="rent-roll-metric-button" aria-pressed={statusFilter === "all"} onClick={() => { setStatusFilter("all"); setMonthlyTotalSort(false); }}>
            <span>表示中の区画数</span>
            <strong>{numberFormatter.format(summary.units)} 区画</strong>
            <small>全体 {numberFormatter.format(overallSummary.units)} 区画</small>
          </button>
          <button type="button" className="rent-roll-metric-button" aria-pressed={statusFilter === "occupied_group"} onClick={() => { setStatusFilter("occupied_group"); setMonthlyTotalSort(false); }}>
            <span>表示中の入居</span>
            <strong>{numberFormatter.format(summary.occupied)} 区画</strong>
            <small>全体 {numberFormatter.format(overallSummary.occupied)} 区画</small>
          </button>
          <button type="button" className="rent-roll-metric-button" aria-pressed={statusFilter === "vacant_group"} onClick={() => { setStatusFilter("vacant_group"); setMonthlyTotalSort(false); }}>
            <span>表示中の空室</span>
            <strong>{numberFormatter.format(summary.vacant)} 区画</strong>
            <small>全体 {numberFormatter.format(overallSummary.vacant)} 区画</small>
          </button>
          <button type="button" className="rent-roll-metric-button rent-roll-total" aria-pressed={monthlyTotalSort} onClick={() => setMonthlyTotalSort((current) => !current)}>
            <span>表示中の月額総計</span>
            <strong>{currencyFormatter.format(summary.monthlyTotal)}</strong>
            <small>{monthlyTotalSort ? "月額の高い順で表示中" : "賃料・共益費・駐車場代・その他を別項目で集計｜全体"} {currencyFormatter.format(overallSummary.monthlyTotal)}</small>
          </button>
        </div>
      )}

      <div className="rent-roll-panel">
        <div className="rent-roll-panel-heading">
          <div>
            <h3>{selectedProperty?.propertyName ?? "物件を選択"}</h3>
            <p>
              {loadingRows
                ? "読み込み中…"
                : `${numberFormatter.format(filteredRows.length)} / ${numberFormatter.format(rows.length)} 区画を表示`}
            </p>
          </div>
          <div className="rent-roll-table-controls" aria-label="一覧のスクロール操作">
            <span>{tableScrollPosition === "left" ? "左端" : tableScrollPosition === "right" ? "右端" : "中央"}を表示中</span>
            <button type="button" className="secondary-button" onClick={() => tableWrapRef.current?.scrollBy({ left: -640, behavior: "smooth" })} aria-label="表を左へ移動">← 左へ</button>
            <button type="button" className="secondary-button" onClick={() => tableWrapRef.current?.scrollBy({ left: 640, behavior: "smooth" })} aria-label="表を右へ移動">右へ →</button>
            <button type="button" className="secondary-button" onClick={() => tableWrapRef.current?.scrollTo({ top: 0, behavior: "smooth" })}>先頭行へ</button>
          </div>
        </div>
        <div
          ref={tableWrapRef}
          className="rent-roll-table-wrap"
          role="region"
          aria-label={"レントロール一覧" + (viewMode === "snapshot" ? "。過去スナップショット" : "") + "。表内で縦横にスクロールできます。左側の区画情報は固定表示されます"}
          tabIndex={0}
          onScroll={(event) => {
            const element = event.currentTarget;
            const maxScroll = element.scrollWidth - element.clientWidth;
            if (totalsWrapRef.current) {
              totalsWrapRef.current.scrollLeft = element.scrollLeft;
            }
            setTableScrollPosition(element.scrollLeft < 8 ? "left" : element.scrollLeft >= maxScroll - 8 ? "right" : "middle");
          }}
        >
          <table className="rent-roll-table">
            <colgroup>
              {Array.from({ length: 21 }, (_, index) => <col key={`base-${index}`} />)}
              {shownUtilityColumns.map((column) => <col key={column.key} style={{ width: column.kind === 'basic' ? 130 : 68 }} />)}
              {viewMode === "snapshot" && <col />}
            </colgroup>
            <thead>
              <tr>
                <th rowSpan={twoRowHeader ? 2 : 1} className="rent-roll-pinned rent-roll-pinned-1">状態</th>
                <th rowSpan={twoRowHeader ? 2 : 1} className="rent-roll-pinned rent-roll-pinned-2">商品</th>
                <th rowSpan={twoRowHeader ? 2 : 1} className="rent-roll-pinned rent-roll-pinned-3">種別</th>
                <th rowSpan={twoRowHeader ? 2 : 1} className="rent-roll-pinned rent-roll-pinned-4">階</th>
                <th rowSpan={twoRowHeader ? 2 : 1} className="rent-roll-pinned rent-roll-pinned-5">室・枠</th>
                {['契約期間', '契約形態'].map((label) => <th key={label} rowSpan={twoRowHeader ? 2 : 1}>{label}</th>)}
                <th rowSpan={twoRowHeader ? 2 : 1} className="rent-roll-pinned rent-roll-pinned-tenant">テナント名</th>
                {['面積㎡', '賃料', '共益費', '賃料＋共益費', '駐車場代', 'その他月額', '敷金', '保証金', '礼金', '更新料', '内外', '暗証番号', '車両'].map((label) => <th key={label} rowSpan={twoRowHeader ? 2 : 1}>{label}</th>)}
                {utilityGroups.map((group) => {
                  const onlyColumn = group.count === 1 ? shownUtilityColumns.find((column) => column.group === group.group) : null;
                  return <th key={group.group} colSpan={group.count} className={`rent-roll-utility-group utility-${group.group}${onlyColumn?.kind === 'price' ? ' utility-price-only' : ''}`}>{utilityCategoryNames[group.group] ?? 'その他'}</th>;
                })}
                {viewMode === "snapshot" && <th rowSpan={twoRowHeader ? 2 : 1}>操作</th>}
              </tr>
              {twoRowHeader && <tr>{shownUtilityColumns.map((column) => <th key={column.key} className={`rent-roll-utility-column utility-${column.group} utility-${column.kind}`}>{column.label}</th>)}</tr>}
            </thead>
            <tbody>
              {loadingRows && (
                <tr>
                  <td colSpan={21 + shownUtilityColumns.length + (viewMode === "snapshot" ? 1 : 0)} className="rent-roll-empty">
                    レントロールを読み込んでいます。
                  </td>
                </tr>
              )}
              {!loadingRows && filteredRows.length === 0 && (
                <tr>
                  <td colSpan={21 + shownUtilityColumns.length + (viewMode === "snapshot" ? 1 : 0)} className="rent-roll-empty">
                    条件に一致する区画はありません。
                  </td>
                </tr>
              )}
              {!loadingRows &&
                filteredRows.map((row) => (
                  <tr
                    key={row.unitId}
                    className={
                      row.incomingContracts?.length
                        ? "rent-roll-row-has-incoming"
                        : undefined
                    }
                  >
                    <td className="rent-roll-pinned rent-roll-pinned-1">
                      <span className={`rent-roll-status ${row.status}`}>
                        {row.terminationInProgress && !row.terminationDate
                          ? "契約手続き中"
                          : statusLabel[row.status]}
                      </span>
                      {row.status === "scheduled" && row.terminationDate ? (
                        <small className="rent-roll-incoming-note">
                          {formatJapaneseDate(row.terminationDate)}
                          {row.terminationInProgress ? "（手続き中）" : ""}
                        </small>
                      ) : null}
                      {row.incomingContracts?.length ? (
                        <small className="rent-roll-incoming-note">
                          入居予定:{" "}
                          {row.incomingContracts
                            .map(
                              (incoming) =>
                                `${incoming.tenant_name}（${formatJapaneseDate(incoming.contract_start_date)}から）`,
                            )
                            .join("、")}
                        </small>
                      ) : null}
                    </td>
                    <td className="rent-roll-pinned rent-roll-pinned-2">
                      <span
                        className={`rent-roll-product-badge ${row.productCategory}`}
                      >
                        {productCategoryLabel[row.productCategory]}
                      </span>
                    </td>
                    <td className="rent-roll-pinned rent-roll-pinned-3">
                      <span
                        className={`unit-type-badge ${row.unitType === "parking" ? "parking" : ""}`}
                      >
                        {row.displayType}
                      </span>
                    </td>
                    <td className="rent-roll-pinned rent-roll-pinned-4">{row.floor || "—"}</td>
                    <td className="rent-roll-pinned rent-roll-pinned-5">
                      <strong>
                        {row.parkingSpaceNumber
                          ? `枠 ${row.parkingSpaceNumber}`
                          : row.unitName}
                      </strong>
                      {row.discriminator && (
                        <small className="rent-roll-discriminator">
                          暫定識別子: {row.discriminator}
                        </small>
                      )}
                    </td>
                    <td>{row.contractPeriod}</td>
                    <td>{row.leaseTermLabel}</td>
                    <td className="rent-roll-pinned rent-roll-pinned-tenant" title={row.tenantName || undefined}>
                      {row.tenantName &&
                      row.leaseContractUnitId &&
                      capabilities.canViewContract ? (
                        <button
                          type="button"
                          className="rent-roll-tenant-link"
                          onClick={() =>
                            setSelectedLeaseContractUnitId(
                              row.leaseContractUnitId,
                            )
                          }
                        >
                          {row.tenantName}
                        </button>
                      ) : (
                        row.tenantName || "—"
                      )}
                    </td>
                    <td className="numeric">
                      {row.area == null
                        ? "—"
                        : numberFormatter.format(row.area)}
                    </td>
                    <td className="numeric emphasis">
                      {formatCurrency(row.rent)}
                    </td>
                    <td className="numeric">
                      {formatCurrency(row.commonCharge)}
                    </td>
                    <td className="numeric emphasis">
                      {formatCurrency(row.rentCommonTotal)}
                    </td>
                    <td className="numeric">
                      {formatCurrency(row.parkingAmount)}
                    </td>
                    <td className="numeric">
                      {formatCurrency(row.otherMonthlyAmount)}
                    </td>
                    <td className="numeric">{formatCurrency(row.deposit)}</td>
                    <td className="numeric">
                      {formatCurrency(row.securityDeposit)}
                    </td>
                    <td className="numeric">{formatCurrency(row.keyMoney)}</td>
                    <td className="numeric">
                      {formatCurrency(row.renewalFee)}
                    </td>
                    <td>
                      {row.parkingScope === "internal"
                        ? "内部"
                        : row.parkingScope === "external"
                          ? "外部"
                          : "—"}
                    </td>
                    <td className="access-code">
                      {row.parkingAccessCode || "—"}
                    </td>
                    <td className="rent-roll-vehicle-cell" title={row.parkingVehicle || undefined}>{row.parkingVehicle || "—"}</td>
                    {shownUtilityColumns.map((column) => {
                      const utility = utilityValueOf(row, column);
                      const note = utility?.taxMode === 'inclusive' ? '税込' : '';
                      return <td key={column.key} className={`numeric rent-roll-utility-value utility-${column.kind}`}>{utility ? <>{column.kind === 'basic' ? formatCurrency(utility.value) : unitPriceFormatter.format(utility.value)}{note && <small>{note}</small>}</> : '—'}</td>;
                    })}
                    {viewMode === "snapshot" && row.status !== "vacant" && (
                      <td>
                        <button
                          type="button"
                          className="secondary-button snapshot-contractize-button"
                          onClick={() =>
                            navigate("/admin/contracts", {
                              state: {
                                propertyId,
                                snapshot: {
                                  tenant_name: row.tenantName,
                                  unit_code: row.unitCode,
                                  unit_name: row.unitName,
                                  unit_type: [
                                    "parking",
                                    "office",
                                    "retail",
                                    "residential",
                                    "storage",
                                    "equipment",
                                    "other",
                                  ].includes(row.unitType)
                                    ? row.unitType
                                    : "equipment",
                                  contract_type: row.productCategory,
                                  monthly_rent_amount: row.rent,
                                  monthly_common_charge_amount:
                                    row.commonCharge,
                                  deposit_amount: row.deposit,
                                  snapshot_as_of_date: row.snapshotAsOfDate,
                                  source_file_name: row.sourceFileName,
                                  source_sheet_name: row.sourceSheetName,
                                  source_row_number: row.sourceRowNumber,
                                },
                              },
                            })
                          }
                        >
                          契約化
                        </button>
                      </td>
                    )}{viewMode === "snapshot" && row.status === "vacant" && <td />}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!loadingRows && filteredRows.length > 0 && (
          <div ref={totalsWrapRef} className="rent-roll-total-wrap" aria-label="表示中の合計">
            <table className="rent-roll-table rent-roll-total-table" aria-hidden="true">
              <tbody>
                <tr className="rent-roll-total-row">
                  <td className="rent-roll-pinned rent-roll-pinned-1" />
                  <td className="rent-roll-pinned rent-roll-pinned-2" />
                  <td className="rent-roll-pinned rent-roll-pinned-3" />
                  <td className="rent-roll-pinned rent-roll-pinned-4" />
                  <td className="rent-roll-pinned rent-roll-pinned-5" />
                  <td />
                  <td />
                  <td className="rent-roll-pinned rent-roll-pinned-tenant">表示中の合計（{numberFormatter.format(filteredRows.length)}件）</td>
                  <td className="numeric">{numberFormatter.format(columnTotals.area)}</td>
                  <td className="numeric emphasis">{formatCurrency(columnTotals.rent)}</td>
                  <td className="numeric">{formatCurrency(columnTotals.commonCharge)}</td>
                  <td className="numeric emphasis">{formatCurrency(columnTotals.rentCommonTotal)}</td>
                  <td className="numeric">{formatCurrency(columnTotals.parkingAmount)}</td>
                  <td className="numeric">{formatCurrency(columnTotals.otherMonthlyAmount)}</td>
                  <td className="numeric">{formatCurrency(columnTotals.deposit)}</td>
                  <td className="numeric">{formatCurrency(columnTotals.securityDeposit)}</td>
                  <td className="numeric">{formatCurrency(columnTotals.keyMoney)}</td>
                  <td className="numeric">{formatCurrency(columnTotals.renewalFee)}</td>
                  <td colSpan={3} />
                  {shownUtilityColumns.map((column) => <td key={column.key} />)}
                  {viewMode === "snapshot" && <td />}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
      {selectedLeaseContractUnitId && (
        <ContractDetailModal
          leaseContractUnitId={selectedLeaseContractUnitId}
          asOfDate={asOfDate}
          capabilities={capabilities}
          onClose={() => setSelectedLeaseContractUnitId(null)}
          onChanged={() => setRefreshVersion((current) => current + 1)}
        />
      )}
    </section>
  );
}
