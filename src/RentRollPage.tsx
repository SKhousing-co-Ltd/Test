import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';

type RentRollStatus = 'occupied' | 'scheduled' | 'vacant' | 'applied' | 'unavailable';
type ProductCategory = 'office' | 'residential' | 'parking' | 'bicycle_parking' | 'signage' | 'warehouse' | 'antenna' | 'other';

type PropertyOption = {
  propertyId: string;
  propertyName: string;
  shortName: string | null;
};

type TenantBillingCode = { billing_code: string; is_primary: boolean; is_active: boolean; sort_order: number };
type TenantBillingCodeRecord = TenantBillingCode & { tenant_id: string };
type RentRollSource = {
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  floor_label: string | null;
  unit_type: string;
  rentable_area_sqm: number | null;
  source_discriminator: string | null;
  leasing_status: string | null;
  lease_contract_id: string | null;
  contract_status: string | null;
  contract_notes: string | null;
  tenant_id: string | null;
  external_tenant_code: string | null;
  tenant_name: string | null;
  billing_codes?: TenantBillingCode[] | null;
  leased_area_sqm: number | null;
  gross_monthly_rent_amount: number;
  parking_fee_deduction_amount: number;
  monthly_rent_amount: number;
  monthly_common_charge_amount: number;
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
  unitType: string;
  status: RentRollStatus;
  productCategory: ProductCategory;
  floor: string;
  unitCode: string;
  unitName: string;
  discriminator: string | null;
  tenantCode: string;
  tenantCodes: string[];
  tenantName: string;
  area: number | null;
  grossRent: number;
  parkingDeduction: number;
  rent: number;
  commonCharge: number;
  total: number;
  deposit: number;
  securityDeposit: number;
  keyMoney: number;
  renewalFee: number;
  parkingScope: 'internal' | 'external' | null;
  parkingSpaceNumber: string;
  parkingAccessCode: string;
  parkingVehicle: string;
};

const today = new Date().toISOString().slice(0, 10);
const currencyFormatter = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const numberFormatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });
const collator = new Intl.Collator('ja-JP', { numeric: true, sensitivity: 'base' });
const productCategories: Array<{ code: ProductCategory; label: string }> = [
  { code: 'office', label: '事務所' },
  { code: 'residential', label: '住居' },
  { code: 'parking', label: '駐車場' },
  { code: 'bicycle_parking', label: '駐輪場' },
  { code: 'signage', label: '看板' },
  { code: 'warehouse', label: '倉庫' },
  { code: 'antenna', label: 'アンテナ' },
  { code: 'other', label: 'その他' },
];
const allProductCategories = productCategories.map(({ code }) => code);
const productCategoryLabel = Object.fromEntries(productCategories.map(({ code, label }) => [code, label])) as Record<ProductCategory, string>;
const productCategorySet = new Set<ProductCategory>(allProductCategories);

const statusLabel: Record<RentRollStatus, string> = {
  occupied: '入居中',
  scheduled: '解約予定',
  vacant: '空室',
  applied: '申込中',
  unavailable: '使用不可',
};

function normalizeProductCategory(value: string): ProductCategory {
  if (value === 'storage') return 'warehouse';
  if (value === 'equipment' || value === 'retail') return 'other';
  return productCategorySet.has(value as ProductCategory) ? value as ProductCategory : 'other';
}

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
  const tenantCodes = (source.billing_codes ?? [])
    .filter((code) => code.is_active)
    .sort((left, right) => Number(right.is_primary) - Number(left.is_primary) || left.sort_order - right.sort_order || collator.compare(left.billing_code, right.billing_code))
    .map((code) => code.billing_code);
  const primaryTenantCode = tenantCodes[0] ?? source.external_tenant_code ?? '';
  const parkingUnavailable = source.unit_type === 'parking' && source.space_status === 'unavailable';
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
    unitType: source.unit_type,
    status,
    productCategory: normalizeProductCategory(source.unit_type),
    floor: source.floor_label ?? '',
    unitCode: source.unit_code,
    unitName: source.unit_name ?? source.unit_code,
    discriminator: source.source_discriminator,
    tenantCode: parkingUnavailable ? '' : primaryTenantCode,
    tenantCodes: parkingUnavailable ? [] : tenantCodes.length ? tenantCodes : primaryTenantCode ? [primaryTenantCode] : [],
    tenantName: parkingUnavailable ? '' : source.tenant_name ?? '',
    area: source.leased_area_sqm ?? source.rentable_area_sqm,
    grossRent: parkingUnavailable ? 0 : Number(source.gross_monthly_rent_amount ?? 0),
    parkingDeduction: parkingUnavailable ? 0 : Number(source.parking_fee_deduction_amount ?? 0),
    rent: parkingUnavailable ? 0 : Number(source.monthly_rent_amount ?? 0),
    commonCharge: parkingUnavailable ? 0 : Number(source.monthly_common_charge_amount ?? 0),
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

function formatCurrency(value: number): string {
  return value === 0 ? '—' : currencyFormatter.format(value);
}

