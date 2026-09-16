import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';

type Item = { asset_billing_line_item_id: string; line_item_name: string; display_name: string };
type Code = { billing_code_id: string; tenant_id: string | null; issue_code: string; recipient_name: string; tenant: { tenant_name: string } | { tenant_name: string }[] | null };
type ContractUnit = { lease_contract_unit_id: string; unit: { unit_code: string; unit_name: string | null } | { unit_code: string; unit_name: string | null }[] | null; contract: { tenant_id: string; contract_status: string } | { tenant_id: string; contract_status: string }[] | null };
type Assignment = { asset_billing_line_item_id: string; lease_contract_unit_id: string | null; invoice_number: number | null };
type Setting = { billing_invoice_split_setting_id: string; billing_code_id: string; split_mode: 'unit' | 'line_item'; assignments: Assignment[] | null };
const firstOf = <T,>(value: T | T[] | null) => Array.isArray(value) ? value[0] ?? null : value;

export function InvoiceSplitSettings({ propertyId, lineItems, canEdit }: { propertyId: string; lineItems: Item[]; canEdit: boolean }) {
  const [codes, setCodes] = useState<Code[]>([]);
  const [contractUnits, setContractUnits] = useState<ContractUnit[]>([]);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [selectedCodeId, setSelectedCodeId] = useState('');
  const [mode, setMode] = useState<'unit' | 'line_item'>('unit');
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      if (!supabase || !propertyId) { setLoading(false); return; }
      setLoading(true); setNotice('');
      const [codeResult, unitResult, settingResult] = await Promise.all([
        supabase.from('billing_code').select('billing_code_id, tenant_id, issue_code, recipient_name, tenant:tenant_master(tenant_name)').eq('property_id', propertyId).eq('is_active', true).order('issue_code'),
        supabase.from('lease_contract_unit').select('lease_contract_unit_id, unit:unit_master!inner(unit_code, unit_name, property_id), contract:lease_contract!inner(tenant_id, contract_status)').eq('unit.property_id', propertyId).eq('contract.contract_status', 'active'),
        supabase.from('billing_invoice_split_setting').select('billing_invoice_split_setting_id, billing_code_id, split_mode, assignments:billing_invoice_split_assignment(asset_billing_line_item_id, lease_contract_unit_id, invoice_number)').eq('asset_id', propertyId),
      ]);
      if (codeResult.error || unitResult.error) setNotice(`請求書分割の候補を読み込めませんでした: ${codeResult.error?.message ?? unitResult.error?.message}`);
      else if (settingResult.error) setNotice('請求書分割設定のマイグレーションを適用してください。');
      setCodes((codeResult.data ?? []) as unknown as Code[]);
      setContractUnits((unitResult.data ?? []) as unknown as ContractUnit[]);
      setSettings((settingResult.data ?? []) as unknown as Setting[]);
      setLoading(false);
    };
    void load();
  }, [propertyId]);

  const activeTenantIds = useMemo(() => new Set(contractUnits.map((unit) => firstOf(unit.contract)?.tenant_id).filter(Boolean)), [contractUnits]);
  const activeCodes = useMemo(() => codes.filter((code) => code.tenant_id && activeTenantIds.has(code.tenant_id)), [activeTenantIds, codes]);
  const selectedCode = activeCodes.find((code) => code.billing_code_id === selectedCodeId);
  const selectedSetting = settings.find((setting) => setting.billing_code_id === selectedCodeId);
  const tenantUnits = contractUnits.filter((unit) => firstOf(unit.contract)?.tenant_id === selectedCode?.tenant_id);
  const tenantName = (code: Code) => firstOf(code.tenant)?.tenant_name ?? code.recipient_name;
  const unitLabel = (unit: ContractUnit) => { const value = firstOf(unit.unit); return value ? value.unit_name || value.unit_code : '区画名なし'; };
  const chooseCode = (codeId: string) => {
    const setting = settings.find((row) => row.billing_code_id === codeId); setSelectedCodeId(codeId); setMode(setting?.split_mode ?? 'unit');
    setAssignments(Object.fromEntries((setting?.assignments ?? []).map((row) => [row.asset_billing_line_item_id, setting?.split_mode === 'unit' ? row.lease_contract_unit_id ?? '' : String(row.invoice_number ?? '')])));
  };
  const changeMode = (nextMode: 'unit' | 'line_item') => { setMode(nextMode); setAssignments({}); };
  const complete = Boolean(selectedCodeId) && lineItems.length > 0 && lineItems.every((item) => assignments[item.asset_billing_line_item_id]);

  const save = async () => {
    if (!supabase || !selectedCode || !complete) return;
    setNotice('');
    if (selectedSetting) {
      const { error } = await supabase.from('billing_invoice_split_setting').delete().eq('billing_invoice_split_setting_id', selectedSetting.billing_invoice_split_setting_id);
      if (error) { setNotice(`請求書分割設定を更新できませんでした: ${error.message}`); return; }
    }
    const { data, error } = await supabase.from('billing_invoice_split_setting').insert({ asset_id: propertyId, billing_code_id: selectedCodeId, split_mode: mode }).select('billing_invoice_split_setting_id, billing_code_id, split_mode').single();
    if (error || !data) { setNotice(`請求書分割設定を保存できませんでした: ${error?.message ?? ''}`); return; }
    const rows = lineItems.map((item) => ({ billing_invoice_split_setting_id: data.billing_invoice_split_setting_id, asset_billing_line_item_id: item.asset_billing_line_item_id, lease_contract_unit_id: mode === 'unit' ? assignments[item.asset_billing_line_item_id] : null, invoice_number: mode === 'line_item' ? Number(assignments[item.asset_billing_line_item_id]) : null }));
    const assignmentResult = await supabase.from('billing_invoice_split_assignment').insert(rows);
    if (assignmentResult.error) { setNotice(`明細項目の分割先を保存できませんでした: ${assignmentResult.error.message}`); return; }
    const next: Setting = { ...data, assignments: rows.map((row) => ({ asset_billing_line_item_id: row.asset_billing_line_item_id, lease_contract_unit_id: row.lease_contract_unit_id, invoice_number: row.invoice_number })) } as Setting;
    setSettings((current) => [...current.filter((row) => row.billing_code_id !== selectedCodeId), next]); setNotice('請求書分割設定を保存しました。');
  };
  const remove = async (setting: Setting) => {
    if (!supabase) return;
    const { error } = await supabase.from('billing_invoice_split_setting').delete().eq('billing_invoice_split_setting_id', setting.billing_invoice_split_setting_id);
    if (error) { setNotice(`請求書分割設定を削除できませんでした: ${error.message}`); return; }
    setSettings((current) => current.filter((row) => row.billing_invoice_split_setting_id !== setting.billing_invoice_split_setting_id));
    if (selectedCodeId === setting.billing_code_id) { setMode('unit'); setAssignments({}); }
    setNotice('請求書分割設定を削除しました。');
  };

  return <section className="property-billing-items">
    <div className="property-billing-items-heading"><h4>請求書分割設定</h4><p>入居中のテナントコードごとに、区画または明細項目で請求書を分割します。</p></div>
    {notice && <p className="property-billing-settings-notice">{notice}</p>}
    <div className="property-billing-settings-table-wrap invoice-split-code-list"><table><thead><tr><th>テナント名</th><th>テナントコード</th><th>分割設定</th><th /></tr></thead><tbody>{activeCodes.map((code) => { const setting = settings.find((row) => row.billing_code_id === code.billing_code_id); return <tr key={code.billing_code_id}><td><strong>{tenantName(code)}</strong></td><td>{code.issue_code}</td><td>{setting ? setting.split_mode === 'unit' ? '区画で分ける' : '明細項目で分ける' : '未設定'}</td><td><button type="button" className="text-button" onClick={() => chooseCode(code.billing_code_id)}>{setting ? '編集' : '設定'}</button>{setting && <button type="button" className="tenant-billing-delete" disabled={!canEdit} onClick={() => void remove(setting)}>削除</button>}</td></tr>; })}{!loading && !activeCodes.length && <tr><td colSpan={4}>入居中のテナントコードはありません。</td></tr>}</tbody></table></div>
    <div className="allocation-layout invoice-split-layout"><div><h5>1. テナントコードを選択</h5><select value={selectedCodeId} onChange={(event) => chooseCode(event.target.value)}><option value="">選択してください</option>{activeCodes.map((code) => <option key={code.billing_code_id} value={code.billing_code_id}>{tenantName(code)}（{code.issue_code}）</option>)}</select></div><div><h5>2. 請求書の分け方</h5><label><input type="radio" checked={mode === 'unit'} onChange={() => changeMode('unit')} /> 区画で分ける</label><label><input type="radio" checked={mode === 'line_item'} onChange={() => changeMode('line_item')} /> 明細項目で分ける</label><h5>3. 明細項目の分割先</h5>{!selectedCode ? <p>テナントコードを選択してください。</p> : <div className="allocation-targets">{lineItems.map((item) => <label key={item.asset_billing_line_item_id}><span>{item.display_name || item.line_item_name}</span><select value={assignments[item.asset_billing_line_item_id] ?? ''} onChange={(event) => setAssignments({ ...assignments, [item.asset_billing_line_item_id]: event.target.value })}><option value="">選択してください</option>{mode === 'unit' ? tenantUnits.map((unit) => <option key={unit.lease_contract_unit_id} value={unit.lease_contract_unit_id}>{unitLabel(unit)}</option>) : [1, 2, 3].map((number) => <option key={number} value={number}>請求書 {number}</option>)}</select></label>)}{mode === 'unit' && !tenantUnits.length && <p>契約中の区画がありません。</p>}{!lineItems.length && <p>請求対象の明細項目が未登録です。</p>}</div>}<button className="primary-button" disabled={!canEdit || !complete} onClick={() => void save()}>{selectedSetting ? '設定を更新' : '設定を保存'}</button></div></div>
  </section>;
}
