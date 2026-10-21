import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from './lib/supabase';
import './change-request-threads.css';

type RequestStatus = 'open' | 'in_review' | 'on_hold' | 'resolved' | 'applied' | 'excluded' | string;
type JsonObject = Record<string, unknown>;
type ImportIssueSource = { source_file_name: string; source_sheet_name: string; source_row_number: number | null };
type ChangeRequestItem = { change_request_item_id: string; entity_type: string; entity_id: string | null; field_name: string | null; current_value: unknown; proposed_value: unknown; validation_status: string; validation_message: string | null; import_issue?: ImportIssueSource | null };
type ChangeRequestComment = { change_request_comment_id: string; body: string; created_at: string };
type ChangeRequestActionLog = { change_request_action_log_id: string; action_type: string; previous_status: string | null; next_status: string | null; details: JsonObject; performed_by: string | null; created_at: string };
type AppSuiteRecordRef = { appsuite_record_id: string; app_id: string; data_id: string; ringi_number: string | null };
type ChangeRequest = {
  change_request_id: string; request_type: string; status: RequestStatus; source_type: string;
  title: string; summary: string | null; source_payload: JsonObject; proposed_payload: JsonObject;
  source_appsuite_record_id: string | null; target_appsuite_record_id: string | null; lease_contract_id: string | null;
  row_version: number; updated_at: string; items?: ChangeRequestItem[]; comments?: ChangeRequestComment[]; action_logs?: ChangeRequestActionLog[];
  source_record?: AppSuiteRecordRef | null;
};
type AccountRole = 'admin' | 'manager' | 'staff' | 'viewer';
type PropertyOption = { asset_id: string; asset_name: string };
type TenantOption = { tenant_id: string; tenant_name: string; external_tenant_code: string | null };
type UnitOption = { unit_id: string; property_id: string; unit_code: string; unit_name: string | null; floor_label: string | null; unit_type: string | null; is_active: boolean };
type ContractOption = {
  lease_contract_id: string; tenant_id: string; row_version: number; contract_status: string;
  contract_type: string | null; lease_term_type: 'ordinary' | 'fixed_term' | null;
  contract_start_date: string | null; contract_end_date: string | null;
  renewal_due_date: string | null; actual_end_date: string | null;
  tenant: { tenant_name: string } | null;
};
type CancellationCandidate = { appsuite_record_id: string; ringi_number: string | null; property_name: string | null; tenant_name: string | null; approval_status: string | null; is_cancelled: boolean; lease_contract_id: string | null };
type ContractOperation = { action: 'set_field' | 'link_unit' | 'unlink_unit'; entity_type?: 'lease_contract' | 'lease_contract_unit'; entity_id?: string; unit_id?: string; field_name?: string; value: unknown; effective_date?: string };
type ParkingScope = 'internal' | 'external';
type RecheckResult = { outcome?: 'applied' | 'open' | 'skipped' | 'not_eligible'; evaluation_kind?: string };
type RecheckBatchResult = { checked_count?: number; applied_count?: number; open_count?: number; skipped_count?: number };
type WorkflowContractCandidate = {
  lease_contract_id: string; tenant_id: string; tenant_name: string; property_id: string; property_name: string;
  lease_contract_unit_id: string; unit_id: string; unit_code: string; floor_label: string | null; unit_type: string | null;
  contract_start_date: string | null; contract_end_date: string | null; suggestion_level: string; match_reasons: Array<{ rule: string; matched: boolean; message: string }>;
};
type LinkedContract = {
  workflow_contract_link_id: string; lease_contract_id: string; lease_contract_unit_id: string | null;
  contract: { contract_start_date: string | null; contract_end_date: string | null; tenant: { tenant_name: string } | null } | null;
  contract_unit: { unit: { unit_code: string; floor_label: string | null; asset: { asset_name: string } | null } | null } | null;
};
type ContractUnitOption = {
  lease_contract_unit_id: string;
  lease_contract_id?: string;
  lease_start_date: string | null;
  lease_end_date: string | null;
  leased_area_sqm: number | null;
  monthly_rent_amount: number | null;
  monthly_common_charge_amount: number | null;
  deposit_amount: number | null;
  security_deposit_amount: number | null;
  key_money_amount: number | null;
  renewal_fee_amount: number | null;
  unit: {
    property_id: string;
    unit_type: string;
    unit_code: string;
    unit_name: string | null;
    floor_label: string | null;
    building_wing: { wing_code: string; wing_name: string | null } | null;
    asset: { asset_name: string } | null;
    parking_space?: { space_number: string } | null;
  } | null;
  contract: { lease_contract_id: string; tenant_id: string; contract_status: string; tenant: { tenant_name: string } | null } | null;
};