export function RentRollPage() {
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
        .order('asset_name');

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
      const [result, billingCodeResult] = await Promise.all([
        supabase.rpc('rent_roll_list_at_date', {
          p_property_id: propertyId,
          p_as_of_date: asOfDate,
        }),
        supabase.from('tenant_billing_code').select('tenant_id, billing_code, is_primary, is_active, sort_order').eq('is_active', true),
      ]);

      if (cancelled) return;
      if (result.error) {
        setRows([]);
        setError(`レントロールの取得に失敗しました: ${result.error.message}`);
      } else {
        const billingCodesByTenant = new Map<string, TenantBillingCode[]>();
        if (!billingCodeResult.error) {
          for (const code of (billingCodeResult.data ?? []) as TenantBillingCodeRecord[]) {
            billingCodesByTenant.set(code.tenant_id, [...(billingCodesByTenant.get(code.tenant_id) ?? []), code]);
          }
        }
        setRows(((result.data ?? []) as RentRollSource[]).map((source) => toRentRollRow({
          ...source,
          billing_codes: source.tenant_id ? billingCodesByTenant.get(source.tenant_id) ?? null : null,
        })));
      }
      setLoadingRows(false);
    };
    void loadRows();
    return () => { cancelled = true; };
  }, [propertyId, asOfDate]);

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
      const matchesQuery = !normalizedQuery || [row.floor, row.unitCode, row.unitName, row.tenantCodes.join(' '), row.tenantName, row.parkingSpaceNumber, row.parkingAccessCode, row.parkingVehicle]
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

    <div className="rent-roll-toolbar">
      <label>基準日
        <input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} />
      </label>
      <label>物件
        <select value={propertyId} onChange={(event) => setPropertyId(event.target.value)} disabled={loadingProperties}>
          {properties.map((property) => <option key={property.propertyId} value={property.propertyId}>{property.shortName || property.propertyName}</option>)}
        </select>
      </label>
      <label className="rent-roll-search">テナント・区画を検索
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="室名、テナント名、コード" />
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
      <div className="rent-roll-total"><span>表示中の月額合計</span><strong>{currencyFormatter.format(summary.monthlyTotal)}</strong><small>全体 {currencyFormatter.format(overallSummary.monthlyTotal)}</small></div>
    </div>}

    <div className="rent-roll-panel">
      <div className="rent-roll-panel-heading"><div><h3>{selectedProperty?.propertyName ?? '物件を選択'}</h3><p>{loadingRows ? '読み込み中…' : `${numberFormatter.format(filteredRows.length)} / ${numberFormatter.format(rows.length)} 区画を表示`}</p></div></div>
      <div className="rent-roll-table-wrap">
        <table className="rent-roll-table">
          <thead><tr><th>状態</th><th>商品</th><th>種別</th><th>階</th><th>室・枠</th><th>内外</th><th>テナントコード</th><th>テナント名</th><th>暗証番号</th><th>車両</th><th>面積㎡</th><th>総額賃料</th><th>駐車料控除</th><th>表示賃料</th><th>共益費</th><th>賃料＋共益費</th><th>敷金</th><th>保証金</th><th>礼金</th><th>更新料</th></tr></thead>
          <tbody>
            {loadingRows && <tr><td colSpan={20} className="rent-roll-empty">レントロールを読み込んでいます。</td></tr>}
            {!loadingRows && filteredRows.length === 0 && <tr><td colSpan={20} className="rent-roll-empty">条件に一致する区画はありません。</td></tr>}
            {!loadingRows && filteredRows.map((row) => <tr key={row.unitId}>
              <td><span className={`rent-roll-status ${row.status}`}>{statusLabel[row.status]}</span></td>
              <td><span className={`rent-roll-product-badge ${row.productCategory}`}>{productCategoryLabel[row.productCategory]}</span></td>
              <td><span className={`unit-type-badge ${row.unitType === 'parking' ? 'parking' : ''}`}>{row.unitType === 'parking' ? '駐車場' : '貸室等'}</span></td>
              <td>{row.floor || '—'}</td>
              <td><strong>{row.parkingSpaceNumber ? `枠 ${row.parkingSpaceNumber}` : row.unitName}</strong>{row.discriminator && <small className="rent-roll-discriminator">暫定識別子: {row.discriminator}</small>}</td>
              <td>{row.parkingScope === 'internal' ? '内部' : row.parkingScope === 'external' ? '外部' : '—'}</td>
              <td>{row.tenantCode || '—'}{row.tenantCodes.length > 1 ? <span className="tenant-code-pill">＋{row.tenantCodes.length - 1}</span> : null}</td><td>{row.tenantName || '—'}</td><td className="access-code">{row.parkingAccessCode || '—'}</td><td>{row.parkingVehicle || '—'}</td>
              <td className="numeric">{row.area == null ? '—' : numberFormatter.format(row.area)}</td>
              <td className="numeric">{formatCurrency(row.grossRent)}</td><td className="numeric">{formatCurrency(row.parkingDeduction)}</td><td className="numeric emphasis">{formatCurrency(row.rent)}</td><td className="numeric">{formatCurrency(row.commonCharge)}</td><td className="numeric emphasis">{formatCurrency(row.total)}</td>
              <td className="numeric">{formatCurrency(row.deposit)}</td><td className="numeric">{formatCurrency(row.securityDeposit)}</td><td className="numeric">{formatCurrency(row.keyMoney)}</td><td className="numeric">{formatCurrency(row.renewalFee)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>
  </section>;
}
