import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';

type Property = { asset_id: string; asset_name: string; short_name: string | null };
type ChargeType = 'meeting_room' | 'electricity' | 'electricity_increment' | 'water' | 'gas' | 'fluorescent_light' | 'other';
type ChargeFlag = { charge_type: ChargeType; is_enabled: boolean };
type BillingCode = { billing_code_id: string; issue_code: string; recipient_name: string; notes: string | null; is_active: boolean; flags: ChargeFlag[] | null };
type Tenant = { external_tenant_code: string | null };
type Term = { effective_from: string; effective_to: string | null; monthly_rent_amount: number | null; monthly_common_charge_amount: number | null };
type Allocation = { lease_start_date: string | null; lease_end_date: string | null; monthly_rent_amount: number | null; monthly_common_charge_amount: number | null; terms: Term[] | null; contract: { contract_status: string; contract_start_date: string | null; contract_end_date: string | null; tenant: Tenant | Tenant[] | null } | { contract_status: string; contract_start_date: string | null; contract_end_date: string | null; tenant: Tenant | Tenant[] | null }[] | null };
type Unit = { unit_type: string; allocations: Allocation[] | null };
type Amounts = { occupied: boolean; rent: number; commonCharge: number; parking: number; storage: number };

const currency = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const currentMonth = new Date().toISOString().slice(0, 7);
const flagColumns: Array<{ type: ChargeType; label: string }> = [
  { type: 'meeting_room', label: '会議室利用料' }, { type: 'electricity', label: '電気代' }, { type: 'electricity_increment', label: '電気増額分' },
  { type: 'water', label: '水道代' }, { type: 'gas', label: 'ガス代' }, { type: 'fluorescent_light', label: '蛍光灯代' }, { type: 'other', label: 'その他' },
];

const firstOf = <T,>(value: T | T[] | null | undefined): T | null => Array.isArray(value) ? value[0] ?? null : value ?? null;
const amount = (value: number | null | undefined) => Number(value ?? 0);
const isCurrent = (allocation: Allocation, referenceDate: string) => {
  const contract = firstOf(allocation.contract);
  return Boolean(contract?.contract_status === 'active'
    && (!contract.contract_start_date || contract.contract_start_date <= referenceDate)
    && (!contract.contract_end_date || contract.contract_end_date >= referenceDate)
    && (!allocation.lease_start_date || allocation.lease_start_date <= referenceDate)
    && (!allocation.lease_end_date || allocation.lease_end_date >= referenceDate));
};
const currentTerm = (allocation: Allocation, referenceDate: string) => (allocation.terms ?? [])
  .filter((term) => term.effective_from <= referenceDate && (!term.effective_to || term.effective_to >= referenceDate))
  .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ?? null;

