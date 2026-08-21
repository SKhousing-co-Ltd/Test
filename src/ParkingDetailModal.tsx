import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from './lib/supabase';
import type { ParkingCurrentRow } from './ParkingPage';
import './ParkingDetailModal.css';

type ParkingScope = 'internal' | 'external';
type TenantOption = { tenant_id: string; tenant_name: string };
type MainContractCandidate = {
  property_id: string;
  lease_contract_id: string;
  tenant_id: string;
  tenant_name: string;
  contract_start_date: string | null;
  contract_end_date: string | null;
  unit_labels: string;
};
type ParkingSpaceDetail = {
  space_number: string;
  length_mm: number | null;
  width_mm: number | null;
  height_mm: number | null;
  weight_limit_kg: number | null;
};
type AssignmentDetail = {
  source_file_name: string | null;
  source_sheet_name: string | null;
  source_row_number: number | null;
};
type VehicleDetail = {
  vehicle_model: string | null;
  registration_number: string | null;
  chassis_number: string | null;
  effective_from: string;
  effective_to: string | null;
};
type ParkingContractMeta = {
  lease_contract_id: string;
  contract_status: string;
  contract_type: string | null;
  source_system: string | null;
  source_record_key: string | null;
  updated_at: string;
};
type ContractUnitDetail = {
  lease_contract_unit_id: string;
  unit_id: string;
  monthly_rent_amount: number | null;
  monthly_common_charge_amount: number | null;
  monthly_total_amount: number | null;
  deposit_amount: number | null;
  security_deposit_amount: number | null;
  lease_start_date: string | null;
  lease_end_date: string | null;
};
type ContractSnapshot = {
  unit_id: string;
  lease_contract_unit_id: string;
  lease_contract_id: string;
  monthly_rent_amount: number | null;
  monthly_common_charge_amount: number | null;
  monthly_total_amount: number | null;
  deposit_amount: number | null;
  security_deposit_amount: number | null;
};
type RelatedParkingSpace = {
  unit_id: string;
  lease_contract_unit_id: string | null;
  space_number: string;
  facility_name: string;
  parking_type_name: string | null;
  lease_start_date: string | null;
  lease_end_date: string | null;
};
type ContractDocumentDetail = {
  lease_contract_document_id: string;
  document_type: string;
  pdf_file_path: string | null;
  pdf_generated_at: string | null;
  latest_word_output_revision_id: string | null;
  latest_formal_output_revision_id: string | null;
  updated_at: string;
};
type FacilityLookup = {
  parking_facility_id: string;
  facility_name: string;
  parking_type: { parking_type_name: string } | null;
};
type FormState = {
  space_number: string;
  length_mm: string;
  width_mm: string;
  height_mm: string;
  weight_limit_kg: string;
  tenant_id: string;
  parking_scope: '' | ParkingScope;
  main_lease_contract_id: string;
  contract_start_date: string;
  contract_end_date: string;
  access_code: string;
  notes: string;
  vehicle_model: string;
  registration_number: string;
  chassis_number: string;
  vehicle_effective_from: string;
  vehicle_effective_to: string;
};

const today = new Date().toISOString().slice(0, 10);
const collator = new Intl.Collator('ja-JP', { numeric: true, sensitivity: 'base' });
const contractStatusLabels: Record<string, string> = {
  draft: '下書き',
  active: '契約中',
  terminated: '解約済',
  expired: '満了',
};

function asNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function displayDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat('ja-JP').format(new Date(`${value}T00:00:00`)) : '—';
}

function displayDateTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
}

function currency(value: number): string {
  return `${Math.round(value).toLocaleString('ja-JP')}円`;
}

function unitStatusAtDate(startDate: string | null, endDate: string | null, asOfDate: string): 'before' | 'active' | 'ended' {
  if (startDate && startDate > asOfDate) return 'before';
  if (endDate && endDate < asOfDate) return 'ended';
  return 'active';
}

function unitStatusLabel(status: 'before' | 'active' | 'ended'): string {
  if (status === 'before') return '開始前';
  if (status === 'ended') return '終了';
  return '契約中';
}

function FormField({ label, value, editing, children }: { label: string; value: string; editing: boolean; children?: ReactNode }) {
  return <label className="parking-detail-field"><span>{label}</span>{editing && children ? children : <strong>{value || '—'}</strong>}</label>;
}

