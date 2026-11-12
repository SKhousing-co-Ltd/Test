import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import { Dialog } from './components/Dialog';
import { floorOrder, loadSavedTenantOrder, orderTenants, tenantComparator } from './utils/tenantOrder';
import { buildLineSplitAssignmentRows, type InvoiceSplitMode } from './utils/invoiceSplitAssignments';

type Item = { asset_billing_line_item_id: string; line_item_name: string; display_name: string };
type Code = { billing_code_id: string; tenant_id: string | null; issue_code: string; recipient_name: string; tenant: { tenant_name: string } | { tenant_name: string }[] | null };
type ContractUnit = { lease_contract_unit_id: string; unit: { unit_code: string; unit_name: string | null; floor_label: string | null; unit_type: string | null } | { unit_code: string; unit_name: string | null; floor_label: string | null; unit_type: string | null }[] | null; contract: { tenant_id: string; contract_status: string } | { tenant_id: string; contract_status: string }[] | null };
type BillingUnit = { lease_contract_billing_unit_id: string; billing_unit_name: string; contract: { tenant_id: string; contract_status: string } | { tenant_id: string; contract_status: string }[] | null; members: Array<{ lease_contract_unit_id: string }> };
type UnitTarget = { key: string; label: string; order: number; unitIds: string[] };
type Assignment = { asset_billing_line_item_id: string; lease_contract_unit_id: string | null; lease_contract_billing_unit_id: string | null; invoice_number: number | null };
type UnitAssignment = { lease_contract_unit_id: string | null; lease_contract_billing_unit_id: string | null; invoice_number: number };
type SplitMode = InvoiceSplitMode;
type Setting = { billing_invoice_split_setting_id: string; billing_code_id: string; split_mode: SplitMode; split_count: number; assignments: Assignment[] | null; unitAssignments: UnitAssignment[] | null };
const firstOf = <T,>(value: T | T[] | null) => Array.isArray(value) ? value[0] ?? null : value;
const unitCollator = new Intl.Collator('ja-JP', { numeric: true, sensitivity: 'base' });
const compareContractUnits = (left: ContractUnit, right: ContractUnit) => {
  const leftUnit = firstOf(left.unit); const rightUnit = firstOf(right.unit);
  const leftFloor = leftUnit?.floor_label ?? ''; const rightFloor = rightUnit?.floor_label ?? '';
  return floorOrder(leftFloor) - floorOrder(rightFloor)
    || unitCollator.compare(leftFloor, rightFloor)
    || unitCollator.compare(leftUnit?.unit_name ?? '', rightUnit?.unit_name ?? '')
    || unitCollator.compare(leftUnit?.unit_code ?? '', rightUnit?.unit_code ?? '');
};

