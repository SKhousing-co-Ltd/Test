import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ContractDetailModal } from './ContractDetailModal';
import { RentRollReconciliationPanel } from './RentRollReconciliationPanel';
import type { ContractCapabilities } from './lib/contract-capabilities';
import { allProductCategories, normalizeProductCategory, productCategories, productCategoryLabel, type ProductCategory } from './lib/product-categories';
import { supabase } from './lib/supabase';

type RentRollStatus = 'occupied' | 'scheduled' | 'vacant' | 'applied' | 'unavailable';

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
  lease_term_type: 'ordinary' | 'fixed_term' | null;
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
  space_status: 'occupied' | 'vacant' | 'unavailable' | null;
  space_number: string | null;
  parking_scope: 'internal' | 'external' | null;
  access_code: string | null;
  vehicle_model: string | null;
  registration_number: string | null;
};

type RentRollRow = {
  unitId: string;
  leaseContractUnitId: string | null;
  unitType: string;
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
  parkingScope: 'internal' | 'external' | null;
  parkingSpaceNumber: string;
  parkingAccessCode: string;
  parkingVehicle: string;
  areaTsubo?: number | null;
  sourceFileName?: string;
  sourceSheetName?: string;
  sourceRowNumber?: number | null;
  terminationScheduled?: boolean;
  snapshotAsOfDate?: string;
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
  occupancy_status: 'occupied' | 'vacant';
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
const currencyFormatter = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const numberFormatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });
const collator = new Intl.Collator('ja-JP', { numeric: true, sensitivity: 'base' });

const statusLabel: Record<RentRollStatus, string> = {
  occupied: '入居中',
  scheduled: '解約予定',
  vacant: '空室',
  applied: '申込中',
  unavailable: '使用不可',
};

function storedProductCategories(propertyId: string): ProductCategory[] {
  if (!propertyId) return allProductCategories;
  try {
    const stored = localStorage.getItem(`rent-roll-product-filters:v1:${propertyId}`);
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
    occupied: targetRows.filter((row) => row.status === 'occupied' || row.status === 'scheduled').length,
    vacant: targetRows.filter((row) => row.status === 'vacant').length,
    monthlyTotal: targetRows.reduce((total, row) => total + row.total, 0),
  };
}

function floorOrder(label: string): number {
  const normalized = label.normalize('NFKC').trim().toUpperCase();
  const basement = normalized.match(/^B(\d+)/);
  if (basement) return -Number(basement[1]);
  const numeric = normalized.match(/-?\d+(?:\.\d+)?/);
  if (numeric) return Number(numeric[0]);
  if (normalized.includes('PH') || normalized.includes('屋上')) return 10000;
  return 5000;
}

