import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import type { BillingPeriod } from './TenantBillingControls';
import './BillingStatementPage.css';

type StatementKind = 'payment' | 'invoice';
type RentRollSource = { unit_code: string; unit_name: string | null; floor_label: string | null; lease_contract_id: string | null; tenant_id: string | null; tenant_name: string | null; monthly_rent_amount: number; monthly_common_charge_amount: number; monthly_parking_amount: number; other_monthly_amount: number };
type BillingCode = { tenant_id: string | null; issue_code: string; is_primary: boolean; match_status: string };
type ChargeType = { billing_charge_type_id: string; charge_type_name: string; sort_order?: number };
type ConfiguredItem = { billing_charge_type_id: string; sort_order: number };
type StatementRow = { key: string; code: string; floor: string; unitName: string; tenantName: string; rent: number; commonCharge: number; parking: number; other: number };
const currency = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
const collator = new Intl.Collator('ja-JP', { numeric: true, sensitivity: 'base' });
const floorOrder = (label: string) => { const normalized = label.normalize('NFKC').trim().toUpperCase(); const basement = normalized.match(/^B(\d+)/); if (basement) return -Number(basement[1]); const numeric = normalized.match(/-?\d+(?:\.\d+)?/); if (numeric) return Number(numeric[0]); if (normalized.includes('PH') || normalized.includes('屋上')) return 10000; return 5000; };
const amount = (value: number) => value ? currency.format(value) : '—';
const monthKey = (period: BillingPeriod) => `${period.fiscalYear + (period.month <= 3 ? 1 : 0)}${String(period.month).padStart(2, '0')}`;
const referenceDate = (period: BillingPeriod) => `${period.fiscalYear + (period.month <= 3 ? 1 : 0)}-${String(period.month).padStart(2, '0')}-01`;
const stored = <T,>(key: string, fallback: T): T => { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const chargeAmount = (row: StatementRow, name: string) => name === '賃料' ? row.rent : name === '共益費' ? row.commonCharge : name === '駐車料' ? row.parking : name === 'その他' ? row.other : 0;

export function BillingStatementPage({ kind, propertyId, propertyName, period }: { kind: StatementKind; propertyId: string; propertyName: string; period: BillingPeriod }) {
  const [rows, setRows] = useState<StatementRow[]>([]);
  const [chargeTypes, setChargeTypes] = useState<ChargeType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { const load = async () => {
    if (!supabase || !propertyId) { setRows([]); setChargeTypes([]); setLoading(false); return; }
    setLoading(true); setError('');
    const [rentRollResult, codeResult, itemResult, typeResult] = await Promise.all([
      supabase.rpc('rent_roll_list_with_terms_at_date', { p_property_id: propertyId, p_as_of_date: referenceDate(period) }),
      supabase.from('billing_code').select('tenant_id, issue_code, is_primary, match_status').eq('property_id', propertyId).eq('is_active', true),
      supabase.from('asset_billing_line_item').select('billing_charge_type_id, sort_order').eq('asset_id', propertyId).eq('is_active', true).order('sort_order'),
      supabase.from('billing_charge_type').select('billing_charge_type_id, charge_type_name, sort_order').eq('is_active', true).order('sort_order'),
    ]);
    if (rentRollResult.error || codeResult.error) { setError(`明細を読み込めませんでした: ${rentRollResult.error?.message ?? codeResult.error?.message}`); setRows([]); setLoading(false); return; }
    const configuredItems = itemResult.error ? stored<ConfiguredItem[]>(`tenant-billing-property-line-items:${propertyId}`, []) : (itemResult.data ?? []) as ConfiguredItem[];
    const allTypes = typeResult.error ? stored<ChargeType[]>('tenant-billing-charge-types', []) : (typeResult.data ?? []) as ChargeType[];
    const firstItemOrder = new Map<string, number>(); for (const item of configuredItems) if (!firstItemOrder.has(item.billing_charge_type_id)) firstItemOrder.set(item.billing_charge_type_id, item.sort_order);
    setChargeTypes(allTypes.filter((type) => firstItemOrder.has(type.billing_charge_type_id)).sort((left, right) => (firstItemOrder.get(left.billing_charge_type_id) ?? 0) - (firstItemOrder.get(right.billing_charge_type_id) ?? 0)));
    const primaryCodes = new Map<string, BillingCode>(); for (const code of (codeResult.data ?? []) as BillingCode[]) if (code.tenant_id && code.is_primary && code.match_status === 'matched') primaryCodes.set(code.tenant_id, code);
    const grouped = new Map<string, StatementRow>();
    for (const source of (rentRollResult.data ?? []) as RentRollSource[]) { if (!source.lease_contract_id || !source.tenant_id || !source.tenant_name) continue; const existing = grouped.get(source.tenant_id); const row = existing ?? { key: source.tenant_id, code: primaryCodes.get(source.tenant_id)?.issue_code ?? '—', floor: source.floor_label ?? '', unitName: source.unit_name ?? source.unit_code, tenantName: source.tenant_name, rent: 0, commonCharge: 0, parking: 0, other: 0 }; row.rent += Number(source.monthly_rent_amount ?? 0); row.commonCharge += Number(source.monthly_common_charge_amount ?? 0); row.parking += Number(source.monthly_parking_amount ?? 0); row.other += Number(source.other_monthly_amount ?? 0); if (!existing || floorOrder(source.floor_label ?? '') < floorOrder(row.floor)) { row.floor = source.floor_label ?? ''; row.unitName = source.unit_name ?? source.unit_code; } grouped.set(source.tenant_id, row); }
    setRows([...grouped.values()].sort((left, right) => floorOrder(left.floor) - floorOrder(right.floor) || collator.compare(left.floor, right.floor) || collator.compare(left.unitName, right.unitName))); setLoading(false);
  }; void load(); }, [propertyId, period.fiscalYear, period.month]);
  const title = kind === 'payment' ? '入金明細表' : '請求明細表';
  const total = useMemo(() => rows.reduce((sum, row) => sum + chargeTypes.reduce((subtotal, type) => subtotal + chargeAmount(row, type.charge_type_name), 0), 0), [rows, chargeTypes]);
  const columnCount = 3 + chargeTypes.length + 3 + (kind === 'payment' ? 3 : 0);
  return <section className="billing-statement-page"><header className="billing-statement-heading"><div><p className="section-kicker">{monthKey(period)}</p><h3>{title}（{propertyName || '物件未選択'}）</h3></div>{kind === 'invoice' && <div className="billing-statement-dates"><span>発行予定日：未設定</span><span>支払期日：未設定</span></div>}</header>{error && <p className="billing-statement-notice">{error}</p>}{!loading && !chargeTypes.length && <p className="billing-statement-notice">請求設定で明細項目を登録すると、紐づく請求種別をヘッダーに表示します。</p>}<div className="billing-statement-table-wrap"><table><colgroup><col className="statement-code" /><col className="statement-floor" /><col className="statement-tenant" />{chargeTypes.map((type) => <col className="statement-money" key={type.billing_charge_type_id} />)}<col className="statement-money" /><col className="statement-money" /><col className="statement-money" />{kind === 'payment' && <><col className="statement-money" /><col className="statement-money" /><col className="statement-date" /></>}</colgroup><thead><tr><th>コード</th><th>階</th><th>テナント名</th>{chargeTypes.map((type) => <th key={type.billing_charge_type_id}>{type.charge_type_name}</th>)}<th>小計</th><th>消費税</th><th>合計</th>{kind === 'payment' && <><th>未入金額</th><th>入金額</th><th>入金日</th></>}</tr></thead><tbody>{loading ? <tr><td colSpan={columnCount}>読み込み中…</td></tr> : rows.map((row) => { const subtotal = chargeTypes.reduce((sum, type) => sum + chargeAmount(row, type.charge_type_name), 0); const tax = Math.floor(subtotal * 0.1); const billed = subtotal + tax; return <tr key={row.key}><td><strong>{row.code}</strong></td><td>{row.floor || '—'}</td><td>{row.tenantName}</td>{chargeTypes.map((type) => <td className="numeric" key={type.billing_charge_type_id}>{amount(chargeAmount(row, type.charge_type_name))}</td>)}<td className="numeric">{amount(subtotal)}</td><td className="numeric">{amount(tax)}</td><td className="numeric total">{amount(billed)}</td>{kind === 'payment' && <><td className="numeric">{amount(billed)}</td><td className="numeric">—</td><td>—</td></>}</tr>; })}{!loading && !rows.length && <tr><td colSpan={columnCount} className="billing-statement-empty">入居中のテナントがありません。</td></tr>}</tbody><tfoot>{rows.length > 0 && <tr><th colSpan={3 + chargeTypes.length}>合計</th><th className="numeric">{amount(total)}</th><th className="numeric">{amount(Math.floor(total * 0.1))}</th><th className="numeric total">{amount(total + Math.floor(total * 0.1))}</th>{kind === 'payment' && <><th className="numeric">{amount(total + Math.floor(total * 0.1))}</th><th>—</th><th>—</th></>}</tr>}</tfoot></table></div></section>;
}
