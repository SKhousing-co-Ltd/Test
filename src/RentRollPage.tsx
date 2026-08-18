import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';

type RentRollStatus = 'occupied' | 'scheduled' | 'vacant' | 'applied' | 'unavailable';
type ProductCategory = 'office' | 'residential' | 'parking' | 'bicycle_parking' | 'signage' | 'warehouse' | 'antenna' | 'other';

type PropertyOption = {
  propertyId: string;
  propertyName: string;
  shortName: string | null;
};

type Tenant = { external_tenant_code: string | null; tenant_name: string | null };
type Contract = {
  contract_status: string;
  contract_start_date: string | null;
  contract_end_date: string | null;
  notes: string | null;
  tenant: Tenant | Tenant[] | null;
};

type ContractAllocation = {
  lease_start_date: string | null;
  lease_end_date: string | null;
  created_by_amendment: { status: string } | { status: string }[] | null;
  leased_area_sqm: number | null;
  monthly_rent_amount: number | null;
  monthly_common_charge_amount: number | null;
  monthly_total_amount: number | null;
  deposit_amount: number | null;
  security_deposit_amount: number | null;
  key_money_amount: number | null;
  renewal_fee_amount: number | null;
  terms: ContractTerm[] | null;
  contract: Contract | Contract[] | null;
};

type ContractTerm = {
  effective_from: string;
  effective_to: string | null;
  monthly_rent_amount: number | null;
  monthly_common_charge_amount: number | null;
  deposit_amount: number | null;
  security_deposit_amount: number | null;
  key_money_amount: number | null;
  renewal_fee_amount: number | null;
  amendment: { status: string } | { status: string }[] | null;
};

type UnitSource = {
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  floor_label: string | null;
  unit_type: string;
  rentable_area_sqm: number | null;
  source_discriminator: string | null;
  leasing_status: { leasing_status: string } | { leasing_status: string }[] | null;
  allocations: ContractAllocation[] | null;
};