function toRentRollRow(source: RentRollSource): RentRollRow {
  const parkingUnavailable = source.unit_type === 'parking' && source.space_status === 'unavailable';
  const isParking = source.unit_type === 'parking';
  const leaseTermLabel = isParking ? '—' : source.lease_term_type === 'ordinary' ? '普通' : source.lease_term_type === 'fixed_term' ? '定期' : '未確認';
  const contractPeriod = !source.lease_contract_id || isParking
    ? '—'
    : source.lease_term_type === 'ordinary'
      ? `${source.contract_start_date ?? '開始日未設定'} ～ 無期限`
      : source.lease_term_type === 'fixed_term'
        ? `${source.contract_start_date ?? '開始日未設定'} ～ ${source.contract_end_date ?? '終了日未設定'}`
        : `${source.contract_start_date ?? '開始日未設定'} ～ ${source.contract_end_date ?? '未確認'}`;
  const isTerminationScheduled = Boolean(source.contract_notes?.includes('解約予定'));
  const status: RentRollStatus = parkingUnavailable
    ? 'unavailable'
    : source.leasing_status === 'applied' || source.leasing_status === 'unavailable'
      ? source.leasing_status
      : source.lease_contract_id
        ? isTerminationScheduled ? 'scheduled' : 'occupied'
        : 'vacant';

  return {
    unitId: source.unit_id,
    leaseContractUnitId: source.lease_contract_unit_id,
    unitType: source.unit_type,
    status,
    productCategory: normalizeProductCategory(source.unit_type),
    floor: source.floor_label ?? '',
    unitCode: source.unit_code,
    unitName: source.unit_name ?? source.unit_code,
    discriminator: source.source_discriminator,
    tenantName: parkingUnavailable ? '' : source.tenant_name ?? '',
    leaseTermLabel,
    contractPeriod,
    area: source.leased_area_sqm ?? source.rentable_area_sqm,
    rent: parkingUnavailable ? 0 : Number(source.monthly_rent_amount ?? 0),
    commonCharge: parkingUnavailable ? 0 : Number(source.monthly_common_charge_amount ?? 0),
    rentCommonTotal: parkingUnavailable ? 0 : Number(source.rent_common_total_amount ?? 0),
    parkingAmount: parkingUnavailable ? 0 : Number(source.monthly_parking_amount ?? 0),
    otherMonthlyAmount: parkingUnavailable ? 0 : Number(source.other_monthly_amount ?? 0),
    total: parkingUnavailable ? 0 : Number(source.monthly_total_amount ?? 0),
    deposit: parkingUnavailable ? 0 : Number(source.deposit_amount ?? 0),
    securityDeposit: parkingUnavailable ? 0 : Number(source.security_deposit_amount ?? 0),
    keyMoney: parkingUnavailable ? 0 : Number(source.key_money_amount ?? 0),
    renewalFee: parkingUnavailable ? 0 : Number(source.renewal_fee_amount ?? 0),
    parkingScope: parkingUnavailable ? null : source.parking_scope,
    parkingSpaceNumber: source.space_number ?? '',
    parkingAccessCode: parkingUnavailable ? '' : source.access_code ?? '',
    parkingVehicle: parkingUnavailable ? '' : [source.vehicle_model, source.registration_number].filter(Boolean).join(' / '),
  };
}

function toSnapshotRow(source: SnapshotSource, sourceFileName: string, snapshotAsOfDate: string): RentRollRow {
  const terminationScheduled = (source.review_flags ?? '').includes('termination') || (source.source_status ?? '').includes('解約');
  const status: RentRollStatus = source.occupancy_status === 'vacant' ? 'vacant' : terminationScheduled ? 'scheduled' : 'occupied';
  const rent = Number(source.monthly_rent_amount ?? 0);
  const commonCharge = Number(source.monthly_common_charge_amount ?? 0);
  const parkingAmount = Number(source.monthly_parking_amount ?? 0);
  const otherMonthlyAmount = Number(source.other_monthly_amount ?? 0);
  const occupied = status !== 'vacant';
  return {
    unitId: source.rent_roll_snapshot_row_id, leaseContractUnitId: null, unitType: source.unit_type ?? 'office', status,
    productCategory: normalizeProductCategory(source.unit_type ?? 'office'), floor: source.floor_label ?? '',
    unitCode: source.unit_code ?? '', unitName: source.unit_code ?? '', discriminator: null, tenantName: source.tenant_name ?? '',
    leaseTermLabel: '—', contractPeriod: '—', area: source.area_sqm, areaTsubo: source.area_tsubo,
    rent: occupied ? rent : 0, commonCharge: occupied ? commonCharge : 0, rentCommonTotal: occupied ? rent + commonCharge : 0,
    parkingAmount: occupied ? parkingAmount : 0, otherMonthlyAmount: occupied ? otherMonthlyAmount : 0,
    total: occupied ? rent + commonCharge + parkingAmount + otherMonthlyAmount : 0,
    deposit: Number(source.deposit_amount ?? 0), securityDeposit: Number(source.security_deposit_amount ?? 0),
    keyMoney: Number(source.key_money_amount ?? 0), renewalFee: Number(source.renewal_fee_amount ?? 0), parkingScope: null,
    parkingSpaceNumber: '', parkingAccessCode: '', parkingVehicle: '', sourceFileName, sourceSheetName: source.source_sheet_name,
    sourceRowNumber: source.source_row_number, terminationScheduled, snapshotAsOfDate,
  };
}

function formatCurrency(value: number): string {
  return value === 0 ? '—' : currencyFormatter.format(value);
}

