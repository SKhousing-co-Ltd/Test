import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabase } from './lib/supabase';
import type { ParkingCurrentRow } from './ParkingPage';
import './ParkingDetailModal.css';

type ParkingScope = 'internal' | 'external';
type TenantOption = { tenant_id: string; tenant_name: string };
type MainContractCandidate = { property_id: string; lease_contract_id: string; tenant_id: string; tenant_name: string; contract_start_date: string | null; contract_end_date: string | null; unit_labels: string };
type ParkingSpaceDetail = { space_number: string; length_mm: number | null; width_mm: number | null; height_mm: number | null; weight_limit_kg: number | null };
type AssignmentDetail = { source_file_name: string | null; source_sheet_name: string | null; source_row_number: number | null };
type VehicleDetail = { vehicle_model: string | null; registration_number: string | null; chassis_number: string | null; effective_from: string; effective_to: string | null };
type FormState = { space_number: string; length_mm: string; width_mm: string; height_mm: string; weight_limit_kg: string; tenant_id: string; parking_scope: '' | ParkingScope; main_lease_contract_id: string; contract_start_date: string; contract_end_date: string; access_code: string; notes: string; vehicle_model: string; registration_number: string; chassis_number: string; vehicle_effective_from: string; vehicle_effective_to: string };

function asNumber(value: string): number | null { if (!value.trim()) return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function displayDate(value: string | null): string { return value ? new Intl.DateTimeFormat('ja-JP').format(new Date(`${value}T00:00:00`)) : '—'; }
function FormField({ label, value, editing, children }: { label: string; value: string; editing: boolean; children?: ReactNode }) { return <label className="parking-detail-field"><span>{label}</span>{editing && children ? children : <strong>{value || '—'}</strong>}</label>; }

export function ParkingDetailModal({ row, canManage, onClose, onSaved }: { row: ParkingCurrentRow; canManage: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const [assignmentDetail, setAssignmentDetail] = useState<AssignmentDetail | null>(null);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [mainContracts, setMainContracts] = useState<MainContractCandidate[]>([]);
  const [tenantQuery, setTenantQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState<FormState>({ space_number: row.space_number, length_mm: '', width_mm: '', height_mm: '', weight_limit_kg: '', tenant_id: row.tenant_id ?? '', parking_scope: row.parking_scope ?? '', main_lease_contract_id: row.main_lease_contract_id ?? '', contract_start_date: row.contract_start_date ?? '', contract_end_date: row.contract_end_date ?? '', access_code: row.access_code ?? '', notes: row.notes ?? '', vehicle_model: row.vehicle_model ?? '', registration_number: row.registration_number ?? '', chassis_number: row.chassis_number ?? '', vehicle_effective_from: row.vehicle_effective_from ?? '', vehicle_effective_to: '' });
  const occupied = Boolean(row.lease_contract_id && row.lease_contract_unit_id);

  useEffect(() => {
    if (!supabase) { setMessage('Supabaseが設定されていません。'); setLoading(false); return; }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const [spaceResult, tenantResult, contractResult] = await Promise.all([
        supabase.from('parking_space_master').select('space_number, length_mm, width_mm, height_mm, weight_limit_kg').eq('unit_id', row.unit_id).single(),
        supabase.from('tenant_master').select('tenant_id, tenant_name').order('tenant_name'),
        supabase.from('parking_main_contract_candidate').select('*').eq('property_id', row.property_id),
      ]);
      const loadError = spaceResult.error ?? tenantResult.error ?? contractResult.error;
      if (loadError) { if (!cancelled) { setMessage(`詳細情報を読み込めませんでした: ${loadError.message}`); setLoading(false); } return; }
      let assignment: AssignmentDetail | null = null;
      let vehicle: VehicleDetail | null = null;
      if (row.lease_contract_unit_id) {
        const [assignmentResult, vehicleResult] = await Promise.all([
          supabase.from('parking_space_assignment').select('source_file_name, source_sheet_name, source_row_number').eq('lease_contract_unit_id', row.lease_contract_unit_id).maybeSingle(),
          supabase.from('parking_vehicle_history').select('vehicle_model, registration_number, chassis_number, effective_from, effective_to').eq('lease_contract_unit_id', row.lease_contract_unit_id).order('effective_from', { ascending: false }).limit(1).maybeSingle(),
        ]);
        const detailError = assignmentResult.error ?? vehicleResult.error;
        if (detailError) { if (!cancelled) { setMessage(`契約付帯情報を読み込めませんでした: ${detailError.message}`); setLoading(false); } return; }
        assignment = assignmentResult.data as AssignmentDetail | null;
        vehicle = vehicleResult.data as VehicleDetail | null;
      }
      if (cancelled) return;
      const space = spaceResult.data as ParkingSpaceDetail;
      setAssignmentDetail(assignment);
      setTenants((tenantResult.data ?? []) as TenantOption[]);
      setMainContracts((contractResult.data ?? []) as MainContractCandidate[]);
      setForm((current) => ({ ...current, space_number: space.space_number, length_mm: space.length_mm?.toString() ?? '', width_mm: space.width_mm?.toString() ?? '', height_mm: space.height_mm?.toString() ?? '', weight_limit_kg: space.weight_limit_kg?.toString() ?? '', vehicle_model: vehicle?.vehicle_model ?? current.vehicle_model, registration_number: vehicle?.registration_number ?? current.registration_number, chassis_number: vehicle?.chassis_number ?? current.chassis_number, vehicle_effective_from: vehicle?.effective_from ?? current.vehicle_effective_from, vehicle_effective_to: vehicle?.effective_to ?? '' }));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [row]);

  const tenantChoices = useMemo(() => { const normalized = tenantQuery.normalize('NFKC').toLocaleLowerCase('ja-JP').trim(); const current = tenants.find((tenant) => tenant.tenant_id === form.tenant_id); const choices = (normalized ? tenants.filter((tenant) => tenant.tenant_name.normalize('NFKC').toLocaleLowerCase('ja-JP').includes(normalized)) : tenants.filter((tenant) => mainContracts.some((contract) => contract.tenant_id === tenant.tenant_id))).slice(0, 60); if (current && !choices.some((tenant) => tenant.tenant_id === current.tenant_id)) choices.unshift(current); return choices; }, [form.tenant_id, mainContracts, tenantQuery, tenants]);
  const contractChoices = useMemo(() => mainContracts.filter((contract) => contract.tenant_id === form.tenant_id), [form.tenant_id, mainContracts]);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  const save = async () => {
    if (!supabase || !canManage || saving) return;
    if (!form.space_number.trim()) { setMessage('枠番を入力してください。'); return; }
    if (occupied && (!form.tenant_id || !form.parking_scope)) { setMessage('契約先と内部・外部を選択してください。'); return; }
    if (occupied && form.parking_scope === 'internal' && !form.main_lease_contract_id) { setMessage('内部契約では主契約を選択してください。'); return; }
    setSaving(true); setMessage('');
    const { error } = await supabase.rpc('update_parking_registration', { p_unit_id: row.unit_id, p_lease_contract_unit_id: row.lease_contract_unit_id, p_lease_contract_id: row.lease_contract_id, p_space_number: form.space_number.trim(), p_length_mm: asNumber(form.length_mm), p_width_mm: asNumber(form.width_mm), p_height_mm: asNumber(form.height_mm), p_weight_limit_kg: asNumber(form.weight_limit_kg), p_tenant_id: occupied ? form.tenant_id || null : null, p_parking_scope: occupied ? form.parking_scope || null : null, p_main_lease_contract_id: occupied && form.parking_scope === 'internal' ? form.main_lease_contract_id || null : null, p_contract_start_date: occupied ? form.contract_start_date || null : null, p_contract_end_date: occupied ? form.contract_end_date || null : null, p_access_code: occupied ? form.access_code : null, p_notes: occupied ? form.notes : null, p_vehicle_model: occupied ? form.vehicle_model : null, p_registration_number: occupied ? form.registration_number : null, p_chassis_number: occupied ? form.chassis_number : null, p_vehicle_effective_from: occupied ? form.vehicle_effective_from || null : null, p_vehicle_effective_to: occupied ? form.vehicle_effective_to || null : null });
    if (error) { setMessage(`保存できませんでした: ${error.message}`); setSaving(false); return; }
    await onSaved(); setSaving(false); setEditing(false); setMessage('保存しました。');
  };

  const tenantName = tenants.find((tenant) => tenant.tenant_id === form.tenant_id)?.tenant_name ?? row.tenant_name ?? '—';
  const mainContractLabel = contractChoices.find((contract) => contract.lease_contract_id === form.main_lease_contract_id)?.unit_labels ?? '—';

  return <div className="parking-detail-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="parking-detail-modal" role="dialog" aria-modal="true" aria-labelledby="parking-detail-modal-title">
    <header><div><p className="section-kicker">PARKING REGISTRATION</p><h2 id="parking-detail-modal-title">駐車枠 {row.space_number} の登録情報</h2><span>{row.property_name} / {row.facility_name}{row.parking_type_name ? ` / ${row.parking_type_name}` : ''}</span></div><button className="parking-detail-close" onClick={onClose} aria-label="詳細画面を閉じる">×</button></header>
    {message ? <p className={`parking-detail-modal-message ${message === '保存しました。' ? 'success' : ''}`}>{message}</p> : null}
    {loading ? <div className="parking-detail-loading">登録情報を読み込んでいます…</div> : <div className="parking-detail-modal-body">
      <section><div className="parking-detail-section-title"><div><h3>駐車枠情報</h3><p>駐車場設備側の登録情報</p></div><span className={`parking-state ${occupied ? 'occupied' : 'vacant'}`}>{occupied ? '契約中' : '空き'}</span></div><div className="parking-detail-form-grid"><FormField label="物件" value={row.property_name} editing={false} /><FormField label="駐車場" value={row.facility_name} editing={false} /><FormField label="駐車場種別" value={row.parking_type_name ?? '—'} editing={false} /><FormField label="ユニットコード" value={row.unit_code} editing={false} /><FormField label="枠番" value={form.space_number} editing={editing}><input value={form.space_number} onChange={(e) => set('space_number', e.target.value)} /></FormField><FormField label="全長上限（mm）" value={form.length_mm} editing={editing}><input type="number" min="0" value={form.length_mm} onChange={(e) => set('length_mm', e.target.value)} /></FormField><FormField label="全幅上限（mm）" value={form.width_mm} editing={editing}><input type="number" min="0" value={form.width_mm} onChange={(e) => set('width_mm', e.target.value)} /></FormField><FormField label="全高上限（mm）" value={form.height_mm} editing={editing}><input type="number" min="0" value={form.height_mm} onChange={(e) => set('height_mm', e.target.value)} /></FormField><FormField label="重量上限（kg）" value={form.weight_limit_kg} editing={editing}><input type="number" min="0" value={form.weight_limit_kg} onChange={(e) => set('weight_limit_kg', e.target.value)} /></FormField></div></section>
      <section className={!occupied ? 'parking-detail-disabled-section' : ''}><div className="parking-detail-section-title"><div><h3>契約情報</h3><p>{occupied ? '現在有効な駐車場契約' : '空き区画のため契約情報はありません'}</p></div></div>{occupied ? <div className="parking-detail-form-grid"><FormField label="契約先" value={tenantName} editing={editing}><div className="parking-tenant-editor"><input placeholder="契約先を検索" value={tenantQuery} onChange={(e) => setTenantQuery(e.target.value)} /><select value={form.tenant_id} onChange={(e) => { set('tenant_id', e.target.value); set('main_lease_contract_id', ''); }}><option value="">選択してください</option>{tenantChoices.map((tenant) => <option key={tenant.tenant_id} value={tenant.tenant_id}>{tenant.tenant_name}</option>)}</select></div></FormField><FormField label="契約区分" value={form.parking_scope === 'internal' ? '内部' : form.parking_scope === 'external' ? '外部' : '—'} editing={editing}><select value={form.parking_scope} onChange={(e) => { const scope = e.target.value as '' | ParkingScope; set('parking_scope', scope); if (scope === 'external') set('main_lease_contract_id', ''); }}><option value="">選択してください</option><option value="internal">内部</option><option value="external">外部</option></select></FormField><FormField label="主契約" value={form.parking_scope === 'internal' ? mainContractLabel : '対象外'} editing={editing && form.parking_scope === 'internal'}>{form.parking_scope === 'internal' ? <select value={form.main_lease_contract_id} onChange={(e) => set('main_lease_contract_id', e.target.value)}><option value="">主契約を選択</option>{contractChoices.map((contract) => <option key={contract.lease_contract_id} value={contract.lease_contract_id}>{contract.unit_labels} / {displayDate(contract.contract_start_date)}</option>)}</select> : null}</FormField><FormField label="契約開始日" value={displayDate(form.contract_start_date || null)} editing={editing}><input type="date" value={form.contract_start_date} onChange={(e) => set('contract_start_date', e.target.value)} /></FormField><FormField label="契約終了日" value={displayDate(form.contract_end_date || null)} editing={editing}><input type="date" value={form.contract_end_date} onChange={(e) => set('contract_end_date', e.target.value)} /></FormField><FormField label="暗証番号" value={form.access_code} editing={editing}><input value={form.access_code} onChange={(e) => set('access_code', e.target.value)} /></FormField><label className="parking-detail-field parking-detail-field-wide"><span>備考</span>{editing ? <textarea rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} /> : <strong>{form.notes || '—'}</strong>}</label></div> : null}</section>
      {occupied ? <section><div className="parking-detail-section-title"><div><h3>車両情報</h3><p>現在の車両履歴の最新レコード</p></div></div><div className="parking-detail-form-grid"><FormField label="車種" value={form.vehicle_model} editing={editing}><input value={form.vehicle_model} onChange={(e) => set('vehicle_model', e.target.value)} /></FormField><FormField label="車両番号" value={form.registration_number} editing={editing}><input value={form.registration_number} onChange={(e) => set('registration_number', e.target.value)} /></FormField><FormField label="車台番号" value={form.chassis_number} editing={editing}><input value={form.chassis_number} onChange={(e) => set('chassis_number', e.target.value)} /></FormField><FormField label="有効開始日" value={displayDate(form.vehicle_effective_from || null)} editing={editing}><input type="date" value={form.vehicle_effective_from} onChange={(e) => set('vehicle_effective_from', e.target.value)} /></FormField><FormField label="有効終了日" value={displayDate(form.vehicle_effective_to || null)} editing={editing}><input type="date" value={form.vehicle_effective_to} onChange={(e) => set('vehicle_effective_to', e.target.value)} /></FormField></div></section> : null}
      <section className="parking-detail-meta-section"><div className="parking-detail-section-title"><div><h3>登録元・識別情報</h3><p>照合や問い合わせに使用するシステム情報</p></div></div><div className="parking-detail-form-grid"><FormField label="Unit ID" value={row.unit_id} editing={false} /><FormField label="契約ID" value={row.lease_contract_id ?? '—'} editing={false} /><FormField label="契約割当ID" value={row.lease_contract_unit_id ?? '—'} editing={false} /><FormField label="取込ファイル" value={assignmentDetail?.source_file_name ?? '—'} editing={false} /><FormField label="取込シート" value={assignmentDetail?.source_sheet_name ?? '—'} editing={false} /><FormField label="取込行" value={assignmentDetail?.source_row_number?.toString() ?? '—'} editing={false} /></div></section>
    </div>}
    <footer><button className="secondary-button" onClick={onClose}>閉じる</button>{canManage && !loading ? editing ? <div><button className="secondary-button" disabled={saving} onClick={() => { setEditing(false); setMessage(''); }}>編集をやめる</button><button className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '変更を保存'}</button></div> : <button className="primary-button" onClick={() => { setEditing(true); setMessage(''); }}>編集する</button> : null}</footer>
  </div></div>;
}