type RentRollRow = {
  unitId: string;
  status: RentRollStatus;
  productCategory: ProductCategory;
  floor: string;
  unitCode: string;
  unitName: string;
  discriminator: string | null;
  tenantCode: string;
  tenantName: string;
  area: number | null;
  rent: number;
  commonCharge: number;
  total: number;
  deposit: number;
  securityDeposit: number;
  keyMoney: number;
  renewalFee: number;
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
  unavailable: '利用不可',
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

const amount = (value: number | null | undefined) => value ?? 0;

function firstOf<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function isCurrentContract(allocation: ContractAllocation, asOfDate: string): boolean {
  const contract = firstOf(allocation.contract);
  const originAmendment = firstOf(allocation.created_by_amendment);
  return Boolean(
    contract?.contract_status === 'active'
    && (!contract.contract_start_date || contract.contract_start_date <= asOfDate)
    && (!contract.contract_end_date || contract.contract_end_date >= asOfDate)
    && (!allocation.lease_start_date || allocation.lease_start_date <= asOfDate)
    && (!allocation.lease_end_date || allocation.lease_end_date >= asOfDate)
    && (!originAmendment || originAmendment.status === 'executed'),
  );
}

function currentTerms(allocation: ContractAllocation, asOfDate: string): ContractTerm | null {
  return (allocation.terms ?? [])
    .filter((term) => term.effective_from <= asOfDate && (!term.effective_to || term.effective_to >= asOfDate))
    .filter((term) => !firstOf(term.amendment) || firstOf(term.amendment)?.status === 'executed')
    .sort((left, right) => right.effective_from.localeCompare(left.effective_from))[0] ?? null;
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

function leasingStatus(source: UnitSource): string | null {
  const value = Array.isArray(source.leasing_status) ? source.leasing_status[0] : source.leasing_status;
  return value?.leasing_status ?? null;
}

function toRentRollRow(source: UnitSource, asOfDate: string): RentRollRow {
  const currentAllocation = (source.allocations ?? []).find((allocation) => isCurrentContract(allocation, asOfDate));
  const terms = currentAllocation ? currentTerms(currentAllocation, asOfDate) : null;
  const manualStatus = leasingStatus(source);
  const contract = firstOf(currentAllocation?.contract);
  const tenant = firstOf(contract?.tenant);
  const isTerminationScheduled = Boolean(contract?.notes?.includes('解約予定'));
  const status: RentRollStatus = manualStatus === 'applied' || manualStatus === 'unavailable'
    ? manualStatus
    : currentAllocation
      ? isTerminationScheduled ? 'scheduled' : 'occupied'
      : 'vacant';

  return {
    unitId: source.unit_id,
    status,
    productCategory: normalizeProductCategory(source.unit_type),
    floor: source.floor_label ?? '',
    unitCode: source.unit_code,
    unitName: source.unit_name ?? source.unit_code,
    discriminator: source.source_discriminator,
    tenantCode: tenant?.external_tenant_code ?? '',
    tenantName: tenant?.tenant_name ?? '',
    area: currentAllocation?.leased_area_sqm ?? source.rentable_area_sqm,
    rent: amount(terms?.monthly_rent_amount ?? currentAllocation?.monthly_rent_amount),
    commonCharge: amount(terms?.monthly_common_charge_amount ?? currentAllocation?.monthly_common_charge_amount),
    total: amount(terms?.monthly_rent_amount ?? currentAllocation?.monthly_rent_amount) + amount(terms?.monthly_common_charge_amount ?? currentAllocation?.monthly_common_charge_amount),
    deposit: amount(terms?.deposit_amount ?? currentAllocation?.deposit_amount),
    securityDeposit: amount(terms?.security_deposit_amount ?? currentAllocation?.security_deposit_amount),
    keyMoney: amount(terms?.key_money_amount ?? currentAllocation?.key_money_amount),
    renewalFee: amount(terms?.renewal_fee_amount ?? currentAllocation?.renewal_fee_amount),
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
        .from('lease_contract_unit')
        .select('unit:unit_master!inner(property_id, asset:asset_master(asset_name, short_name)), contract:lease_contract!inner(source_system)')
        .eq('contract.source_system', 'rent_roll_xlsx');

      if (cancelled) return;
      if (loadError) {
        setError(`物件の取得に失敗しました: ${loadError.message}`);
        setLoadingProperties(false);
        return;
      }

      const uniqueProperties = new Map<string, PropertyOption>();
      const propertyUnits = (data ?? []) as unknown as Array<{ unit: { property_id: string; asset: { asset_name: string; short_name: string | null } | { asset_name: string; short_name: string | null }[] | null } | { property_id: string; asset: { asset_name: string; short_name: string | null } | { asset_name: string; short_name: string | null }[] | null }[] | null }>;
      propertyUnits.forEach((record) => {
        const unit = firstOf(record.unit);
        if (!unit) return;
        const asset = firstOf(unit.asset);
        if (asset) {
          uniqueProperties.set(unit.property_id, {
            propertyId: unit.property_id,
            propertyName: asset.asset_name,
            shortName: asset.short_name,
          });
        }
      });
      const options = [...uniqueProperties.values()].sort((a, b) => collator.compare(a.propertyName, b.propertyName));
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
      const { data, error: loadError } = await supabase
        .from('unit_master')
        .select(`
          unit_id, unit_code, unit_name, floor_label, unit_type, rentable_area_sqm, source_discriminator,
          leasing_status:unit_leasing_status(leasing_status),
          allocations:lease_contract_unit(
            lease_start_date, lease_end_date, created_by_amendment:lease_contract_amendment!lease_contract_unit_created_by_amendment_id_fkey(status), leased_area_sqm, monthly_rent_amount, monthly_common_charge_amount, monthly_total_amount,
            deposit_amount, security_deposit_amount, key_money_amount, renewal_fee_amount,
            terms:lease_contract_unit_term(
              effective_from, effective_to, monthly_rent_amount, monthly_common_charge_amount,
              deposit_amount, security_deposit_amount, key_money_amount, renewal_fee_amount,
              amendment:lease_contract_amendment(status)
            ),
            contract:lease_contract(
              contract_status, contract_start_date, contract_end_date, notes,
              tenant:tenant_master(external_tenant_code, tenant_name)
            )
          )
        `)
        .eq('property_id', propertyId)
        .eq('is_active', true);

      if (cancelled) return;
      if (loadError) {
        setRows([]);
        setError(`レントロールの取得に失敗しました: ${loadError.message}`);
      } else {
        setRows(((data ?? []) as unknown as UnitSource[]).map((source) => toRentRollRow(source, asOfDate)));
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
      const matchesQuery = !normalizedQuery || [row.floor, row.unitCode, row.unitName, row.tenantCode, row.tenantName]
        .some((value) => value.toLocaleLowerCase('ja-JP').includes(normalizedQuery));
      return matchesProductCategory && matchesStatus && matchesQuery;
    });
  }, [query, selectedProductCategories, sortedRows, statusFilter]);

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
        <p>取り込み済みの区画・賃貸借情報を、Excelに近い一覧で確認できます。</p>
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
          <thead><tr><th>状態</th><th>商品</th><th>階</th><th>室</th><th>テナントコード</th><th>テナント名</th><th>面積㎡</th><th>賃料</th><th>共益費</th><th>賃料＋共益費</th><th>敷金</th><th>保証金</th><th>礼金</th><th>更新料</th></tr></thead>
          <tbody>
            {loadingRows && <tr><td colSpan={14} className="rent-roll-empty">レントロールを読み込んでいます。</td></tr>}
            {!loadingRows && filteredRows.length === 0 && <tr><td colSpan={14} className="rent-roll-empty">条件に一致する区画はありません。</td></tr>}
            {!loadingRows && filteredRows.map((row) => <tr key={row.unitId}>
              <td><span className={`rent-roll-status ${row.status}`}>{statusLabel[row.status]}</span></td>
              <td><span className={`rent-roll-product-badge ${row.productCategory}`}>{productCategoryLabel[row.productCategory]}</span></td>
              <td>{row.floor || '—'}</td>
              <td><strong>{row.unitName}</strong>{row.discriminator && <small className="rent-roll-discriminator">暫定識別子: {row.discriminator}</small>}</td>
              <td>{row.tenantCode || '—'}</td><td>{row.tenantName || '—'}</td>
              <td className="numeric">{row.area == null ? '—' : numberFormatter.format(row.area)}</td>
              <td className="numeric">{formatCurrency(row.rent)}</td><td className="numeric">{formatCurrency(row.commonCharge)}</td><td className="numeric emphasis">{formatCurrency(row.total)}</td>
              <td className="numeric">{formatCurrency(row.deposit)}</td><td className="numeric">{formatCurrency(row.securityDeposit)}</td><td className="numeric">{formatCurrency(row.keyMoney)}</td><td className="numeric">{formatCurrency(row.renewalFee)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>
  </section>;
}
