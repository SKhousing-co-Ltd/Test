import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from './lib/supabase';

type RequestStatus = 'open' | 'in_review' | 'on_hold' | 'resolved' | 'applied' | 'excluded' | string;
type JsonObject = Record<string, unknown>;
type ImportIssueSource = { source_file_name: string; source_sheet_name: string; source_row_number: number | null };
type ChangeRequestItem = { change_request_item_id: string; entity_type: string; entity_id: string | null; field_name: string | null; current_value: unknown; proposed_value: unknown; validation_status: string; validation_message: string | null; import_issue?: ImportIssueSource | null };
type ChangeRequestComment = { change_request_comment_id: string; body: string; created_at: string };
type ChangeRequest = {
  change_request_id: string; request_type: string; status: RequestStatus; source_type: string;
  title: string; summary: string | null; source_payload: JsonObject; proposed_payload: JsonObject;
  source_appsuite_record_id: string | null; target_appsuite_record_id: string | null; lease_contract_id: string | null;
  row_version: number; updated_at: string; items?: ChangeRequestItem[]; comments?: ChangeRequestComment[];
};
type AccountRole = 'admin' | 'manager' | 'staff' | 'viewer';
type PropertyOption = { asset_id: string; asset_name: string };
type TenantOption = { tenant_id: string; tenant_name: string; external_tenant_code: string | null };
type UnitOption = { unit_id: string; property_id: string; unit_code: string; unit_name: string | null; floor_label: string | null; is_active: boolean };
type ContractOption = { lease_contract_id: string; contract_type: string | null; contract_start_date: string | null; contract_end_date: string | null; tenant: { tenant_name: string } | null };
type CancellationCandidate = { appsuite_record_id: string; ringi_number: string | null; property_name: string | null; tenant_name: string | null; approval_status: string | null; is_cancelled: boolean; lease_contract_id: string | null };
type ContractOperation = { action: 'set_field' | 'link_unit' | 'unlink_unit'; entity_type?: 'lease_contract' | 'lease_contract_unit'; entity_id?: string; unit_id?: string; field_name?: string; value: unknown };
type ContractUnitOption = {
  lease_contract_unit_id: string;
  lease_start_date: string | null;
  lease_end_date: string | null;
  unit: {
    property_id: string;
    unit_type: string;
    unit_code: string;
    unit_name: string | null;
    floor_label: string | null;
    building_wing: { wing_code: string; wing_name: string | null } | null;
    asset: { asset_name: string } | null;
  } | null;
  contract: { lease_contract_id: string; tenant_id: string; contract_status: string; tenant: { tenant_name: string } | null } | null;
};

const editableFields = [
  ['leased_area_sqm', '契約面積（㎡）'], ['monthly_rent_amount', '月額賃料'], ['monthly_common_charge_amount', '月額共益費'],
  ['deposit_amount', '保証金・敷金'], ['security_deposit_amount', '敷金'], ['key_money_amount', '礼金'],
  ['renewal_fee_amount', '更新料'], ['lease_start_date', '契約開始日'], ['lease_end_date', '契約終了日'],
] as const;
const statusLabel: Record<string, string> = { open: '要確認', in_review: '確認中', on_hold: '保留', resolved: '確認済み（確定待ち）', applied: '確定済み', excluded: '対象外' };
const sourceLabels: Record<string, string> = { floor: '階', unit: '取込元の区画表記', tenant_name: '取込元のテナント名', tenant_code: '取込元のテナントコード', discriminator: '仮識別子' };
const formatDate = (value: string) => new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const prettyValue = (value: unknown) => value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const sourceValue = (payload: JsonObject, key: string) => {
  const field = payload[key];
  if (field && typeof field === 'object' && 'val' in field) return String((field as { val?: unknown }).val ?? '').trim();
  return field === null || field === undefined ? '' : String(field).trim();
};
const requestTypeLabel: Record<string, string> = { contract_create: '新規契約', contract_update: '契約変更', approval_cancel: '稟議取消', contract_cancellation_review: '取消後の契約確認', parking_fee_setup: '駐車料設定' };
const compareContractUnitOptions = (left: ContractUnitOption, right: ContractUnitOption) => contractUnitLabel(left).localeCompare(contractUnitLabel(right), 'ja-JP', { numeric: true, sensitivity: 'base' });

function contractUnitLabel(option: ContractUnitOption) {
  const unit = option.unit;
  if (!unit) return `未設定の区画（${option.lease_contract_unit_id}）`;
  const wing = unit.building_wing ? (unit.building_wing.wing_name || unit.building_wing.wing_code) : '';
  const location = [unit.asset?.asset_name, wing, unit.floor_label].filter(Boolean).join('｜');
  const unitName = unit.unit_name ? ` ${unit.unit_name}` : '';
  const tenant = option.contract?.tenant?.tenant_name ? `｜${option.contract.tenant.tenant_name}` : '';
  const status = option.contract?.contract_status && option.contract.contract_status !== 'active' ? `（${option.contract.contract_status}）` : '';
  return `${location || '物件・階未設定'}｜${unit.unit_code}${unitName}${tenant}${status}`;
}

function getImportType(request: ChangeRequest) {
  return request.source_type === 'initial_import' ? request.title.replace(/^取込エラー:\s*/, '') : null;
}

function isReviewOnlyImport(request: ChangeRequest) {
  return request.source_type === 'initial_import'
    && Boolean(request.items?.length)
    && request.items!.every((item) => item.entity_type === 'rent_roll_import_issue');
}