// 公共料金の列です。検針設定で基本料を請求する分類の基本料と、請求設定で「単価をレントロールに載せる」明細項目の単価を出します。
type UtilityColumn = { key: string; label: string; kind: 'basic' | 'price'; id: string; fallback: { value: number; taxMode: string } | null };
type UtilityValue = { value: number; taxMode: string; isDefault: boolean };
const utilityCategoryNames: Record<string, string> = { electric: '電気', water: '水道', gas: 'ガス' };
const unitPriceFormatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 4 });

export function RentRollPage({ capabilities }: { capabilities: ContractCapabilities }) {
  const navigate = useNavigate();
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [propertyId, setPropertyId] = useState('');
  const [rows, setRows] = useState<RentRollRow[]>([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | RentRollStatus>('all');
  const [selectedProductCategories, setSelectedProductCategories] = useState<ProductCategory[]>(allProductCategories);
  const [unitTypeFilter, setUnitTypeFilter] = useState<'all' | 'space' | 'parking'>('all');
  const [asOfDate, setAsOfDate] = useState(today);
  const [loadingProperties, setLoadingProperties] = useState(true);
  const [loadingRows, setLoadingRows] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedLeaseContractUnitId, setSelectedLeaseContractUnitId] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [viewMode, setViewMode] = useState<'current' | 'snapshot'>('current');
  const [snapshotDates, setSnapshotDates] = useState<string[]>([]);
  const [utilityColumns, setUtilityColumns] = useState<UtilityColumn[]>([]);
  const [utilityValues, setUtilityValues] = useState<Record<string, Record<string, { value: number; taxMode: string }>>>({});

  useEffect(() => {
    if (!propertyId || !supabase) { setUtilityColumns([]); setUtilityValues({}); return; }
    let cancelled = false;
    const client = supabase;
    const loadUtility = async () => {
      const [settingResult, lineItemResult, contractResult] = await Promise.all([
        client.from('asset_meter_category_setting').select('category, is_billable, is_basic_billable').eq('asset_id', propertyId),
        client.from('asset_billing_line_item').select('asset_billing_line_item_id, display_name, billing_content, default_unit_price, default_tax_mode, sort_order').eq('asset_id', propertyId).eq('is_active', true).eq('show_unit_price_in_rent_roll', true).order('sort_order'),
        client.from('lease_contract_unit').select('lease_contract_unit_id, unit:unit_master!inner(property_id), prices:lease_contract_unit_utility_price(asset_billing_line_item_id, unit_price, tax_mode), basics:lease_contract_unit_basic_charge(category, amount, tax_mode)').eq('unit.property_id', propertyId),
      ]);
      if (cancelled) return;
      // 読み込めないとき（未適用の環境など）は公共料金の列を出さないだけにします。
      if (settingResult.error || lineItemResult.error || contractResult.error) { setUtilityColumns([]); setUtilityValues({}); return; }
      const settings = (settingResult.data ?? []) as Array<{ category: string; is_billable: boolean; is_basic_billable: boolean }>;
      const basicColumns: UtilityColumn[] = ['electric', 'water', 'gas']
        .filter((category) => settings.some((row) => row.category === category && row.is_basic_billable && (category === 'electric' || row.is_billable)))
        .map((category) => ({ key: `basic:${category}`, label: `${utilityCategoryNames[category]}基本料`, kind: 'basic', id: category, fallback: null }));
      const priceColumns: UtilityColumn[] = ((lineItemResult.data ?? []) as Array<{ asset_billing_line_item_id: string; display_name: string; billing_content: string | null; default_unit_price: number | null; default_tax_mode: string }>)
        .map((item) => ({ key: `price:${item.asset_billing_line_item_id}`, label: `${item.billing_content || item.display_name}単価`, kind: 'price', id: item.asset_billing_line_item_id, fallback: item.default_unit_price === null ? null : { value: Number(item.default_unit_price), taxMode: item.default_tax_mode } }));
      const values: Record<string, Record<string, { value: number; taxMode: string }>> = {};
      for (const unit of (contractResult.data ?? []) as unknown as Array<{ lease_contract_unit_id: string; prices: Array<{ asset_billing_line_item_id: string; unit_price: number; tax_mode: string }> | null; basics: Array<{ category: string; amount: number; tax_mode: string }> | null }>) {
        const target: Record<string, { value: number; taxMode: string }> = {};
        for (const price of unit.prices ?? []) target[`price:${price.asset_billing_line_item_id}`] = { value: Number(price.unit_price), taxMode: price.tax_mode };
        for (const basic of unit.basics ?? []) target[`basic:${basic.category}`] = { value: Number(basic.amount), taxMode: basic.tax_mode };
        values[unit.lease_contract_unit_id] = target;
      }
      setUtilityColumns([...basicColumns, ...priceColumns]);
      setUtilityValues(values);
    };
    void loadUtility();
    return () => { cancelled = true; };
  }, [propertyId, refreshVersion]);

  // 契約区画の単価が無い入居区画は、明細項目の既定単価を「既定」として出します。
  const utilityValueOf = (row: RentRollRow, column: UtilityColumn): UtilityValue | null => {
    if (!row.leaseContractUnitId) return null;
    const own = utilityValues[row.leaseContractUnitId]?.[column.key];
    if (own) return { ...own, isDefault: false };
    return column.fallback ? { ...column.fallback, isDefault: true } : null;
  };
  const shownUtilityColumns = viewMode === 'current' ? utilityColumns : [];

  useEffect(() => {
    let cancelled = false;
    const loadProperties = async () => {
      setLoadingProperties(true);
      setError(null);
      if (!supabase) {
        setError('Supabaseの接続設定が見つかりません。');
        setLoadingProperties(false);
        return;
      }
      const { data, error: loadError } = await supabase
        .from('asset_master')
        .select('asset_id, asset_name, short_name')
        .eq('is_rent_roll_visible', true)
        .order('asset_code');

      if (cancelled) return;
      if (loadError) {
        setError(`物件の取得に失敗しました: ${loadError.message}`);
        setLoadingProperties(false);
        return;
      }

      const options = ((data ?? []) as Array<{ asset_id: string; asset_name: string; short_name: string | null }>).map((asset) => ({
        propertyId: asset.asset_id,
        propertyName: asset.asset_name,
        shortName: asset.short_name,
      }));
      setProperties(options);
      setPropertyId((current) => current || options[0]?.propertyId || '');
      setLoadingProperties(false);
    };
    void loadProperties();
    return () => { cancelled = true; };
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
        setError('Supabaseの接続設定が見つかりません。');
        setLoadingRows(false);
        return;
      }
      let loadedRows: RentRollRow[] = [];
      let loadError: { message: string } | null = null;
      if (viewMode === 'snapshot') {
        const batch = await supabase.from('rent_roll_snapshot_batch')
          .select('rent_roll_snapshot_batch_id, source_file_name')
          .eq('as_of_date', asOfDate)
          .order('source_file_updated_at', { ascending: false })
          .limit(1).maybeSingle();
        if (batch.error) loadError = batch.error;
        else if (batch.data) {
          const detail = await supabase.from('rent_roll_snapshot_row').select('*')
            .eq('rent_roll_snapshot_batch_id', batch.data.rent_roll_snapshot_batch_id)
            .eq('property_id', propertyId).order('floor_label').order('source_row_number');
          if (detail.error) loadError = detail.error;
          else loadedRows = (detail.data as SnapshotSource[] ?? []).map((row) => toSnapshotRow(row, batch.data!.source_file_name, asOfDate));
        }
      } else {
        const result = await supabase.rpc('rent_roll_list_with_terms_at_date', { p_property_id: propertyId, p_as_of_date: asOfDate });
        loadError = result.error;
        loadedRows = ((result.data ?? []) as RentRollSource[]).map(toRentRollRow);
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
    return () => { cancelled = true; };
  }, [propertyId, asOfDate, refreshVersion, viewMode]);

  useEffect(() => {
    if (!supabase) return;
    void supabase.from('rent_roll_snapshot_batch').select('as_of_date').order('as_of_date', { ascending: false })
      .then(({ data }) => setSnapshotDates([...new Set((data ?? []).map((row) => String(row.as_of_date)))]));
  }, []);

  const sortedRows = useMemo(() => [...rows].sort((a, b) => {
    const floorDifference = floorOrder(a.floor) - floorOrder(b.floor);
    return floorDifference || collator.compare(a.floor, b.floor) || collator.compare(a.unitName, b.unitName) || collator.compare(a.unitCode, b.unitCode);
  }), [rows]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('ja-JP');
    const selectedCategories = new Set(selectedProductCategories);
    return sortedRows.filter((row) => {
      const matchesProductCategory = selectedCategories.has(row.productCategory);
      const matchesStatus = statusFilter === 'all' || row.status === statusFilter;
      const matchesType = unitTypeFilter === 'all' || (unitTypeFilter === 'parking' ? row.unitType === 'parking' : row.unitType !== 'parking');
      const matchesQuery = !normalizedQuery || [row.floor, row.unitCode, row.unitName, row.tenantName, row.leaseTermLabel, row.contractPeriod, row.parkingSpaceNumber, row.parkingAccessCode, row.parkingVehicle]
        .some((value) => value.toLocaleLowerCase('ja-JP').includes(normalizedQuery));
      return matchesProductCategory && matchesStatus && matchesType && matchesQuery;
    });
  }, [query, selectedProductCategories, sortedRows, statusFilter, unitTypeFilter]);

  const summary = useMemo(() => summarizeRows(filteredRows), [filteredRows]);
  const overallSummary = useMemo(() => summarizeRows(rows), [rows]);
  const productCounts = useMemo(() => Object.fromEntries(allProductCategories.map((category) => [
    category,
    rows.filter((row) => row.productCategory === category).length,
  ])) as Record<ProductCategory, number>, [rows]);

  const selectedProperty = properties.find((property) => property.propertyId === propertyId);

  const saveSelectedProductCategories = (categories: ProductCategory[]) => {
    setSelectedProductCategories(categories);
    if (!propertyId) return;
    try {
      localStorage.setItem(`rent-roll-product-filters:v1:${propertyId}`, JSON.stringify(categories));
    } catch {
      // The filter still works for the current page when browser storage is unavailable.
    }
  };

  const toggleProductCategory = (category: ProductCategory) => {
    const nextCategories = selectedProductCategories.includes(category)
      ? selectedProductCategories.filter((item) => item !== category)
      : allProductCategories.filter((item) => item === category || selectedProductCategories.includes(item));
    saveSelectedProductCategories(nextCategories);
  };

  return <section className="rent-roll-page">
    <div className="rent-roll-heading">
      <div>
        <p className="section-kicker">RENT ROLL</p>
        <h2>レントロール</h2>
        <p>取り込み済みの区画・賃貸借情報を、指定した基準日時点で確認できます。</p>
      </div>
    </div>

    <div className="rent-roll-mode-switch" role="group" aria-label="表示モード">
      <button type="button" className={viewMode === 'current' ? 'active' : ''} onClick={() => setViewMode('current')}>現在のレントロール</button>
      <button type="button" className={viewMode === 'snapshot' ? 'active' : ''} onClick={() => { setViewMode('snapshot'); if (snapshotDates[0]) setAsOfDate(snapshotDates[0]); }}>過去スナップショット</button>
    </div>
    {viewMode === 'snapshot' && <p className="rent-roll-snapshot-banner">{asOfDate} 時点の過去スナップショット</p>}

    <div className="rent-roll-toolbar">
      <label>基準日
        {viewMode === 'snapshot' ? <select value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)}>{snapshotDates.map((date) => <option key={date} value={date}>{date}</option>)}</select> : <input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} />}
      </label>
      <label>物件
        <select value={propertyId} onChange={(event) => setPropertyId(event.target.value)} disabled={loadingProperties}>
          {properties.map((property) => <option key={property.propertyId} value={property.propertyId}>{property.shortName || property.propertyName}</option>)}
        </select>
      </label>
      <label className="rent-roll-search">テナント・区画を検索
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="室名、テナント名、契約形態" />
      </label>
      <label>状態
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | RentRollStatus)}>
          <option value="all">全件</option>
          <option value="occupied">入居中</option>
          <option value="scheduled">解約予定</option>
          <option value="vacant">空室</option>
          <option value="unavailable">使用不可</option>
        </select>
      </label>
      <label>区画種別
        <select value={unitTypeFilter} onChange={(event) => setUnitTypeFilter(event.target.value as typeof unitTypeFilter)}>
          <option value="all">すべて</option><option value="space">貸室等</option><option value="parking">駐車場</option>
        </select>
      </label>
    </div>

    <section className="rent-roll-product-filter" aria-labelledby="rent-roll-product-filter-title">
      <div className="rent-roll-product-filter-heading">
        <div><h3 id="rent-roll-product-filter-title">商品区分</h3><p>表示する商品を複数選択できます。</p></div>
        <div className="rent-roll-product-filter-actions">
          <button type="button" onClick={() => saveSelectedProductCategories(allProductCategories)}>全選択</button>
          <button type="button" onClick={() => saveSelectedProductCategories([])}>全解除</button>
        </div>
      </div>
      <div className="rent-roll-product-options">
        {productCategories.map(({ code, label }) => <label key={code} className={selectedProductCategories.includes(code) ? 'selected' : ''}>
          <input type="checkbox" checked={selectedProductCategories.includes(code)} onChange={() => toggleProductCategory(code)} />
          <span>{label}</span><small>{numberFormatter.format(productCounts[code])}</small>
        </label>)}
      </div>
      <div className="rent-roll-selected-products">
        <strong>選択中</strong>
        {selectedProductCategories.length > 0
          ? selectedProductCategories.map((category) => <span key={category}>{productCategoryLabel[category]}</span>)
          : <em>選択されている商品はありません</em>}
      </div>
    </section>

    {error && <p className="rent-roll-notice">{error}</p>}
    {!loadingProperties && properties.length === 0 && !error && <p className="rent-roll-notice">表示できるレントロール物件がありません。</p>}

    {selectedProperty && <div className="rent-roll-metrics" aria-label={`${selectedProperty.propertyName} の集計`}>
      <div><span>表示中の区画数</span><strong>{numberFormatter.format(summary.units)} 区画</strong><small>全体 {numberFormatter.format(overallSummary.units)} 区画</small></div>
      <div><span>表示中の入居</span><strong>{numberFormatter.format(summary.occupied)} 区画</strong><small>全体 {numberFormatter.format(overallSummary.occupied)} 区画</small></div>
      <div><span>表示中の空室</span><strong>{numberFormatter.format(summary.vacant)} 区画</strong><small>全体 {numberFormatter.format(overallSummary.vacant)} 区画</small></div>
      <div className="rent-roll-total"><span>表示中の月額総計</span><strong>{currencyFormatter.format(summary.monthlyTotal)}</strong><small>賃料・共益費・駐車場代・その他を別項目で集計｜全体 {currencyFormatter.format(overallSummary.monthlyTotal)}</small></div>
    </div>}

    <div className="rent-roll-panel">
      <div className="rent-roll-panel-heading"><div><h3>{selectedProperty?.propertyName ?? '物件を選択'}</h3><p>{loadingRows ? '読み込み中…' : `${numberFormatter.format(filteredRows.length)} / ${numberFormatter.format(rows.length)} 区画を表示`}</p></div></div>
      <div className="rent-roll-table-wrap" role="region" aria-label="レントロール一覧。縦横にスクロールできます" tabIndex={0}>
        <table className="rent-roll-table">
          <thead><tr><th>状態</th><th>商品</th><th>種別</th><th>階</th><th>室・枠</th><th>内外</th><th>契約形態</th><th>契約期間</th><th>テナント名</th><th>暗証番号</th><th>車両</th><th>面積㎡</th><th>賃料</th><th>共益費</th><th>賃料＋共益費</th><th>駐車場代</th><th>その他月額</th><th>敷金</th><th>保証金</th><th>礼金</th><th>更新料</th>{shownUtilityColumns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
          <tbody>
            {loadingRows && <tr><td colSpan={21 + shownUtilityColumns.length} className="rent-roll-empty">レントロールを読み込んでいます。</td></tr>}
            {!loadingRows && filteredRows.length === 0 && <tr><td colSpan={21 + shownUtilityColumns.length} className="rent-roll-empty">条件に一致する区画はありません。</td></tr>}
            {!loadingRows && filteredRows.map((row) => <tr key={row.unitId}>
              <td><span className={`rent-roll-status ${row.status}`}>{statusLabel[row.status]}</span></td>
              <td><span className={`rent-roll-product-badge ${row.productCategory}`}>{productCategoryLabel[row.productCategory]}</span></td>
              <td><span className={`unit-type-badge ${row.unitType === 'parking' ? 'parking' : ''}`}>{row.unitType === 'parking' ? '駐車場' : '貸室等'}</span></td>
              <td>{row.floor || '—'}</td>
              <td><strong>{row.parkingSpaceNumber ? `枠 ${row.parkingSpaceNumber}` : row.unitName}</strong>{row.discriminator && <small className="rent-roll-discriminator">暫定識別子: {row.discriminator}</small>}</td>
              <td>{row.parkingScope === 'internal' ? '内部' : row.parkingScope === 'external' ? '外部' : '—'}</td>
              <td>{row.leaseTermLabel}</td><td>{row.contractPeriod}</td><td>{row.tenantName && row.leaseContractUnitId && capabilities.canViewContract ? <button type="button" className="rent-roll-tenant-link" onClick={() => setSelectedLeaseContractUnitId(row.leaseContractUnitId)}>{row.tenantName}</button> : row.tenantName || '—'}</td><td className="access-code">{row.parkingAccessCode || '—'}</td><td>{row.parkingVehicle || '—'}</td>
              <td className="numeric">{row.area == null ? '—' : numberFormatter.format(row.area)}</td>
              <td className="numeric emphasis">{formatCurrency(row.rent)}</td><td className="numeric">{formatCurrency(row.commonCharge)}</td><td className="numeric emphasis">{formatCurrency(row.rentCommonTotal)}</td><td className="numeric">{formatCurrency(row.parkingAmount)}</td><td className="numeric">{formatCurrency(row.otherMonthlyAmount)}</td>
              <td className="numeric">{formatCurrency(row.deposit)}</td><td className="numeric">{formatCurrency(row.securityDeposit)}</td><td className="numeric">{formatCurrency(row.keyMoney)}</td><td className="numeric">{formatCurrency(row.renewalFee)}</td>{shownUtilityColumns.map((column) => { const value = utilityValueOf(row, column); return <td key={column.key} className={`numeric${value?.isDefault ? ' rent-roll-utility-default' : ''}`} title={value?.isDefault ? '請求設定の既定単価' : undefined}>{value ? <>{column.kind === 'basic' ? formatCurrency(value.value) : unitPriceFormatter.format(value.value)}{value.taxMode === 'inclusive' && <small>税込</small>}{value.isDefault && <small>既定</small>}</> : '—'}</td>; })}{viewMode === 'snapshot' && row.status !== 'vacant' && <td><button type="button" className="secondary-button snapshot-contractize-button" onClick={() => navigate('/admin/contracts', { state: { propertyId, snapshot: { tenant_name: row.tenantName, unit_code: row.unitCode, unit_name: row.unitName, unit_type: ['parking', 'office', 'retail', 'residential', 'storage', 'equipment', 'other'].includes(row.unitType) ? row.unitType : 'equipment', contract_type: row.productCategory, monthly_rent_amount: row.rent, monthly_common_charge_amount: row.commonCharge, deposit_amount: row.deposit, snapshot_as_of_date: row.snapshotAsOfDate, source_file_name: row.sourceFileName, source_sheet_name: row.sourceSheetName, source_row_number: row.sourceRowNumber } } })}>契約化</button></td>}
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>
    {capabilities.canViewAuditData && <RentRollReconciliationPanel selectedPropertyName={selectedProperty?.propertyName} canManage={capabilities.canEditContract} />}
    {selectedLeaseContractUnitId && <ContractDetailModal leaseContractUnitId={selectedLeaseContractUnitId} asOfDate={asOfDate} capabilities={capabilities} onClose={() => setSelectedLeaseContractUnitId(null)} onChanged={() => setRefreshVersion((current) => current + 1)} />}
  </section>;
}