export function InvoiceSplitSettings({ propertyId, lineItems, canEdit }: { propertyId: string; lineItems: Item[]; canEdit: boolean }) {
  const [codes, setCodes] = useState<Code[]>([]);
  const [contractUnits, setContractUnits] = useState<ContractUnit[]>([]);
  const [billingUnits, setBillingUnits] = useState<BillingUnit[]>([]);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [selectedCodeId, setSelectedCodeId] = useState('');
  const [mode, setMode] = useState<SplitMode>('unit');
  const [splitCount, setSplitCount] = useState(2);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    const load = async () => {
      if (!supabase || !propertyId) { setLoading(false); return; }
      setLoading(true); setNotice('');
      const [codeResult, unitResult, billingUnitResult, settingResult, savedOrder] = await Promise.all([
        supabase.from('billing_code').select('billing_code_id, tenant_id, issue_code, recipient_name, tenant:tenant_master(tenant_name)').eq('property_id', propertyId).eq('is_active', true).order('issue_code'),
        supabase.from('lease_contract_unit').select('lease_contract_unit_id, unit:unit_master!inner(unit_code, unit_name, floor_label, unit_type, property_id), contract:lease_contract!inner(tenant_id, contract_status)').eq('unit.property_id', propertyId).eq('contract.contract_status', 'active'),
        supabase.from('lease_contract_billing_unit').select('lease_contract_billing_unit_id, billing_unit_name, contract:lease_contract!inner(tenant_id, contract_status), members:lease_contract_billing_unit_member(lease_contract_unit_id, contractUnit:lease_contract_unit!inner(unit:unit_master!inner(property_id)))').eq('members.contractUnit.unit.property_id', propertyId).eq('contract.contract_status', 'active').order('sort_order'),
        supabase.from('billing_invoice_split_setting').select('billing_invoice_split_setting_id, billing_code_id, split_mode, split_count, assignments:billing_invoice_split_assignment(asset_billing_line_item_id, lease_contract_unit_id, lease_contract_billing_unit_id, invoice_number), unitAssignments:billing_invoice_split_unit_assignment(lease_contract_unit_id, lease_contract_billing_unit_id, invoice_number)').eq('asset_id', propertyId),
        loadSavedTenantOrder(supabase, propertyId),
      ]);
      if (codeResult.error || unitResult.error || billingUnitResult.error) setNotice(`請求書分割の候補を読み込めませんでした: ${codeResult.error?.message ?? unitResult.error?.message ?? billingUnitResult.error?.message}`);
      else if (settingResult.error) setNotice('請求書分割設定のマイグレーションを適用してください。');
      const loadedUnits = (unitResult.data ?? []) as unknown as ContractUnit[];
      const order = orderTenants(loadedUnits.map((row) => {
        const unit = firstOf(row.unit); return { tenant_id: firstOf(row.contract)?.tenant_id ?? null, unit_id: row.lease_contract_unit_id, floor_label: unit?.floor_label, unit_name: unit?.unit_name, unit_code: unit?.unit_code };
      }), savedOrder);
      const compareTenant = tenantComparator(order);
      setCodes([...(codeResult.data ?? []) as unknown as Code[]].sort((left, right) => compareTenant(left.tenant_id, right.tenant_id) || left.issue_code.localeCompare(right.issue_code, 'ja')));
      setContractUnits(loadedUnits);
      setBillingUnits((billingUnitResult.data ?? []) as unknown as BillingUnit[]);
      setSettings((settingResult.data ?? []) as unknown as Setting[]);
      setLoading(false);
    };
    void load();
  }, [propertyId]);

  const activeTenantIds = useMemo(() => new Set(contractUnits.map((unit) => firstOf(unit.contract)?.tenant_id).filter(Boolean)), [contractUnits]);
  const activeCodes = useMemo(() => codes.filter((code) => code.tenant_id && activeTenantIds.has(code.tenant_id)), [activeTenantIds, codes]);
  // 設定済みのテナントを先に出し、どの設定が有効かを一覧だけで把握できるようにします。
  const displayCodes = useMemo(() => [...activeCodes].sort((left, right) => {
    const leftConfigured = settings.some((setting) => setting.billing_code_id === left.billing_code_id);
    const rightConfigured = settings.some((setting) => setting.billing_code_id === right.billing_code_id);
    return Number(rightConfigured) - Number(leftConfigured);
  }), [activeCodes, settings]);
  const selectedCode = activeCodes.find((code) => code.billing_code_id === selectedCodeId);
  const selectedSetting = settings.find((setting) => setting.billing_code_id === selectedCodeId);
  const tenantUnits = contractUnits.filter((unit) => firstOf(unit.contract)?.tenant_id === selectedCode?.tenant_id).sort(compareContractUnits);
  const tenantBillingUnits = billingUnits.filter((unit) => firstOf(unit.contract)?.tenant_id === selectedCode?.tenant_id);
  const tenantName = (code: Code) => firstOf(code.tenant)?.tenant_name ?? code.recipient_name;
  const unitLabel = (unit: ContractUnit) => { const value = firstOf(unit.unit); return value ? [value.floor_label, value.unit_name || value.unit_code].filter(Boolean).join(' ') : '区画名なし'; };
  const groupedContractUnitIds = new Set(tenantBillingUnits.flatMap((unit) => (unit.members ?? []).map((member) => member.lease_contract_unit_id)));
  const parkingUnitIds = tenantUnits.filter((unit) => firstOf(unit.unit)?.unit_type === 'parking').map((unit) => unit.lease_contract_unit_id);
  const parkingUnitIdSet = new Set(parkingUnitIds);
  const unitTargets: UnitTarget[] = [
    ...tenantUnits.map((unit, index) => ({ unit, index })).filter(({ unit }) => !parkingUnitIdSet.has(unit.lease_contract_unit_id) && !groupedContractUnitIds.has(unit.lease_contract_unit_id)).map(({ unit, index }) => ({ key: `unit:${unit.lease_contract_unit_id}`, label: unitLabel(unit), order: index, unitIds: [unit.lease_contract_unit_id] })),
    ...tenantBillingUnits.flatMap((unit, index) => { const members = unit.members ?? []; if (members.length && members.every((member) => parkingUnitIdSet.has(member.lease_contract_unit_id))) return []; const firstMember = tenantUnits.find((row) => members.some((member) => member.lease_contract_unit_id === row.lease_contract_unit_id)); const floor = firstOf(firstMember?.unit ?? null)?.floor_label; return [{ key: `billing:${unit.lease_contract_billing_unit_id}`, label: [floor, unit.billing_unit_name].filter(Boolean).join(' '), order: Math.min(...members.map((member) => tenantUnits.findIndex((row) => row.lease_contract_unit_id === member.lease_contract_unit_id)).filter((position) => position >= 0), tenantUnits.length) + index / 100, unitIds: members.map((member) => member.lease_contract_unit_id) }]; }),
    ...(parkingUnitIds.length ? [{ key: 'parking', label: '駐車場（全台）', order: tenantUnits.length + 1, unitIds: parkingUnitIds }] : []),
  ].sort((left, right) => left.order - right.order);
  const chooseCode = (codeId: string) => {
    const setting = settings.find((row) => row.billing_code_id === codeId); setSelectedCodeId(codeId); setMode(setting?.split_mode ?? 'unit'); setSplitCount(setting?.split_count ?? 2);
    const selectedTenantId = activeCodes.find((code) => code.billing_code_id === codeId)?.tenant_id;
    const selectedParkingIds = new Set(contractUnits.filter((unit) => firstOf(unit.contract)?.tenant_id === selectedTenantId && firstOf(unit.unit)?.unit_type === 'parking').map((unit) => unit.lease_contract_unit_id));
    const savedUnitValues = (setting?.unitAssignments ?? [])
      .filter((row) => !row.lease_contract_unit_id || !selectedParkingIds.has(row.lease_contract_unit_id))
      .map((row) => [row.lease_contract_billing_unit_id ? `billing:${row.lease_contract_billing_unit_id}` : `unit:${row.lease_contract_unit_id}`, String(row.invoice_number)]);
    const savedParkingValue = (setting?.unitAssignments ?? [])
      .filter((row) => row.lease_contract_unit_id && selectedParkingIds.has(row.lease_contract_unit_id))
      .slice(0, 1).map((row) => ['parking', String(row.invoice_number)]);
    const unitValues = [...savedUnitValues, ...savedParkingValue];
    const lineValues = (setting?.assignments ?? []).map((row) => [row.asset_billing_line_item_id, String(row.invoice_number ?? 1)]);
    setAssignments(Object.fromEntries(setting?.split_mode === 'unit' ? unitValues : setting?.split_mode === 'line_item' ? lineValues : [...lineValues, ...unitValues]));
    setNotice(''); setEditorOpen(true);
  };
  const closeEditor = () => { setEditorOpen(false); setSelectedCodeId(''); setAssignments({}); };
  const changeMode = (nextMode: SplitMode) => { setMode(nextMode); setAssignments({}); };
  const save = async () => {
    if (!supabase || !selectedCode) return;
    setNotice('');
    if (selectedSetting) {
      const { error } = await supabase.from('billing_invoice_split_setting').delete().eq('billing_invoice_split_setting_id', selectedSetting.billing_invoice_split_setting_id);
      if (error) { setNotice(`請求書分割設定を更新できませんでした: ${error.message}`); return; }
    }
    const { data, error } = await supabase.from('billing_invoice_split_setting').insert({ asset_id: propertyId, billing_code_id: selectedCodeId, split_mode: mode, split_count: splitCount }).select('billing_invoice_split_setting_id, billing_code_id, split_mode, split_count').single();
    if (error || !data) { setNotice(`請求書分割設定を保存できませんでした: ${error?.message ?? ''}`); return; }
    const lineRows = buildLineSplitAssignmentRows(data.billing_invoice_split_setting_id, mode, lineItems, assignments);
    const lineInvoiceNumbers = new Set(lineRows.map((row) => row.invoice_number));
    const firstUnitInvoiceNumber = Array.from({ length: splitCount }, (_, index) => index + 1).find((number) => !lineInvoiceNumbers.has(number)) ?? 1;
    const unitRows = mode !== 'line_item' ? unitTargets.flatMap((target) => {
      const invoiceNumber = Number(assignments[target.key] ?? firstUnitInvoiceNumber);
      if (invoiceNumber <= 1) return [];
      if (target.key === 'parking') return target.unitIds.map((unitId) => ({ billing_invoice_split_setting_id: data.billing_invoice_split_setting_id, lease_contract_unit_id: unitId, lease_contract_billing_unit_id: null, invoice_number: invoiceNumber }));
      return [{ billing_invoice_split_setting_id: data.billing_invoice_split_setting_id, lease_contract_unit_id: target.key.startsWith('unit:') ? target.key.slice(5) : null, lease_contract_billing_unit_id: target.key.startsWith('billing:') ? target.key.slice(8) : null, invoice_number: invoiceNumber }];
    }) : [];
    if (lineRows.length) { const result = await supabase.from('billing_invoice_split_assignment').insert(lineRows); if (result.error) { setNotice(`明細項目の分割先を保存できませんでした: ${result.error.message}`); return; } }
    if (unitRows.length) { const result = await supabase.from('billing_invoice_split_unit_assignment').insert(unitRows); if (result.error) { setNotice(`区画の分割先を保存できませんでした: ${result.error.message}`); return; } }
    const next: Setting = { ...data, assignments: lineRows, unitAssignments: unitRows } as Setting;
    setSettings((current) => [...current.filter((row) => row.billing_code_id !== selectedCodeId), next]); setNotice('請求書分割設定を保存しました。'); setEditorOpen(false);
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
    <div className="property-billing-items-heading"><h4>請求書分割設定</h4><p>入居中のテナントを一覧表示します。行を選ぶと、区画または明細項目での請求書の分け方を編集できます。</p></div>
    {notice && <p className="property-billing-settings-notice">{notice}</p>}
    <div className="property-billing-settings-table-wrap invoice-split-code-list">
      <table>
        <thead><tr><th>テナント名</th><th>テナントコード</th><th>分割設定</th><th /></tr></thead>
        <tbody>
          {loading ? <tr><td colSpan={4}>読み込み中…</td></tr> : displayCodes.map((code) => {
            const setting = settings.find((row) => row.billing_code_id === code.billing_code_id);
            return <tr key={code.billing_code_id} className="billing-settings-row" tabIndex={0} role="button" aria-label={`${tenantName(code)}の請求書分割設定を編集`} onClick={() => chooseCode(code.billing_code_id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseCode(code.billing_code_id); } }}>
              <td><strong>{tenantName(code)}</strong></td>
              <td>{code.issue_code}</td>
              <td>{setting ? `${setting.split_count}枚・${setting.split_mode === 'unit' ? '区画で分ける' : setting.split_mode === 'line_item' ? '明細項目で分ける' : '明細項目＋区画で分ける'}` : '未設定'}</td>
              <td>{setting && <button type="button" className="tenant-billing-delete" disabled={!canEdit} onClick={(event) => { event.stopPropagation(); void remove(setting); }}>削除</button>}</td>
            </tr>;
          })}
          {!loading && !displayCodes.length && <tr><td colSpan={4}>入居中のテナントはありません。</td></tr>}
        </tbody>
      </table>
    </div>
    {editorOpen && selectedCode && <Dialog title={`${tenantName(selectedCode)}の請求書分割設定`} onClose={closeEditor} className="billing-settings-dialog">
      <div className="billing-settings-dialog-body">
        <p className="billing-settings-dialog-codes"><span><strong>{selectedCode.issue_code}</strong>{selectedCode.recipient_name}</span></p>
        <h5>1. 請求書の分割数</h5>
        <label>分割数 <select value={splitCount} onChange={(event) => { const count = Number(event.target.value); setSplitCount(count); setAssignments((current) => Object.fromEntries(Object.entries(current).filter(([, value]) => Number(value) <= count))); }}>{Array.from({ length: 8 }, (_, index) => index + 2).map((number) => <option key={number} value={number}>{number}枚</option>)}</select></label>
        <h5>2. 請求書の分け方</h5>
        <label><input type="radio" checked={mode === 'unit'} onChange={() => changeMode('unit')} /> 区画で分ける</label>
        <label><input type="radio" checked={mode === 'line_item'} onChange={() => changeMode('line_item')} /> 明細項目で分ける</label>
        <label><input type="radio" checked={mode === 'line_item_unit'} onChange={() => changeMode('line_item_unit')} /> 明細項目で分け、区画でも分ける</label>
        <h5>3. {mode === 'unit' ? '区画ごとの請求書' : mode === 'line_item' ? '明細項目の請求書' : '明細項目で独立させる請求書'}</h5>
        <div className="allocation-targets">
          {mode === 'unit' ? unitTargets.map((target) => <label key={target.key}><span>{target.label}</span><select value={assignments[target.key] ?? '1'} onChange={(event) => setAssignments({ ...assignments, [target.key]: event.target.value })}>{Array.from({ length: splitCount }, (_, index) => index + 1).map((number) => <option key={number} value={number}>請求書 {number}</option>)}</select></label>) : lineItems.map((item) => <label key={item.asset_billing_line_item_id}><span>{item.line_item_name}</span><select value={assignments[item.asset_billing_line_item_id] ?? (mode === 'line_item_unit' ? '' : '1')} onChange={(event) => setAssignments({ ...assignments, [item.asset_billing_line_item_id]: event.target.value })}>{mode === 'line_item_unit' && <option value="">区画に従う</option>}{Array.from({ length: splitCount }, (_, index) => index + 1).map((number) => <option key={number} value={number}>請求書 {number}</option>)}</select></label>)}
          {mode === 'unit' && !unitTargets.length && <p>契約中の区画がありません。</p>}
          {!lineItems.length && <p>請求対象の明細項目が未登録です。</p>}
        </div>
        {mode === 'line_item_unit' && <><h5>4. 区画ごとの請求書</h5><div className="allocation-targets">{unitTargets.map((target) => { const used = new Set(lineItems.map((item) => Number(assignments[item.asset_billing_line_item_id])).filter(Boolean)); const options = Array.from({ length: splitCount }, (_, index) => index + 1).filter((number) => !used.has(number)); return <label key={target.key}><span>{target.label}</span><select value={assignments[target.key] ?? String(options[0] ?? '')} onChange={(event) => setAssignments({ ...assignments, [target.key]: event.target.value })}>{options.map((number) => <option key={number} value={number}>請求書 {number}</option>)}</select></label>; })}{!unitTargets.length && <p>契約中の区画がありません。</p>}</div></>}
        <div className="billing-settings-dialog-actions">
          <button type="button" className="text-button" onClick={closeEditor}>取消</button>
          <button className="primary-button" disabled={!canEdit} onClick={() => void save()}>{selectedSetting ? '設定を更新' : '設定を保存'}</button>
        </div>
      </div>
    </Dialog>}
  </section>;
}