function IssueContext({ request }: { request: ChangeRequest }) {
  const issueType = getImportType(request);
  if (!issueType) return null;
  const sourceRows = Object.entries(request.source_payload).filter(([, value]) => value !== null && value !== undefined && value !== '');
  const importSource = request.items?.find((item) => item.import_issue)?.import_issue;
  const guide: Record<string, { title: string; objective: string; steps: string[] }> = {
    multiple_tenant_codes: {
      title: 'この区画には複数のテナントコードが記載されています',
      objective: '記載された全コードを保存し、請求する収入科目との対応を確定します。',
      steps: ['下の「取込元の記載」で、登録対象の全テナントコードを確認します。', '「テナントコード設定を開く」から、主コード・サブコードと各収入科目の割当を設定します。', 'すべてのコードと科目割当を保存すると、この対応依頼は自動的に確定済みになります。テナントを特定できない場合は「保留」にします。'],
    },
    combined_unit: {
      title: '複数区画を1契約にまとめた取込内容です',
      objective: '取込元の区画の組み合わせが、契約書・平面図と一致するかを確定します。一致する場合、契約条件の入力は不要です。',
      steps: ['下の「取込元の区画表記」と階を確認します。例：A・B、C〜E。', '契約書と平面図で、表示された全区画がこの契約に含まれるか確認します。', '一致する場合は確認した資料を対応メモに残して「確認完了にする」を押します。不一致の場合は正しい区画をメモに残して「保留」にします。'],
    },
    temporary_unit_discriminator: {
      title: '同じ名称の区画を区別するため、仮識別子を付けています',
      objective: '仮識別子と実際の区画の対応を特定します。',
      steps: ['階・区画表記・テナント名・仮識別子が、元の資料と一致するか確認します。', 'どの実際の区画に対応するかを平面図・契約書で特定します。', '特定できない場合は、判断理由をメモに残して「保留」にします。'],
    },
    layout_not_supported: {
      title: 'このExcelレイアウトは自動取込の対象外です',
      objective: '自動取込に必要な列の場所を特定し、取込設定の追加を依頼します。',
      steps: ['元のExcelを開き、棟・階・区画・テナントがどの列に書かれているか確認します。', '資料の保存場所と確認結果を対応メモへ残します。', 'この依頼は賃料入力では解決しないため、「保留」にして取込設定の追加を依頼します。'],
    },
  };
  const detail = guide[issueType] ?? { title: '取込内容の確認が必要です', objective: '取込元の値と元資料の一致・不一致を特定します。', steps: ['下の取込元の記載と元の資料を照合します。', '判断内容を対応メモに残します。'] };
  return <section className="change-card issue-context">
    <p className="section-kicker">IMPORT SOURCE</p>
    <h4>{detail.title}</h4>
    <div className="change-objective"><strong>この依頼で確定すること</strong><p>{detail.objective}</p></div>
    {issueType === 'multiple_tenant_codes' && typeof request.proposed_payload.tenant_id === 'string' ? <div className="change-master-link"><Link className="primary-button" to={`/tenants?tenant=${encodeURIComponent(request.proposed_payload.tenant_id)}`}>テナントコード設定を開く</Link><small>設定保存後、この依頼は自動的に確定済みになります。</small></div> : null}
    <div className="change-diff-table">
      <div className="change-diff-head"><span>ソースシート（物件）</span><span>元Excelファイル</span><span>該当行</span></div>
      <div><strong>{importSource?.source_sheet_name ?? '確認中'}</strong><span>{importSource?.source_file_name ?? '確認中'}</span><span>{importSource?.source_row_number ? `${importSource.source_row_number} 行目` : '行番号なし'}</span></div>
    </div>
    <div className="change-diff-table">
      <div className="change-diff-head"><span>取込元の項目</span><span>記載されていた値</span><span>確認すること</span></div>
      {sourceRows.length ? sourceRows.map(([key, value]) => <div key={key}><strong>{sourceLabels[key] ?? key}</strong><span>{prettyValue(value)}</span><span>{key === 'tenant_code' ? issueType === 'multiple_tenant_codes' ? '全コードを保存し、請求科目へ割り当てる' : '契約書と照合してコードを確認する' : key === 'unit' ? '平面図で実際に含まれる区画を確認する' : '元資料と一致するか確認する'}</span></div>) : <div><strong>取込元データ</strong><span>表示できる項目がありません</span><span>元のExcelレイアウトを確認し、対応メモへ保存場所を記録する</span></div>}
    </div>
    <details className="change-dev-details"><summary>取込ペイロード全体を確認</summary><pre className="change-json-editor">{JSON.stringify(request.source_payload, null, 2)}</pre></details>
    <h4>この依頼で行うこと</h4>
    <ol>{detail.steps.map((step) => <li key={step}>{step}</li>)}</ol>
  </section>;
}

function AppsuiteSourceContext({ request }: { request: ChangeRequest }) {
  if (request.source_type !== 'desknets') return null;
  const importantFields = ['稟議番号', '取下稟議番号', '物件名', '物件名称', 'テナント名', '申請内容', '取下理由']
    .map((key) => [key, sourceValue(request.source_payload, key)] as const)
    .filter(([, value]) => value);
  return <section className="change-card issue-context">
    <p className="section-kicker">APPSUITE APPROVAL</p>
    <h4>{requestTypeLabel[request.request_type] ?? 'AppSuite申請'}の原文</h4>
    <div className="change-diff-table">
      <div className="change-diff-head"><span>項目</span><span>申請内容</span><span>取扱い</span></div>
      {importantFields.map(([key, value]) => <div key={key}><strong>{key}</strong><span>{value}</span><span>{key === '申請内容' || key === '取下理由' ? '原文を目視確認' : '照合情報'}</span></div>)}
    </div>
    <details className="change-dev-details"><summary>AppSuiteペイロード全体を確認</summary><pre className="change-json-editor">{JSON.stringify(request.source_payload, null, 2)}</pre></details>
  </section>;
}

