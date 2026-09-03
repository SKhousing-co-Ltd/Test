import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from './lib/supabase';

type TenantRow = {
  tenant_id: string;
  tenant_name: string;
  normalized_tenant_name: string;
  external_tenant_code: string | null;
};

type BillingCodeRow = {
  tenant_billing_code_id: string;
  tenant_id: string;
  billing_code: string;
  is_primary: boolean;
  is_active: boolean;
  sort_order: number;
};

type AssignmentRow = {
  tenant_id: string;
  account_id: string;
  tenant_billing_code_id: string;
};

type IncomeAccount = { account_id: string; account_name: string };
type DraftCode = BillingCodeRow & { local_id: string };

function createDraftCode(tenantId: string, billingCode = '', isPrimary = false, sortOrder = 0): DraftCode {
  const localId = `new-${crypto.randomUUID()}`;
  return {
    local_id: localId,
    tenant_billing_code_id: localId,
    tenant_id: tenantId,
    billing_code: billingCode,
    is_primary: isPrimary,
    is_active: true,
    sort_order: sortOrder,
  };
}

function configurationComplete(tenantId: string, codes: BillingCodeRow[], assignments: AssignmentRow[], accounts: IncomeAccount[]) {
  const tenantCodes = codes.filter((code) => code.tenant_id === tenantId);
  const activeIds = new Set(tenantCodes.filter((code) => code.is_active).map((code) => code.tenant_billing_code_id));
  const tenantAssignments = assignments.filter((assignment) => assignment.tenant_id === tenantId);
  return tenantCodes.filter((code) => code.is_primary && code.is_active).length === 1
    && accounts.every((account) => tenantAssignments.some((assignment) => assignment.account_id === account.account_id && activeIds.has(assignment.tenant_billing_code_id)));
}

