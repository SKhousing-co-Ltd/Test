import { useMemo, useState } from 'react';
import type { ContractDetail } from './ContractDetailModal';
import { productCategories, productCategoryLabel, type ProductCategory } from './lib/product-categories';
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
  scope: 'contract' | 'term' | 'unit';
  type?: 'date' | 'number' | 'textarea' | 'select';
  leaseTerm?: 'ordinary' | 'fixed_term';
};

const fields: EditableField[] = [
  { key: 'tenant_id', label: '契約名義', scope: 'contract', type: 'select' },
  { key: 'unit_type', label: '商品', scope: 'unit', type: 'select' },
  { key: 'lease_term_type', label: '契約形態', scope: 'term', type: 'select' },
  { key: 'contract_start_date', label: '契約開始日', scope: 'contract', type: 'date' },
  { key: 'renewal_due_date', label: '次回更新予定日', scope: 'term', type: 'date', leaseTerm: 'ordinary' },
  { key: 'contract_end_date', label: '契約終了日', scope: 'contract', type: 'date', leaseTerm: 'fixed_term' },
  { key: 'actual_end_date', label: '実終了日', scope: 'term', type: 'date' },
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
  const [tenantQuery, setTenantQuery] = useState('');
  const [tenantOptions, setTenantOptions] = useState<Array<{ tenant_id: string; tenant_name: string; external_tenant_code: string | null }>>([]);
  const selectedLeaseTerm = form.lease_term_type as 'ordinary' | 'fixed_term' | '';
  const visibleFields = useMemo(() => fields.filter((field) => !field.leaseTerm || field.leaseTerm === selectedLeaseTerm), [selectedLeaseTerm]);
  const diffs = useMemo(() => fields.flatMap((field) => {
    const before = contract[field.key as keyof ContractDetail] ?? null;
    const after = normalize(field, form[field.key]);
    return String(before ?? '') === String(after ?? '') ? [] : [{ field, before, after }];
  }), [contract, form]);

  const save = async () => {
    if (!supabase || !reason.trim() || diffs.length === 0) return;
    setSaving(true); setError('');
    const contractChanges = Object.fromEntries(diffs.filter(({ field }) => field.scope === 'contract').map(({ field, after }) => [field.key, after]));
    const termChanges = Object.fromEntries(diffs.filter(({ field }) => field.scope === 'term').map(({ field, after }) => [field.key, after]));
    const unitChanges = Object.fromEntries(diffs.filter(({ field }) => field.scope === 'unit' && field.key !== 'unit_type').map(({ field, after }) => [field.key, after]));
    const tenantId = contractChanges.tenant_id as string | null | undefined;
    delete contractChanges.tenant_id;
    const unitType = diffs.find(({ field }) => field.key === 'unit_type')?.after as ProductCategory | null | undefined;
    const { error: saveError } = await supabase.rpc('apply_rent_roll_contract_edit_with_terms_and_identity', {
      p_lease_contract_unit_id: contract.lease_contract_unit_id,
      p_expected_contract_row_version: contract.contract_row_version,
      p_expected_contract_unit_row_version: contract.contract_unit_row_version,
      p_contract_changes: contractChanges,
      p_contract_unit_changes: unitChanges,
      p_term_changes: termChanges,
      p_tenant_id: tenantId ?? null,
      p_unit_type: unitType ?? null,
      p_expected_unit_row_version: contract.unit_row_version,
      p_reason: reason.trim(),
      p_as_of_date: asOfDate,
    });
    setSaving(false);
    if (saveError) { setError(`契約を更新できませんでした: ${saveError.message}`); return; }
    await onApplied();
  };

  const searchTenants = async (query: string) => {
    setTenantQuery(query);
    if (!supabase) return;
    const term = query.trim();
    const request = supabase.from('tenant_master').select('tenant_id, tenant_name, external_tenant_code')
      .order('tenant_name').limit(50);
    const { data, error: tenantError } = term
      ? await request.or(`tenant_name.ilike.%${term.replace(/,/g, ' ')}%,external_tenant_code.ilike.%${term.replace(/,/g, ' ')}%`)
      : await request;
    if (tenantError) { setError(`テナント候補を取得できませんでした: ${tenantError.message}`); return; }
    setTenantOptions((data ?? []) as Array<{ tenant_id: string; tenant_name: string; external_tenant_code: string | null }>);
  };

  const startConfirmation = () => {
    if (!selectedLeaseTerm) { setError('契約形態を選択してください。'); return; }
    if (selectedLeaseTerm === 'fixed_term' && !form.contract_end_date) { setError('定期賃貸借の契約終了日は必須です。'); return; }
    setError('');
    setConfirming(true);
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
    <div className="contract-detail-section-heading"><div><h3>主契約を編集</h3><p>「契約開始日・終了日」は同一契約の全区画に共通する期間です。「区画利用開始日・終了日」は、この画面で選択した区画だけの利用期間です。</p><p>駐車場代はここでは編集せず、駐車場台帳から独立して管理します。</p></div></div>
    <div className="contract-editor-grid">{visibleFields.map((field) => <label key={field.key}>{field.label}{field.key === 'tenant_id'
      ? <><input value={tenantQuery} onChange={(event) => void searchTenants(event.target.value)} placeholder="テナント名・コードで検索" /><select value={form.tenant_id} onChange={(event) => setForm({ ...form, tenant_id: event.target.value })}><option value="">選択してください</option>{form.tenant_id && !tenantOptions.some((tenant) => tenant.tenant_id === form.tenant_id) && <option value={form.tenant_id}>{contract.tenant_name}（{contract.external_tenant_code || 'コード未設定'}）</option>}{tenantOptions.map((tenant) => <option key={tenant.tenant_id} value={tenant.tenant_id}>{tenant.tenant_name}（{tenant.external_tenant_code || 'コード未設定'}）</option>)}</select></>
      : field.key === 'unit_type' ? <select value={form.unit_type} onChange={(event) => setForm({ ...form, unit_type: event.target.value })}>{productCategories.map(({ code, label }) => <option key={code} value={code}>{label}</option>)}</select>
      : field.type === 'textarea'
      ? <textarea value={form[field.key]} onChange={(event) => setForm({ ...form, [field.key]: event.target.value })} />
      : field.type === 'select' ? <select value={form[field.key]} onChange={(event) => {
        const leaseTerm = event.target.value;
        setForm({ ...form, lease_term_type: leaseTerm, ...(leaseTerm === 'ordinary' ? { contract_end_date: '' } : { renewal_due_date: '' }) });
      }}><option value="">選択してください</option><option value="ordinary">普通賃貸借</option><option value="fixed_term">定期賃貸借</option></select>
      : <input type={field.type ?? 'text'} min={field.type === 'number' ? '0' : undefined} step={field.key === 'leased_area_sqm' ? '0.01' : field.type === 'number' ? '1' : undefined} value={form[field.key]} onChange={(event) => setForm({ ...form, [field.key]: event.target.value })} />}</label>)}</div>
    {error && <p className="contract-detail-error">{error}</p>}
    <div className="contract-editor-actions"><button type="button" className="secondary-button" onClick={onCancel}>キャンセル</button><button type="button" className="primary-button" disabled={diffs.length === 0} onClick={startConfirmation}>変更内容を確認</button></div>
  </section>;
}