function ParkingFeeRequestEditor({ request, contractUnits, role, working, onWorking, onError, onSaved }: {
  request: ChangeRequest;
  contractUnits: ContractUnitOption[];
  role: AccountRole;
  working: boolean;
  onWorking: (working: boolean) => void;
  onError: (message: string) => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const payload = request.proposed_payload;
  const scope = payload.parking_scope === 'external' ? 'external' : 'internal';
  const propertyId = typeof payload.property_id === 'string' ? payload.property_id : '';
  const tenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id : '';
  const initialStart = typeof payload.contract_start_date === 'string' ? payload.contract_start_date : '';
  const [monthlyFee, setMonthlyFee] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(initialStart);
  const [mainContractUnitId, setMainContractUnitId] = useState('');
  const candidates = useMemo(() => contractUnits.filter((candidate) =>
    candidate.unit?.unit_type !== 'parking'
      && candidate.unit?.property_id === propertyId
      && candidate.contract?.tenant_id === tenantId,
  ), [contractUnits, propertyId, tenantId]);

  const applyParkingFee = async () => {
    if (!supabase) return;
    const amount = Number(monthlyFee);
    if (!monthlyFee.trim() || !Number.isSafeInteger(amount) || amount < 0) {
      onError('月額駐車料は0以上の整数で入力してください。');
      return;
    }
    if (!effectiveFrom) { onError('適用開始日を入力してください。'); return; }
    if (scope === 'internal' && !mainContractUnitId) { onError('内部契約は控除対象の主契約区画を選択してください。'); return; }
    if (!window.confirm('入力した駐車料を履歴へ反映し、この対応依頼を確定しますか？')) return;
    onWorking(true); onError('');
    const { data, error } = await supabase.rpc('apply_parking_fee_change_request', {
      p_change_request_id: request.change_request_id,
      p_expected_row_version: request.row_version,
      p_monthly_parking_fee: amount,
      p_effective_from: effectiveFrom,
      p_main_lease_contract_unit_id: scope === 'internal' ? mainContractUnitId : null,
    });
    onWorking(false);
    if (error) { onError(`駐車料を反映できませんでした: ${error.message}`); return; }
    const applied = (Array.isArray(data) ? data[0] : data) as { status?: string } | null;
    if (applied?.status !== 'applied') { onError('確定済みへの更新を確認できませんでした。画面を更新してください。'); return; }
    await onSaved('駐車料を履歴へ反映し、対応依頼を確定しました。');
  };

  return <section className="change-card">
    <p className="section-kicker">PARKING FEE</p>
    <h4>駐車料を手入力</h4>
    <p>Excel取込では金額を登録していません。契約原本を確認し、基準日履歴へ反映します。</p>
    <div className="change-diff-table">
      <div className="change-diff-head"><span>物件・枠</span><span>テナント</span><span>区分</span></div>
      <div><strong>{String(payload.property_name ?? '物件未設定')} / {String(payload.space_number ?? '枠未設定')}</strong><span>{String(payload.tenant_name ?? 'テナント未設定')}</span><span>{scope === 'internal' ? '内部' : '外部'}</span></div>
    </div>
    {request.status === 'applied' ? <p className="notice">駐車料は登録済みです。</p> : <div className="change-item-editor">
      <label>月額駐車料<input type="number" min="0" step="1" value={monthlyFee} onChange={(event) => setMonthlyFee(event.target.value)} placeholder="例: 30000" /></label>
      <label>適用開始日<input type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></label>
      {scope === 'internal' ? <label>控除対象の主契約区画<select value={mainContractUnitId} onChange={(event) => setMainContractUnitId(event.target.value)}><option value="">選択してください</option>{candidates.map((candidate) => <option key={candidate.lease_contract_unit_id} value={candidate.lease_contract_unit_id}>{contractUnitLabel(candidate)}｜{candidate.lease_start_date ?? '開始日未設定'}～{candidate.lease_end_date ?? '継続中'}</option>)}</select></label> : null}
      {(role === 'admin' || role === 'manager') ? <button className="primary-button" onClick={() => void applyParkingFee()} disabled={working}>履歴へ反映して確定</button> : <p className="notice">履歴への反映は管理者またはマネージャーが行います。</p>}
    </div>}
  </section>;
}

function AppsuiteContractEditor({ request, properties, tenants, units, contracts, contractUnits, role, working, onWorking, onError, onSaved }: {
  request: ChangeRequest; properties: PropertyOption[]; tenants: TenantOption[]; units: UnitOption[]; contracts: ContractOption[];
  contractUnits: ContractUnitOption[]; role: AccountRole; working: boolean; onWorking: (value: boolean) => void;
  onError: (value: string) => void; onSaved: (message: string) => Promise<void>;
}) {
  const sourceProperty = sourceValue(request.source_payload, '物件名') || sourceValue(request.source_payload, '物件名称');
  const sourceTenant = sourceValue(request.source_payload, 'テナント名');
  const savedContract = (request.proposed_payload.contract ?? {}) as JsonObject;
  const savedUnits = Array.isArray(request.proposed_payload.units) ? request.proposed_payload.units as JsonObject[] : [];
  const [propertyId, setPropertyId] = useState(String(savedContract.property_id ?? properties.find((item) => item.asset_name === sourceProperty)?.asset_id ?? ''));
  const [tenantId, setTenantId] = useState(String(savedContract.tenant_id ?? tenants.find((item) => item.tenant_name === sourceTenant)?.tenant_id ?? ''));
  const [newTenantName, setNewTenantName] = useState(String(savedContract.new_tenant_name ?? (tenantId ? '' : sourceTenant)));
  const [contractType, setContractType] = useState(String(savedContract.contract_type ?? 'lease'));
  const [startDate, setStartDate] = useState(String(savedContract.contract_start_date ?? ''));
  const [endDate, setEndDate] = useState(String(savedContract.contract_end_date ?? ''));
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>(savedUnits.map((item) => String(item.unit_id)));
  const [unitDrafts, setUnitDrafts] = useState<Record<string, JsonObject>>(() => Object.fromEntries(savedUnits.map((item) => [String(item.unit_id), item])));
  const [targetContractId, setTargetContractId] = useState(String(request.proposed_payload.lease_contract_id ?? request.lease_contract_id ?? ''));
  const [operationKind, setOperationKind] = useState<'contract' | 'unit' | 'link' | 'unlink'>('unit');
  const [operationTarget, setOperationTarget] = useState('');
  const [operationField, setOperationField] = useState<string>('monthly_rent_amount');
  const [operationValue, setOperationValue] = useState('');
  const [operations, setOperations] = useState<ContractOperation[]>(Array.isArray(request.proposed_payload.operations) ? request.proposed_payload.operations as ContractOperation[] : []);
  const [noSystemReason, setNoSystemReason] = useState(String(request.proposed_payload.no_system_reason ?? ''));
  const [candidates, setCandidates] = useState<CancellationCandidate[]>([]);
  const [targetRecordId, setTargetRecordId] = useState(request.target_appsuite_record_id ?? '');
  const [cancelMode, setCancelMode] = useState<'source_only' | 'create_contract_follow_up'>((request.proposed_payload.mode as 'source_only' | 'create_contract_follow_up') ?? 'source_only');
  const [cancelNote, setCancelNote] = useState(String(request.proposed_payload.note ?? ''));

  useEffect(() => {
    if (!propertyId && properties.length) setPropertyId(properties.find((item) => item.asset_name === sourceProperty)?.asset_id ?? '');
  }, [properties, propertyId, sourceProperty]);
  useEffect(() => {
    if (request.request_type !== 'approval_cancel' || !supabase) return;
    void supabase.rpc('list_approval_cancellation_candidates', { p_change_request_id: request.change_request_id })
      .then(({ data, error }) => {
        if (error) { onError(`取消対象候補を読み込めませんでした: ${error.message}`); return; }
        const next = (data ?? []) as CancellationCandidate[];
        setCandidates(next);
        if (!targetRecordId && next.length === 1) setTargetRecordId(next[0].appsuite_record_id);
      });
  }, [request.change_request_id, request.request_type, targetRecordId, onError]);

  const propertyUnits = units.filter((unit) => unit.property_id === propertyId && unit.is_active);
  const saveCreate = async () => {
    if (!supabase || !propertyId || (!tenantId && !newTenantName.trim()) || !selectedUnitIds.length) { onError('物件、テナント、1件以上の区画を入力してください。'); return; }
    onWorking(true); onError('');
    const unitPayload = selectedUnitIds.map((unitId) => ({ unit_id: unitId, ...(unitDrafts[unitId] ?? {}) }));
    const { error } = await supabase.rpc('save_contract_create_draft', {
      p_change_request_id: request.change_request_id, p_expected_row_version: request.row_version,
      p_contract: { property_id: propertyId, ...(tenantId ? { tenant_id: tenantId } : { new_tenant_name: newTenantName.trim() }), contract_type: contractType, contract_start_date: startDate, contract_end_date: endDate },
      p_units: unitPayload,
    });
    onWorking(false); if (error) { onError(`新規契約の下書きを保存できませんでした: ${error.message}`); return; }
    await onSaved('契約内容とリーシング区画を保存しました。');
  };
  const addOperation = () => {
    if ((operationKind !== 'contract' && !operationTarget) || !operationValue.trim()) { onError('変更対象と値を入力してください。'); return; }
    const operation: ContractOperation = operationKind === 'contract'
      ? { action: 'set_field', entity_type: 'lease_contract', field_name: operationField, value: operationValue.trim() }
      : operationKind === 'unit'
        ? { action: 'set_field', entity_type: 'lease_contract_unit', entity_id: operationTarget, field_name: operationField, value: operationValue.trim() }
        : operationKind === 'link'
          ? { action: 'link_unit', unit_id: operationTarget, value: { lease_start_date: operationValue.trim() } }
          : { action: 'unlink_unit', entity_id: operationTarget, value: { effective_date: operationValue.trim() } };
    setOperations((current) => [...current, operation]); setOperationValue(''); onError('');
  };
  const saveUpdate = async () => {
    if (!supabase || !targetContractId) { onError('対象契約を選択してください。'); return; }
    onWorking(true); onError('');
    const { error } = await supabase.rpc('save_contract_update_draft', {
      p_change_request_id: request.change_request_id, p_expected_row_version: request.row_version,
      p_lease_contract_id: targetContractId, p_operations: operations, p_no_system_reason: noSystemReason || null,
    });
    onWorking(false); if (error) { onError(`契約変更の下書きを保存できませんでした: ${error.message}`); return; }
    await onSaved('目視確認した契約変更を保存しました。');
  };
  const saveCancellation = async () => {
    if (!supabase || !targetRecordId || !cancelNote.trim()) { onError('取消対象と確認メモを入力してください。'); return; }
    onWorking(true); onError('');
    const { error } = await supabase.rpc('save_approval_cancellation_draft', {
      p_change_request_id: request.change_request_id, p_expected_row_version: request.row_version,
      p_target_appsuite_record_id: targetRecordId, p_mode: cancelMode, p_note: cancelNote.trim(),
    });
    onWorking(false); if (error) { onError(`取消確認を保存できませんでした: ${error.message}`); return; }
    await onSaved('取消対象と処理方法を保存しました。');
  };
  const confirmCancellation = async () => {
    if (!supabase || !window.confirm('対象稟議を取消済みにします。契約データは自動変更されません。実行しますか？')) return;
    onWorking(true); onError('');
    const { error } = await supabase.rpc('confirm_approval_cancellation', {
      p_change_request_id: request.change_request_id, p_expected_row_version: request.row_version,
      p_mode: cancelMode, p_note: cancelNote.trim() || String(request.proposed_payload.note ?? ''),
    });
    onWorking(false); if (error) { onError(`取消を確定できませんでした: ${error.message}`); return; }
    await onSaved('決裁済み稟議を取消済みにしました。');
  };

  if (request.request_type === 'contract_create') return <section className="change-card">
    <h4>新規契約とリーシング区画を登録</h4><p>申請原文を確認し、正本へ反映する内容を入力します。</p>
    <div className="change-item-editor">
      <label>物件<select value={propertyId} onChange={(e) => { setPropertyId(e.target.value); setSelectedUnitIds([]); }}><option value="">選択してください</option>{properties.map((item) => <option key={item.asset_id} value={item.asset_id}>{item.asset_name}</option>)}</select></label>
      <label>既存テナント<select value={tenantId} onChange={(e) => { setTenantId(e.target.value); if (e.target.value) setNewTenantName(''); }}><option value="">新規テナントとして入力</option>{tenants.map((item) => <option key={item.tenant_id} value={item.tenant_id}>{item.tenant_name}</option>)}</select></label>
      {!tenantId && <label>新規テナント名<input value={newTenantName} onChange={(e) => setNewTenantName(e.target.value)} /></label>}
      <label>契約種別<input value={contractType} onChange={(e) => setContractType(e.target.value)} /></label>
      <label>開始日<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label><label>終了日<input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
    </div>
    <div className="change-unit-picker"><strong>リーシング区画</strong>{propertyUnits.map((unit) => <label key={unit.unit_id} className="check"><input type="checkbox" checked={selectedUnitIds.includes(unit.unit_id)} onChange={(e) => setSelectedUnitIds((current) => e.target.checked ? [...current, unit.unit_id] : current.filter((id) => id !== unit.unit_id))} />{unit.floor_label ?? '階未設定'}｜{unit.unit_code} {unit.unit_name ?? ''}</label>)}</div>
    {selectedUnitIds.map((unitId) => { const unit = units.find((item) => item.unit_id === unitId); const draft = unitDrafts[unitId] ?? {}; const change = (field: string, value: string) => setUnitDrafts((current) => ({ ...current, [unitId]: { ...(current[unitId] ?? {}), [field]: value } })); return <div className="change-item-editor" key={unitId}><strong>{unit?.floor_label}｜{unit?.unit_code}</strong><label>面積<input type="number" value={String(draft.leased_area_sqm ?? '')} onChange={(e) => change('leased_area_sqm', e.target.value)} /></label><label>月額賃料<input type="number" value={String(draft.monthly_rent_amount ?? '')} onChange={(e) => change('monthly_rent_amount', e.target.value)} /></label><label>共益費<input type="number" value={String(draft.monthly_common_charge_amount ?? '')} onChange={(e) => change('monthly_common_charge_amount', e.target.value)} /></label><label>敷金・保証金<input type="number" value={String(draft.deposit_amount ?? '')} onChange={(e) => change('deposit_amount', e.target.value)} /></label></div>; })}
    <button className="secondary-button" onClick={() => void saveCreate()} disabled={working}>契約下書きを保存</button>
  </section>;

  if (request.request_type === 'contract_update' || request.request_type === 'contract_cancellation_review') return <section className="change-card">
    <h4>契約変更を目視確認して入力</h4><p>申請原文は自動解釈しません。対象と変更値を1件ずつ登録します。</p>
    <label>対象契約<select value={targetContractId} onChange={(e) => { setTargetContractId(e.target.value); setOperations([]); }}><option value="">選択してください</option>{contracts.map((contract) => <option key={contract.lease_contract_id} value={contract.lease_contract_id}>{contract.tenant?.tenant_name ?? 'テナント未設定'}｜{contract.contract_start_date ?? '開始日未設定'}｜{contract.contract_type ?? '種別未設定'}</option>)}</select></label>
    <div className="change-item-editor">
      <label>操作<select value={operationKind} onChange={(e) => { const next = e.target.value as typeof operationKind; setOperationKind(next); setOperationTarget(''); setOperationField(next === 'contract' ? 'contract_type' : 'monthly_rent_amount'); }}><option value="contract">契約項目を変更</option><option value="unit">契約区画項目を変更</option><option value="link">区画を追加</option><option value="unlink">区画を解除</option></select></label>
      {operationKind === 'contract' ? <label>対象契約<input value={targetContractId ? '選択中の契約' : ''} disabled /></label> : operationKind === 'link' ? <label>追加区画<select value={operationTarget} onChange={(e) => setOperationTarget(e.target.value)}><option value="">選択してください</option>{units.filter((unit) => unit.is_active).map((unit) => <option key={unit.unit_id} value={unit.unit_id}>{unit.floor_label}｜{unit.unit_code}</option>)}</select></label> : <label>契約区画<select value={operationTarget} onChange={(e) => setOperationTarget(e.target.value)}><option value="">選択してください</option>{contractUnits.filter((unit) => unit.contract?.lease_contract_id === targetContractId).map((unit) => <option key={unit.lease_contract_unit_id} value={unit.lease_contract_unit_id}>{contractUnitLabel(unit)}</option>)}</select></label>}
      {(operationKind === 'contract' || operationKind === 'unit') && <label>項目<select value={operationField} onChange={(e) => setOperationField(e.target.value)}>{operationKind === 'contract' ? [['contract_type', '契約種別'], ['contract_start_date', '契約開始日'], ['contract_end_date', '契約終了日'], ['renewal_terms', '更新条件'], ['payment_terms', '支払条件'], ['notes', '備考']].map(([value, label]) => <option value={value} key={value}>{label}</option>) : editableFields.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}
      <label>{operationKind === 'unlink' ? '解除効力発生日' : operationKind === 'link' ? '利用開始日' : '反映予定値'}<input value={operationValue} onChange={(e) => setOperationValue(e.target.value)} /></label><button className="secondary-button" onClick={addOperation}>変更を追加</button>
    </div>
    <ol>{operations.map((operation, index) => <li key={`${operation.action}-${index}`}>{operation.action}｜{operation.field_name ?? operation.entity_id ?? operation.unit_id}｜{prettyValue(operation.value)} <button className="text-button" onClick={() => setOperations((current) => current.filter((_, itemIndex) => itemIndex !== index))}>削除</button></li>)}</ol>
    <label>本システムに対象項目がない場合の理由<textarea value={noSystemReason} onChange={(e) => setNoSystemReason(e.target.value)} placeholder="例：連帯保証人は本システムの管理対象外。契約原本側で確認済み。" /></label>
    <button className="secondary-button" onClick={() => void saveUpdate()} disabled={working}>目視確認結果を保存</button>
  </section>;

  if (request.request_type === 'approval_cancel') return <section className="change-card">
    <h4>決裁済み稟議の取消確認</h4><p>取下稟議番号と一致した候補だけを表示します。既存契約は自動変更されません。</p>
    {candidates.length === 0 ? <p className="notice">一致する決裁済み稟議がありません。対象フォームを同期してから再確認してください。</p> : <div className="change-diff-table"><div className="change-diff-head"><span>対象</span><span>物件・テナント</span><span>反映状態</span></div>{candidates.map((candidate) => <label key={candidate.appsuite_record_id}><span><input type="radio" checked={targetRecordId === candidate.appsuite_record_id} onChange={() => setTargetRecordId(candidate.appsuite_record_id)} /> {candidate.ringi_number}</span><span>{candidate.property_name ?? '物件未設定'} / {candidate.tenant_name ?? 'テナント未設定'}</span><span>{candidate.is_cancelled ? '取消済み' : candidate.lease_contract_id ? '契約反映済み' : '未反映'}</span></label>)}</div>}
    <label>取消後の処理<select value={cancelMode} onChange={(e) => setCancelMode(e.target.value as typeof cancelMode)}><option value="source_only">稟議連携だけ取消</option><option value="create_contract_follow_up">反映済み契約の確認タスクも作成</option></select></label>
    <label>確認メモ<textarea value={cancelNote} onChange={(e) => setCancelNote(e.target.value)} placeholder="対象稟議、申請理由、確認資料を記録" /></label>
    {request.status !== 'resolved' && <button className="secondary-button" onClick={() => void saveCancellation()} disabled={working || !candidates.length}>取消確認を保存</button>}
    {request.status === 'resolved' && (role === 'admin' || role === 'manager') && <button className="primary-button" onClick={() => void confirmCancellation()} disabled={working}>管理者として取消を最終確定</button>}
    {request.status === 'resolved' && role !== 'admin' && role !== 'manager' && <p className="notice">最終確定は管理者またはマネージャーが行います。</p>}
  </section>;
  return null;
}

export function ChangeRequestWorkbenchPage({ role }: { role: AccountRole }) {
  const [searchParams] = useSearchParams();
  const parkingTarget = searchParams.get('parking');
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<RequestStatus>('open');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [contractUnits, setContractUnits] = useState<ContractUnitOption[]>([]);
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [contracts, setContracts] = useState<ContractOption[]>([]);
  const [itemUnitId, setItemUnitId] = useState('');
  const [itemField, setItemField] = useState<(typeof editableFields)[number][0]>('leased_area_sqm');
  const [itemValue, setItemValue] = useState('');

  const loadRequests = useCallback(async () => {
    if (!supabase) return;
    setLoading(true); setError('');
    const { data, error: loadError } = await supabase.from('change_request')
      .select('change_request_id, request_type, status, source_type, title, summary, source_payload, proposed_payload, source_appsuite_record_id, target_appsuite_record_id, lease_contract_id, row_version, updated_at, items:change_request_item(change_request_item_id, entity_type, entity_id, field_name, current_value, proposed_value, validation_status, validation_message, import_issue:rent_roll_import_issue(source_file_name, source_sheet_name, source_row_number)), comments:change_request_comment(change_request_comment_id, body, created_at)')
      .order('updated_at', { ascending: false });
    setLoading(false);
    if (loadError) { setError(`対応依頼を読み込めませんでした: ${loadError.message}`); return; }
    const result = (data ?? []) as unknown as ChangeRequest[];
    setRequests(result);
    const parkingRequest = parkingTarget ? result.find((request) => request.items?.some((item) => item.entity_type === 'parking_fee_history' && item.entity_id === parkingTarget)) : null;
    setSelectedId((current) => parkingRequest?.change_request_id ?? (current && result.some((item) => item.change_request_id === current) ? current : result[0]?.change_request_id ?? null));
  }, [parkingTarget]);

  useEffect(() => { void loadRequests(); }, [loadRequests]);
  useEffect(() => {
    if (!supabase) return;
    void Promise.all([
      supabase.from('lease_contract_unit').select('lease_contract_unit_id, lease_start_date, lease_end_date, unit:unit_master(property_id, unit_type, unit_code, unit_name, floor_label, building_wing:building_wing_master(wing_code, wing_name), asset:asset_master(asset_name)), contract:lease_contract(lease_contract_id, tenant_id, contract_status, tenant:tenant_master(tenant_name))'),
      supabase.from('asset_master').select('asset_id, asset_name').order('asset_name'),
      supabase.from('tenant_master').select('tenant_id, tenant_name, external_tenant_code').order('tenant_name'),
      supabase.from('unit_master').select('unit_id, property_id, unit_code, unit_name, floor_label, is_active').order('unit_code'),
      supabase.from('lease_contract').select('lease_contract_id, contract_type, contract_start_date, contract_end_date, tenant:tenant_master(tenant_name)').in('contract_status', ['active', 'draft']).order('updated_at', { ascending: false }),
    ]).then(([contractUnitResult, propertyResult, tenantResult, unitResult, contractResult]) => {
      const firstError = contractUnitResult.error ?? propertyResult.error ?? tenantResult.error ?? unitResult.error ?? contractResult.error;
      if (firstError) { setError(`契約候補を読み込めませんでした: ${firstError.message}`); return; }
      setContractUnits(((contractUnitResult.data ?? []) as unknown as ContractUnitOption[]).sort(compareContractUnitOptions));
      setProperties((propertyResult.data ?? []) as PropertyOption[]); setTenants((tenantResult.data ?? []) as TenantOption[]);
      setUnits((unitResult.data ?? []) as UnitOption[]); setContracts((contractResult.data ?? []) as unknown as ContractOption[]);
    });
  }, []);
  const selected = requests.find((request) => request.change_request_id === selectedId) ?? null;
  const availableContractUnits = useMemo(() => {
    const linkedUnitIds = new Set((selected?.items ?? [])
      .filter((item) => item.entity_type === 'lease_contract_unit' && item.entity_id)
      .map((item) => item.entity_id!));
    return linkedUnitIds.size ? contractUnits.filter((unit) => linkedUnitIds.has(unit.lease_contract_unit_id)) : contractUnits;
  }, [contractUnits, selected]);
  useEffect(() => { setComment(''); setItemUnitId(''); setItemValue(''); }, [selectedId]);

  const filtered = useMemo(() => requests.filter((request) => {
    const matchesStatus = filter === 'all' || request.status === filter;
    const text = `${request.title} ${request.summary ?? ''} ${JSON.stringify(request.source_payload)}`.toLocaleLowerCase();
    return matchesStatus && (!search.trim() || text.includes(search.trim().toLocaleLowerCase()));
  }), [filter, requests, search]);
  const editable = selected?.status === 'open' || selected?.status === 'in_review' || selected?.status === 'on_hold';
  const reviewOnly = selected ? isReviewOnlyImport(selected) : false;
  const isAppsuiteContractRequest = selected ? ['contract_create', 'contract_update', 'approval_cancel', 'contract_cancellation_review'].includes(selected.request_type) : false;
  const isParkingFeeRequest = selected?.request_type === 'parking_fee_setup';
  const domainItems = selected?.items?.filter((item) => item.entity_type !== 'rent_roll_import_issue') ?? [];

  const addComment = async () => {
    if (!selected || !supabase || !comment.trim()) return;
    setWorking(true); setError('');
    const { error: addError } = await supabase.rpc('add_change_request_comment', { p_change_request_id: selected.change_request_id, p_body: comment.trim() });
    setWorking(false);
    if (addError) { setError(`対応メモを保存できませんでした: ${addError.message}`); return; }
    setComment(''); setMessage('対応メモを追加しました。'); await loadRequests();
  };
  const setStatus = async (status: 'on_hold' | 'excluded') => {
    if (!selected || !supabase) return;
    const note = window.prompt(status === 'on_hold' ? '保留にする理由を入力してください' : '対象外にする理由を入力してください');
    if (note === null) return;
    setWorking(true); setError('');
    const { error: statusError } = await supabase.rpc('set_change_request_status', { p_change_request_id: selected.change_request_id, p_expected_row_version: selected.row_version, p_next_status: status, p_note: note || null });
    setWorking(false);
    if (statusError) { setError(`状態を更新できませんでした: ${statusError.message}`); return; }
    setMessage(status === 'on_hold' ? '保留にしました。' : '対象外にしました。'); await loadRequests();
  };
  const updateItem = async () => {
    if (!selected || !supabase || !itemUnitId || !itemValue.trim()) { setError('対象区画・項目・反映予定の値を入力してください。'); return; }
    const existing = selected.items?.find((item) => item.field_name === itemField && item.entity_id === itemUnitId) ?? selected.items?.find((item) => !item.field_name && item.validation_status !== 'valid');
    if (!existing) { setError('この依頼には更新できる明細がありません。'); return; }
    const proposedValue: unknown = itemField.endsWith('_date') ? itemValue.trim() : Number(itemValue.replace(/,/g, ''));
    if (typeof proposedValue === 'number' && Number.isNaN(proposedValue)) { setError('金額・面積には数値を入力してください。'); return; }
    setWorking(true); setError('');
    const { error: itemError } = await supabase.rpc('update_change_request_item', { p_change_request_item_id: existing.change_request_item_id, p_expected_request_row_version: selected.row_version, p_entity_type: 'lease_contract_unit', p_entity_id: itemUnitId, p_field_name: itemField, p_proposed_value: proposedValue, p_validation_status: 'valid', p_validation_message: null });
    setWorking(false);
    if (itemError) { setError(`契約条件を保存できませんでした: ${itemError.message}`); return; }
    setMessage('契約条件を保存しました。内容を確認してからResolveしてください。'); await loadRequests();
  };
  const resolve = async () => {
    if (!selected || !supabase || !window.confirm('確認内容を見直したうえで、確認完了にしますか？')) return;
    setWorking(true); setError('');
    const { data, error: resolveError } = await supabase.rpc('resolve_change_request', { p_change_request_id: selected.change_request_id, p_expected_row_version: selected.row_version, p_resolution_payload: {} });
    setWorking(false);
    if (resolveError) { setError(`確認完了にできませんでした: ${resolveError.message}`); return; }
    const resolved = (Array.isArray(data) ? data[0] : data) as ChangeRequest | null;
    if (!resolved || resolved.status !== 'resolved') { setError('確認完了をDBで確認できませんでした。画面を更新して再試行してください。'); return; }
    setFilter('resolved');
    setMessage('確認完了にしました。続けて「内容を確定」を押すと確定済みになります。'); await loadRequests();
  };
  const apply = async () => {
    if (!selected || !supabase || !window.confirm(reviewOnly ? '確認内容を確定し、この取込依頼を閉じますか？' : '正本への反映を確定しますか？')) return;
    setWorking(true); setError('');
    const { data, error: applyError } = await supabase.rpc('apply_change_request', { p_change_request_id: selected.change_request_id, p_expected_row_version: selected.row_version });
    setWorking(false);
    if (applyError) { setError(`適用できませんでした: ${applyError.message}`); return; }
    const applied = (Array.isArray(data) ? data[0] : data) as ChangeRequest | null;
    if (!applied || applied.status !== 'applied') { setError('確定済みへの更新をDBで確認できませんでした。画面を更新して再試行してください。'); return; }
    setFilter('applied');
    setMessage('内容を確定し、取込依頼を確定済みにしました。'); await loadRequests();
  };

  return <section className="change-workbench">
    <div className="page-heading"><p className="section-kicker">DATA REVIEW WORKBENCH</p><h2>取込データ・対応依頼</h2><p>選択した依頼ごとに、取込元の記載と確認手順を見ながら判断します。</p></div>
    {error && <p className="change-message error">{error}</p>}{message && <p className="change-message">{message}</p>}
    <div className="change-workbench-layout">
      <aside className="change-request-list"><header><div><h3>対応依頼</h3><p>未対応のものから順に確認します</p></div><button className="secondary-button" onClick={() => void loadRequests()} disabled={loading}>更新</button></header>
        <div className="change-filters"><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="open">要確認</option><option value="on_hold">保留</option><option value="resolved">確認済み（確定待ち）</option><option value="applied">確定済み</option><option value="excluded">対象外</option><option value="all">すべて</option></select><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="区画・テナント名・コードで検索" /></div>
        <div className="change-request-rows">{loading ? <p className="change-empty">読み込み中…</p> : filtered.length === 0 ? <p className="change-empty">該当する対応依頼はありません。</p> : filtered.map((request) => <button key={request.change_request_id} onClick={() => setSelectedId(request.change_request_id)} className={request.change_request_id === selectedId ? 'selected' : ''}><span className={`change-status ${request.status}`}>{statusLabel[request.status] ?? request.status}</span><strong>{request.title}</strong><small>{request.summary || '確認待ち'}</small></button>)}</div>
      </aside>
      <main className="change-request-detail">{selected ? <>
        <header className="change-detail-heading"><div><p className="section-kicker">{selected.source_type === 'initial_import' ? 'INITIAL IMPORT' : selected.source_type}</p><h3>{selected.title}</h3><p>{selected.summary || '取込内容を確認してください。'} <span>最終更新: {formatDate(selected.updated_at)}</span></p></div><span className={`change-status ${selected.status}`}>{statusLabel[selected.status] ?? selected.status}</span></header>
        <IssueContext request={selected} />
        <AppsuiteSourceContext request={selected} />
        {isParkingFeeRequest ? <ParkingFeeRequestEditor key={`${selected.change_request_id}-${selected.row_version}`} request={selected} contractUnits={contractUnits} role={role} working={working} onWorking={setWorking} onError={setError} onSaved={async (nextMessage) => { setMessage(nextMessage); setFilter('applied'); await loadRequests(); }} /> : null}
        {isAppsuiteContractRequest && (editable || selected.status === 'resolved') && <AppsuiteContractEditor key={`${selected.change_request_id}-${selected.row_version}`} request={selected} properties={properties} tenants={tenants} units={units} contracts={contracts} contractUnits={contractUnits} role={role} working={working} onWorking={setWorking} onError={setError} onSaved={async (nextMessage) => { setMessage(nextMessage); await loadRequests(); }} />}
        {!isAppsuiteContractRequest && !isParkingFeeRequest && (reviewOnly ? <section className="change-card change-no-edit"><h4>契約条件の入力は不要です</h4><p>この依頼は、取込内容と元資料の一致を確認する作業です。確認した資料と結果を対応メモに残してください。</p></section> : <section className="change-card"><h4>反映する契約条件</h4><p>現在の値と反映予定の値を確認します。</p><div className="change-diff-table"><div className="change-diff-head"><span>項目</span><span>現在</span><span>反映予定</span></div>{domainItems.map((item) => <div key={item.change_request_item_id}><strong>{item.field_name || '未設定'}</strong><span>{prettyValue(item.current_value)}</span><span className="proposed-value">{prettyValue(item.proposed_value)}</span></div>)}</div></section>)}
        {editable && !reviewOnly && !isAppsuiteContractRequest && !isParkingFeeRequest && <section className="change-card"><h4>契約条件を修正</h4><p>取込元と照合して対象区画が確定した場合のみ、賃料・面積・期間を入力します。候補は「物件｜棟｜階｜区画コード 区画名｜契約者」で表示します。</p><div className="change-item-editor"><label>対象区画<select value={itemUnitId} onChange={(event) => setItemUnitId(event.target.value)}><option value="">選択してください</option>{availableContractUnits.map((unit) => <option key={unit.lease_contract_unit_id} value={unit.lease_contract_unit_id}>{contractUnitLabel(unit)}</option>)}</select></label><label>項目<select value={itemField} onChange={(event) => setItemField(event.target.value as typeof itemField)}>{editableFields.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>反映予定の値<input value={itemValue} onChange={(event) => setItemValue(event.target.value)} placeholder={itemField.endsWith('_date') ? 'YYYY-MM-DD' : '例: 100000'} /></label><button className="secondary-button" onClick={() => void updateItem()} disabled={working}>契約条件を保存</button></div></section>}
        <section className="change-card"><h4>対応メモ</h4><p>確認した資料、採用する区画・テナントコード、判断理由を残してください。</p><div className="change-comments">{selected.comments?.length ? selected.comments.map((entry) => <div key={entry.change_request_comment_id}><strong>開発メンバー</strong><time>{formatDate(entry.created_at)}</time><p>{entry.body}</p></div>) : <p className="muted">まだメモはありません。</p>}</div>{editable && <div className="comment-composer"><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="例：原本Excelの〇シートと契約書を確認。4F A〜Cを1契約として扱う。" /><button className="secondary-button" onClick={() => void addComment()} disabled={working || !comment.trim()}>メモを追加</button></div>}</section>
        {editable && !isParkingFeeRequest ? <footer className="change-actions"><button className="secondary-button" onClick={() => void setStatus('on_hold')} disabled={working}>保留にする</button><button className="secondary-button" onClick={() => void setStatus('excluded')} disabled={working}>対象外にする</button><button className="primary-button" onClick={() => void resolve()} disabled={working}>{working ? '処理中…' : '確認完了にする'}</button></footer> : selected.status === 'resolved' && selected.request_type !== 'approval_cancel' && !isParkingFeeRequest ? <footer className="change-actions"><p>最終確認後、正本へ反映します。</p><button className="primary-button" onClick={() => void apply()} disabled={working}>{working ? '処理中…' : '内容を確定'}</button></footer> : null}
      </> : <p className="change-empty">左側から対応依頼を選択してください。</p>}</main>
    </div>
  </section>;
}
