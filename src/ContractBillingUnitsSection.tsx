import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import { ContractUtilityPricesSection } from './ContractUtilityPricesSection';

type ContractUnit = { lease_contract_unit_id: string; unit: { unit_code: string; unit_name: string | null; floor_label: string | null } | null };
type BillingUnit = { id: string; name: string; memberIds: string[] };

const newId = () => crypto.randomUUID();
const labelOf = (row: ContractUnit) => [row.unit?.floor_label, row.unit?.unit_name || row.unit?.unit_code].filter(Boolean).join(' ') || '区画名なし';

export function ContractBillingUnitsSection({ leaseContractId, propertyId, canEdit, onEnabledChange }: { leaseContractId: string; propertyId: string; canEdit: boolean; onEnabledChange?: (enabled: boolean) => void }) {
  const [contractUnits, setContractUnits] = useState<ContractUnit[]>([]);
  const [billingUnits, setBillingUnits] = useState<BillingUnit[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!supabase || !leaseContractId) return;
    let cancelled = false;
    setLoading(true); setError(''); setMessage('');
    void Promise.all([
      supabase.from('lease_contract_unit').select('lease_contract_unit_id, unit:unit_master(unit_code, unit_name, floor_label)').eq('lease_contract_id', leaseContractId),
      supabase.from('lease_contract_billing_unit').select('lease_contract_billing_unit_id, billing_unit_name, sort_order, members:lease_contract_billing_unit_member(lease_contract_unit_id)').eq('lease_contract_id', leaseContractId).order('sort_order'),
    ]).then(([unitResult, billingResult]) => {
      if (cancelled) return;
      const failed = unitResult.error ?? billingResult.error;
      if (failed) { setError(`請求区画を読み込めませんでした: ${failed.message}`); setLoading(false); return; }
      setContractUnits((unitResult.data ?? []) as unknown as ContractUnit[]);
      const rows = (billingResult.data ?? []) as unknown as Array<{ lease_contract_billing_unit_id: string; billing_unit_name: string; members: Array<{ lease_contract_unit_id: string }> }>;
      setBillingUnits(rows.map((row) => ({ id: row.lease_contract_billing_unit_id, name: row.billing_unit_name, memberIds: row.members.map((member) => member.lease_contract_unit_id) })));
      setEnabled(rows.length > 0); onEnabledChange?.(rows.length > 0); setLoading(false);
    });
    return () => { cancelled = true; };
  }, [leaseContractId, onEnabledChange]);

  const toggleMember = (billingUnitId: string, contractUnitId: string, checked: boolean) => setBillingUnits((current) => current.map((row) => ({
    ...row,
    memberIds: row.id === billingUnitId
      ? checked ? [...new Set([...row.memberIds, contractUnitId])] : row.memberIds.filter((id) => id !== contractUnitId)
      : row.memberIds,
  })));

  const save = async () => {
    if (!supabase || !canEdit) return;
    setError(''); setMessage('');
    if (enabled && billingUnits.length < 2) { setError('請求区画を分ける場合は、請求区画を2つ以上作成してください。'); return; }
    if (enabled && billingUnits.some((row) => !row.name.trim())) { setError('請求区画名を入力してください。'); return; }
    if (enabled && billingUnits.some((row) => row.memberIds.length === 0)) { setError('各請求区画に契約区画を1つ以上割り当ててください。'); return; }
    if (enabled && contractUnits.some((unit) => !billingUnits.some((row) => row.memberIds.includes(unit.lease_contract_unit_id)))) { setError('すべての契約区画をいずれかの請求区画に割り当ててください。'); return; }
    setSaving(true);
    const existing = await supabase.from('lease_contract_billing_unit').select('lease_contract_billing_unit_id').eq('lease_contract_id', leaseContractId);
    if (existing.error) { setError(existing.error.message); setSaving(false); return; }
    const ids = (existing.data ?? []).map((row) => row.lease_contract_billing_unit_id);
    const removedIds = ids.filter((id) => !enabled || !billingUnits.some((row) => row.id === id));
    if (removedIds.length) {
      const deleted = await supabase.from('lease_contract_billing_unit').delete().in('lease_contract_billing_unit_id', removedIds);
      if (deleted.error) { setError(`請求区画を更新できませんでした: ${deleted.error.message}`); setSaving(false); return; }
    }
    if (enabled) {
      const rows = billingUnits.map((row, index) => ({ lease_contract_billing_unit_id: row.id, lease_contract_id: leaseContractId, billing_unit_name: row.name.trim(), sort_order: index }));
      const saved = await supabase.from('lease_contract_billing_unit').upsert(rows);
      if (saved.error) { setError(`請求区画を保存できませんでした: ${saved.error.message}`); setSaving(false); return; }
      const currentIds = billingUnits.map((row) => row.id);
      const cleared = await supabase.from('lease_contract_billing_unit_member').delete().in('lease_contract_billing_unit_id', currentIds);
      if (cleared.error) { setError(`請求区画の構成を更新できませんでした: ${cleared.error.message}`); setSaving(false); return; }
      const members = billingUnits.flatMap((row) => row.memberIds.map((id) => ({ lease_contract_billing_unit_id: row.id, lease_contract_unit_id: id })));
      const savedMembers = await supabase.from('lease_contract_billing_unit_member').insert(members);
      if (savedMembers.error) { setError(`請求区画の構成を保存できませんでした: ${savedMembers.error.message}`); setSaving(false); return; }
    }
    setSaving(false); setMessage('請求区画を保存しました。');
  };

  if (loading) return <p className="contract-information-empty">請求区画を読み込み中…</p>;
  return <section className="contract-billing-units">
    <div className="contract-information-section-heading"><div><h3>請求区画</h3><p>同一契約の区画を、公共料金の請求上の区画に分けます。</p></div></div>
    {error && <p className="contract-information-notice">{error}</p>}
    <label className="billing-terms-check"><input type="checkbox" checked={enabled} disabled={!canEdit || saving || contractUnits.length === 0} onChange={(event) => { const checked = event.target.checked; setEnabled(checked); onEnabledChange?.(checked); if (checked && billingUnits.length === 0) { const midpoint = Math.ceil(contractUnits.length / 2); const first = contractUnits.slice(0, midpoint).map((row) => row.lease_contract_unit_id); const second = contractUnits.length === 1 ? first : contractUnits.slice(midpoint).map((row) => row.lease_contract_unit_id); setBillingUnits([{ id: newId(), name: '', memberIds: first }, { id: newId(), name: '', memberIds: second }]); } }} />請求区画を分ける</label>
    {enabled && <div className="contract-billing-unit-list">
      {billingUnits.map((row, index) => <div key={row.id} className="billing-terms-field">
        <label>請求区画名<input value={row.name} disabled={!canEdit || saving} placeholder={`請求区画 ${index + 1}`} onChange={(event) => setBillingUnits((current) => current.map((item) => item.id === row.id ? { ...item, name: event.target.value } : item))} /></label>
        <div>{contractUnits.map((unit) => <label key={unit.lease_contract_unit_id} className="billing-terms-check"><input type="checkbox" checked={row.memberIds.includes(unit.lease_contract_unit_id)} disabled={!canEdit || saving} onChange={(event) => toggleMember(row.id, unit.lease_contract_unit_id, event.target.checked)} />{labelOf(unit)}</label>)}</div>
        {billingUnits.length > 2 && <button type="button" className="text-button" disabled={!canEdit || saving} onClick={() => setBillingUnits((current) => current.filter((item) => item.id !== row.id))}>削除</button>}
        <ContractUtilityPricesSection billingUnitId={row.id} fallbackLeaseContractUnitId={row.memberIds[0]} propertyId={propertyId} canEdit={canEdit} />
      </div>)}
      <button type="button" className="text-button" disabled={!canEdit || saving} onClick={() => setBillingUnits((current) => [...current, { id: newId(), name: '', memberIds: [] }])}>請求区画を追加</button>
    </div>}
    {canEdit && <div className="utility-price-actions">{message && <span className="billing-terms-preview">{message}</span>}<button type="button" className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '請求区画を保存'}</button></div>}
  </section>;
}