export function BillingCodePage({ canEdit }: { canEdit: boolean }) {
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPropertyId] = useState('');
  const [month, setMonth] = useState(currentMonth);
  const [codes, setCodes] = useState<BillingCode[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const referenceDate = `${month}-01`;

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    let cancelled = false;
    const loadProperties = async () => {
      const { data, error: loadError } = await client.from('asset_master').select('asset_id, asset_name, short_name').order('asset_name');
      if (cancelled) return;
      if (loadError) setError(`物件を読み込めませんでした: ${loadError.message}`);
      const next = (data ?? []) as Property[];
      setProperties(next);
      setPropertyId((current) => current || next[0]?.asset_id || '');
    };
    void loadProperties();
    return () => { cancelled = true; };
  }, []);

  const load = async () => {
    if (!supabase || !propertyId) return;
    setLoading(true); setError('');
    const [codeResult, unitResult] = await Promise.all([
      supabase.from('billing_code').select('billing_code_id, issue_code, recipient_name, notes, is_active, flags:billing_code_charge_flag(charge_type, is_enabled)').eq('property_id', propertyId).order('issue_code'),
      supabase.from('unit_master').select(`unit_type, allocations:lease_contract_unit(lease_start_date, lease_end_date, monthly_rent_amount, monthly_common_charge_amount, terms:lease_contract_unit_term(effective_from, effective_to, monthly_rent_amount, monthly_common_charge_amount), contract:lease_contract(contract_status, contract_start_date, contract_end_date, tenant:tenant_master(external_tenant_code)))`).eq('property_id', propertyId).eq('is_active', true),
    ]);
    if (codeResult.error || unitResult.error) setError(`発行コード一覧を読み込めませんでした: ${codeResult.error?.message ?? unitResult.error?.message}`);
    setCodes((codeResult.data ?? []) as unknown as BillingCode[]);
    setUnits((unitResult.data ?? []) as unknown as Unit[]);
    setLoading(false);
  };
  useEffect(() => { void load(); }, [propertyId, referenceDate]);

  const amountsByCode = useMemo(() => {
    const result = new Map<string, Amounts>();
    for (const code of codes) result.set(code.issue_code, { occupied: false, rent: 0, commonCharge: 0, parking: 0, storage: 0 });
    for (const unit of units) for (const allocation of unit.allocations ?? []) {
      const contract = firstOf(allocation.contract);
      const tenant = firstOf(contract?.tenant);
      const code = tenant?.external_tenant_code;
      if (!code || !result.has(code) || !isCurrent(allocation, referenceDate)) continue;
      const target = result.get(code)!;
      const term = currentTerm(allocation, referenceDate);
      const rent = amount(term?.monthly_rent_amount ?? allocation.monthly_rent_amount);
      const commonCharge = amount(term?.monthly_common_charge_amount ?? allocation.monthly_common_charge_amount);
      target.occupied = true;
      if (unit.unit_type === 'parking') target.parking += rent + commonCharge;
      else if (unit.unit_type === 'storage') target.storage += rent + commonCharge;
      else { target.rent += rent; target.commonCharge += commonCharge; }
    }
    return result;
  }, [codes, units, referenceDate]);

  const toggleFlag = async (code: BillingCode, chargeType: ChargeType) => {
    if (!supabase || !canEdit) return;
    const flag = (code.flags ?? []).find((item) => item.charge_type === chargeType);
    const { error: saveError } = await supabase.from('billing_code_charge_flag').upsert({ billing_code_id: code.billing_code_id, charge_type: chargeType, is_enabled: !flag?.is_enabled }, { onConflict: 'billing_code_id,charge_type' });
    if (saveError) setError(`請求対象フラグを保存できませんでした: ${saveError.message}`); else void load();
  };

  const selectedProperty = properties.find((property) => property.asset_id === propertyId);
  const activeCount = codes.filter((code) => amountsByCode.get(code.issue_code)?.occupied).length;
  return <section className="billing-code-page">
    <div className="page-heading"><div><p className="section-kicker">BILLING CODES</p><h2>発行コード</h2><p>物件ごとの請求先コードと、基準月のレントロール金額・請求対象を確認します。</p></div></div>
    <div className="billing-code-toolbar"><label>基準月<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><label>物件<select value={propertyId} onChange={(event) => setPropertyId(event.target.value)}>{properties.map((property) => <option key={property.asset_id} value={property.asset_id}>{property.short_name || property.asset_name}</option>)}</select></label></div>
    {error && <p className="billing-code-notice">{error}</p>}
    {selectedProperty && <div className="billing-code-summary"><div><span>発行コード</span><strong>{codes.length}件</strong></div><div><span>入居中</span><strong>{activeCount}件</strong></div><div><span>表示基準月</span><strong>{month.replace('-', '年')}月</strong></div></div>}
    <div className="billing-code-panel"><div className="billing-code-panel-heading"><div><h3>{selectedProperty?.asset_name ?? '物件を選択'}</h3><p>金額は基準月時点の契約条件から集計します。○は請求対象です。</p></div></div><div className="billing-code-table-wrap"><table className="billing-code-table"><thead><tr><th>入居状況</th><th>発行コード</th><th>テナント名</th><th>賃料</th><th>共益費</th><th>駐車料</th><th>看板料</th><th>倉庫料</th><th>駐輪場利用料</th>{flagColumns.map((column) => <th key={column.type}>{column.label}</th>)}</tr></thead><tbody>{loading && <tr><td colSpan={16} className="billing-code-empty">読み込み中…</td></tr>}{!loading && codes.map((code) => { const values = amountsByCode.get(code.issue_code) ?? { occupied: false, rent: 0, commonCharge: 0, parking: 0, storage: 0 }; return <tr key={code.billing_code_id}><td><span className={`billing-code-status ${values.occupied ? 'occupied' : 'terminated'}`}>{values.occupied ? '入居中' : '解約済み'}</span></td><td><strong>{code.issue_code}</strong>{code.notes && <small>{code.notes}</small>}</td><td>{code.recipient_name}</td><Amount value={values.rent} /><Amount value={values.commonCharge} /><Amount value={values.parking} /><Amount value={0} /><Amount value={values.storage} /><Amount value={0} />{flagColumns.map((column) => { const enabled = Boolean((code.flags ?? []).find((flag) => flag.charge_type === column.type)?.is_enabled); return <td className="billing-code-flag-cell" key={column.type}><button disabled={!canEdit} className={enabled ? 'enabled' : ''} onClick={() => void toggleFlag(code, column.type)} aria-label={`${code.issue_code}の${column.label}を${enabled ? '対象外' : '請求対象'}にする`}>{enabled ? '○' : '–'}</button></td>; })}</tr>; })}{!loading && codes.length === 0 && <tr><td colSpan={16} className="billing-code-empty">この物件の発行コードは未登録です。発行コード.xlsxを取込後に表示されます。</td></tr>}</tbody></table></div></div>
  </section>;
}

function Amount({ value }: { value: number }) { return <td className="numeric">{value ? currency.format(value) : '–'}</td>; }
