import { useMemo, useState } from 'react';
import type { ContractDetail } from './ContractDetailModal';
import { supabase } from './lib/supabase';

type EditorProps = {
  contract: ContractDetail;
  asOfDate: string;
  onCancel: () => void;
  onApplied: () => Promise<void>;
};

type FormState = Record<string, string>;
type EditableField = {
  key: string;
  label: string;
  scope: 'contract' | 'unit';
  type?: 'date' | 'number' | 'textarea';
};

const fields: EditableField[] = [
  { key: 'contract_type', label: '契約種別', scope: 'contract' },
  { key: 'contract_start_date', label: '契約開始日', scope: 'contract', type: 'date' },
  { key: 'contract_end_date', label: '契約終了日', scope: 'contract', type: 'date' },
  { key: 'lease_start_date', label: '区画利用開始日', scope: 'unit', type: 'date' },
  { key: 'lease_end_date', label: '区画利用終了日', scope: 'unit', type: 'date' },
  { key: 'leased_area_sqm', label: '面積（㎡）', scope: 'unit', type: 'number' },
  { key: 'monthly_rent_amount', label: '賃料', scope: 'unit', type: 'number' },
  { key: 'monthly_common_charge_amount', label: '共益費', scope: 'unit', type: 'number' },
  { key: 'deposit_amount', label: '敷金', scope: 'unit', type: 'number' },
  { key: 'security_deposit_amount', label: '保証金', scope: 'unit', type: 'number' },
  { key: 'key_money_amount', label: '礼金', scope: 'unit', type: 'number' },
  { key: 'renewal_fee_amount', label: '更新料', scope: 'unit', type: 'number' },
  { key: 'payment_terms', label: '支払条件', scope: 'contract', type: 'textarea' },
  { key: 'renewal_terms', label: '更新条件', scope: 'contract', type: 'textarea' },
  { key: 'notes', label: '備考', scope: 'contract', type: 'textarea' },
];

function initialForm(contract: ContractDetail): FormState {
  return Object.fromEntries(fields.map(({ key }) => [key, contract[key as keyof ContractDetail] == null ? '' : String(contract[key as keyof ContractDetail])]));
}

function normalize(field: EditableField, value: string): string | number | null {
  if (value.trim() === '') return null;
  return field.type === 'number' ? Number(value) : value;
}

function display(value: unknown): string {
  if (value == null || value === '') return '—';
  return String(value);
}

export function MainContractEditor({ contract, asOfDate, onCancel, onApplied }: EditorProps) {
  const [form, setForm] = useState<FormState>(() => initialForm(contract));
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const diffs = useMemo(() => fields.flatMap((field) => {
    const before = contract[field.key as keyof ContractDetail] ?? null;
    const after = normalize(field, form[field.key]);
    return String(before ?? '') === String(after ?? '') ? [] : [{ field, before, after }];
  }), [contract, form]);

  const save = async () => {
    if (!supabase || !reason.trim() || diffs.length === 0) return;
    setSaving(true); setError('');
    const contractChanges = Object.fromEntries(diffs.filter(({ field }) => field.scope === 'contract').map(({ field, after }) => [field.key, after]));
    const unitChanges = Object.fromEntries(diffs.filter(({ field }) => field.scope === 'unit').map(({ field, after }) => [field.key, after]));
    const { error: saveError } = await supabase.rpc('apply_rent_roll_contract_edit', {
      p_lease_contract_unit_id: contract.lease_contract_unit_id,
      p_expected_contract_row_version: contract.contract_row_version,
      p_expected_contract_unit_row_version: contract.contract_unit_row_version,
      p_contract_changes: contractChanges,
      p_contract_unit_changes: unitChanges,
      p_reason: reason.trim(),
      p_as_of_date: asOfDate,
    });
    setSaving(false);
    if (saveError) { setError(`契約を更新できませんでした: ${saveError.message}`); return; }
    await onApplied();
  };

  if (confirming) return <section className="contract-editor">
    <div className="contract-detail-section-heading"><div><h3>変更内容を確認</h3><p>保存すると対応依頼と監査ログを作成し、契約へ反映します。</p></div></div>
    <div className="contract-editor-diff"><div className="heading"><span>項目</span><span>変更前</span><span>変更後</span></div>
      {diffs.map(({ field, before, after }) => <div key={field.key}><strong>{field.label}</strong><span>{display(before)}</span><span>{display(after)}</span></div>)}
    </div>
    <label>変更理由<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="契約原本や確認資料、修正理由を入力" /></label>
    {error && <p className="contract-detail-error">{error}</p>}
    <div className="contract-editor-actions"><button type="button" className="secondary-button" onClick={() => setConfirming(false)} disabled={saving}>戻る</button><button type="button" className="primary-button" onClick={() => void save()} disabled={saving || !reason.trim()}>{saving ? '保存中…' : '確認して保存'}</button></div>
  </section>;

  return <section className="contract-editor">
    <div className="contract-detail-section-heading"><div><h3>主契約を編集</h3><p>駐車場代はここでは編集せず、駐車場台帳から独立して管理します。</p></div></div>
    <div className="contract-editor-grid">{fields.map((field) => <label key={field.key}>{field.label}{field.type === 'textarea'
      ? <textarea value={form[field.key]} onChange={(event) => setForm({ ...form, [field.key]: event.target.value })} />
      : <input type={field.type ?? 'text'} min={field.type === 'number' ? '0' : undefined} step={field.key === 'leased_area_sqm' ? '0.01' : field.type === 'number' ? '1' : undefined} value={form[field.key]} onChange={(event) => setForm({ ...form, [field.key]: event.target.value })} />}</label>)}</div>
    <div className="contract-editor-actions"><button type="button" className="secondary-button" onClick={onCancel}>キャンセル</button><button type="button" className="primary-button" disabled={diffs.length === 0} onClick={() => setConfirming(true)}>変更内容を確認</button></div>
  </section>;
}