export function ParkingDetailModal({ row, canManage, onClose, onSaved }: {
  row: ParkingCurrentRow;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const snapshotAsOfDate = (row as ParkingCurrentRow & { snapshot_as_of_date?: string }).snapshot_as_of_date ?? today;
  const [assignmentDetail, setAssignmentDetail] = useState<AssignmentDetail | null>(null);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [mainContracts, setMainContracts] = useState<MainContractCandidate[]>([]);
  const [contractMeta, setContractMeta] = useState<ParkingContractMeta | null>(null);
  const [contractUnits, setContractUnits] = useState<ContractUnitDetail[]>([]);
  const [contractSnapshotUnits, setContractSnapshotUnits] = useState<ContractSnapshot[]>([]);
  const [relatedSpaces, setRelatedSpaces] = useState<RelatedParkingSpace[]>([]);
  const [contractDocument, setContractDocument] = useState<ContractDocumentDetail | null>(null);
  const [parkingTemplateReady, setParkingTemplateReady] = useState(false);
  const [tenantQuery, setTenantQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState<FormState>({
    space_number: row.space_number,
    length_mm: '',
    width_mm: '',
    height_mm: '',
    weight_limit_kg: '',
    tenant_id: row.tenant_id ?? '',
    parking_scope: row.parking_scope ?? '',
    main_lease_contract_id: row.main_lease_contract_id ?? '',
    contract_start_date: row.contract_start_date ?? '',
    contract_end_date: row.contract_end_date ?? '',
    access_code: row.access_code ?? '',
    notes: row.notes ?? '',
    vehicle_model: row.vehicle_model ?? '',
    registration_number: row.registration_number ?? '',
    chassis_number: row.chassis_number ?? '',
    vehicle_effective_from: row.vehicle_effective_from ?? '',
    vehicle_effective_to: '',
  });
  const occupied = Boolean(row.lease_contract_id && row.lease_contract_unit_id);

  useEffect(() => {
    if (!supabase) {
      setMessage('Supabaseが設定されていません。');
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setMessage('');
      const [spaceResult, tenantResult, contractCandidateResult] = await Promise.all([
        supabase.from('parking_space_master').select('space_number, length_mm, width_mm, height_mm, weight_limit_kg').eq('unit_id', row.unit_id).single(),
        supabase.from('tenant_master').select('tenant_id, tenant_name').order('tenant_name'),
        supabase.from('parking_main_contract_candidate').select('*').eq('property_id', row.property_id),
      ]);
      const loadError = spaceResult.error ?? tenantResult.error ?? contractCandidateResult.error;
      if (loadError) {
        if (!cancelled) {
          setMessage(`詳細情報を読み込めませんでした: ${loadError.message}`);
          setLoading(false);
        }
        return;
      }

      let assignment: AssignmentDetail | null = null;
      let vehicle: VehicleDetail | null = null;
      let loadedContractMeta: ParkingContractMeta | null = null;
      let loadedContractUnits: ContractUnitDetail[] = [];
      let loadedContractSnapshotUnits: ContractSnapshot[] = [];
      let loadedRelatedSpaces: RelatedParkingSpace[] = [];
      let loadedDocument: ContractDocumentDetail | null = null;
      let templateReady = false;

      if (row.lease_contract_unit_id) {
        const [assignmentResult, vehicleResult] = await Promise.all([
          supabase.from('parking_space_assignment').select('source_file_name, source_sheet_name, source_row_number').eq('lease_contract_unit_id', row.lease_contract_unit_id).maybeSingle(),
          supabase.from('parking_vehicle_history').select('vehicle_model, registration_number, chassis_number, effective_from, effective_to').eq('lease_contract_unit_id', row.lease_contract_unit_id).order('effective_from', { ascending: false }).limit(1).maybeSingle(),
        ]);
        const detailError = assignmentResult.error ?? vehicleResult.error;
        if (detailError) {
          if (!cancelled) {
            setMessage(`契約付帯情報を読み込めませんでした: ${detailError.message}`);
            setLoading(false);
          }
          return;
        }
        assignment = assignmentResult.data as AssignmentDetail | null;
        vehicle = vehicleResult.data as VehicleDetail | null;
      }

      if (row.lease_contract_id) {
        const [metaResult, unitResult, snapshotResult, documentResult, templateResult] = await Promise.all([
          supabase.from('lease_contract').select('lease_contract_id, contract_status, contract_type, source_system, source_record_key, updated_at').eq('lease_contract_id', row.lease_contract_id).maybeSingle(),
          supabase.from('lease_contract_unit').select('lease_contract_unit_id, unit_id, monthly_rent_amount, monthly_common_charge_amount, monthly_total_amount, deposit_amount, security_deposit_amount, lease_start_date, lease_end_date').eq('lease_contract_id', row.lease_contract_id),
          supabase.rpc('lease_contract_unit_snapshot_at_date', { p_property_id: row.property_id, p_as_of_date: snapshotAsOfDate }),
          supabase.from('lease_contract_document').select('lease_contract_document_id, document_type, pdf_file_path, pdf_generated_at, latest_word_output_revision_id, latest_formal_output_revision_id, updated_at').eq('lease_contract_id', row.lease_contract_id).maybeSingle(),
          supabase.from('contract_document_template').select('active_revision_id').eq('document_type', 'parking').maybeSingle(),
        ]);
        const contractError = metaResult.error ?? unitResult.error ?? snapshotResult.error ?? documentResult.error ?? templateResult.error;
        if (contractError) {
          if (!cancelled) {
            setMessage(`駐車場契約を読み込めませんでした: ${contractError.message}`);
            setLoading(false);
          }
          return;
        }
        loadedContractMeta = metaResult.data as ParkingContractMeta | null;
        loadedContractUnits = (unitResult.data ?? []) as ContractUnitDetail[];
        loadedContractSnapshotUnits = ((snapshotResult.data ?? []) as ContractSnapshot[]).filter((item) => item.lease_contract_id === row.lease_contract_id);
        loadedDocument = documentResult.data as ContractDocumentDetail | null;
        templateReady = Boolean(templateResult.data?.active_revision_id);

        const unitIds = loadedContractUnits.map((item) => item.unit_id);
        if (unitIds.length) {
          const { data: spaceRows, error: relatedSpaceError } = await supabase.from('parking_space_master').select('unit_id, space_number, parking_facility_id').in('unit_id', unitIds);
          if (relatedSpaceError) {
            if (!cancelled) {
              setMessage(`契約対象枠を読み込めませんでした: ${relatedSpaceError.message}`);
              setLoading(false);
            }
            return;
          }
          const facilityIds = [...new Set((spaceRows ?? []).map((item) => item.parking_facility_id))];
          const { data: facilityRows, error: facilityError } = facilityIds.length
            ? await supabase.from('parking_facility_master').select('parking_facility_id, facility_name, parking_type:parking_type_master(parking_type_name)').in('parking_facility_id', facilityIds)
            : { data: [] as FacilityLookup[], error: null };
          if (facilityError) {
            if (!cancelled) {
              setMessage(`駐車場施設を読み込めませんでした: ${facilityError.message}`);
              setLoading(false);
            }
            return;
          }
          const facilityMap = new Map(((facilityRows ?? []) as unknown as FacilityLookup[]).map((item) => [item.parking_facility_id, item]));
          const contractUnitMap = new Map(loadedContractUnits.map((item) => [item.unit_id, item]));
          loadedRelatedSpaces = (spaceRows ?? []).map((item) => {
            const facility = facilityMap.get(item.parking_facility_id);
            const allocation = contractUnitMap.get(item.unit_id);
            return {
              unit_id: item.unit_id,
              lease_contract_unit_id: allocation?.lease_contract_unit_id ?? null,
              space_number: item.space_number,
              facility_name: facility?.facility_name ?? '駐車場',
              parking_type_name: facility?.parking_type?.parking_type_name ?? null,
              lease_start_date: allocation?.lease_start_date ?? null,
              lease_end_date: allocation?.lease_end_date ?? null,
            };
          }).sort((left, right) => collator.compare(left.facility_name, right.facility_name) || collator.compare(left.space_number, right.space_number));
        }
      }

      if (cancelled) return;
      const space = spaceResult.data as ParkingSpaceDetail;
      setAssignmentDetail(assignment);
      setTenants((tenantResult.data ?? []) as TenantOption[]);
      setMainContracts((contractCandidateResult.data ?? []) as MainContractCandidate[]);
      setContractMeta(loadedContractMeta);
      setContractUnits(loadedContractUnits);
      setContractSnapshotUnits(loadedContractSnapshotUnits);
      setRelatedSpaces(loadedRelatedSpaces);
      setContractDocument(loadedDocument);
      setParkingTemplateReady(templateReady);
      setForm((current) => ({
        ...current,
        space_number: space.space_number,
        length_mm: space.length_mm?.toString() ?? '',
        width_mm: space.width_mm?.toString() ?? '',
        height_mm: space.height_mm?.toString() ?? '',
        weight_limit_kg: space.weight_limit_kg?.toString() ?? '',
        vehicle_model: vehicle?.vehicle_model ?? current.vehicle_model,
        registration_number: vehicle?.registration_number ?? current.registration_number,
        chassis_number: vehicle?.chassis_number ?? current.chassis_number,
        vehicle_effective_from: vehicle?.effective_from ?? current.vehicle_effective_from,
        vehicle_effective_to: vehicle?.effective_to ?? '',
      }));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [row, snapshotAsOfDate]);

  const tenantChoices = useMemo(() => {
    const normalized = tenantQuery.normalize('NFKC').toLocaleLowerCase('ja-JP').trim();
    const current = tenants.find((tenant) => tenant.tenant_id === form.tenant_id);
    const choices = (normalized
      ? tenants.filter((tenant) => tenant.tenant_name.normalize('NFKC').toLocaleLowerCase('ja-JP').includes(normalized))
      : tenants.filter((tenant) => mainContracts.some((contract) => contract.tenant_id === tenant.tenant_id))).slice(0, 60);
    if (current && !choices.some((tenant) => tenant.tenant_id === current.tenant_id)) choices.unshift(current);
    return choices;
  }, [form.tenant_id, mainContracts, tenantQuery, tenants]);

  const contractChoices = useMemo(
    () => mainContracts.filter((contract) => contract.tenant_id === form.tenant_id),
    [form.tenant_id, mainContracts],
  );

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const contractTotals = useMemo(() => contractSnapshotUnits.reduce((totals, item) => ({
    rent: totals.rent + Number(item.monthly_rent_amount ?? 0),
    common: totals.common + Number(item.monthly_common_charge_amount ?? 0),
    total: totals.total + Number(item.monthly_total_amount ?? (Number(item.monthly_rent_amount ?? 0) + Number(item.monthly_common_charge_amount ?? 0))),
    deposit: totals.deposit + Number(item.deposit_amount ?? 0) + Number(item.security_deposit_amount ?? 0),
  }), { rent: 0, common: 0, total: 0, deposit: 0 }), [contractSnapshotUnits]);

  const save = async () => {
    if (!supabase || !canManage || saving) return;
    if (!form.space_number.trim()) {
      setMessage('枠番を入力してください。');
      return;
    }
    if (occupied && (!form.tenant_id || !form.parking_scope)) {
      setMessage('契約先と内部・外部を選択してください。');
      return;
    }
    if (occupied && form.parking_scope === 'internal' && !form.main_lease_contract_id) {
      setMessage('内部契約では主契約を選択してください。');
      return;
    }
    setSaving(true);
    setMessage('');
    const { error } = await supabase.rpc('update_parking_registration', {
      p_unit_id: row.unit_id,
      p_lease_contract_unit_id: row.lease_contract_unit_id,
      p_lease_contract_id: row.lease_contract_id,
      p_space_number: form.space_number.trim(),
      p_length_mm: asNumber(form.length_mm),
      p_width_mm: asNumber(form.width_mm),
      p_height_mm: asNumber(form.height_mm),
      p_weight_limit_kg: asNumber(form.weight_limit_kg),
      p_tenant_id: occupied ? form.tenant_id || null : null,
      p_parking_scope: occupied ? form.parking_scope || null : null,
      p_main_lease_contract_id: occupied && form.parking_scope === 'internal' ? form.main_lease_contract_id || null : null,
      p_contract_start_date: occupied ? form.contract_start_date || null : null,
      p_contract_end_date: occupied ? form.contract_end_date || null : null,
      p_access_code: occupied ? form.access_code : null,
      p_notes: occupied ? form.notes : null,
      p_vehicle_model: occupied ? form.vehicle_model : null,
      p_registration_number: occupied ? form.registration_number : null,
      p_chassis_number: occupied ? form.chassis_number : null,
      p_vehicle_effective_from: occupied ? form.vehicle_effective_from || null : null,
      p_vehicle_effective_to: occupied ? form.vehicle_effective_to || null : null,
    });
    if (error) {
      setMessage(`保存できませんでした: ${error.message}`);
      setSaving(false);
      return;
    }
    await onSaved();
    setSaving(false);
    setEditing(false);
    setMessage('保存しました。');
  };

  const tenantName = tenants.find((tenant) => tenant.tenant_id === form.tenant_id)?.tenant_name ?? row.tenant_name ?? '—';
  const mainContractLabel = contractChoices.find((contract) => contract.lease_contract_id === form.main_lease_contract_id)?.unit_labels ?? '—';
  const contractKey = contractMeta?.source_record_key || row.lease_contract_id?.slice(0, 8) || '—';
  const currentContractStatus = contractStatusLabels[contractMeta?.contract_status ?? ''] ?? contractMeta?.contract_status ?? '—';
  const canOpenParkingDocument = Boolean(row.lease_contract_id && (parkingTemplateReady || contractDocument));

  return <div className="parking-detail-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="parking-detail-modal" role="dialog" aria-modal="true" aria-labelledby="parking-detail-modal-title">
      <header>
        <div>
          <p className="section-kicker">PARKING REGISTRATION</p>
          <h2 id="parking-detail-modal-title">駐車枠 {row.space_number} の登録情報</h2>
          <span>{row.property_name} / {row.facility_name}{row.parking_type_name ? ` / ${row.parking_type_name}` : ''}</span>
        </div>
        <button className="parking-detail-close" onClick={onClose} aria-label="詳細画面を閉じる">×</button>
      </header>

      {message ? <p className={`parking-detail-modal-message ${message === '保存しました。' ? 'success' : ''}`}>{message}</p> : null}

      {loading ? <div className="parking-detail-loading">登録情報を読み込んでいます…</div> : <div className="parking-detail-modal-body">
        <section>
          <div className="parking-detail-section-title">
            <div><h3>駐車枠情報</h3><p>駐車場設備側の登録情報</p></div>
            <span className={`parking-state ${occupied ? 'occupied' : 'vacant'}`}>{occupied ? '契約中' : '空き'}</span>
          </div>
          <div className="parking-detail-form-grid">
            <FormField label="物件" value={row.property_name} editing={false} />
            <FormField label="駐車場" value={row.facility_name} editing={false} />
            <FormField label="駐車場種別" value={row.parking_type_name ?? '—'} editing={false} />
            <FormField label="ユニットコード" value={row.unit_code} editing={false} />
            <FormField label="枠番" value={form.space_number} editing={editing}><input value={form.space_number} onChange={(event) => set('space_number', event.target.value)} /></FormField>
            <FormField label="全長上限（mm）" value={form.length_mm} editing={editing}><input type="number" min="0" value={form.length_mm} onChange={(event) => set('length_mm', event.target.value)} /></FormField>
            <FormField label="全幅上限（mm）" value={form.width_mm} editing={editing}><input type="number" min="0" value={form.width_mm} onChange={(event) => set('width_mm', event.target.value)} /></FormField>
            <FormField label="全高上限（mm）" value={form.height_mm} editing={editing}><input type="number" min="0" value={form.height_mm} onChange={(event) => set('height_mm', event.target.value)} /></FormField>
            <FormField label="重量上限（kg）" value={form.weight_limit_kg} editing={editing}><input type="number" min="0" value={form.weight_limit_kg} onChange={(event) => set('weight_limit_kg', event.target.value)} /></FormField>
          </div>
        </section>

        <section className={!occupied ? 'parking-detail-disabled-section' : ''}>
          <div className="parking-detail-section-title">
            <div>
              <h3>駐車場契約</h3>
              <p>{occupied ? `${displayDate(snapshotAsOfDate)} 時点の契約情報` : `${displayDate(snapshotAsOfDate)} 時点では空き区画です`}</p>
            </div>
            {occupied ? <span className="parking-contract-status">基準日時点 契約中</span> : null}
          </div>
          {occupied ? <>
            <div className="parking-detail-form-grid parking-contract-overview">
              <FormField label="契約管理キー" value={contractKey} editing={false} />
              <FormField label="契約先" value={tenantName} editing={editing}>
                <div className="parking-tenant-editor">
                  <input placeholder="契約先を検索" value={tenantQuery} onChange={(event) => setTenantQuery(event.target.value)} />
                  <select value={form.tenant_id} onChange={(event) => { set('tenant_id', event.target.value); set('main_lease_contract_id', ''); }}>
                    <option value="">選択してください</option>
                    {tenantChoices.map((tenant) => <option key={tenant.tenant_id} value={tenant.tenant_id}>{tenant.tenant_name}</option>)}
                  </select>
                </div>
              </FormField>
              <FormField label="契約区分" value={form.parking_scope === 'internal' ? '内部' : form.parking_scope === 'external' ? '外部' : '—'} editing={editing}>
                <select value={form.parking_scope} onChange={(event) => {
                  const scope = event.target.value as '' | ParkingScope;
                  set('parking_scope', scope);
                  if (scope === 'external') set('main_lease_contract_id', '');
                }}>
                  <option value="">選択してください</option>
                  <option value="internal">内部</option>
                  <option value="external">外部</option>
                </select>
              </FormField>
              <FormField label="区画利用開始日" value={displayDate(form.contract_start_date || null)} editing={editing}>
                <input type="date" value={form.contract_start_date} onChange={(event) => set('contract_start_date', event.target.value)} />
              </FormField>
              <FormField label="区画利用終了日" value={displayDate(form.contract_end_date || null)} editing={editing}>
                <input type="date" value={form.contract_end_date} onChange={(event) => set('contract_end_date', event.target.value)} />
              </FormField>
              <FormField label="主契約" value={form.parking_scope === 'internal' ? mainContractLabel : '対象外'} editing={editing && form.parking_scope === 'internal'}>
                {form.parking_scope === 'internal' ? <select value={form.main_lease_contract_id} onChange={(event) => set('main_lease_contract_id', event.target.value)}>
                  <option value="">主契約を選択</option>
                  {contractChoices.map((contract) => <option key={contract.lease_contract_id} value={contract.lease_contract_id}>{contract.unit_labels} / {displayDate(contract.contract_start_date)}</option>)}
                </select> : null}
              </FormField>
              <FormField label={`月額賃料（${displayDate(snapshotAsOfDate)}時点）`} value={currency(contractTotals.rent)} editing={false} />
              <FormField label="月額共益費" value={currency(contractTotals.common)} editing={false} />
              <FormField label="月額合計" value={currency(contractTotals.total)} editing={false} />
              <FormField label="敷金・保証金" value={currency(contractTotals.deposit)} editing={false} />
              <FormField label="暗証番号" value={form.access_code} editing={editing}><input value={form.access_code} onChange={(event) => set('access_code', event.target.value)} /></FormField>
              <FormField label="現在の契約管理状態" value={currentContractStatus} editing={false} />
              <FormField label="契約データ更新" value={displayDateTime(contractMeta?.updated_at ?? null)} editing={false} />
              <label className="parking-detail-field parking-detail-field-wide"><span>備考</span>{editing ? <textarea rows={3} value={form.notes} onChange={(event) => set('notes', event.target.value)} /> : <strong>{form.notes || '—'}</strong>}</label>
            </div>

            <div className="parking-contract-edit-scope-note">
              <strong>編集範囲</strong>
              <span>区画利用開始日・終了日は選択中の「枠 {row.space_number}」だけに反映します。契約先・契約区分・主契約は同一駐車場契約全体の情報です。</span>
            </div>

            <div className="parking-contract-subsection">
              <strong>契約対象枠</strong>
              <span>同一契約内でも区画ごとに利用開始日・終了日を保持します</span>
            </div>
            <div className="parking-contract-space-table-wrap">
              <table className="parking-contract-space-table">
                <thead><tr><th>駐車場</th><th>枠</th><th>利用開始日</th><th>利用終了日</th><th>{displayDate(snapshotAsOfDate)}時点</th></tr></thead>
                <tbody>
                  {relatedSpaces.length ? relatedSpaces.map((space) => {
                    const status = unitStatusAtDate(space.lease_start_date, space.lease_end_date, snapshotAsOfDate);
                    return <tr key={space.unit_id} className={space.unit_id === row.unit_id ? 'current' : ''}>
                      <td>{space.facility_name}<small>{space.parking_type_name || ''}</small></td>
                      <td><strong>{space.space_number}</strong>{space.unit_id === row.unit_id ? <small>選択中</small> : null}</td>
                      <td>{displayDate(space.lease_start_date)}</td>
                      <td>{displayDate(space.lease_end_date)}</td>
                      <td><span className={`parking-contract-unit-status ${status}`}>{unitStatusLabel(status)}</span></td>
                    </tr>;
                  }) : <tr><td colSpan={5} className="parking-contract-empty">契約対象枠を取得できませんでした。</td></tr>}
                </tbody>
              </table>
            </div>

            <div className="parking-contract-subsection"><strong>契約書・契約リンク</strong><span>駐車場契約と主契約を相互に確認できます</span></div>
            <div className="parking-contract-link-panel">
              <div>
                <span>駐車場契約書</span>
                <strong>{contractDocument ? '契約書データ登録済み' : parkingTemplateReady ? '作成可能' : 'ひな型準備中'}</strong>
                <small>{contractDocument ? `最終更新 ${displayDateTime(contractDocument.updated_at)}` : '現在の駐車場契約データは維持されたままです。'}</small>
              </div>
              <div className="parking-contract-actions">
                <button className="secondary-button" disabled={!canOpenParkingDocument} onClick={() => row.lease_contract_id && navigate(`/contracts/${row.lease_contract_id}/document`)}>{canOpenParkingDocument ? '駐車場契約書を開く' : '駐車場契約書ひな型 準備中'}</button>
                {form.parking_scope === 'internal' && form.main_lease_contract_id ? <button className="secondary-button" onClick={() => navigate(`/contracts/${form.main_lease_contract_id}/document`)}>主契約の契約書を開く</button> : null}
              </div>
            </div>
          </> : null}
        </section>

        {occupied ? <section>
          <div className="parking-detail-section-title"><div><h3>車両情報</h3><p>現在の車両履歴の最新レコード</p></div></div>
          <div className="parking-detail-form-grid">
            <FormField label="車種" value={form.vehicle_model} editing={editing}><input value={form.vehicle_model} onChange={(event) => set('vehicle_model', event.target.value)} /></FormField>
            <FormField label="車両番号" value={form.registration_number} editing={editing}><input value={form.registration_number} onChange={(event) => set('registration_number', event.target.value)} /></FormField>
            <FormField label="車台番号" value={form.chassis_number} editing={editing}><input value={form.chassis_number} onChange={(event) => set('chassis_number', event.target.value)} /></FormField>
            <FormField label="有効開始日" value={displayDate(form.vehicle_effective_from || null)} editing={editing}><input type="date" value={form.vehicle_effective_from} onChange={(event) => set('vehicle_effective_from', event.target.value)} /></FormField>
            <FormField label="有効終了日" value={displayDate(form.vehicle_effective_to || null)} editing={editing}><input type="date" value={form.vehicle_effective_to} onChange={(event) => set('vehicle_effective_to', event.target.value)} /></FormField>
          </div>
        </section> : null}

        <section className="parking-detail-meta-section">
          <div className="parking-detail-section-title"><div><h3>登録元・識別情報</h3><p>照合や問い合わせに使用するシステム情報</p></div></div>
          <div className="parking-detail-form-grid">
            <FormField label="Unit ID" value={row.unit_id} editing={false} />
            <FormField label="契約ID" value={row.lease_contract_id ?? '—'} editing={false} />
            <FormField label="契約割当ID" value={row.lease_contract_unit_id ?? '—'} editing={false} />
            <FormField label="取込ファイル" value={assignmentDetail?.source_file_name ?? '—'} editing={false} />
            <FormField label="取込シート" value={assignmentDetail?.source_sheet_name ?? '—'} editing={false} />
            <FormField label="取込行" value={assignmentDetail?.source_row_number?.toString() ?? '—'} editing={false} />
          </div>
        </section>
      </div>}

      <footer>
        <button className="secondary-button" onClick={onClose}>閉じる</button>
        {canManage && !loading ? editing ? <div>
          <button className="secondary-button" disabled={saving} onClick={() => { setEditing(false); setMessage(''); }}>編集をやめる</button>
          <button className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '変更を保存'}</button>
        </div> : <button className="primary-button" onClick={() => { setEditing(true); setMessage(''); }}>編集する</button> : null}
      </footer>
    </div>
  </div>;
}