const editableFields = [
  ['leased_area_sqm', '契約面積（㎡）'], ['monthly_rent_amount', '月額賃料'], ['monthly_common_charge_amount', '月額共益費'],
  ['deposit_amount', '保証金・敷金'], ['security_deposit_amount', '敷金'], ['key_money_amount', '礼金'],
  ['renewal_fee_amount', '更新料'], ['lease_start_date', '契約開始日'], ['lease_end_date', '契約終了日'],
] as const;
const statusLabel: Record<string, string> = { open: '要確認', in_review: '確認中', on_hold: '保留', resolved: '確認済み（確定待ち）', applied: '確定済み', excluded: '対象外' };
const sourceLabels: Record<string, string> = { floor: '階', unit: '取込元の区画表記', tenant_name: '取込元のテナント名', tenant_code: '取込元の請求コード', discriminator: '仮識別子' };
const formatDate = (value: string) => new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const prettyValue = (value: unknown) => value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const sourceValue = (payload: JsonObject, key: string) => {
  const field = payload[key];
  if (field && typeof field === 'object' && 'val' in field) return String((field as { val?: unknown }).val ?? '').trim();
  return field === null || field === undefined ? '' : String(field).trim();
};
const formatAppsuiteSourceValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.map((item, index) => {
    const formatted = formatAppsuiteSourceValue(item);
    return formatted ? `${index + 1}. ${formatted}` : '';
  }).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    if ('val' in objectValue) return formatAppsuiteSourceValue(objectValue.val);
    return Object.entries(objectValue)
      .map(([key, entry]) => {
        const formatted = formatAppsuiteSourceValue(entry);
        return formatted ? `${key}: ${formatted}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(value).trim();
};
const sourceDateInput = (value: string) => {
  const match = value.trim().match(/^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?$/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : '';
};
function guessSourceTenantName(payload: JsonObject): string {
  return sourceValue(payload, 'テナント名')
    || sourceValue(payload, '契約者名')
    || sourceValue(payload, '会社名')
    || sourceValue(payload, 'tenant_name');
}
function requestDisplayTitle(request: ChangeRequest) {
  const tenant = guessSourceTenantName(request.source_payload);
  const property = sourceValue(request.source_payload, '物件名')
    || sourceValue(request.source_payload, '物件名称')
    || sourceValue(request.source_payload, '建物名称');
  return request.title
    .replace(/契約者未設定|テナント未設定/g, tenant || 'テナント未設定')
    .replace(/物件未設定/g, property || '物件未設定');
}
function useTextFilter<T>(items: T[], initial: string, textOf: (item: T) => string) {
  const [query, setQuery] = useState(initial);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('ja-JP');
    return term ? items.filter((item) => textOf(item).toLocaleLowerCase('ja-JP').includes(term)) : items;
  }, [items, query]);
  return { query, setQuery, filtered };
}
const requestTypeLabel: Record<string, string> = { contract_create: '新規契約', contract_update: '契約変更', approval_cancel: '稟議取消', contract_cancellation_review: '取消後の契約確認', parking_fee_setup: '駐車料設定', contract_term_type_confirmation: '契約形態確認', contract_renewal_due: '契約更新確認', fixed_term_contract_end: '定期賃貸借契約終了確認' };
const requestTypeGroup = (request: ChangeRequest) => request.request_type.startsWith('contract_') || request.request_type === 'approval_cancel' ? 'contract' : request.request_type === 'parking_fee_setup' ? 'parking' : request.source_type === 'initial_import' ? 'import' : 'other';
const requestTypeGroupLabel: Record<string, string> = { contract: '契約', parking: '駐車場', import: '取込確認', other: 'その他' };
function relatedWorkflowLinks(request: ChangeRequest): { to: string; label: string }[] {
  if (request.request_type === 'parking_fee_setup') return [{ to: '/parking', label: '駐車場台帳' }, { to: '/contract-information', label: '契約情報' }];
  if (request.source_type === 'initial_import') return [{ to: '/rent-roll', label: 'レントロール' }];
  if (request.request_type === 'contract_create') return [{ to: '/contracts', label: '契約業務フロー' }, { to: '/contract-information', label: '契約情報' }];
  if (request.request_type.startsWith('contract_') || ['approval_cancel', 'contract_cancellation_review'].includes(request.request_type)) return [{ to: '/contract-information', label: '契約情報' }];
  return [{ to: '/contracts', label: '契約業務フロー' }];
}
const requestLocation = (request: ChangeRequest) => {
  const payload = request.source_payload;
  return [sourceValue(payload, '物件名') || sourceValue(payload, '物件名称') || sourceValue(payload, '建物名称'), guessSourceTenantName(payload), sourceValue(payload, 'unit') || sourceValue(payload, '区画')].filter(Boolean).join(' / ');
};
type HistoricalContractCandidate = {
  historical_contract_key: string; snapshot_date: string; snapshot_count: number;
  property_name: string; unit_code: string | null; floor_label: string | null; unit_type: string | null;
  tenant_name: string | null; period_start: string | null; period_end: string | null;
  monthly_rent_amount: number | null; monthly_common_charge_amount: number | null;
  match_level: string; match_reasons: Array<{ rule: string; matched: boolean; message: string }>; source_rows: unknown[];
};
const compareContractUnitOptions = (left: ContractUnitOption, right: ContractUnitOption) => contractUnitLabel(left).localeCompare(contractUnitLabel(right), 'ja-JP', { numeric: true, sensitivity: 'base' });
const ACTIVE_REQUEST_STATUSES = ['open', 'in_review', 'on_hold'] as const;
const ARCHIVED_REQUEST_STATUSES = ['resolved', 'applied', 'excluded'] as const;
const REQUEST_FETCH_PAGE_SIZE = 500;
const REQUEST_DISPLAY_PAGE_SIZE = 25;

type PageResponse<T> = { data: T[] | null; error: { message: string } | null };
type ThreadTimelineEntry = { id: string; created_at: string; type: 'comment' | 'action'; title: string; body: string };
async function fetchAllPages<T>(loadPage: (from: number, to: number) => PromiseLike<PageResponse<T>>): Promise<PageResponse<T>> {
  const allRows: T[] = [];
  for (let from = 0; ; from += REQUEST_FETCH_PAGE_SIZE) {
    const { data, error } = await loadPage(from, from + REQUEST_FETCH_PAGE_SIZE - 1);
    if (error) return { data: null, error };
    const page = data ?? [];
    allRows.push(...page);
    if (page.length < REQUEST_FETCH_PAGE_SIZE) return { data: allRows, error: null };
  }
}

function requestDisplayContext(request: ChangeRequest, contracts: ContractOption[], contractUnits: ContractUnitOption[], properties: PropertyOption[], tenants: TenantOption[]) {
  const sourceProperty = sourceValue(request.source_payload, '物件名') || sourceValue(request.source_payload, '物件名称') || sourceValue(request.source_payload, '建物名称') || sourceValue(request.source_payload, 'property_name');
  const sourceTenant = guessSourceTenantName(request.source_payload) || sourceValue(request.source_payload, 'tenant_name');
  const titleParties = request.title.split(':').slice(1).join(':').split(/\s*\/\s*/, 2).map((value) => value.trim());
  const titleProperty = titleParties[0] || '';
  const titleTenant = titleParties[1] || '';
  const itemContractIds = request.items?.filter((item) => item.entity_type === 'lease_contract' && item.entity_id).map((item) => item.entity_id!) ?? [];
  const itemUnitIds = new Set(request.items?.filter((item) => item.entity_type === 'lease_contract_unit' && item.entity_id).map((item) => item.entity_id!) ?? []);
  const proposedContractId = typeof request.proposed_payload.lease_contract_id === 'string' ? request.proposed_payload.lease_contract_id : '';
  const contractId = request.lease_contract_id || itemContractIds[0] || proposedContractId;
  const linkedUnits = contractUnits.filter((unit) => (unit.lease_contract_id ?? unit.contract?.lease_contract_id) === contractId || itemUnitIds.has(unit.lease_contract_unit_id));
  const resolvedContractId = contractId || linkedUnits[0]?.lease_contract_id || linkedUnits[0]?.contract?.lease_contract_id || '';
  const contract = contracts.find((candidate) => candidate.lease_contract_id === resolvedContractId);
  const propertyId = String(request.proposed_payload.property_id ?? request.source_payload.property_id ?? '');
  const tenantId = String(request.proposed_payload.tenant_id ?? request.source_payload.tenant_id ?? '');
  const linkedPropertyNames = [...new Set(linkedUnits.map((unit) => unit.unit?.asset?.asset_name || properties.find((property) => property.asset_id === unit.unit?.property_id)?.asset_name).filter((name): name is string => Boolean(name)))];
  const property = sourceProperty || properties.find((candidate) => candidate.asset_id === propertyId)?.asset_name || linkedPropertyNames.join('、') || titleProperty || '物件未特定';
  const tenant = sourceTenant || contract?.tenant?.tenant_name || tenants.find((candidate) => candidate.tenant_id === tenantId)?.tenant_name || titleTenant || 'テナント未特定';
  const sourceUnit = sourceValue(request.source_payload, 'unit') || sourceValue(request.source_payload, '区画');
  const unitNames = [...new Set(linkedUnits.map((unit) => [unit.unit?.floor_label, unit.unit?.unit_code, unit.unit?.unit_name].filter(Boolean).join(' ')).filter(Boolean))];
  const unit = sourceUnit || unitNames.join('、');
  return { property, tenant, unit };
}

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

function workflowLinkSummary(link: LinkedContract, contractUnits: ContractUnitOption[]) {
  const linkedUnits = contractUnits.filter((unit) => unit.lease_contract_id === link.lease_contract_id
    && (!link.lease_contract_unit_id || unit.lease_contract_unit_id === link.lease_contract_unit_id));
  const locations = [...new Set(linkedUnits.map((option) => [option.unit?.asset?.asset_name, option.unit?.floor_label, option.unit?.unit_code].filter(Boolean).join(' ')).filter(Boolean))];
  const nestedUnit = link.contract_unit?.unit;
  const nestedLocation = nestedUnit ? [nestedUnit.asset?.asset_name, nestedUnit.floor_label, nestedUnit.unit_code].filter(Boolean).join(' ') : '';
  const location = nestedLocation || locations.join('、') || '物件・階・区画未設定';
  const tenant = link.contract?.tenant?.tenant_name || linkedUnits[0]?.contract?.tenant?.tenant_name || '契約者未設定';
  const startDate = link.contract?.contract_start_date || linkedUnits[0]?.lease_start_date;
  const endDate = link.contract?.contract_end_date || linkedUnits[0]?.lease_end_date;
  return `${location} / ${tenant} / ${startDate ?? '開始日未設定'}～${endDate ?? '継続中'}`;
}

function getImportType(request: ChangeRequest) {
  return request.source_type === 'initial_import' ? request.title.replace(/^取込エラー:\s*/, '') : null;
}

function isReviewOnlyImport(request: ChangeRequest) {
  return request.source_type === 'initial_import'
    && Boolean(request.items?.length)
    && request.items!.every((item) => item.entity_type === 'rent_roll_import_issue');
}

function ChecklistBox({ items }: { items: string[] }) {
  if (!items.length) return null;
  return <section className="change-card change-checklist">
    <p className="section-kicker">確認すること</p>
    <ol>{items.map((item) => <li key={item}>{item}</li>)}</ol>
  </section>;
}

function ChangeSummary({ rows, note }: { rows: { label: string; before: string; after: string }[]; note?: string }) {
  return <section className="change-card">
    <p className="section-kicker">承認すると変わる内容</p>
    {note ? <p className="muted">{note}</p> : null}
    <div className="change-diff-table">
      <div className="change-diff-head"><span>項目</span><span>現在</span><span>変更後</span></div>
      {rows.length
        ? rows.map((row, index) => <div key={`${row.label}-${index}`}><strong>{row.label}</strong><span>{row.before}</span><span className="proposed-value">{row.after}</span></div>)
        : <div><strong>—</strong><span>変更はありません</span><span>—</span></div>}
    </div>
  </section>;
}

function ActionButton({ className, onClick, disabled, label, hint }: { className: string; onClick: () => void; disabled?: boolean; label: string; hint: string }) {
  return <span className="change-action-with-hint"><button type="button" className={className} onClick={onClick} disabled={disabled}>{label}</button><small>{hint}</small></span>;
}

function IssueContext({ request }: { request: ChangeRequest }) {
  const issueType = getImportType(request);
  if (!issueType) return null;
  const sourceRows = Object.entries(request.source_payload).filter(([, value]) => value !== null && value !== undefined && value !== '');
  const importSource = request.items?.find((item) => item.import_issue)?.import_issue;
  const guide: Record<string, { title: string; objective: string; steps: string[] }> = {
    multiple_tenant_codes: {
      title: 'この区画には複数の請求コードが記載されています',
      objective: '記載された全コードを保存し、請求する収入科目との対応を確定します。',
      steps: ['下の「取込元の記載」で、登録対象の全請求コードを確認します。', '「請求コード設定を開く」から、主コード・サブコードと各収入科目の割当を設定します。', 'すべてのコードと科目割当を保存すると、この対応依頼は自動的に確定済みになります。テナントを特定できない場合は「保留」にします。'],
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
    {issueType === 'multiple_tenant_codes' && typeof request.proposed_payload.tenant_id === 'string' ? <div className="change-master-link"><Link className="primary-button" to="/billing-codes">テナント請求を開く</Link><small>請求先コードの状況を確認してください。</small></div> : null}
    <div className="change-diff-table">
      <div className="change-diff-head"><span>ソースシート（物件）</span><span>元Excelファイル</span><span>該当行</span></div>
      <div><strong>{importSource?.source_sheet_name ?? '確認中'}</strong><span>{importSource?.source_file_name ?? '確認中'}</span><span>{importSource?.source_row_number ? `${importSource.source_row_number} 行目` : '行番号なし'}</span></div>
    </div>
    <div className="change-diff-table">
      <div className="change-diff-head"><span>取込元の項目</span><span>記載されていた値</span><span>確認すること</span></div>
      {sourceRows.length ? sourceRows.map(([key, value]) => <div key={key}><strong>{sourceLabels[key] ?? key}</strong><span>{prettyValue(value)}</span><span>{key === 'tenant_code' ? issueType === 'multiple_tenant_codes' ? '全コードを保存し、請求科目へ割り当てる' : '契約書と照合してコードを確認する' : key === 'unit' ? '平面図で実際に含まれる区画を確認する' : '元資料と一致するか確認する'}</span></div>) : <div><strong>取込元データ</strong><span>表示できる項目がありません</span><span>元のExcelレイアウトを確認し、対応メモへ保存場所を記録する</span></div>}
    </div>
    <details className="change-dev-details"><summary>取込ペイロード全体を確認</summary><pre className="change-json-editor">{JSON.stringify(request.source_payload, null, 2)}</pre></details>
    <ChecklistBox items={detail.steps} />
  </section>;
}

function appsuiteRecordUrl(appId: string, dataId: string): string {
  return `https://sk-housing.dn-cloud.com/cgi-bin/dneo/appsuite.cgi?cmd=cdbbrowse&app_id=${appId}#view_id=2&id=${dataId}`;
}

function openAppsuiteRecord(event: React.MouseEvent<HTMLAnchorElement>, url: string) {
  event.preventDefault();
  const popup = window.open(url, 'desknets-workflow', 'popup,width=1280,height=900,resizable=yes,scrollbars=yes');
  if (!popup) window.open(url, '_blank', 'noopener,noreferrer');
}

function AppsuiteSourceContext({ request }: { request: ChangeRequest }) {
  if (request.source_type !== 'desknets') return null;
  const importantFields = ['稟議番号', '取下稟議番号', '物件名', '物件名称', '建物名称', 'テナント名', '契約者名', '会社名', '区画', '申請内容', '取下理由']
    .map((key) => [key, key === '稟議番号' ? (request.source_record?.ringi_number || sourceValue(request.source_payload, key)) : sourceValue(request.source_payload, key)] as const)
    .filter(([, value]) => value);
  const terminationFields = request.request_type === 'contract_terminate'
    ? Object.entries(request.source_payload)
      .map(([key, value]) => [key, formatAppsuiteSourceValue(value)] as const)
      .filter(([, value]) => value)
    : [];
  return <section className="change-card issue-context">
    <p className="section-kicker">APPSUITE APPROVAL</p>
    <h4>{requestTypeLabel[request.request_type] ?? 'AppSuite申請'}の原文</h4>
    <div className="change-diff-table">
      <div className="change-diff-head"><span>項目</span><span>申請内容</span><span>取扱い</span></div>
      {importantFields.map(([key, value]) => <div key={key}><strong>{key}</strong><span>{key === '稟議番号' && request.source_record ? <a href={appsuiteRecordUrl(request.source_record.app_id, request.source_record.data_id)} target="_blank" rel="noreferrer" onClick={(event) => openAppsuiteRecord(event, appsuiteRecordUrl(request.source_record!.app_id, request.source_record!.data_id))}>{value}</a> : value}</span><span>{key === '稟議番号' && request.source_record ? 'クリックしてデスクネッツを別ウインドウで開く' : key === '申請内容' || key === '取下理由' ? '原文を目視確認' : '照合情報'}</span></div>)}
    </div>
    {terminationFields.length > 0 && <details className="change-dev-details"><summary>解約申請の同期項目（{terminationFields.length}項目）</summary><div className="change-diff-table">{terminationFields.map(([key, value]) => <div key={key}><strong>{key}</strong><span style={{ whiteSpace: 'pre-wrap' }}>{value}</span><span>AppSuite同期値</span></div>)}</div></details>}
  </section>;
}

function ParkingFeeRequestEditor({ request, contractUnits, role, working, onWorking, onError, onSaved, onHold }: {
  request: ChangeRequest;
  contractUnits: ContractUnitOption[];
  role: AccountRole;
  working: boolean;
  onWorking: (working: boolean) => void;
  onError: (message: string) => void;
  onSaved: (message: string) => Promise<void>;
  onHold: () => Promise<void>;
}) {
  const payload = request.proposed_payload;
  const scope: ParkingScope | null = payload.parking_scope === 'internal' || payload.parking_scope === 'external'
    ? payload.parking_scope
    : null;
  const propertyId = typeof payload.property_id === 'string' ? payload.property_id : '';
  const tenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id : '';
  const initialStart = typeof payload.contract_start_date === 'string' ? payload.contract_start_date : '';
  const initialEnd = typeof payload.contract_end_date === 'string' ? payload.contract_end_date : '';
  const [monthlyFee, setMonthlyFee] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(initialStart);
  const [parkingContractEndDate, setParkingContractEndDate] = useState(initialEnd);
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
    if (!parkingContractEndDate) { onError('駐車場契約の終了日が未登録です。契約書を確認し、終了日を入力してください。'); return; }
    if (parkingContractEndDate < effectiveFrom) { onError('駐車場契約終了日は適用開始日以降を指定してください。'); return; }
    if (initialStart && parkingContractEndDate < initialStart) { onError('駐車場契約終了日は契約開始日以降を指定してください。'); return; }
    if (!scope) { onError('内部・外部の区分を確認できません。この対応依頼を再チェックしてください。'); return; }
    if (scope === 'internal' && !mainContractUnitId) { onError('内部契約は関連する主契約区画を選択してください。'); return; }
    if (!window.confirm('入力した駐車料を履歴へ反映し、この対応依頼を確定しますか？')) return;
    onWorking(true); onError('');
    const { data, error } = await supabase.rpc('apply_parking_fee_change_request', {
      p_change_request_id: request.change_request_id,
      p_expected_row_version: request.row_version,
      p_monthly_parking_fee: amount,
      p_effective_from: effectiveFrom,
      p_parking_contract_end_date: parkingContractEndDate,
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
    <p>Excel取込では駐車料を登録していません。契約原本を確認し、月額駐車料・適用開始日・駐車場契約終了日を入力してください。</p>
    <ChecklistBox items={['契約原本で月額駐車料・適用開始日・駐車場契約終了日を確認します。', '内部契約の場合は関連する主契約区画を特定します。']} />
    <div className="change-diff-table">
      <div className="change-diff-head"><span>物件・枠</span><span>テナント</span><span>区分</span></div>
      <div><strong>{String(payload.property_name ?? '物件未設定')} / {String(payload.space_number ?? '枠未設定')}</strong><span>{String(payload.tenant_name ?? 'テナント未設定')}</span><span>{scope === 'internal' ? '内部' : scope === 'external' ? '外部' : '区分未設定'}</span></div>
    </div>
    {request.status !== 'applied' && <ChangeSummary rows={[
      { label: '駐車料履歴', before: '未登録', after: monthlyFee.trim() && !Number.isNaN(Number(monthlyFee)) ? `月額${Number(monthlyFee).toLocaleString('ja-JP')}円（${effectiveFrom || '開始日未入力'}〜${parkingContractEndDate || '終了日未入力'}）` : '未入力' },
      ...(scope === 'internal' ? [{ label: '関連する主契約区画', before: '—', after: mainContractUnitId ? (candidates.find((c) => c.lease_contract_unit_id === mainContractUnitId) ? contractUnitLabel(candidates.find((c) => c.lease_contract_unit_id === mainContractUnitId)!) : '選択済み') : '未選択' }] : []),
    ]} />}
    {request.status === 'applied' ? <p className="notice">駐車料は登録済みです。</p> : <div className="change-item-editor">
      <label>月額駐車料<input type="number" min="0" step="1" value={monthlyFee} onChange={(event) => setMonthlyFee(event.target.value)} placeholder="例: 30000" /></label>
      <label>適用開始日<input type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></label>
      <label>駐車場契約終了日<input type="date" value={parkingContractEndDate} onChange={(event) => setParkingContractEndDate(event.target.value)} /></label>
      {scope === 'internal' ? <label>関連する主契約区画<select value={mainContractUnitId} onChange={(event) => setMainContractUnitId(event.target.value)}><option value="">選択してください</option>{candidates.map((candidate) => <option key={candidate.lease_contract_unit_id} value={candidate.lease_contract_unit_id}>{contractUnitLabel(candidate)}｜{candidate.lease_start_date ?? '開始日未設定'}～{candidate.lease_end_date ?? '継続中'}</option>)}</select></label> : null}
      {request.status === 'open' || request.status === 'in_review' ? <ActionButton className="secondary-button" onClick={() => void onHold()} disabled={working} label="保留にする" hint="後で対応するため保留にします。データは変更されません。" /> : request.status === 'on_hold' ? <p className="notice">この対応依頼は保留中です。内容の確定後、そのまま履歴へ反映できます。</p> : null}
      {(role === 'admin' || role === 'manager') ? <ActionButton className="primary-button" onClick={() => void applyParkingFee()} disabled={working} label="履歴へ反映して確定" hint="入力した駐車料を履歴へ登録し、正本データへ反映します。この操作は取り消せません。" /> : <p className="notice">履歴への反映は管理者またはマネージャーが行います。</p>}
    </div>}
  </section>;
}

type RecontractUnitDraft = {
  source_lease_contract_unit_id: string;
  label: string;
  included: boolean;
  leased_area_sqm: string;
  monthly_rent_amount: string;
  monthly_common_charge_amount: string;
  deposit_amount: string;
  security_deposit_amount: string;
  key_money_amount: string;
  renewal_fee_amount: string;
};
type RecontractUnitDefaults = Omit<RecontractUnitDraft, 'label' | 'included'>;

const nextDay = (value: string | null) => {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

function ContractDeadlineRequestEditor({ request, contract, contractUnits, role, working, onWorking, onError, onSaved, onHold }: {
  request: ChangeRequest;
  contract: ContractOption | undefined;
  contractUnits: ContractUnitOption[];
  role: AccountRole;
  working: boolean;
  onWorking: (value: boolean) => void;
  onError: (value: string) => void;
  onSaved: (message: string) => Promise<void>;
  onHold: () => void;
}) {
  const [termType, setTermType] = useState<'ordinary' | 'fixed_term' | ''>(contract?.lease_term_type ?? '');
  const [renewalDueDate, setRenewalDueDate] = useState(contract?.renewal_due_date ?? '');
  const [contractEndDate, setContractEndDate] = useState(contract?.contract_end_date ?? '');
  const [fixedAction, setFixedAction] = useState<'recontract' | 'move_out'>('recontract');
  const [newStartDate, setNewStartDate] = useState(nextDay(contract?.contract_end_date ?? null));
  const [newEndDate, setNewEndDate] = useState('');
  const [actualEndDate, setActualEndDate] = useState(contract?.contract_end_date ?? '');
  const [reason, setReason] = useState('');
  const [unitDrafts, setUnitDrafts] = useState<RecontractUnitDraft[]>(() => contractUnits
    .filter((unit) => unit.contract?.lease_contract_id === contract?.lease_contract_id)
    .map((unit) => ({
      source_lease_contract_unit_id: unit.lease_contract_unit_id,
      label: contractUnitLabel(unit), included: true,
      leased_area_sqm: unit.leased_area_sqm == null ? '' : String(unit.leased_area_sqm),
      monthly_rent_amount: unit.monthly_rent_amount == null ? '' : String(unit.monthly_rent_amount),
      monthly_common_charge_amount: unit.monthly_common_charge_amount == null ? '' : String(unit.monthly_common_charge_amount),
      deposit_amount: unit.deposit_amount == null ? '' : String(unit.deposit_amount),
      security_deposit_amount: unit.security_deposit_amount == null ? '' : String(unit.security_deposit_amount),
      key_money_amount: unit.key_money_amount == null ? '' : String(unit.key_money_amount),
      renewal_fee_amount: unit.renewal_fee_amount == null ? '' : String(unit.renewal_fee_amount),
    })));
  const [confirmationUnits, setConfirmationUnits] = useState<ContractUnitOption[]>([]);
  const canManage = role === 'admin' || role === 'manager';

  useEffect(() => {
    if (!supabase || request.request_type !== 'contract_term_type_confirmation' || !contract?.lease_contract_id) return;
    let cancelled = false;
    void supabase.from('lease_contract_unit')
      .select('lease_contract_unit_id, lease_contract_id, lease_start_date, lease_end_date, unit:unit_master(property_id, unit_type, unit_code, unit_name, floor_label, asset:asset_master(asset_name)), contract:lease_contract(lease_contract_id, tenant_id, contract_status, tenant:tenant_master(tenant_name))')
      .eq('lease_contract_id', contract.lease_contract_id)
      .then(({ data, error }) => {
        if (!cancelled && !error) setConfirmationUnits((data ?? []) as unknown as ContractUnitOption[]);
      });
    return () => { cancelled = true; };
  }, [contract?.lease_contract_id, request.request_type]);

  useEffect(() => {
    if (!supabase || request.request_type !== 'fixed_term_contract_end' || !contract?.lease_contract_id) return;
    let cancelled = false;
    void supabase.rpc('contract_recontract_unit_defaults', { p_lease_contract_id: contract.lease_contract_id })
      .then(({ data, error }) => {
        if (cancelled || error) return;
        const defaultsByUnit = new Map(((data ?? []) as RecontractUnitDefaults[]).map((item) => [item.source_lease_contract_unit_id, item]));
        setUnitDrafts((current) => current.map((item) => {
          const defaults = defaultsByUnit.get(item.source_lease_contract_unit_id);
          return defaults ? {
            ...item,
            leased_area_sqm: defaults.leased_area_sqm == null ? '' : String(defaults.leased_area_sqm),
            monthly_rent_amount: defaults.monthly_rent_amount == null ? '' : String(defaults.monthly_rent_amount),
            monthly_common_charge_amount: defaults.monthly_common_charge_amount == null ? '' : String(defaults.monthly_common_charge_amount),
            deposit_amount: defaults.deposit_amount == null ? '' : String(defaults.deposit_amount),
            security_deposit_amount: defaults.security_deposit_amount == null ? '' : String(defaults.security_deposit_amount),
            key_money_amount: defaults.key_money_amount == null ? '' : String(defaults.key_money_amount),
            renewal_fee_amount: defaults.renewal_fee_amount == null ? '' : String(defaults.renewal_fee_amount),
          } : item;
        }));
      });
    return () => { cancelled = true; };
  }, [contract?.lease_contract_id, request.request_type]);

  if (!contract) return <section className="change-card"><p className="notice">対象契約が見つかりません。</p></section>;

  const relationOne = <T,>(value: T | T[] | null | undefined): T | null => Array.isArray(value) ? value[0] ?? null : value ?? null;
  const fallbackConfirmationUnits = contractUnits.filter((unit) => unit.lease_contract_id === contract?.lease_contract_id || relationOne(unit.contract)?.lease_contract_id === contract?.lease_contract_id);
  const displayedConfirmationUnits = confirmationUnits.length ? confirmationUnits : fallbackConfirmationUnits;
  const confirmationUnitValue = (unit: ContractUnitOption) => {
    const unitMaster = relationOne(unit.unit);
    return [unitMaster?.floor_label, unitMaster?.unit_code, unitMaster?.unit_name].filter(Boolean).join(' ') || '—';
  };

  const confirmTerm = async () => {
    if (!supabase || !canManage || !termType) return;
    if (termType === 'fixed_term' && !contractEndDate) { onError('定期賃貸借の契約終了日は必須です。'); return; }
    onWorking(true); onError('');
    const { error } = await supabase.rpc('confirm_contract_term_type', {
      p_change_request_id: request.change_request_id,
      p_expected_request_row_version: request.row_version,
      p_expected_contract_row_version: contract.row_version,
      p_lease_term_type: termType,
      p_renewal_due_date: termType === 'ordinary' ? renewalDueDate || null : null,
      p_contract_end_date: termType === 'fixed_term' ? contractEndDate : null,
    });
    onWorking(false);
    if (error) { onError(`契約形態を確定できませんでした: ${error.message}`); return; }
    await onSaved('契約形態を確定しました。');
  };

  const resolveFixed = async () => {
    if (!supabase || !canManage || !reason.trim()) return;
    const units = unitDrafts.filter((unit) => unit.included).map(({ included: _included, label: _label, ...unit }) => ({
      ...unit, lease_start_date: newStartDate, lease_end_date: newEndDate,
    }));
    if (fixedAction === 'recontract' && (!newStartDate || !newEndDate || units.length === 0)) {
      onError('再契約の開始日・終了日と対象区画を確認してください。'); return;
    }
    onWorking(true); onError('');
    const { error } = await supabase.rpc('resolve_fixed_term_contract_end', {
      p_change_request_id: request.change_request_id,
      p_expected_request_row_version: request.row_version,
      p_expected_contract_row_version: contract.row_version,
      p_action: fixedAction,
      p_new_contract_start_date: fixedAction === 'recontract' ? newStartDate : null,
      p_new_contract_end_date: fixedAction === 'recontract' ? newEndDate : null,
      p_actual_end_date: fixedAction === 'move_out' ? actualEndDate || null : null,
      p_units: fixedAction === 'recontract' ? units : [],
      p_reason: reason.trim(),
    });
    onWorking(false);
    if (error) { onError(`定期賃貸借の処理を確定できませんでした: ${error.message}`); return; }
    await onSaved(fixedAction === 'recontract' ? '旧契約を保持して再契約を作成しました。' : '退去の実終了日を確定しました。');
  };

  if (request.request_type === 'contract_term_type_confirmation') return <>
    <section className="change-card">
      <h4>対象契約</h4>
      <div className="change-diff-table contract-confirmation-table">
        <div className="change-diff-head"><span>項目</span><span>内容</span></div>
        <div><strong>物件</strong><span>{relationOne(relationOne(displayedConfirmationUnits[0]?.unit)?.asset)?.asset_name ?? '—'}</span></div>
        <div><strong>種別</strong><span>{displayedConfirmationUnits.length ? [...new Set(displayedConfirmationUnits.map((unit) => relationOne(unit.unit)?.unit_type).filter(Boolean))].join('、') : '—'}</span></div>
        <div><strong>区画</strong><span>{displayedConfirmationUnits.length ? displayedConfirmationUnits.map(confirmationUnitValue).join('、') : '—'}</span></div>
        <div><strong>契約者名</strong><span>{contract?.tenant?.tenant_name ?? '—'}</span></div>
        <div><strong>契約開始日</strong><span>{contract?.contract_start_date ?? '—'}</span></div>
      </div>
    </section>
    <section className="change-card">
    <h4>契約書で契約形態を確認</h4><p>既存日付から推測せず、契約書の記載を確認して確定します。</p>
    <ChecklistBox items={['契約書で普通賃貸借か定期賃貸借かを確認します。', '定期賃貸借の場合は契約終了日も確認します。']} />
    <div className="change-item-editor">
      <label>契約形態<select value={termType} disabled={!canManage} onChange={(event) => setTermType(event.target.value as typeof termType)}><option value="">選択してください</option><option value="ordinary">普通賃貸借</option><option value="fixed_term">定期賃貸借</option></select></label>
      {termType === 'ordinary' ? <label>次回更新予定日<input type="date" value={renewalDueDate} onChange={(event) => setRenewalDueDate(event.target.value)} /></label> : null}
      {termType === 'fixed_term' ? <label>契約終了日<input type="date" value={contractEndDate} onChange={(event) => setContractEndDate(event.target.value)} /></label> : null}
    </div>
    {termType && <ChangeSummary rows={[
      { label: '契約形態', before: contract.lease_term_type ? (contract.lease_term_type === 'ordinary' ? '普通賃貸借' : '定期賃貸借') : '未確認', after: termType === 'ordinary' ? '普通賃貸借' : '定期賃貸借' },
      ...(termType === 'ordinary' ? [{ label: '次回更新予定日', before: contract.renewal_due_date || '—', after: renewalDueDate || '未入力' }] : []),
      ...(termType === 'fixed_term' ? [{ label: '契約終了日', before: contract.contract_end_date || '—', after: contractEndDate || '未入力' }] : []),
    ]} />}
    <ActionButton className="primary-button" onClick={() => void confirmTerm()} disabled={working || !canManage || !termType} label="契約形態を確定" hint="内容を正本データへ反映します。" />
  </section>;

  const isOrdinaryContract = contract.lease_term_type === 'ordinary' || Boolean(contract.renewal_due_date);
  if (request.request_type === 'contract_renewal_due' || (request.request_type !== 'contract_term_type_confirmation' && isOrdinaryContract)) return <section className="change-card">
    <h4>普通賃貸借の自動更新</h4><p>初回登録時に設定した次回更新予定日を基準に、月次処理で1年間自動更新します。解約・終了予定の契約は自動更新されません。</p>
    <ChecklistBox items={['この対応依頼は月次の自動更新処理で処理されます。', '自動更新が完了すると対応依頼は「確定済み（applied）」になります。']} />
    <ChangeSummary rows={[{ label: '現在の次回更新予定日', before: contract.renewal_due_date || '—', after: '自動更新待ち' }]} />
  </section>
  </>;

  return <section className="change-card">
    <h4>定期賃貸借の終了対応</h4><p>旧契約は変更・削除せず、再契約時は新しい契約を作成します。</p>
    <ChecklistBox items={['契約書・退去連絡を確認し、再契約か退去かを判断します。', '再契約の場合は新しい契約期間と対象区画の条件を確認します。']} />
    <label>対応<select value={fixedAction} onChange={(event) => setFixedAction(event.target.value as typeof fixedAction)}><option value="recontract">再契約</option><option value="move_out">退去</option></select></label>
    {fixedAction === 'recontract' ? <>
      <div className="change-item-editor"><label>新契約開始日<input type="date" value={newStartDate} onChange={(event) => setNewStartDate(event.target.value)} /></label><label>新契約終了日<input type="date" value={newEndDate} onChange={(event) => setNewEndDate(event.target.value)} /></label></div>
      <div className="change-diff-table"><div className="change-diff-head"><span>対象区画</span><span>面積</span><span>月額賃料 / 共益費</span></div>{unitDrafts.map((unit, index) => <div key={unit.source_lease_contract_unit_id}><label><input type="checkbox" checked={unit.included} onChange={(event) => setUnitDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, included: event.target.checked } : item))} />{unit.label}</label><input aria-label="契約面積" value={unit.leased_area_sqm} disabled={!unit.included} onChange={(event) => setUnitDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, leased_area_sqm: event.target.value } : item))} /><span><input aria-label="月額賃料" value={unit.monthly_rent_amount} disabled={!unit.included} onChange={(event) => setUnitDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, monthly_rent_amount: event.target.value } : item))} /> / <input aria-label="月額共益費" value={unit.monthly_common_charge_amount} disabled={!unit.included} onChange={(event) => setUnitDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, monthly_common_charge_amount: event.target.value } : item))} /></span></div>)}</div>
      <div className="change-diff-table"><div className="change-diff-head"><span>対象区画</span><span>敷金 / 保証金</span><span>礼金 / 更新料</span></div>{unitDrafts.map((unit, index) => unit.included ? <div key={`terms-${unit.source_lease_contract_unit_id}`}><strong>{unit.label}</strong><span><input aria-label="敷金" value={unit.deposit_amount} onChange={(event) => setUnitDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, deposit_amount: event.target.value } : item))} /> / <input aria-label="保証金" value={unit.security_deposit_amount} onChange={(event) => setUnitDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, security_deposit_amount: event.target.value } : item))} /></span><span><input aria-label="礼金" value={unit.key_money_amount} onChange={(event) => setUnitDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, key_money_amount: event.target.value } : item))} /> / <input aria-label="更新料" value={unit.renewal_fee_amount} onChange={(event) => setUnitDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, renewal_fee_amount: event.target.value } : item))} /></span></div> : null)}</div>
    </> : <label>実終了日<input type="date" value={actualEndDate} onChange={(event) => setActualEndDate(event.target.value)} /></label>}
    <label>確認理由<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="確認した契約書・退去連絡等を記載" /></label>
    <ChangeSummary rows={fixedAction === 'recontract' ? [
      { label: '新契約期間', before: '—', after: `${newStartDate || '開始日未入力'} ～ ${newEndDate || '終了日未入力'}` },
      { label: '対象区画数', before: '—', after: `${unitDrafts.filter((u) => u.included).length}件` },
    ] : [
      { label: '実終了日', before: contract.contract_end_date || '—', after: actualEndDate || '未入力' },
    ]} />
    <div className="change-actions">
      <ActionButton className="secondary-button" onClick={onHold} disabled={working} label="その他確認として保留" hint="後で対応するため保留にします。データは変更されません。" />
      <ActionButton className="primary-button" onClick={() => void resolveFixed()} disabled={working || !canManage || !reason.trim()} label={fixedAction === 'recontract' ? '再契約を作成' : '退去を確定'} hint="内容を正本データへ反映します。この操作は取り消せません。" />
    </div>
  </section>;
}