export function TenantBillingCodesPage({ canManage }: { canManage: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [codes, setCodes] = useState<BillingCodeRow[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [accounts, setAccounts] = useState<IncomeAccount[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState(searchParams.get('tenant') ?? '');
  const [query, setQuery] = useState('');
  const [draftCodes, setDraftCodes] = useState<DraftCode[]>([]);
  const [draftAssignments, setDraftAssignments] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError('');
    const [tenantResult, codeResult, assignmentResult, accountResult] = await Promise.all([
      supabase.from('tenant_master').select('tenant_id, tenant_name, normalized_tenant_name, external_tenant_code').order('tenant_name'),
      supabase.from('tenant_billing_code').select('tenant_billing_code_id, tenant_id, billing_code, is_primary, is_active, sort_order').order('sort_order').order('billing_code'),
      supabase.from('tenant_billing_code_account').select('tenant_id, account_id, tenant_billing_code_id'),
      supabase.from('income_expense_account_master').select('account_id, account_name').eq('income_expense_type', '収入').order('account_id'),
    ]);
    const loadError = tenantResult.error ?? codeResult.error ?? assignmentResult.error ?? accountResult.error;
    if (loadError) {
      setError(`請求コード設定を読み込めませんでした: ${loadError.message}`);
      setLoading(false);
      return;
    }
    const nextTenants = (tenantResult.data ?? []) as TenantRow[];
    setTenants(nextTenants);
    setCodes((codeResult.data ?? []) as BillingCodeRow[]);
    setAssignments((assignmentResult.data ?? []) as AssignmentRow[]);
    setAccounts((accountResult.data ?? []) as IncomeAccount[]);
    setSelectedTenantId((current) => current && nextTenants.some((tenant) => tenant.tenant_id === current) ? current : nextTenants[0]?.tenant_id ?? '');
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selectedTenantId) return;
    const tenantCodes = codes
      .filter((code) => code.tenant_id === selectedTenantId)
      .sort((left, right) => left.sort_order - right.sort_order || left.billing_code.localeCompare(right.billing_code, 'ja-JP'))
      .map((code) => ({ ...code, local_id: code.tenant_billing_code_id }));
    const tenant = tenants.find((item) => item.tenant_id === selectedTenantId);
    const nextCodes = tenantCodes.length
      ? tenantCodes
      : [createDraftCode(selectedTenantId, tenant?.external_tenant_code ?? '', true, 0)];
    const nextAssignments: Record<string, string> = {};
    for (const assignment of assignments.filter((item) => item.tenant_id === selectedTenantId)) {
      nextAssignments[assignment.account_id] = assignment.tenant_billing_code_id;
    }
    setDraftCodes(nextCodes);
    setDraftAssignments(nextAssignments);
  }, [assignments, codes, selectedTenantId, tenants]);

  useEffect(() => {
    if (!selectedTenantId || searchParams.get('tenant') === selectedTenantId) return;
    setSearchParams({ tenant: selectedTenantId }, { replace: true });
  }, [searchParams, selectedTenantId, setSearchParams]);

  const filteredTenants = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ja-JP');
    if (!normalized) return tenants;
    return tenants.filter((tenant) => {
      const tenantCodes = codes.filter((code) => code.tenant_id === tenant.tenant_id).map((code) => code.billing_code).join(' ');
      return `${tenant.tenant_name} ${tenantCodes}`.toLocaleLowerCase('ja-JP').includes(normalized);
    });
  }, [codes, query, tenants]);

  const selectedTenant = tenants.find((tenant) => tenant.tenant_id === selectedTenantId) ?? null;
  const completeTenantIds = useMemo(() => new Set(tenants
    .filter((tenant) => configurationComplete(tenant.tenant_id, codes, assignments, accounts))
    .map((tenant) => tenant.tenant_id)), [accounts, assignments, codes, tenants]);

  const updateCode = (localId: string, patch: Partial<DraftCode>) => {
    setDraftCodes((current) => current.map((code) => code.local_id === localId ? { ...code, ...patch } : code));
  };

  const setPrimary = (localId: string) => {
    setDraftCodes((current) => current.map((code) => ({ ...code, is_primary: code.local_id === localId, is_active: code.local_id === localId ? true : code.is_active })));
  };

  const setActive = (localId: string, isActive: boolean) => {
    setDraftCodes((current) => current.map((code) => code.local_id === localId ? { ...code, is_active: isActive, is_primary: isActive ? code.is_primary : false } : code));
    if (!isActive) {
      setDraftAssignments((current) => Object.fromEntries(Object.entries(current).filter(([, codeId]) => codeId !== localId)));
    }
  };

  const removeCode = (localId: string) => {
    setDraftCodes((current) => current.filter((code) => code.local_id !== localId));
    setDraftAssignments((current) => Object.fromEntries(Object.entries(current).filter(([, codeId]) => codeId !== localId)));
  };

  const save = async () => {
    if (!supabase || !selectedTenant) return;
    setError('');
    setMessage('');
    const trimmedCodes = draftCodes.map((code) => ({ ...code, billing_code: code.billing_code.trim() }));
    if (!trimmedCodes.length || trimmedCodes.some((code) => !code.billing_code)) {
      setError('請求コードを1件以上入力してください。'); return;
    }
    if (new Set(trimmedCodes.map((code) => code.billing_code)).size !== trimmedCodes.length) {
      setError('同じ請求コードが重複しています。'); return;
    }
    if (trimmedCodes.filter((code) => code.is_primary && code.is_active).length !== 1) {
      setError('有効な主コードを1件選択してください。'); return;
    }
    if (accounts.some((account) => !draftAssignments[account.account_id])) {
      setError('すべての収入科目に請求コードを割り当ててください。'); return;
    }
    setSaving(true);
    const payload = trimmedCodes.map((code, index) => ({
      billing_code: code.billing_code,
      is_primary: code.is_primary,
      is_active: code.is_active,
      sort_order: index,
      account_ids: accounts.filter((account) => draftAssignments[account.account_id] === code.local_id).map((account) => account.account_id),
    }));
    const { error: saveError } = await supabase.rpc('replace_tenant_billing_code_config', {
      p_tenant_id: selectedTenant.tenant_id,
      p_codes: payload,
    });
    setSaving(false);
    if (saveError) {
      setError(`保存できませんでした: ${saveError.message}`); return;
    }
    setMessage('請求コード設定を保存しました。条件を満たす複数コード対応依頼は確定済みに更新されています。');
    await load();
  };

  return <section className="tenant-code-page">
    <div className="page-heading"><div><p className="section-kicker">TENANT BILLING MASTER</p><h2>請求コード管理</h2><p>請求項目ごとに使用する主コード・サブコードを設定します。</p></div></div>
    {message ? <p className="tenant-code-message">{message}</p> : null}
    {error ? <p className="tenant-code-message error">{error}</p> : null}
    <div className="tenant-code-layout">
      <aside className="tenant-code-list">
        <header><h3>テナント</h3><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称・コードで検索" /></header>
        <div>{loading ? <p className="tenant-code-empty">読み込み中…</p> : filteredTenants.map((tenant) => <button type="button" key={tenant.tenant_id} className={tenant.tenant_id === selectedTenantId ? 'selected' : ''} onClick={() => setSelectedTenantId(tenant.tenant_id)}><span className={completeTenantIds.has(tenant.tenant_id) ? 'complete' : 'incomplete'}>{completeTenantIds.has(tenant.tenant_id) ? '設定済み' : '要設定'}</span><strong>{tenant.tenant_name}</strong><small>{codes.filter((code) => code.tenant_id === tenant.tenant_id).map((code) => code.billing_code).join('・') || 'コード未設定'}</small></button>)}</div>
      </aside>
      <main className="tenant-code-detail">
        {selectedTenant ? <>
          <header><div><p className="section-kicker">BILLING CODE CONFIG</p><h3>{selectedTenant.tenant_name}</h3><p>各収入科目を必ず1つの有効コードへ割り当ててください。</p></div>{canManage ? <button type="button" className="secondary-button" onClick={() => setDraftCodes((current) => [...current, createDraftCode(selectedTenant.tenant_id, '', false, current.length)])}>コードを追加</button> : null}</header>
          <section className="tenant-code-section"><h4>主コード・サブコード</h4><div className="tenant-code-table"><div className="tenant-code-table-head"><span>主</span><span>コード</span><span>状態</span><span /></div>{draftCodes.map((code) => <div key={code.local_id}><label className="tenant-primary-radio"><input type="radio" name="primary-code" checked={code.is_primary} disabled={!canManage || !code.is_active} onChange={() => setPrimary(code.local_id)} /><span className="sr-only">主コードに設定</span></label><input value={code.billing_code} disabled={!canManage} maxLength={100} onChange={(event) => updateCode(code.local_id, { billing_code: event.target.value })} placeholder="例: 2901-02" /><label className="tenant-active-check"><input type="checkbox" checked={code.is_active} disabled={!canManage || code.is_primary} onChange={(event) => setActive(code.local_id, event.target.checked)} />有効</label>{canManage && draftCodes.length > 1 && !code.is_primary ? <button type="button" className="link-button" onClick={() => removeCode(code.local_id)}>削除</button> : <span />}</div>)}</div></section>
          <section className="tenant-code-section"><h4>請求項目の割当</h4><p>未割当の科目は請求コード解決時にエラーになります。</p><div className="tenant-account-grid">{accounts.map((account) => <label key={account.account_id}><span><strong>{account.account_id}</strong>{account.account_name}</span><select value={draftAssignments[account.account_id] ?? ''} disabled={!canManage} onChange={(event) => setDraftAssignments((current) => ({ ...current, [account.account_id]: event.target.value }))}><option value="">未割当</option>{draftCodes.filter((code) => code.is_active && code.billing_code.trim()).map((code) => <option key={code.local_id} value={code.local_id}>{code.billing_code}{code.is_primary ? '（主）' : ''}</option>)}</select></label>)}</div></section>
          {canManage ? <footer><button type="button" className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '設定を保存'}</button></footer> : <footer><p>参照権限で表示しています。変更はシステム管理者または業務管理者へ依頼してください。</p></footer>}
        </> : <p className="tenant-code-empty">テナントを選択してください。</p>}
      </main>
    </div>
  </section>;
}