function AppsuiteContractEditor({ request, properties, tenants, units, contracts, contractUnits, role, working, onWorking, onError, onSaved }: {
  request: ChangeRequest; properties: PropertyOption[]; tenants: TenantOption[]; units: UnitOption[]; contracts: ContractOption[];
  contractUnits: ContractUnitOption[]; role: AccountRole; working: boolean; onWorking: (value: boolean) => void;
  onError: (value: string) => void; onSaved: (message: string) => Promise<void>;
}) {
  const sourceProperty = sourceValue(request.source_payload, '物件名') || sourceValue(request.source_payload, '物件名称') || sourceValue(request.source_payload, '建物名称');
  const sourceTenant = guessSourceTenantName(request.source_payload);
  const sortedContracts = useMemo(() => [...contracts].sort((a, b) => (a.tenant?.tenant_name ?? '').localeCompare(b.tenant?.tenant_name ?? '', 'ja-JP')), [contracts]);
  const contractFilter = useTextFilter(sortedContracts, sourceTenant, (c) => `${c.tenant?.tenant_name ?? ''} ${c.contract_type ?? ''}`);
  const tenantFilter = useTextFilter(tenants, sourceTenant, (t) => `${t.tenant_name} ${t.external_tenant_code ?? ''}`);
  const propertyNameById = useMemo(() => new Map(properties.map((p) => [p.asset_id, p.asset_name])), [properties]);
  const activeUnits = useMemo(() => units.filter((unit) => unit.is_active), [units]);
  const unitFilter = useTextFilter(activeUnits, sourceProperty, (u) => `${propertyNameById.get(u.property_id) ?? ''} ${u.floor_label ?? ''} ${u.unit_code} ${u.unit_name ?? ''}`);
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
  const [operationEffectiveDate, setOperationEffectiveDate] = useState('');
  const [operations, setOperations] = useState<ContractOperation[]>(Array.isArray(request.proposed_payload.operations) ? request.proposed_payload.operations as ContractOperation[] : []);
  const [noSystemReason, setNoSystemReason] = useState(String(request.proposed_payload.no_system_reason ?? ''));
  const [candidates, setCandidates] = useState<CancellationCandidate[]>([]);
  const [targetRecordId, setTargetRecordId] = useState(request.target_appsuite_record_id ?? '');
  const [cancelMode, setCancelMode] = useState<'source_only' | 'create_contract_follow_up'>((request.proposed_payload.mode as 'source_only' | 'create_contract_follow_up') ?? 'source_only');
  const [cancelNote, setCancelNote] = useState(String(request.proposed_payload.note ?? ''));
  const [directTargetUnits, setDirectTargetUnits] = useState<ContractUnitOption[]>([]);

  const targetContractUnits = (directTargetUnits.length ? directTargetUnits : contractUnits).filter((unit) =>
    unit.lease_contract_id === targetContractId || unit.contract?.lease_contract_id === targetContractId,
  );

  useEffect(() => {
    if (!supabase || !targetContractId || request.request_type !== 'contract_update') {
      setDirectTargetUnits([]);
      return;
    }
    let cancelled = false;
    void supabase.from('lease_contract_unit')
      .select('lease_contract_unit_id, lease_contract_id, lease_start_date, lease_end_date, leased_area_sqm, monthly_rent_amount, monthly_common_charge_amount, deposit_amount, security_deposit_amount, key_money_amount, renewal_fee_amount, unit:unit_master(property_id, unit_type, unit_code, unit_name, floor_label, building_wing:building_wing_master(wing_code, wing_name), asset:asset_master(asset_name)), contract:lease_contract(lease_contract_id, tenant_id, contract_status, tenant:tenant_master(tenant_name))')
      .eq('lease_contract_id', targetContractId)
      .then(({ data, error }) => {
        if (!cancelled && !error) setDirectTargetUnits((data ?? []) as unknown as ContractUnitOption[]);
      });
    return () => { cancelled = true; };
  }, [request.request_type, supabase, targetContractId]);

  useEffect(() => {
    if (operationKind !== 'unit' || operationTarget || targetContractUnits.length !== 1) return;
    setOperationTarget(targetContractUnits[0].lease_contract_unit_id);
  }, [operationKind, operationTarget, targetContractUnits]);

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

  const propertyUnits = useMemo(() => {
    const typeOrder: Record<string, number> = { parking: 0, bicycle_parking: 1, signage: 2, antenna: 3, warehouse: 4, office: 5, residential: 6, retail: 7, other: 8 };
    const contractUnitType = ({ parking: 'parking', bicycle_parking: 'bicycle_parking', warehouse: 'warehouse', signage: 'signage', antenna: 'antenna' } as Record<string, string | undefined>)[contractType];
    return units
      .filter((unit) => unit.property_id === propertyId && unit.is_active && (!contractUnitType || unit.unit_type === contractUnitType || (contractType === 'lease' || contractType === 'ordinary_lease' || contractType === 'fixed_term_lease') && ['office', 'residential', 'retail'].includes(unit.unit_type ?? '')))
      .sort((a, b) => (typeOrder[a.unit_type ?? 'other'] ?? 99) - (typeOrder[b.unit_type ?? 'other'] ?? 99) || a.unit_code.localeCompare(b.unit_code, 'ja-JP'));
  }, [contractType, propertyId, units]);
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
    if (operationKind === 'unit' && operationField === 'monthly_rent_amount' && !operationEffectiveDate) { onError('賃料の適用開始日を入力してください。'); return; }
    if ((operationKind !== 'contract' && !operationTarget) || !operationValue.trim()) { onError('変更対象と値を入力してください。'); return; }
    const operation: ContractOperation = operationKind === 'contract'
      ? { action: 'set_field', entity_type: 'lease_contract', field_name: operationField, value: operationValue.trim() }
      : operationKind === 'unit'
        ? { action: 'set_field', entity_type: 'lease_contract_unit', entity_id: operationTarget, field_name: operationField, value: operationValue.trim(), ...(operationField === 'monthly_rent_amount' ? { effective_date: operationEffectiveDate } : {}) }
        : operationKind === 'link'
          ? { action: 'link_unit', unit_id: operationTarget, value: { lease_start_date: operationValue.trim() } }
          : { action: 'unlink_unit', entity_id: operationTarget, value: { effective_date: operationValue.trim() } };
    setOperations((current) => [...current, operation]); setOperationValue(''); setOperationEffectiveDate(''); onError('');
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
    <ChecklistBox items={['原文の物件名・テナント名・契約期間を確認します。', 'システムに一致する物件・テナントがあるか検索します。', 'リーシング区画と各区画の賃料・面積を契約書と照合します。']} />
    <div className="change-item-editor">
      <label>物件<select value={propertyId} onChange={(e) => { setPropertyId(e.target.value); setSelectedUnitIds([]); }}><option value="">選択してください</option>{properties.map((item) => <option key={item.asset_id} value={item.asset_id}>{item.asset_name}</option>)}</select></label>
      <label>既存テナント
        <input value={tenantFilter.query} onChange={(e) => tenantFilter.setQuery(e.target.value)} placeholder="テナント名・コードで絞り込み" />
        <select value={tenantId} onChange={(e) => { setTenantId(e.target.value); if (e.target.value) setNewTenantName(''); }}>
          <option value="">新規テナントとして入力</option>
          {tenantId && !tenantFilter.filtered.some((t) => t.tenant_id === tenantId) && (() => { const current = tenants.find((t) => t.tenant_id === tenantId); return current ? <option value={current.tenant_id}>{current.tenant_name}（選択中）</option> : null; })()}
          {tenantFilter.filtered.map((item) => <option key={item.tenant_id} value={item.tenant_id}>{item.tenant_name}</option>)}
        </select>
      </label>
      {!tenantId && <label>新規テナント名<input value={newTenantName} onChange={(e) => setNewTenantName(e.target.value)} /></label>}
      <label>契約種別<select value={contractType} onChange={(e) => { setContractType(e.target.value); setSelectedUnitIds([]); setUnitDrafts({}); }}><option value="lease">lease（通常契約）</option><option value="ordinary_lease">普通賃貸借</option><option value="fixed_term_lease">定期賃貸借</option><option value="parking">駐車場</option><option value="bicycle_parking">駐輪場</option><option value="warehouse">倉庫</option><option value="signage">看板</option><option value="antenna">アンテナ</option><option value="other">その他</option></select></label>
      <label>開始日<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label><label>終了日<input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
    </div>
    <div className="change-unit-picker"><strong>リーシング区画（{propertyUnits.length}件）</strong><p className="muted">契約種別に合う区画だけを表示しています。契約種別を変更すると候補も切り替わります。</p>{propertyUnits.map((unit) => <label key={unit.unit_id} className="check"><input type="checkbox" checked={selectedUnitIds.includes(unit.unit_id)} onChange={(e) => setSelectedUnitIds((current) => e.target.checked ? [...current, unit.unit_id] : current.filter((id) => id !== unit.unit_id))} />{unit.floor_label ?? '階未設定'}｜{unit.unit_code} {unit.unit_name ?? ''}（{unit.unit_type === 'parking' ? '駐車場' : unit.unit_type === 'bicycle_parking' ? '駐輪場' : unit.unit_type === 'signage' ? '看板' : unit.unit_type === 'antenna' ? 'アンテナ' : unit.unit_type === 'warehouse' ? '倉庫' : unit.unit_type === 'office' ? '貸室' : unit.unit_type ?? '区画'}）</label>)}</div>
    {selectedUnitIds.map((unitId) => { const unit = units.find((item) => item.unit_id === unitId); const draft = unitDrafts[unitId] ?? {}; const change = (field: string, value: string) => setUnitDrafts((current) => ({ ...current, [unitId]: { ...(current[unitId] ?? {}), [field]: value } })); return <div className="change-item-editor" key={unitId}><strong>{unit?.floor_label}｜{unit?.unit_code}</strong><label>面積<input type="number" value={String(draft.leased_area_sqm ?? '')} onChange={(e) => change('leased_area_sqm', e.target.value)} /></label><label>月額賃料<input type="number" value={String(draft.monthly_rent_amount ?? '')} onChange={(e) => change('monthly_rent_amount', e.target.value)} /></label><label>共益費<input type="number" value={String(draft.monthly_common_charge_amount ?? '')} onChange={(e) => change('monthly_common_charge_amount', e.target.value)} /></label><label>敷金・保証金<input type="number" value={String(draft.deposit_amount ?? '')} onChange={(e) => change('deposit_amount', e.target.value)} /></label></div>; })}
    <ChangeSummary rows={[
      { label: '物件名', before: '—', after: properties.find((p) => p.asset_id === propertyId)?.asset_name ?? '未選択' },
      { label: 'テナント', before: '—', after: (tenantId ? tenants.find((t) => t.tenant_id === tenantId)?.tenant_name : newTenantName) || '未入力' },
      { label: '契約期間', before: '—', after: `${startDate || '未入力'} ～ ${endDate || '未入力'}` },
      { label: '選択区画数', before: '—', after: `${selectedUnitIds.length}件` },
    ]} />
    <ActionButton className="secondary-button" onClick={() => void saveCreate()} disabled={working} label="契約下書きを保存" hint="入力内容を保存します。正本データはまだ変更されません。" />
  </section>;

  if (request.request_type === 'contract_update' || request.request_type === 'contract_cancellation_review') return <section className="change-card">
    <h4>契約変更を目視確認して入力</h4><p>申請原文は自動解釈しません。対象と変更値を1件ずつ登録します。</p>
    <ChecklistBox items={['原文の変更内容を確認します。', '対象契約と変更項目を1件ずつ、契約書原本と照合しながら入力します。', '本システムに対象項目がない場合は理由を記録します。']} />
    <label>対象契約
      <input value={contractFilter.query} onChange={(e) => contractFilter.setQuery(e.target.value)} placeholder="テナント名で絞り込み" />
      <select value={targetContractId} onChange={(e) => { setTargetContractId(e.target.value); setOperations([]); }}>
        <option value="">選択してください（{contractFilter.filtered.length}件中）</option>
        {targetContractId && !contractFilter.filtered.some((c) => c.lease_contract_id === targetContractId) && (() => { const current = contracts.find((c) => c.lease_contract_id === targetContractId); return current ? <option value={current.lease_contract_id}>{current.tenant?.tenant_name ?? 'テナント未設定'}｜{current.contract_start_date ?? '開始日未設定'}｜{current.contract_type ?? '種別未設定'}（選択中）</option> : null; })()}
        {contractFilter.filtered.map((contract) => <option key={contract.lease_contract_id} value={contract.lease_contract_id}>{contract.tenant?.tenant_name ?? 'テナント未設定'}｜{contract.contract_start_date ?? '開始日未設定'}｜{contract.contract_type ?? '種別未設定'}</option>)}
      </select>
    </label>
    <div className="change-item-editor">
      <label>操作<select value={operationKind} onChange={(e) => { const next = e.target.value as typeof operationKind; setOperationKind(next); setOperationTarget(''); setOperationField(next === 'contract' ? 'contract_type' : 'monthly_rent_amount'); }}><option value="contract">契約項目を変更</option><option value="unit">契約区画項目を変更</option><option value="link">区画を追加</option><option value="unlink">区画を解除</option></select></label>
      {operationKind === 'contract' ? <label>対象契約<input value={targetContractId ? '選択中の契約' : ''} disabled /></label> : operationKind === 'link' ? <label>追加区画
        <input value={unitFilter.query} onChange={(e) => unitFilter.setQuery(e.target.value)} placeholder="物件名・区画コードで絞り込み" />
        <select value={operationTarget} onChange={(e) => setOperationTarget(e.target.value)}>
          <option value="">選択してください（{unitFilter.filtered.length}件中）</option>
          {unitFilter.filtered.map((unit) => <option key={unit.unit_id} value={unit.unit_id}>{propertyNameById.get(unit.property_id) ?? '物件未設定'}｜{unit.floor_label ?? '階未設定'}｜{unit.unit_code}</option>)}
        </select>
      </label> : <label>契約区画<select value={operationTarget} onChange={(e) => setOperationTarget(e.target.value)}><option value="">選択してください</option>{targetContractUnits.map((unit) => <option key={unit.lease_contract_unit_id} value={unit.lease_contract_unit_id}>{contractUnitLabel(unit)}</option>)}</select></label>}
      {(operationKind === 'contract' || operationKind === 'unit') && <label>項目<select value={operationField} onChange={(e) => setOperationField(e.target.value)}>{operationKind === 'contract' ? [['contract_type', '契約種別'], ['contract_start_date', '契約開始日'], ['contract_end_date', '契約終了日'], ['renewal_terms', '更新条件'], ['payment_terms', '支払条件'], ['notes', '備考']].map(([value, label]) => <option value={value} key={value}>{label}</option>) : editableFields.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}
      <label>{operationKind === 'unlink' ? '解除効力発生日' : operationKind === 'link' ? '利用開始日' : '反映予定値'}<input value={operationValue} onChange={(e) => setOperationValue(e.target.value)} /></label><button className="secondary-button" onClick={addOperation}>変更を追加</button>
    </div>
    {operationKind === 'unit' && operationField === 'monthly_rent_amount' && <label>賃料適用開始日<input type="date" value={operationEffectiveDate} onChange={(e) => setOperationEffectiveDate(e.target.value)} /></label>}
    <ChangeSummary rows={operations.map((op) => ({ label: op.field_name ?? op.entity_id ?? op.unit_id ?? op.action, before: op.action, after: `${prettyValue(op.value)}${op.effective_date ? `（適用開始日：${op.effective_date}）` : ''}` }))} />
    <ol>{operations.map((operation, index) => <li key={`${operation.action}-${index}`}>{operation.action}｜{operation.field_name ?? operation.entity_id ?? operation.unit_id}｜{prettyValue(operation.value)}{operation.effective_date ? `（適用開始日：${operation.effective_date}）` : ''} <button className="text-button" onClick={() => setOperations((current) => current.filter((_, itemIndex) => itemIndex !== index))}>削除</button></li>)}</ol>
    <label>本システムに対象項目がない場合の理由<textarea value={noSystemReason} onChange={(e) => setNoSystemReason(e.target.value)} placeholder="例：連帯保証人は本システムの管理対象外。契約原本側で確認済み。" /></label>
    <ActionButton className="secondary-button" onClick={() => void saveUpdate()} disabled={working} label="目視確認結果を保存" hint="入力内容を保存します。正本データはまだ変更されません。" />
  </section>;

  if (request.request_type === 'approval_cancel') return <section className="change-card">
    <h4>決裁済み稟議の取消確認</h4><p>取下稟議番号と一致した候補だけを表示します。既存契約は自動変更されません。</p>
    <ChecklistBox items={['取下稟議番号に一致する決裁済み稟議を確認します。', '取消後、契約データの確認も必要かを判断します。']} />
    {candidates.length === 0 ? <p className="notice">一致する決裁済み稟議がありません。対象フォームを同期してから再確認してください。</p> : <div className="change-diff-table"><div className="change-diff-head"><span>対象</span><span>物件・テナント</span><span>反映状態</span></div>{candidates.map((candidate) => <label key={candidate.appsuite_record_id}><span><input type="radio" checked={targetRecordId === candidate.appsuite_record_id} onChange={() => setTargetRecordId(candidate.appsuite_record_id)} /> {candidate.ringi_number}</span><span>{candidate.property_name ?? '物件未設定'} / {candidate.tenant_name ?? 'テナント未設定'}</span><span>{candidate.is_cancelled ? '取消済み' : candidate.lease_contract_id ? '契約反映済み' : '未反映'}</span></label>)}</div>}
    <label>取消後の処理<select value={cancelMode} onChange={(e) => setCancelMode(e.target.value as typeof cancelMode)}><option value="source_only">稟議連携だけ取消</option><option value="create_contract_follow_up">反映済み契約の確認タスクも作成</option></select></label>
    <label>確認メモ<textarea value={cancelNote} onChange={(e) => setCancelNote(e.target.value)} placeholder="対象稟議、申請理由、確認資料を記録" /></label>
    <ChangeSummary rows={[
      { label: '対象稟議', before: '—', after: candidates.find((c) => c.appsuite_record_id === targetRecordId)?.ringi_number ?? '未選択' },
      { label: '取消後の処理', before: '—', after: cancelMode === 'create_contract_follow_up' ? '確認タスクも作成' : '稟議連携だけ取消' },
    ]} />
    {request.status !== 'resolved' && <ActionButton className="secondary-button" onClick={() => void saveCancellation()} disabled={working || !candidates.length} label="取消確認を保存" hint="入力内容を保存します。正本データはまだ変更されません。" />}
    {request.status === 'resolved' && (role === 'admin' || role === 'manager') && <ActionButton className="primary-button" onClick={() => void confirmCancellation()} disabled={working} label="管理者として取消を最終確定" hint="対象の稟議を取消済みとして正本データに反映します。" />}
    {request.status === 'resolved' && role !== 'admin' && role !== 'manager' && <p className="notice">最終確定は管理者またはマネージャーが行います。</p>}
  </section>;
  return null;
}

export function ChangeRequestWorkbenchPage({ role }: { role: AccountRole }) {
  const [searchParams] = useSearchParams();
  const parkingTarget = searchParams.get('parking');
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<RequestStatus>('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [page, setPage] = useState(1);
  const [archiveLoaded, setArchiveLoaded] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveCount, setArchiveCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [rechecking, setRechecking] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [contractUnits, setContractUnits] = useState<ContractUnitOption[]>([]);
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [contracts, setContracts] = useState<ContractOption[]>([]);
  const [workflowCandidates, setWorkflowCandidates] = useState<WorkflowContractCandidate[]>([]);
  const [workflowLinks, setWorkflowLinks] = useState<LinkedContract[]>([]);
  const [workflowLinksRecordId, setWorkflowLinksRecordId] = useState<string | null>(null);
  const [manualContractSearch, setManualContractSearch] = useState('');
  const [manualContractId, setManualContractId] = useState('');
  const [terminationContractIds, setTerminationContractIds] = useState<string[]>([]);
  const [verifiedLinkIds, setVerifiedLinkIds] = useState<string[]>([]);
  const [confirmedFields, setConfirmedFields] = useState<Record<string, boolean>>({});
  const [reconciliationNote, setReconciliationNote] = useState('');
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [historicalCandidates, setHistoricalCandidates] = useState<HistoricalContractCandidate[]>([]);
  const [historicalCandidateLoading, setHistoricalCandidateLoading] = useState(false);
  const [terminationScope, setTerminationScope] = useState<'contract' | 'unit' | 'parking'>('contract');
  const [terminationUnitIds, setTerminationUnitIds] = useState<string[]>([]);
  const [terminationDate, setTerminationDate] = useState('');
  const [snapshotDate, setSnapshotDate] = useState('2026-08-31');
  const [snapshotFile, setSnapshotFile] = useState('');
  const [snapshotSheet, setSnapshotSheet] = useState('');
  const [snapshotRow, setSnapshotRow] = useState('');
  const [snapshotResult, setSnapshotResult] = useState<'rent_roll_only' | 'not_found' | 'uncertain'>('rent_roll_only');
  const [itemUnitId, setItemUnitId] = useState('');
  const [itemUnitSearch, setItemUnitSearch] = useState('');
  const [itemField, setItemField] = useState<(typeof editableFields)[number][0]>('leased_area_sqm');
  const [itemValue, setItemValue] = useState('');
  const archiveLoadedRef = useRef(false);

  const loadRequests = useCallback(async (includeArchive = archiveLoadedRef.current) => {
    if (!supabase) return;
    const client = supabase;
    setLoading(true); setError('');
    const selectFields = 'change_request_id, request_type, status, source_type, title, summary, source_payload, proposed_payload, source_appsuite_record_id, target_appsuite_record_id, lease_contract_id, row_version, updated_at, source_record:appsuite_record!source_appsuite_record_id(appsuite_record_id, app_id, data_id, ringi_number), items:change_request_item(change_request_item_id, entity_type, entity_id, field_name, current_value, proposed_value, validation_status, validation_message, import_issue:rent_roll_import_issue(source_file_name, source_sheet_name, source_row_number)), comments:change_request_comment(change_request_comment_id, body, created_at), action_logs:change_request_action_log(change_request_action_log_id, action_type, previous_status, next_status, details, performed_by, created_at)';
    const activeResult = await fetchAllPages<ChangeRequest>((from, to) => client.from('change_request')
      .select(selectFields)
      .in('status', [...ACTIVE_REQUEST_STATUSES])
      .order('change_request_id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<PageResponse<ChangeRequest>>);
    const [archiveCountResult, archiveResult] = await Promise.all([
      client.from('change_request').select('change_request_id', { count: 'exact', head: true }).in('status', [...ARCHIVED_REQUEST_STATUSES]),
      includeArchive
        ? fetchAllPages<ChangeRequest>((from, to) => client.from('change_request')
          .select(selectFields)
          .in('status', [...ARCHIVED_REQUEST_STATUSES])
          .order('change_request_id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResponse<ChangeRequest>>)
        : Promise.resolve({ data: [] as ChangeRequest[], error: null }),
    ]);
    setLoading(false);
    if (activeResult.error) { setError(`作業中の案件を読み込めませんでした: ${activeResult.error.message}`); return; }
    if (archiveCountResult.error) setError(`完了分の件数を取得できませんでした: ${archiveCountResult.error.message}`);
    else setArchiveCount(archiveCountResult.count ?? 0);
    if (archiveResult.error) { setError(`完了分を読み込めませんでした: ${archiveResult.error.message}`); return; }
    let result = [...(activeResult.data ?? []), ...(archiveResult.data ?? [])];
    const missingRecordRequests = result.filter((request) => request.source_type === 'desknets' && !request.source_record);
    const missingDataIds = [...new Set(missingRecordRequests.map((request) => sourceValue(request.source_payload, 'データID')).filter(Boolean))];
    if (missingDataIds.length) {
      const batches = await Promise.all(Array.from({ length: Math.ceil(missingDataIds.length / 250) }, (_, index) => {
        const ids = missingDataIds.slice(index * 250, (index + 1) * 250);
        return fetchAllPages<AppSuiteRecordRef>((from, to) => client.from('appsuite_record')
          .select('appsuite_record_id, app_id, data_id, ringi_number')
          .in('data_id', ids)
          .order('data_id', { ascending: true })
          .order('app_id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResponse<AppSuiteRecordRef>>);
      }));
      const sourceMatches = new Map<string, AppSuiteRecordRef[]>();
      for (const batch of batches) {
        if (batch.error) continue;
        for (const record of batch.data ?? []) sourceMatches.set(record.data_id, [...(sourceMatches.get(record.data_id) ?? []), record]);
      }
      if (batches.some((batch) => batch.error)) setError('稟議番号とAppSuite原文リンクの照合に失敗した依頼があります。');
      result = result.map((request) => {
        if (request.source_type !== 'desknets' || request.source_record) return request;
        const dataId = sourceValue(request.source_payload, 'データID');
        const payloadAppId = sourceValue(request.source_payload, 'AppSuiteアプリID') || sourceValue(request.source_payload, 'アプリID') || sourceValue(request.source_payload, 'app_id');
        const expectedAppId = payloadAppId || (request.request_type === 'contract_create' ? '65' : '');
        const matches = (sourceMatches.get(dataId) ?? []).filter((record) => !expectedAppId || record.app_id === expectedAppId);
        return matches.length === 1 ? { ...request, source_record: matches[0] } : request;
      });
    }
    setRequests(result);
    const parkingRequest = parkingTarget ? result.find((request) => request.items?.some((item) => item.entity_type === 'parking_fee_history' && item.entity_id === parkingTarget)) : null;
    setSelectedId((current) => parkingRequest?.change_request_id ?? current);
  }, [parkingTarget]);

  const toggleArchivedRequests = async () => {
    if (archiveLoadedRef.current) {
      archiveLoadedRef.current = false;
      setArchiveLoaded(false);
      setRequests((current) => current.filter((request) => ACTIVE_REQUEST_STATUSES.includes(request.status as typeof ACTIVE_REQUEST_STATUSES[number])));
      setFilter('all'); setPage(1);
      return;
    }
    archiveLoadedRef.current = true;
    setArchiveLoaded(true); setArchiveLoading(true); setPage(1);
    await loadRequests(true);
    setArchiveLoading(false);
  };

  useEffect(() => { void loadRequests(); }, [loadRequests]);
  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    void Promise.all([
      fetchAllPages<ContractUnitOption>((from, to) => client.from('lease_contract_unit').select('lease_contract_unit_id, lease_contract_id, lease_start_date, lease_end_date, leased_area_sqm, monthly_rent_amount, monthly_common_charge_amount, deposit_amount, security_deposit_amount, key_money_amount, renewal_fee_amount, unit:unit_master(property_id, unit_type, unit_code, unit_name, floor_label, building_wing:building_wing_master(wing_code, wing_name), asset:asset_master(asset_name), parking_space:parking_space_master(space_number)), contract:lease_contract(lease_contract_id, tenant_id, contract_status, tenant:tenant_master(tenant_name))').order('lease_contract_unit_id', { ascending: true }).range(from, to) as unknown as PromiseLike<PageResponse<ContractUnitOption>>),
      fetchAllPages<PropertyOption>((from, to) => client.from('asset_master').select('asset_id, asset_name').order('asset_id', { ascending: true }).range(from, to) as unknown as PromiseLike<PageResponse<PropertyOption>>),
      fetchAllPages<TenantOption>((from, to) => client.from('tenant_master').select('tenant_id, tenant_name, external_tenant_code').order('tenant_id', { ascending: true }).range(from, to) as unknown as PromiseLike<PageResponse<TenantOption>>),
      fetchAllPages<UnitOption>((from, to) => client.from('unit_master').select('unit_id, property_id, unit_code, unit_name, floor_label, unit_type, is_active').order('unit_id', { ascending: true }).range(from, to) as unknown as PromiseLike<PageResponse<UnitOption>>),
      fetchAllPages<ContractOption>((from, to) => client.from('lease_contract').select('lease_contract_id, tenant_id, row_version, contract_status, contract_type, lease_term_type, contract_start_date, contract_end_date, renewal_due_date, actual_end_date, tenant:tenant_master(tenant_name)').neq('contract_status', 'draft').order('lease_contract_id', { ascending: true }).range(from, to) as unknown as PromiseLike<PageResponse<ContractOption>>),
    ]).then(([contractUnitResult, propertyResult, tenantResult, unitResult, contractResult]) => {
      const firstError = contractUnitResult.error ?? propertyResult.error ?? tenantResult.error ?? unitResult.error ?? contractResult.error;
      if (firstError) { setError(`契約候補を読み込めませんでした: ${firstError.message}`); return; }
      setContractUnits((contractUnitResult.data ?? []).sort(compareContractUnitOptions));
      setProperties(propertyResult.data ?? []); setTenants(tenantResult.data ?? []);
      setUnits(unitResult.data ?? []); setContracts(contractResult.data ?? []);
    });
  }, []);
  const selected = requests.find((request) => request.change_request_id === selectedId) ?? null;
  useEffect(() => {
    setTerminationScope('contract');
    setTerminationUnitIds([]);
    const sourceDate = sourceValue(selected?.source_payload ?? {}, '解約日')
      || sourceValue(selected?.source_payload ?? {}, '解約終了日')
      || sourceValue(selected?.source_payload ?? {}, 'effective_date');
    const savedDate = selected?.proposed_payload.termination && typeof selected.proposed_payload.termination === 'object'
      ? String((selected.proposed_payload.termination as JsonObject).termination_date ?? '') : '';
    setTerminationDate(sourceDateInput(sourceDate) || sourceDateInput(savedDate));
  }, [selectedId]);
  const selectedAppsuiteRecordId = selected?.source_appsuite_record_id || selected?.source_record?.appsuite_record_id || null;
  const availableContractUnits = useMemo(() => {
    const linkedUnitIds = new Set((selected?.items ?? [])
      .filter((item) => item.entity_type === 'lease_contract_unit' && item.entity_id)
      .map((item) => item.entity_id!));
    return linkedUnitIds.size ? contractUnits.filter((unit) => linkedUnitIds.has(unit.lease_contract_unit_id)) : contractUnits;
  }, [contractUnits, selected]);
  const filteredAvailableContractUnits = useMemo(() => {
    const term = itemUnitSearch.trim().toLocaleLowerCase('ja-JP');
    return term ? availableContractUnits.filter((unit) => contractUnitLabel(unit).toLocaleLowerCase('ja-JP').includes(term)) : availableContractUnits;
  }, [availableContractUnits, itemUnitSearch]);
  useEffect(() => {
    setComment(''); setItemUnitId(''); setItemValue(''); setItemUnitSearch(selected ? guessSourceTenantName(selected.source_payload) : '');
    setManualContractSearch(selected ? [guessSourceTenantName(selected.source_payload), sourceValue(selected.source_payload, '建物名称') || sourceValue(selected.source_payload, '物件名'), sourceValue(selected.source_payload, '区画')].filter(Boolean).join(' '): '');
    setManualContractId('');
    setTerminationContractIds(selected?.lease_contract_id ? [selected.lease_contract_id] : []);
    setError(''); setMessage('');
    const evidence = selected?.proposed_payload?.rent_roll_snapshot_evidence;
    if (evidence && typeof evidence === 'object') {
      const value = evidence as Record<string, unknown>;
      setSnapshotDate(String(value.snapshot_date ?? '2026-08-31')); setSnapshotFile(String(value.file_name ?? ''));
      setSnapshotSheet(String(value.sheet_name ?? '')); setSnapshotRow(String(value.row_number ?? ''));
      setSnapshotResult((value.result === 'not_found' || value.result === 'uncertain') ? value.result : 'rent_roll_only');
    } else { setSnapshotDate('2026-08-31'); setSnapshotFile(''); setSnapshotSheet(''); setSnapshotRow(''); setSnapshotResult('rent_roll_only'); }
  }, [selectedId]);
  useEffect(() => { setTerminationScope('contract'); setTerminationUnitIds([]); }, [selectedId]);
  useEffect(() => {
    setVerifiedLinkIds([]); setConfirmedFields({}); setReconciliationNote('');
    setManualContractSearch(''); setManualContractId('');
  }, [selectedId]);

  const requestContexts = useMemo(() => new Map(requests.map((request) => [request.change_request_id, requestDisplayContext(request, contracts, contractUnits, properties, tenants)])), [requests, contracts, contractUnits, properties, tenants]);
  const filtered = useMemo(() => requests.filter((request) => {
    const matchesStatus = filter === 'all' || request.status === filter;
    const matchesType = typeFilter === 'all' || requestTypeGroup(request) === typeFilter;
    const matchesSource = sourceFilter === 'all' || request.source_type === sourceFilter;
    const context = requestContexts.get(request.change_request_id);
    const text = `${request.title} ${request.summary ?? ''} ${request.source_record?.ringi_number ?? ''} ${context?.property ?? ''} ${context?.tenant ?? ''} ${context?.unit ?? ''} ${requestTypeLabel[request.request_type] ?? request.request_type} ${JSON.stringify(request.source_payload)}`.toLocaleLowerCase('ja-JP');
    return matchesStatus && matchesType && matchesSource && (!search.trim() || text.includes(search.trim().toLocaleLowerCase('ja-JP')));
  }).sort((a, b) => sortOrder === 'newest' ? b.updated_at.localeCompare(a.updated_at) : a.updated_at.localeCompare(b.updated_at)), [filter, requests, requestContexts, search, sortOrder, sourceFilter, typeFilter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / REQUEST_DISPLAY_PAGE_SIZE));
  const pageRequests = useMemo(() => filtered.slice((page - 1) * REQUEST_DISPLAY_PAGE_SIZE, page * REQUEST_DISPLAY_PAGE_SIZE), [filtered, page]);
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
    const pageIds = pageRequests.map((request) => request.change_request_id);
    if (selectedId && pageIds.includes(selectedId)) return;
    setSelectedId(pageIds[0] ?? null);
  }, [pageCount, pageRequests, selectedId]);
  const editable = selected?.status === 'open' || selected?.status === 'in_review' || selected?.status === 'on_hold';
  const reviewOnly = selected ? isReviewOnlyImport(selected) : false;
  const isAppsuiteContractRequest = selected ? ['contract_create', 'contract_update', 'contract_terminate', 'approval_cancel', 'contract_cancellation_review'].includes(selected.request_type) : false;
  const isLinkedContractCreate = selected?.request_type === 'contract_create' && workflowLinksRecordId === selectedAppsuiteRecordId && workflowLinks.length > 0;
  const isContractCreateLinkLoading = selected?.request_type === 'contract_create' && !!selectedAppsuiteRecordId && workflowLinksRecordId !== selectedAppsuiteRecordId;
  const isParkingFeeRequest = selected?.request_type === 'parking_fee_setup';
  const isContractDeadlineRequest = selected ? ['contract_term_type_confirmation', 'contract_renewal_due', 'fixed_term_contract_end'].includes(selected.request_type) : false;
  const selectedContract = selected?.lease_contract_id ? contracts.find((contract) => contract.lease_contract_id === selected.lease_contract_id) : undefined;
  const selectedContext = selected ? requestContexts.get(selected.change_request_id) ?? null : null;
  const selectedRingiNumber = selected ? selected.source_record?.ringi_number || sourceValue(selected.source_payload, '稟議番号') || sourceValue(selected.source_payload, '稟議NO') || sourceValue(selected.source_payload, '稟議No') || sourceValue(selected.source_payload, 'ringi_number') : '';
  const selectedAppsuiteDataId = selected ? selected.source_record?.data_id || sourceValue(selected.source_payload, 'データID') : '';
  const selectedWorkflowLinks = selected ? relatedWorkflowLinks(selected) : [];
  const manualContractOptions = useMemo(() => {
    const term = manualContractSearch.trim().toLocaleLowerCase('ja-JP');
    return contracts.filter((contract) => {
      const unitsForContract = contractUnits.filter((unit) => (unit.lease_contract_id ?? unit.contract?.lease_contract_id) === contract.lease_contract_id);
      const searchable = [contract.tenant?.tenant_name, ...unitsForContract.flatMap((unit) => [unit.unit?.asset?.asset_name, unit.unit?.unit_code, unit.unit?.floor_label]), contract.contract_start_date, contract.contract_end_date].filter(Boolean).join(' ').toLocaleLowerCase('ja-JP');
      return !term || searchable.includes(term);
    }).slice(0, 100);
  }, [contracts, contractUnits, manualContractSearch]);
  const selectedManualContract = contracts.find((contract) => contract.lease_contract_id === manualContractId);
  const terminationTargetContractIds = selected?.request_type === 'contract_terminate'
    ? terminationContractIds
    : [manualContractId || selected?.lease_contract_id || ''].filter(Boolean);
  const terminationContractSelectionSummary = terminationContractIds.map((id) => contracts.find((contract) => contract.lease_contract_id === id))
    .filter((contract): contract is ContractOption => Boolean(contract))
    .map((contract) => `${contract.tenant?.tenant_name ?? 'テナント未設定'}（${contract.contract_start_date ?? '開始日未設定'}）`)
    .join('、');
  const terminationTargetUnits = useMemo(() => {
    const targetContractIdSet = new Set(terminationTargetContractIds);
    return targetContractIdSet.size
      ? contractUnits.filter((unit) => targetContractIdSet.has(unit.lease_contract_id ?? unit.contract?.lease_contract_id ?? ''))
      : [];
  }, [contractUnits, terminationTargetContractIds]);
  const threadTimeline = useMemo<ThreadTimelineEntry[]>(() => {
    if (!selected) return [];
    const comments: ThreadTimelineEntry[] = (selected.comments ?? []).map((entry) => ({ id: entry.change_request_comment_id, created_at: entry.created_at, type: 'comment', title: '対応メモ', body: entry.body }));
    const actions: ThreadTimelineEntry[] = (selected.action_logs ?? []).filter((entry) => entry.action_type !== 'commented').map((entry) => {
      const status = entry.next_status ? statusLabel[entry.next_status] ?? entry.next_status : '';
      const title = entry.action_type === 'created' ? '案件を作成'
        : entry.action_type === 'draft_saved' ? '確認内容を保存'
          : entry.action_type === 'resolved' ? '確認を完了'
            : entry.action_type === 'applied' ? '業務データへ確定反映'
              : entry.action_type === 'excluded' ? '対象外に設定'
                : entry.action_type === 'status_changed' ? `状態を${status}に変更`
                  : '案件を更新';
      const reason = [entry.details.reason, entry.details.note].find((value) => typeof value === 'string');
      return { id: entry.change_request_action_log_id, created_at: entry.created_at, type: 'action', title, body: typeof reason === 'string' ? reason : '' };
    });
    return [...comments, ...actions].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }, [selected]);
  const domainItems = selected?.items?.filter((item) => item.entity_type !== 'rent_roll_import_issue') ?? [];

  useEffect(() => {
    const recordId = selectedAppsuiteRecordId;
    if (!supabase || !recordId || !isAppsuiteContractRequest) { setWorkflowCandidates([]); return; }
    setCandidateLoading(true);
    void supabase.rpc('list_workflow_contract_candidates', { p_appsuite_record_id: recordId }).then(({ data, error: candidateError }) => {
      setCandidateLoading(false);
      if (candidateError) { setError(`契約候補を取得できませんでした: ${candidateError.message}`); return; }
      setWorkflowCandidates((data ?? []) as WorkflowContractCandidate[]);
    });
  }, [isAppsuiteContractRequest, selectedAppsuiteRecordId]);

  useEffect(() => {
    const recordId = selected?.request_type === 'contract_create' ? selectedAppsuiteRecordId : null;
    if (!supabase || !recordId) { setWorkflowLinks([]); setWorkflowLinksRecordId(null); return; }
    setWorkflowLinks([]); setWorkflowLinksRecordId(null);
    let cancelled = false;
    void supabase.from('workflow_contract_link')
      .select('workflow_contract_link_id, lease_contract_id, lease_contract_unit_id, contract:lease_contract(contract_start_date, contract_end_date, tenant:tenant_master(tenant_name)), contract_unit:lease_contract_unit(unit:unit_master(unit_code, floor_label, asset:asset_master(asset_name)))')
      .eq('appsuite_record_id', recordId)
      .then(({ data, error: linkError }) => {
        if (cancelled) return;
        if (linkError) { setError(`既存契約リンクを読み込めませんでした: ${linkError.message}`); return; }
        setWorkflowLinks((data ?? []) as unknown as LinkedContract[]);
        setWorkflowLinksRecordId(recordId);
      });
    return () => { cancelled = true; };
  }, [selectedAppsuiteRecordId, selected?.request_type, selected?.row_version]);

  useEffect(() => {
    const recordId = selected?.source_appsuite_record_id;
    if (!supabase || !recordId || !isAppsuiteContractRequest) { setHistoricalCandidates([]); return; }
    setHistoricalCandidateLoading(true);
    void supabase.rpc('list_workflow_historical_contract_candidates', { p_appsuite_record_id: recordId }).then(({ data, error: candidateError }) => {
      setHistoricalCandidateLoading(false);
      if (candidateError) { setError(`過去契約候補を取得できませんでした: ${candidateError.message}`); return; }
      setHistoricalCandidates((data ?? []) as HistoricalContractCandidate[]);
    });
  }, [isAppsuiteContractRequest, selected?.source_appsuite_record_id]);

  const confirmHistoricalContract = async (candidate: HistoricalContractCandidate) => {
    if (!selected?.source_appsuite_record_id || !supabase) return;
    setWorking(true); setError('');
    const { error: linkError } = await supabase.rpc('confirm_workflow_historical_contract_link', {
      p_appsuite_record_id: selected.source_appsuite_record_id,
      p_historical_contract_key: candidate.historical_contract_key,
      p_snapshot_date: candidate.snapshot_date,
      p_property_name: candidate.property_name,
      p_unit_code: candidate.unit_code,
      p_tenant_name: candidate.tenant_name,
      p_operation_kind: selected.request_type,
    });
    if (linkError) { setWorking(false); setError(`過去契約履歴を紐付けできませんでした: ${linkError.message}`); return; }
    const { error: completeError } = await supabase.rpc('complete_historical_contract_workflow', {
      p_change_request_id: selected.change_request_id,
      p_expected_row_version: selected.row_version,
      p_historical_contract_key: candidate.historical_contract_key,
    });
    setWorking(false);
    if (completeError) {
      setError(`過去契約への紐付けは完了しましたが、対応依頼を完了できませんでした: ${completeError.message}`);
      await loadRequests();
      return;
    }
    setMessage('過去契約に紐付け、現行データを変更せずに対応依頼を完了しました。');
    await loadRequests();
  };

  const confirmWorkflowContract = async (candidate: WorkflowContractCandidate) => {
    if (!selected || !selectedAppsuiteRecordId || !supabase) return;
    const isTermination = selected.request_type === 'contract_terminate' || selected.request_type === 'contract_cancellation_review';
    if (selected.request_type === 'contract_terminate' && !terminationDate) {
      setError('契約終了日を入力してください。'); return;
    }
    if (isTermination && terminationScope !== 'contract' && terminationUnitIds.length === 0) {
      setError('解約対象区画を選択してください。'); return;
    }
    if (isTermination && terminationScope !== 'contract') {
      const selectedCandidates = workflowCandidates.filter((entry) => terminationUnitIds.includes(entry.lease_contract_unit_id));
      if (selectedCandidates.some((entry) => entry.lease_contract_id !== candidate.lease_contract_id)) {
        setError('複数区画は同一契約の区画を選択してください。複数契約にまたがる場合は契約ごとに確定してください。'); return;
      }
    }
    if (selected.request_type === 'contract_create' && workflowCandidates.length > 0
      && !window.confirm('既存契約候補があります。重複を確認したうえで、この契約を新規案件の対象として確定しますか？')) return;
    setWorking(true); setError('');
    if (selected.request_type === 'contract_terminate') {
      const { error: terminationError } = await supabase.rpc('complete_appsuite_termination_request', {
        p_change_request_id: selected.change_request_id,
        p_expected_row_version: selected.row_version,
        p_lease_contract_id: candidate.lease_contract_id,
        p_termination_date: terminationDate,
        p_target_scope: terminationScope,
        p_lease_contract_unit_ids: terminationScope === 'contract' ? [] : terminationUnitIds,
      });
      setWorking(false);
      if (terminationError) { setError(`解約内容を契約データへ反映できませんでした: ${terminationError.message}`); return; }
      setMessage('対象契約への紐付けと対応依頼の完了が済み、案件を契約業務フローへ移行しました。契約データは契約業務側で反映するまで変更されません。');
      await loadRequests();
      return;
    }
    const rpcName = isTermination && terminationScope !== 'contract' ? 'confirm_workflow_contract_links' : 'confirm_workflow_contract_link';
    const rpcArgs = isTermination && terminationScope !== 'contract' ? {
      p_appsuite_record_id: selectedAppsuiteRecordId, p_lease_contract_id: candidate.lease_contract_id,
      p_lease_contract_unit_ids: terminationUnitIds, p_link_role: 'primary', p_effective_date: candidate.contract_start_date, p_target_scope: terminationScope,
    } : {
      p_appsuite_record_id: selectedAppsuiteRecordId,
      p_lease_contract_id: candidate.lease_contract_id,
      p_link_role: 'primary',
      p_effective_date: candidate.contract_start_date,
      p_lease_contract_unit_id: isTermination && terminationScope !== 'contract' ? terminationUnitIds[0] : null,
      p_target_scope: isTermination ? terminationScope : 'contract',
    };
    const { error: linkError } = await supabase.rpc(rpcName, rpcArgs);
    setWorking(false);
    if (linkError) { setError(`契約リンクを確定できませんでした: ${linkError.message}`); return; }
    setMessage('契約リンクを確定しました。契約処理とレントロール確認を続けてください。');
    await loadRequests();
  };

  const handoffAppsuiteTermination = async () => {
    if (!selected || !selectedAppsuiteRecordId || !supabase) return;
    if (terminationTargetContractIds.length === 0) {
      setError('紐づける契約を1件以上選択してください。'); return;
    }
    if (!terminationDate) {
      setError('契約終了日を入力してください。'); return;
    }
    const contractSelections = [...terminationTargetContractIds].sort().map((leaseContractId) => ({
      lease_contract_id: leaseContractId,
      lease_contract_unit_ids: terminationScope === 'contract'
        ? []
        : terminationTargetUnits
          .filter((unit) => (unit.lease_contract_id ?? unit.contract?.lease_contract_id) === leaseContractId
            && terminationUnitIds.includes(unit.lease_contract_unit_id))
          .map((unit) => unit.lease_contract_unit_id),
    }));
    if (terminationScope !== 'contract' && contractSelections.some((selection) => selection.lease_contract_unit_ids.length === 0)) {
      setError('契約ごとに解約対象区画を1件以上選択してください。'); return;
    }
    if (!window.confirm(`選択した${contractSelections.length}件の契約に、契約終了日 ${terminationDate} と対象範囲を適用して契約業務フローへ移行します。契約データは契約業務側で反映するまで変更されません。よろしいですか？`)) return;
    setWorking(true); setError('');
    const { error: handoffError } = await supabase.rpc('complete_appsuite_termination_request_multi', {
      p_change_request_id: selected.change_request_id,
      p_expected_row_version: selected.row_version,
      p_contract_selections: contractSelections,
      p_termination_date: terminationDate,
      p_target_scope: terminationScope,
    });
    setWorking(false);
    if (handoffError) {
      setError(`選択した契約を契約業務フローへ移行できませんでした: ${handoffError.message}`); return;
    }
    setMessage(`選択した${contractSelections.length}件の契約へ紐付け、契約業務フローへ移行しました。契約データは契約業務側で反映するまで変更されません。`);
    await loadRequests();
  };

  const linkManuallySelectedContract = async () => {
    if (!selectedAppsuiteRecordId || !supabase || !manualContractId) return;
    const contract = contracts.find((entry) => entry.lease_contract_id === manualContractId);
    if (!contract) return;
    if (!window.confirm(`${contract.tenant?.tenant_name ?? 'テナント未設定'} の既存契約をこの稟議に紐付けます。契約内容は変更されません。よろしいですか？`)) return;
    setWorking(true); setError('');
    const { error: linkError } = await supabase.rpc('confirm_workflow_contract_link', {
      p_appsuite_record_id: selectedAppsuiteRecordId,
      p_lease_contract_id: contract.lease_contract_id,
      p_link_role: 'primary',
      p_effective_date: contract.contract_start_date,
      p_lease_contract_unit_id: null,
      p_target_scope: 'contract',
    });
    setWorking(false);
    if (linkError) { setError(`既存契約を稟議に紐付けできませんでした: ${linkError.message}`); return; }
    setMessage('既存契約と稟議を紐付けました。契約内容は変更していません。');
    await loadRequests();
  };

  const completeLinkedContract = async () => {
    if (!selected || !supabase || !isLinkedContractCreate) return;
    const fields = ['tenant', 'property', 'unit', 'period'];
    if (workflowLinks.some((link) => !verifiedLinkIds.includes(link.workflow_contract_link_id)) ||
        fields.some((field) => !confirmedFields[field]) || !reconciliationNote.trim()) {
      setError('全契約リンクと契約者・物件・区画・期間を照合し、判断理由を記録してください。'); return;
    }
    setWorking(true); setError('');
    const { error: completionError } = await supabase.rpc('complete_linked_contract_request', {
      p_change_request_id: selected.change_request_id,
      p_expected_row_version: selected.row_version,
      p_verified_link_ids: verifiedLinkIds,
      p_confirmed_fields: Object.fromEntries(fields.map((field) => [field, confirmedFields[field]])),
      p_note: reconciliationNote.trim(),
    });
    setWorking(false);
    if (completionError) { setError(`既存契約との照合を確定できませんでした: ${completionError.message}`); return; }
    setMessage('既存契約との照合を記録し、対応依頼を完了しました。');
    await loadRequests();
  };

  const recheckAll = async () => {
    if (!supabase) return;
    setRechecking(true); setError(''); setMessage('');
    if (role === 'admin' || role === 'manager') {
      const { error: syncError } = await supabase.rpc('sync_contract_deadline_change_requests', { p_as_of_date: new Date().toISOString().slice(0, 10) });
      if (syncError) { setRechecking(false); setError(`契約期限依頼を同期できませんでした: ${syncError.message}`); return; }
    }
    const { data, error: recheckError } = await supabase.rpc('recheck_open_change_requests');
    setRechecking(false);
    if (recheckError) { setError(`対応依頼を再チェックできませんでした: ${recheckError.message}`); return; }
    const result = (Array.isArray(data) ? data[0] : data) as RecheckBatchResult | null;
    const appliedCount = Number(result?.applied_count ?? 0);
    const checkedCount = Number(result?.checked_count ?? 0);
    setMessage(appliedCount > 0
      ? `${checkedCount}件を最新データで再チェックし、${appliedCount}件を確定済みにしました。`
      : `${checkedCount}件を最新データで再チェックしました。`);
    await loadRequests();
  };

  const recheckSelected = async () => {
    if (!selected || !supabase) return;
    setRechecking(true); setError(''); setMessage('');
    const { data, error: recheckError } = await supabase.rpc('recheck_change_request', {
      p_change_request_id: selected.change_request_id,
      p_expected_row_version: selected.row_version,
    });
    setRechecking(false);
    if (recheckError) { setError(`再チェックできませんでした: ${recheckError.message}`); return; }
    const result = (Array.isArray(data) ? data[0] : data) as RecheckResult | null;
    if (result?.outcome === 'applied') setMessage('最新データで問題の解消を確認し、対応依頼を確定済みにしました。');
    else if (result?.outcome === 'open') setMessage('最新データで再チェックしました。引き続き確認が必要です。');
    else if (result?.outcome === 'skipped') setMessage('この依頼は現在データだけでは自動判定できないため、状態を変更していません。');
    else setMessage('この依頼は既に更新済みです。');
    await loadRequests();
  };

  const addComment = async () => {
    if (!selected || !supabase || !comment.trim()) return;
    setWorking(true); setError('');
    const { error: addError } = await supabase.rpc('add_change_request_comment', { p_change_request_id: selected.change_request_id, p_body: comment.trim() });
    setWorking(false);
    if (addError) { setError(`対応メモを保存できませんでした: ${addError.message}`); return; }
    setComment(''); setMessage('対応メモを追加しました。'); await loadRequests();
  };
  const saveSnapshotEvidence = async () => {
    if (!selected || !supabase || !snapshotFile.trim() || !snapshotSheet.trim()) { setError('Excelファイル名とシート名を入力してください。'); return; }
    setWorking(true); setError('');
    const { error: saveError } = await supabase.rpc('save_change_request_draft', {
      p_change_request_id: selected.change_request_id,
      p_expected_row_version: selected.row_version,
      p_proposed_payload: { ...selected.proposed_payload, rent_roll_snapshot_evidence: {
        snapshot_date: snapshotDate || null, file_name: snapshotFile.trim(), sheet_name: snapshotSheet.trim(),
        row_number: snapshotRow.trim() ? Number(snapshotRow) : null, result: snapshotResult,
        recorded_at: new Date().toISOString(), source: 'manual_excel_review'
      }},
      p_summary: selected.summary,
    });
    setWorking(false);
    if (saveError) { setError(`過去レントロール証跡を保存できませんでした: ${saveError.message}`); return; }
    setMessage('過去レントロールの確認証跡を保存しました。'); await loadRequests();
  };
  const setStatus = async (status: 'on_hold' | 'excluded') => {
    if (!selected || !supabase) return;
    const holdPrompt = selected.request_type === 'parking_fee_setup'
      ? '保留にする理由を入力してください（例：複数台セット契約の1台あたり金額を後日確認）'
      : '保留にする理由を入力してください';
    const note = window.prompt(status === 'on_hold' ? holdPrompt : '対象外にする理由を入力してください');
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
    setMessage('確認完了にしました。続けて「内容を確定」を押すと確定済みになります。'); await loadRequests();
  };
  const apply = async () => {
    if (!selected || !supabase || !window.confirm(reviewOnly ? '確認内容を確定し、この取込依頼を閉じますか？' : '正本への反映を確定しますか？')) return;
    setWorking(true); setError('');
    const { data, error: applyError } = await supabase.rpc('apply_change_request_with_terms', { p_change_request_id: selected.change_request_id, p_expected_row_version: selected.row_version });
    setWorking(false);
    if (applyError) { setError(`適用できませんでした: ${applyError.message}`); return; }
    const applied = (Array.isArray(data) ? data[0] : data) as ChangeRequest | null;
    if (!applied || applied.status !== 'applied') { setError('確定済みへの更新をDBで確認できませんでした。画面を更新して再試行してください。'); return; }
    setMessage('内容を確定し、取込依頼を確定済みにしました。'); await loadRequests();
  };
  const openCount = requests.filter((request) => request.status === 'open').length;
  const inReviewCount = requests.filter((request) => request.status === 'in_review').length;
  const holdCount = requests.filter((request) => request.status === 'on_hold').length;
  const sourceTypes = Array.from(new Set(requests.map((request) => request.source_type))).sort();
  const visiblePageNumbers = [...new Set([1, page - 1, page, page + 1, pageCount].filter((number) => number >= 1 && number <= pageCount))].sort((a, b) => a - b);

  return <section className="change-workbench change-thread-workbench">
    <div className="page-heading change-thread-page-heading"><div><p className="section-kicker">WORK MANAGEMENT</p><h2>案件スレッド</h2><p>案件ごとの情報・確認・判断を一つの流れで進めます。</p></div><div className="thread-page-actions"><button className="secondary-button" onClick={() => void loadRequests()} disabled={loading || archiveLoading}>一覧を更新</button><button className="secondary-button" onClick={() => void recheckAll()} disabled={loading || rechecking}>{rechecking ? '再チェック中…' : '作業中を再チェック'}</button></div></div>
    {error && <p className="change-message error">{error}</p>}{message && <p className="change-message">{message}</p>}
    <div className="thread-work-stats">
      <div className="thread-work-stat primary"><span>作業中</span><strong>{loading ? '—' : openCount + inReviewCount + holdCount}</strong><small>要確認・確認中・保留</small></div>
      <div className="thread-work-stat"><span><i className="open-dot" />要確認</span><strong>{loading ? '—' : openCount}</strong></div>
      <div className="thread-work-stat"><span><i className="review-dot" />確認中</span><strong>{loading ? '—' : inReviewCount}</strong></div>
      <div className="thread-work-stat"><span><i className="hold-dot" />保留</span><strong>{loading ? '—' : holdCount}</strong></div>
      <div className="thread-work-stat archived"><span><i className="archive-dot" />完了分</span><strong>{archiveCount}</strong><small>確認済み・確定済み・対象外</small></div>
    </div>
    <div className="thread-toolbar">
      <label className="thread-search-field"><span>⌕</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="案件名・物件名・テナント名・稟議番号で検索" /></label>
      <select value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value); setPage(1); }} aria-label="案件種別"><option value="all">すべての種別</option>{Object.entries(requestTypeGroupLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value); setPage(1); }} aria-label="発生元"><option value="all">すべての発生元</option>{sourceTypes.map((source) => <option key={source} value={source}>{source === 'initial_import' ? 'Excel取込' : source === 'desknets' ? 'AppSuite' : source}</option>)}</select>
      <select value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }} aria-label="状態"><option value="all">作業状態: すべて</option><option value="open">要確認</option><option value="in_review">確認中</option><option value="on_hold">保留</option>{archiveLoaded && <><option value="resolved">確認済み（確定待ち）</option><option value="applied">確定済み</option><option value="excluded">対象外</option></>}</select>
      <label className="thread-sort-field"><span>並び順</span><select value={sortOrder} onChange={(event) => { setSortOrder(event.target.value as 'newest' | 'oldest'); setPage(1); }}><option value="newest">更新日時が新しい順</option><option value="oldest">更新日時が古い順</option></select></label>
    </div>
    <div className="thread-archive-bar"><span>{archiveLoaded ? '作業中と完了分を一覧に表示しています。' : '完了分は必要なときに読み込めます。'}</span><button className="secondary-button" onClick={() => void toggleArchivedRequests()} disabled={loading || archiveLoading}>{archiveLoading ? '完了分を取得中…' : archiveLoaded ? '完了分を隠す' : `完了分を読み込む（${archiveCount.toLocaleString('ja-JP')}件）`}</button></div>
     <div className="change-workbench-layout thread-workbench-layout">
      <aside className="change-request-list thread-request-list"><header><div><h3>案件一覧</h3><p>{archiveLoaded ? '作業中・完了分' : '作業中'}　·　{filtered.length.toLocaleString('ja-JP')}件</p></div><button className="thread-refresh-button" onClick={() => void loadRequests()} disabled={loading || archiveLoading} aria-label="一覧を更新">↻</button></header>
        <div className="change-request-rows thread-request-rows">{loading ? <p className="change-empty">案件を読み込んでいます…</p> : filtered.length === 0 ? <p className="change-empty">{search.trim() ? '検索条件に一致する案件はありません。' : '現在、対応が必要な案件はありません。'}</p> : pageRequests.map((request) => {
          const context = requestContexts.get(request.change_request_id);
          return <button key={request.change_request_id} onClick={() => setSelectedId(request.change_request_id)} className={request.change_request_id === selectedId ? 'selected thread-request-card' : 'thread-request-card'}>
            <span className="thread-request-card-top"><span className={`change-status ${request.status}`}>{statusLabel[request.status] ?? request.status}</span><time>{formatDate(request.updated_at)}</time></span>
            <small className="thread-request-type">{requestTypeLabel[request.request_type] ?? request.request_type}</small><strong>{requestDisplayTitle(request)}</strong><small className="thread-request-summary">{request.summary || '内容を確認してください。'}</small>
            <span className="thread-request-parties"><b>物件</b>{context?.property ?? '物件未特定'}<i>·</i><b>テナント</b>{context?.tenant ?? 'テナント未特定'}</span>
            <span className="thread-request-card-footer"><small>{request.source_record?.ringi_number || request.change_request_id.slice(0, 8)}</small><small>{request.comments?.length ?? 0}件のメモ　›</small></span>
          </button>;
        })}</div>
        <div className="thread-list-pagination"><span>{filtered.length ? `${(page - 1) * REQUEST_DISPLAY_PAGE_SIZE + 1}–${Math.min(page * REQUEST_DISPLAY_PAGE_SIZE, filtered.length)}件 / ${filtered.length}件` : '0件'}</span><div><button disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>‹</button>{visiblePageNumbers.map((number, index) => <span key={number}>{index > 0 && number - visiblePageNumbers[index - 1] > 1 ? <i>…</i> : null}<button className={number === page ? 'active' : ''} onClick={() => { setPage(number); setSelectedId(filtered[(number - 1) * REQUEST_DISPLAY_PAGE_SIZE]?.change_request_id ?? null); }}>{number}</button></span>)}<button disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>›</button></div></div>
      </aside>
      <main className="change-request-detail thread-request-detail">{selected ? <>
        <header className="change-detail-heading"><div><div className="thread-detail-labels"><span className={`change-status ${selected.status}`}>{statusLabel[selected.status] ?? selected.status}</span><span>{requestTypeLabel[selected.request_type] ?? selected.request_type}</span><span>{selected.source_type === 'initial_import' ? 'Excel取込' : selected.source_type === 'desknets' ? 'AppSuite' : selected.source_type}</span></div><h3>{selected.title}</h3><p>{selected.summary || '案件の内容を確認してください。'} <span>最終更新: {formatDate(selected.updated_at)}</span></p></div><div className="change-detail-tools">{editable && !isContractDeadlineRequest ? <button className="secondary-button" onClick={() => void recheckSelected()} disabled={working || rechecking}>{rechecking ? '再チェック中…' : '再チェック'}</button> : null}</div></header>
        <section className="thread-related-context"><div><span>物件</span><strong>{selectedContext?.property ?? '物件未特定'}</strong></div><div><span>テナント</span><strong>{selectedContext?.tenant ?? 'テナント未特定'}</strong></div>{selectedContext?.unit && <div><span>区画</span><strong>{selectedContext.unit}</strong></div>}<div><span>案件ID</span><strong>{selected.change_request_id}</strong></div></section>
        <section className="thread-case-links"><div className="thread-ringi"><span>稟議NO</span>{selectedRingiNumber && selected.source_record ? <a href={appsuiteRecordUrl(selected.source_record.app_id, selected.source_record.data_id)} target="_blank" rel="noreferrer" onClick={(event) => openAppsuiteRecord(event, appsuiteRecordUrl(selected.source_record!.app_id, selected.source_record!.data_id))}>{selectedRingiNumber} ↗</a> : <strong>{selectedRingiNumber || '未登録'}</strong>}{selectedAppsuiteDataId && <small>AppSuite ID: {selectedAppsuiteDataId}</small>}</div><nav aria-label="関連ワークフロー"><span>関連ワークフロー</span>{selectedWorkflowLinks.map((workflow) => <Link key={workflow.to} to={workflow.to}>{workflow.label} ↗</Link>)}{selected.source_record && <a href={appsuiteRecordUrl(selected.source_record.app_id, selected.source_record.data_id)} target="_blank" rel="noreferrer" onClick={(event) => openAppsuiteRecord(event, appsuiteRecordUrl(selected.source_record!.app_id, selected.source_record!.data_id))}>AppSuite原文 ↗</a>}</nav></section>
        <IssueContext request={selected} />
        {selected.items?.some((item) => item.validation_status !== 'valid') && <section className="change-card change-validation-pending" role="status">
          <h4>未完了の確認項目</h4>
          <p>契約と稟議の紐付けは保存されています。次の項目が確認済みになるまで「確認完了」にはできません。</p>
          <ul>{selected.items.filter((item) => item.validation_status !== 'valid').map((item) => <li key={item.change_request_item_id}>{item.validation_message || `明細の状態: ${item.validation_status}`}</li>)}</ul>
          {(selected.request_type === 'contract_terminate' || selected.request_type === 'contract_cancellation_review') && <p>解約対象と終了日を確認し、対象契約のデータを更新してください。</p>}
        </section>}
        {isAppsuiteContractRequest && !isLinkedContractCreate && !isContractCreateLinkLoading && <section className="change-card historical-contract-candidates">
          <h4>過去契約履歴候補</h4>
          <p>過去スナップショットを連続期間にまとめた候補です。ここで紐付けても、現行契約・請求・解約処理は変更しません。</p>
          {historicalCandidateLoading ? <p className="muted">過去スナップショット候補を取得中です…</p> : historicalCandidates.length === 0 ? <p className="muted">一致する過去契約履歴はありません。</p> : historicalCandidates.map((candidate) => <article key={candidate.historical_contract_key} className="historical-contract-candidate">
            <div><strong>{candidate.tenant_name ?? 'テナント未設定'}</strong><span>{candidate.property_name} / {candidate.floor_label ?? 'フロア未設定'} / {candidate.unit_code ?? '識別番号未設定'}</span><span>区画種別: {candidate.unit_type === 'parking' ? '駐車場' : candidate.unit_type === 'bicycle_parking' ? '駐輪場' : candidate.unit_type === 'signage' ? '看板' : candidate.unit_type === 'antenna' ? 'アンテナ' : candidate.unit_type === 'warehouse' ? '倉庫' : candidate.unit_type === 'office' ? '貸室' : candidate.unit_type ?? '未設定'}</span><span>履歴期間: {candidate.period_start ?? '未設定'} ～ {candidate.period_end ?? '未設定'}（{candidate.snapshot_count}か月）</span></div>
            <div><strong>一致度: {candidate.match_level}</strong><ul>{candidate.match_reasons.filter((reason) => reason.matched).map((reason) => <li key={reason.rule}>✓ {reason.message}</li>)}</ul></div>
            {editable && <button className="secondary-button" onClick={() => void confirmHistoricalContract(candidate)} disabled={working}>過去履歴に紐付ける</button>}
          </article>)}
        </section>}
        <AppsuiteSourceContext request={selected} />
        {isAppsuiteContractRequest && editable && !isLinkedContractCreate && !isContractCreateLinkLoading && <details className="change-card historical-roll-check" open={historicalCandidates.length === 0}><summary>過去レントロール確認（手動確認・証跡）</summary><p>候補が見つからない場合や、Excelの確認結果を証跡として残す場合に使用します。</p><div className="change-item-editor">
          <label>基準日<input type="date" value={snapshotDate} onChange={(event) => setSnapshotDate(event.target.value)} /></label>
          <label>ファイル名<input value={snapshotFile} onChange={(event) => setSnapshotFile(event.target.value)} /></label>
          <label>シート名<input value={snapshotSheet} onChange={(event) => setSnapshotSheet(event.target.value)} /></label>
          <label>行番号<input inputMode="numeric" value={snapshotRow} onChange={(event) => setSnapshotRow(event.target.value)} /></label>
          <label>確認結果<select value={snapshotResult} onChange={(event) => setSnapshotResult(event.target.value as typeof snapshotResult)}><option value="rent_roll_only">レントロールに存在・contractなし</option><option value="not_found">レントロールにも存在しない</option><option value="uncertain">要追加確認</option></select></label>
          <button className="secondary-button" onClick={() => void saveSnapshotEvidence()} disabled={working}>確認証跡を保存</button>
        </div></details>}
        {isAppsuiteContractRequest && !isLinkedContractCreate && !isContractCreateLinkLoading && <section className="change-card workflow-contract-candidates">
          <h4>契約候補</h4>
          <p>候補は自動確定されません。候補理由を確認して、対象契約を手動で確定してください。</p>
          {selectedAppsuiteRecordId && editable && <div className="change-item-editor">
            <label>既存契約を検索<input value={manualContractSearch} onChange={(event) => { setManualContractSearch(event.target.value); setManualContractId(''); }} placeholder="テナント名・物件名・区画・契約日" /></label>
            {selected.request_type === 'contract_terminate' ? <fieldset className="termination-unit-picker">
              <legend>紐づける契約（複数選択可）</legend>
              <p className="muted">現在 {terminationContractIds.length} 件を選択中です。表示中の契約に同じ終了日・対象範囲を適用します。</p>
              <p className="muted">選択中: {terminationContractSelectionSummary || 'なし'}</p>
              <div className="termination-unit-options termination-contract-options">
                {manualContractOptions.map((contract) => {
                  const unitsForContract = contractUnits.filter((unit) => (unit.lease_contract_id ?? unit.contract?.lease_contract_id) === contract.lease_contract_id);
                  const unitLabel = [...new Set(unitsForContract.map((unit) => [unit.unit?.asset?.asset_name, unit.unit?.floor_label, unit.unit?.unit_code].filter(Boolean).join(' ')))].filter(Boolean).join('、');
                  const checked = terminationContractIds.includes(contract.lease_contract_id);
                  return <label key={contract.lease_contract_id} className={checked ? 'termination-unit-option selected' : 'termination-unit-option'}>
                    <input type="checkbox" checked={checked} onChange={(event) => {
                      setTerminationContractIds((current) => event.target.checked
                        ? [...current, contract.lease_contract_id]
                        : current.filter((id) => id !== contract.lease_contract_id));
                      setTerminationUnitIds([]);
                    }} />
                    <span><strong>{contract.tenant?.tenant_name ?? 'テナント未設定'}</strong><small>{unitLabel || '区画未登録'} / {contract.contract_start_date ?? '開始日未設定'} ～ {contract.contract_end_date ?? '終了日未設定'}</small></span>
                  </label>;
                })}
                {manualContractOptions.length === 0 && <p className="muted">検索条件に一致する契約がありません。</p>}
              </div>
            </fieldset> : <label>紐付ける契約<select value={manualContractId} onChange={(event) => setManualContractId(event.target.value)}><option value="">契約を選択してください</option>{manualContractOptions.map((contract) => {
              const unitsForContract = contractUnits.filter((unit) => (unit.lease_contract_id ?? unit.contract?.lease_contract_id) === contract.lease_contract_id);
              const unitLabel = [...new Set(unitsForContract.map((unit) => [unit.unit?.asset?.asset_name, unit.unit?.floor_label, unit.unit?.unit_code].filter(Boolean).join(' ')))].filter(Boolean).join('、');
              return <option key={contract.lease_contract_id} value={contract.lease_contract_id}>{contract.tenant?.tenant_name ?? 'テナント未設定'} / {unitLabel || '区画未登録'} / {contract.contract_start_date ?? '開始日未設定'} ～ {contract.contract_end_date ?? '終了日未設定'}</option>;
            })}</select></label>}
            {selected.request_type !== 'contract_terminate' && <>
              <button className="secondary-button" onClick={() => void linkManuallySelectedContract()} disabled={working || !manualContractId}>既存契約と稟議を紐付ける</button>
              <small>この操作は契約・請求データを変更せず、稟議との関連だけを記録します。</small>
            </>}
          </div>}
          {(selected.request_type === 'contract_terminate' || selected.request_type === 'contract_cancellation_review') && <div className="change-item-editor">
            {selected.request_type === 'contract_terminate' && <label>契約終了日<input type="date" value={terminationDate} onChange={(event) => setTerminationDate(event.target.value)} /></label>}
            <label>解約対象範囲<select value={terminationScope} onChange={(event) => { setTerminationScope(event.target.value as 'contract' | 'unit' | 'parking'); setTerminationUnitIds([]); }}>
              <option value="contract">契約全体</option><option value="unit">選択した区画（貸室・駐車場など）</option><option value="parking">駐車場のみ</option>
            </select></label>
            {terminationScope !== 'contract' && <fieldset className="termination-unit-picker">
              <legend>対象区画（契約ごとに複数選択可）</legend>
              <p className="muted">選択した各契約から解約する区画を1件以上選んでください。現在 {terminationUnitIds.length} 区画を選択中です。</p>
              {terminationTargetContractIds.length > 0 ? <div className="termination-unit-options">
                {terminationTargetUnits.filter((entry) => terminationScope !== 'parking' || entry.unit?.unit_type === 'parking').map((entry) => {
                  const unit = entry.unit;
                  const checked = terminationUnitIds.includes(entry.lease_contract_unit_id);
                  const isParkingUnit = unit?.unit_type === 'parking';
                  const isOfficeUnit = unit?.unit_type === 'office';
                  const parkingSpaceNumber = unit?.parking_space?.space_number;
                  const areaLabel = entry.leased_area_sqm == null
                    ? '未設定'
                    : `${Number(entry.leased_area_sqm).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}㎡`;
                  const unitDetail = isParkingUnit
                    ? `区画番号 ${parkingSpaceNumber ?? '未設定'} / ${unit?.unit_code ?? '区画コード未設定'}`
                    : isOfficeUnit
                      ? `区画 ${unit?.unit_name ?? unit?.unit_code ?? '未設定'} / 面積 ${areaLabel}`
                      : unit?.unit_code ?? '区画コード未設定';
                  return <label key={entry.lease_contract_unit_id} className={checked ? 'termination-unit-option selected' : 'termination-unit-option'}>
                    <input type="checkbox" checked={checked} onChange={(event) => setTerminationUnitIds((current) => event.target.checked ? [...current, entry.lease_contract_unit_id] : current.filter((id) => id !== entry.lease_contract_unit_id))} />
                    <span><strong>{isParkingUnit ? `駐車区画 ${parkingSpaceNumber ?? '番号未設定'}` : unit?.floor_label ?? unit?.unit_code ?? '区画未設定'}</strong><small>{unit?.asset?.asset_name ?? '物件未設定'} / {unit?.unit_type === 'parking' ? '駐車場' : unit?.unit_type === 'bicycle_parking' ? '駐輪場' : unit?.unit_type === 'signage' ? '看板' : unit?.unit_type === 'antenna' ? 'アンテナ' : unit?.unit_type === 'warehouse' ? '倉庫' : unit?.unit_type === 'office' ? '貸室' : unit?.unit_type ?? '区画'} / {unitDetail} / {entry.contract?.tenant?.tenant_name ?? selectedManualContract?.tenant?.tenant_name ?? 'テナント未設定'} / 契約期間 {entry.lease_start_date ?? '開始日未設定'} ～ {entry.lease_end_date ?? '継続中'}</small></span>
                  </label>;
                })}
                {terminationTargetUnits.filter((entry) => terminationScope !== 'parking' || entry.unit?.unit_type === 'parking').length === 0 && <p className="muted">選択した契約に紐づく対象区画がありません。</p>}
              </div> : <p className="muted">先に紐づける契約を1件以上選択してください。</p>}
            </fieldset>}
            {selected?.request_type === 'contract_terminate' && editable && <button className="primary-button" onClick={() => void handoffAppsuiteTermination()} disabled={working || !terminationDate || terminationTargetContractIds.length === 0 || (terminationScope !== 'contract' && terminationUnitIds.length === 0)}>選択した{terminationTargetContractIds.length}件を紐付けて契約業務フローへ移行</button>}
          </div>}
          {candidateLoading ? <p className="muted">候補を取得中です…</p> : workflowCandidates.length === 0 ? <p className="muted">候補なし。分類・建物・テナント・契約期間を確認してください。</p> : <details open={workflowCandidates.length <= 5}>
            <summary>契約候補を表示（{workflowCandidates.length}件）</summary>
            {workflowCandidates.map((candidate) => <article key={`${candidate.lease_contract_id}-${candidate.lease_contract_unit_id}`} className="workflow-contract-candidate">
            <div><strong>{candidate.tenant_name}</strong><span>{candidate.property_name} / {candidate.floor_label ?? candidate.unit_code} / {candidate.unit_type === 'parking' ? '駐車場' : candidate.unit_type === 'bicycle_parking' ? '駐輪場' : candidate.unit_type === 'signage' ? '看板' : candidate.unit_type === 'antenna' ? 'アンテナ' : candidate.unit_type === 'warehouse' ? '倉庫' : candidate.unit_type === 'office' ? '貸室' : candidate.unit_type ?? '区画'}</span><span>契約期間: {candidate.contract_start_date ?? '未設定'} ～ {candidate.contract_end_date ?? '継続中'}</span></div>
            <div><strong>判定: {candidate.suggestion_level}</strong><ul>{candidate.match_reasons.filter((reason) => reason.matched || reason.rule === 'effective_date').map((reason) => <li key={reason.rule}>{reason.matched ? '✓ ' : '⚠ '}{reason.message}</li>)}</ul></div>
            {selected.request_type === 'contract_terminate' && editable && <button className="secondary-button" onClick={() => {
              setTerminationContractIds((current) => current.includes(candidate.lease_contract_id) ? current : [...current, candidate.lease_contract_id]);
              setTerminationUnitIds([]);
            }} disabled={working}>契約選択に追加</button>}
            {selected.request_type !== 'contract_terminate' && (editable || selected.status === 'resolved') && <button className="secondary-button" onClick={() => void confirmWorkflowContract(candidate)} disabled={working}>この契約に紐付ける</button>}
          </article>)}
          </details>}
        </section>}
        {isLinkedContractCreate && <section className="change-card">
          <h4>既存契約との照合・完了</h4>
          <p>リンク済みの契約をすべて確認します。契約者・物件・区画・期間を原本と照合してください。ここでは契約データを新規作成しません。</p>
          {workflowLinks.map((link) => <label key={link.workflow_contract_link_id} className="thread-linked-workflow-check">
            <input type="checkbox" checked={verifiedLinkIds.includes(link.workflow_contract_link_id)} disabled={working || selected.status === 'applied'} onChange={(event) => setVerifiedLinkIds((current) => event.target.checked ? [...current, link.workflow_contract_link_id] : current.filter((id) => id !== link.workflow_contract_link_id))} />
            <span>{workflowLinkSummary(link, contractUnits)}</span>
          </label>)}
          {selected.status !== 'applied' && <>
            <div className="thread-confirmation-checks">{([['tenant', '契約者'], ['property', '物件'], ['unit', '区画'], ['period', '期間']] as const).map(([field, label]) => <label key={field} className="thread-confirmation-check"><input type="checkbox" checked={!!confirmedFields[field]} onChange={(event) => setConfirmedFields((current) => ({ ...current, [field]: event.target.checked }))} /><span>{label}を照合済み</span></label>)}</div>
            <label>照合結果・表記差などの判断理由<textarea value={reconciliationNote} onChange={(event) => setReconciliationNote(event.target.value)} placeholder="例：契約原本で4項目を照合。契約者の株式会社／(株)は同一法人の表記差。" /></label>
            <ActionButton className="primary-button" onClick={() => void completeLinkedContract()} disabled={working || verifiedLinkIds.length !== workflowLinks.length || ['tenant', 'property', 'unit', 'period'].some((field) => !confirmedFields[field]) || !reconciliationNote.trim()} label={working ? '処理中…' : '既存契約との照合を確定して完了'} hint="照合結果と全リンクを記録し、対応依頼とAppSuiteの処理を完了します。" />
          </>}
        </section>}
        {isParkingFeeRequest ? <ParkingFeeRequestEditor key={`${selected.change_request_id}-${selected.row_version}`} request={selected} contractUnits={contractUnits} role={role} working={working} onWorking={setWorking} onError={setError} onSaved={async (nextMessage) => { setMessage(nextMessage); await loadRequests(); }} onHold={() => setStatus('on_hold')} /> : null}
        {isContractDeadlineRequest && editable ? <ContractDeadlineRequestEditor key={`${selected.change_request_id}-${selected.row_version}-${selectedContract?.row_version ?? 'loading'}-${contractUnits.length}`} request={selected} contract={selectedContract} contractUnits={contractUnits} role={role} working={working} onWorking={setWorking} onError={setError} onSaved={async (nextMessage) => { setMessage(nextMessage); await loadRequests(); }} onHold={() => setStatus('on_hold')} /> : null}
        {isContractCreateLinkLoading && <p className="muted">既存契約リンクを確認中です…</p>}
        {isAppsuiteContractRequest && !isLinkedContractCreate && !isContractCreateLinkLoading && (editable || selected.status === 'resolved') && <AppsuiteContractEditor key={`${selected.change_request_id}-${selected.row_version}`} request={selected} properties={properties} tenants={tenants} units={units} contracts={contracts} contractUnits={contractUnits} role={role} working={working} onWorking={setWorking} onError={setError} onSaved={async (nextMessage) => { setMessage(nextMessage); await loadRequests(); }} />}
        {!isAppsuiteContractRequest && !isParkingFeeRequest && !isContractDeadlineRequest && (reviewOnly ? <section className="change-card change-no-edit"><h4>契約条件の入力は不要です</h4><p>この依頼は、取込内容と元資料の一致を確認する作業です。確認した資料と結果を対応メモに残してください。</p></section> : <section className="change-card"><h4>反映する契約条件</h4><p>現在の値と反映予定の値を確認します。</p><div className="change-diff-table"><div className="change-diff-head"><span>項目</span><span>現在</span><span>反映予定</span></div>{domainItems.map((item) => <div key={item.change_request_item_id}><strong>{item.field_name || '未設定'}</strong><span>{prettyValue(item.current_value)}</span><span className="proposed-value">{prettyValue(item.proposed_value)}</span></div>)}</div></section>)}
        {editable && !reviewOnly && !isAppsuiteContractRequest && !isParkingFeeRequest && !isContractDeadlineRequest && <section className="change-card"><h4>契約条件を修正</h4><p>取込元と照合して対象区画が確定した場合のみ、賃料・面積・期間を入力します。候補は「物件｜棟｜階｜区画コード 区画名｜契約者」で表示します。</p><div className="change-item-editor"><label>対象区画
  <input value={itemUnitSearch} onChange={(event) => setItemUnitSearch(event.target.value)} placeholder="テナント名・区画コードで絞り込み" />
  <select value={itemUnitId} onChange={(event) => setItemUnitId(event.target.value)}>
    <option value="">選択してください（{filteredAvailableContractUnits.length}件中）</option>
    {itemUnitId && !filteredAvailableContractUnits.some((u) => u.lease_contract_unit_id === itemUnitId) && (() => { const current = availableContractUnits.find((u) => u.lease_contract_unit_id === itemUnitId); return current ? <option value={current.lease_contract_unit_id}>{contractUnitLabel(current)}（選択中）</option> : null; })()}
    {filteredAvailableContractUnits.map((unit) => <option key={unit.lease_contract_unit_id} value={unit.lease_contract_unit_id}>{contractUnitLabel(unit)}</option>)}
  </select>
</label><label>項目<select value={itemField} onChange={(event) => setItemField(event.target.value as typeof itemField)}>{editableFields.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>反映予定の値<input value={itemValue} onChange={(event) => setItemValue(event.target.value)} placeholder={itemField.endsWith('_date') ? 'YYYY-MM-DD' : '例: 100000'} /></label><button className="secondary-button" onClick={() => void updateItem()} disabled={working}>契約条件を保存</button></div></section>}
        <section className="change-card thread-history-card"><div className="thread-history-heading"><div><h4>案件スレッド</h4><p>確認内容、コメント、状態変更の履歴を時系列で記録します。</p></div><span>{threadTimeline.length}件</span></div><div className="thread-history-timeline">{threadTimeline.length ? threadTimeline.map((entry) => <article key={`${entry.type}-${entry.id}`} className={`thread-history-entry ${entry.type}`}><i>{entry.type === 'comment' ? '●' : '✓'}</i><div><header><strong>{entry.title}</strong><time>{formatDate(entry.created_at)}</time></header>{entry.body && <p>{entry.body}</p>}</div></article>) : <p className="muted">この案件の記録はまだありません。</p>}</div>{editable && <div className="thread-comment-composer"><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="確認した資料、照合結果、判断理由を記録…" /><button className="primary-button" onClick={() => void addComment()} disabled={working || !comment.trim()}>{working ? '保存中…' : 'コメントを追加'}</button></div>}</section>
        {!isLinkedContractCreate && !isContractCreateLinkLoading && selected.request_type === 'contract_terminate' && editable && <footer className="change-actions"><ActionButton className="secondary-button" onClick={() => void setStatus('on_hold')} disabled={working} label="保留にする" hint="後で対応するため保留にします。データは変更されません。" /><ActionButton className="secondary-button" onClick={() => void setStatus('excluded')} disabled={working} label="対象外にする" hint="この依頼を対応不要として終了します。データは変更されません。" /></footer>}
        {!isLinkedContractCreate && !isContractCreateLinkLoading && selected.request_type !== 'contract_terminate' && (editable && !isParkingFeeRequest && !isContractDeadlineRequest ? <footer className="change-actions"><ActionButton className="secondary-button" onClick={() => void setStatus('on_hold')} disabled={working} label="保留にする" hint="後で対応するため保留にします。データは変更されません。" /><ActionButton className="secondary-button" onClick={() => void setStatus('excluded')} disabled={working} label="対象外にする" hint="この依頼を対応不要として終了します。データは変更されません。" /><ActionButton className="primary-button" onClick={() => void resolve()} disabled={working || !!selected.items?.some((item) => item.validation_status !== 'valid')} label={working ? '処理中…' : selected.items?.some((item) => item.validation_status !== 'valid') ? '確認項目が未完了' : '確認完了にする'} hint="未完了の確認項目を上で確認してください。すべて確認済みになると完了できます。" /></footer> : selected.status === 'resolved' && selected.request_type !== 'approval_cancel' && !isParkingFeeRequest && !isContractDeadlineRequest ? <footer className="change-actions"><p>最終確認後、正本へ反映します。</p><ActionButton className="primary-button" onClick={() => void apply()} disabled={working} label={working ? '処理中…' : '内容を確定'} hint="確認済みの内容を正本データへ反映します。この操作は取り消せません。" /></footer> : null)}
      </> : <p className="change-empty">{filter === 'open' && !search.trim() && !loading ? 'すべての要確認案件を処理しました。' : '左側から対応依頼を選択してください。'}</p>}</main>
    </div>
  </section>;
}
