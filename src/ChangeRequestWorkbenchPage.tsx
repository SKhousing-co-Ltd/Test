import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';

type RequestStatus = 'open' | 'in_review' | 'on_hold' | 'resolved' | 'applied' | 'excluded' | string;
type JsonObject = Record<string, unknown>;
type ImportIssueSource = { source_file_name: string; source_sheet_name: string; source_row_number: number | null };
type ChangeRequestItem = { change_request_item_id: string; entity_type: string; entity_id: string | null; field_name: string | null; current_value: unknown; proposed_value: unknown; validation_status: string; validation_message: string | null; import_issue?: ImportIssueSource | null };
type ChangeRequestComment = { change_request_comment_id: string; body: string; created_at: string };
type ChangeRequest = {
  change_request_id: string; request_type: string; status: RequestStatus; source_type: string;
  title: string; summary: string | null; source_payload: JsonObject; proposed_payload: JsonObject;
  row_version: number; updated_at: string; items?: ChangeRequestItem[]; comments?: ChangeRequestComment[];
};
type ContractUnitOption = {
  lease_contract_unit_id: string;
  unit: {
    unit_code: string;
    unit_name: string | null;
    floor_label: string | null;
    building_wing: { wing_code: string; wing_name: string | null } | null;
    asset: { asset_name: string } | null;
  } | null;
  contract: { contract_status: string; tenant: { tenant_name: string } | null } | null;
};

const editableFields = [
  ['leased_area_sqm', '契約面積（㎡）'], ['monthly_rent_amount', '月額賃料'], ['monthly_common_charge_amount', '月額共益費'],
  ['deposit_amount', '保証金・敷金'], ['security_deposit_amount', '敷金'], ['key_money_amount', '礼金'],
  ['renewal_fee_amount', '更新料'], ['lease_start_date', '契約開始日'], ['lease_end_date', '契約終了日'],
] as const;
const statusLabel: Record<string, string> = { open: '要確認', in_review: '確認中', on_hold: '保留', resolved: 'Resolve済み', applied: '適用済み', excluded: '対象外' };
const sourceLabels: Record<string, string> = { floor: '階', unit: '取込元の区画表記', tenant_name: '取込元のテナント名', tenant_code: '取込元のテナントコード', discriminator: '仮識別子' };
const formatDate = (value: string) => new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const prettyValue = (value: unknown) => value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
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

function IssueContext({ request }: { request: ChangeRequest }) {
  const issueType = getImportType(request);
  if (!issueType) return null;
  const sourceRows = Object.entries(request.source_payload).filter(([, value]) => value !== null && value !== undefined && value !== '');
  const importSource = request.items?.find((item) => item.import_issue)?.import_issue;
  const guide: Record<string, { title: string; steps: string[] }> = {
    multiple_tenant_codes: {
      title: 'この区画には複数のテナントコードが記載されています',
      steps: ['下の「取込元の記載」でテナントコードを確認します。改行で複数並んでいる場合があります。', '元のレントロールまたは契約書を見て、この区画で採用するテナントコードを1つ決めます。', '採用するコード・根拠を対応メモへ残します。区画を特定できない場合は「保留」にします。'],
    },
    combined_unit: {
      title: '複数区画をまとめて1契約として記載されています',
      steps: ['下の「取込元の区画表記」と階を確認します。例：A・B、C〜E。', '平面図と契約書を確認し、実際にこの契約に含める区画を特定します。', '区画が確定した後だけ、必要に応じて賃料・面積・期間を「契約条件を修正」で入力します。'],
    },
    temporary_unit_discriminator: {
      title: '同じ名称の区画を区別するため、仮識別子を付けています',
      steps: ['階・区画表記・テナント名・仮識別子が、元の資料と一致するか確認します。', 'どの実際の区画に対応するかを平面図・契約書で特定します。', '特定できない場合は、判断理由をメモに残して「保留」にします。'],
    },
    layout_not_supported: {
      title: 'このExcelレイアウトは自動取込の対象外です',
      steps: ['元のExcelを開き、棟・階・区画・テナントがどの列に書かれているか確認します。', '資料の保存場所と確認結果を対応メモへ残します。', 'この依頼は賃料入力では解決しないため、「保留」にして取込設定の追加を依頼します。'],
    },
  };
  const detail = guide[issueType] ?? { title: '取込内容の確認が必要です', steps: ['下の取込元の記載と元の資料を照合します。', '判断内容を対応メモに残します。'] };
  return <section className="change-card issue-context">
    <p className="section-kicker">IMPORT SOURCE</p>
    <h4>{detail.title}</h4>
    <p>取込時の元データをそのまま表示しています。まずこの内容と元のExcel・契約書・平面図を照合してください。</p>
    <div className="change-diff-table">
      <div className="change-diff-head"><span>ソースシート（物件）</span><span>元Excelファイル</span><span>該当行</span></div>
      <div><strong>{importSource?.source_sheet_name ?? '確認中'}</strong><span>{importSource?.source_file_name ?? '確認中'}</span><span>{importSource?.source_row_number ? `${importSource.source_row_number} 行目` : '行番号なし'}</span></div>
    </div>
    <div className="change-diff-table">
      <div className="change-diff-head"><span>取込元の項目</span><span>記載されていた値</span><span>確認すること</span></div>
      {sourceRows.length ? sourceRows.map(([key, value]) => <div key={key}><strong>{sourceLabels[key] ?? key}</strong><span>{prettyValue(value)}</span><span>{key === 'tenant_code' ? '契約書と照合して採用するコードを決める' : key === 'unit' ? '平面図で実際に含まれる区画を確認する' : '元資料と一致するか確認する'}</span></div>) : <div><strong>取込元データ</strong><span>表示できる項目がありません</span><span>元のExcelレイアウトを確認し、対応メモへ保存場所を記録する</span></div>}
    </div>
    <details className="change-dev-details"><summary>取込ペイロード全体を確認</summary><pre className="change-json-editor">{JSON.stringify(request.source_payload, null, 2)}</pre></details>
    <h4>この依頼で行うこと</h4>
    <ol>{detail.steps.map((step) => <li key={step}>{step}</li>)}</ol>
  </section>;
}

export function ChangeRequestWorkbenchPage() {
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
  const [itemUnitId, setItemUnitId] = useState('');
  const [itemField, setItemField] = useState<(typeof editableFields)[number][0]>('leased_area_sqm');
  const [itemValue, setItemValue] = useState('');

  const loadRequests = useCallback(async () => {
    if (!supabase) return;
    setLoading(true); setError('');
    const { data, error: loadError } = await supabase.from('change_request')
      .select('change_request_id, request_type, status, source_type, title, summary, source_payload, proposed_payload, row_version, updated_at, items:change_request_item(change_request_item_id, entity_type, entity_id, field_name, current_value, proposed_value, validation_status, validation_message, import_issue:rent_roll_import_issue(source_file_name, source_sheet_name, source_row_number)), comments:change_request_comment(change_request_comment_id, body, created_at)')
      .order('updated_at', { ascending: false });
    setLoading(false);
    if (loadError) { setError(`対応依頼を読み込めませんでした: ${loadError.message}`); return; }
    const result = (data ?? []) as unknown as ChangeRequest[];
    setRequests(result);
    setSelectedId((current) => current && result.some((item) => item.change_request_id === current) ? current : result[0]?.change_request_id ?? null);
  }, []);

  useEffect(() => { void loadRequests(); }, [loadRequests]);
  useEffect(() => {
    if (!supabase) return;
    void supabase.from('lease_contract_unit')
      .select('lease_contract_unit_id, unit:unit_master(unit_code, unit_name, floor_label, building_wing:building_wing_master(wing_code, wing_name), asset:asset_master(asset_name)), contract:lease_contract(contract_status, tenant:tenant_master(tenant_name))')
      .then(({ data, error: unitLoadError }) => {
        if (unitLoadError) { setError(`対象区画の候補を読み込めませんでした: ${unitLoadError.message}`); return; }
        setContractUnits(((data ?? []) as unknown as ContractUnitOption[]).sort(compareContractUnitOptions));
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
    if (!selected || !supabase || !window.confirm('確認内容を見直したうえでResolveしますか？')) return;
    setWorking(true); setError('');
    const { error: resolveError } = await supabase.rpc('resolve_change_request', { p_change_request_id: selected.change_request_id, p_expected_row_version: selected.row_version, p_resolution_payload: {} });
    setWorking(false);
    if (resolveError) { setError(`Resolveできませんでした: ${resolveError.message}`); return; }
    setMessage('Resolveしました。続けて「適用を確定」を押すと正本へ反映します。'); await loadRequests();
  };
  const apply = async () => {
    if (!selected || !supabase || !window.confirm('正本への反映を確定しますか？')) return;
    setWorking(true); setError('');
    const { error: applyError } = await supabase.rpc('apply_change_request', { p_change_request_id: selected.change_request_id, p_expected_row_version: selected.row_version });
    setWorking(false);
    if (applyError) { setError(`適用できませんでした: ${applyError.message}`); return; }
    setMessage('正本へ反映し、取込エラーを解決済みにしました。'); await loadRequests();
  };

  return <section className="change-workbench">
    <div className="page-heading"><p className="section-kicker">DATA REVIEW WORKBENCH</p><h2>取込データ・対応依頼</h2><p>選択した依頼ごとに、取込元の記載と確認手順を見ながら判断します。</p></div>
    {error && <p className="change-message error">{error}</p>}{message && <p className="change-message">{message}</p>}
    <div className="change-workbench-layout">
      <aside className="change-request-list"><header><div><h3>対応依頼</h3><p>未対応のものから順に確認します</p></div><button className="secondary-button" onClick={() => void loadRequests()} disabled={loading}>更新</button></header>
        <div className="change-filters"><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="open">要確認</option><option value="on_hold">保留</option><option value="resolved">Resolve済み</option><option value="applied">適用済み</option><option value="excluded">対象外</option><option value="all">すべて</option></select><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="区画・テナント名・コードで検索" /></div>
        <div className="change-request-rows">{loading ? <p className="change-empty">読み込み中…</p> : filtered.length === 0 ? <p className="change-empty">該当する対応依頼はありません。</p> : filtered.map((request) => <button key={request.change_request_id} onClick={() => setSelectedId(request.change_request_id)} className={request.change_request_id === selectedId ? 'selected' : ''}><span className={`change-status ${request.status}`}>{statusLabel[request.status] ?? request.status}</span><strong>{request.title}</strong><small>{request.summary || '確認待ち'}</small></button>)}</div>
      </aside>
      <main className="change-request-detail">{selected ? <>
        <header className="change-detail-heading"><div><p className="section-kicker">{selected.source_type === 'initial_import' ? 'INITIAL IMPORT' : selected.source_type}</p><h3>{selected.title}</h3><p>{selected.summary || '取込内容を確認してください。'} <span>最終更新: {formatDate(selected.updated_at)}</span></p></div><span className={`change-status ${selected.status}`}>{statusLabel[selected.status] ?? selected.status}</span></header>
        <IssueContext request={selected} />
        <section className="change-card"><h4>反映する契約条件</h4><p>{getImportType(selected) ? '区画が確定した後にだけ、下の項目を入力します。区画やテナントの判定そのものをここで無理に入力しないでください。' : '現在の値と反映予定の値を確認します。'}</p><div className="change-diff-table"><div className="change-diff-head"><span>項目</span><span>現在</span><span>反映予定</span></div>{(selected.items ?? []).map((item) => <div key={item.change_request_item_id}><strong>{item.field_name || '未設定（取込エラーの確認待ち）'}</strong><span>{prettyValue(item.current_value)}</span><span className="proposed-value">{prettyValue(item.proposed_value)}</span></div>)}</div></section>
        {editable && <section className="change-card"><h4>契約条件を修正</h4><p>取込元と照合して対象区画が確定した場合のみ、賃料・面積・期間を入力します。候補は「物件｜棟｜階｜区画コード 区画名｜契約者」で表示します。</p><div className="change-item-editor"><label>対象区画<select value={itemUnitId} onChange={(event) => setItemUnitId(event.target.value)}><option value="">選択してください</option>{availableContractUnits.map((unit) => <option key={unit.lease_contract_unit_id} value={unit.lease_contract_unit_id}>{contractUnitLabel(unit)}</option>)}</select></label><label>項目<select value={itemField} onChange={(event) => setItemField(event.target.value as typeof itemField)}>{editableFields.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>反映予定の値<input value={itemValue} onChange={(event) => setItemValue(event.target.value)} placeholder={itemField.endsWith('_date') ? 'YYYY-MM-DD' : '例: 100000'} /></label><button className="secondary-button" onClick={() => void updateItem()} disabled={working}>契約条件を保存</button></div></section>}
        <section className="change-card"><h4>対応メモ</h4><p>確認した資料、採用する区画・テナントコード、判断理由を残してください。</p><div className="change-comments">{selected.comments?.length ? selected.comments.map((entry) => <div key={entry.change_request_comment_id}><strong>開発メンバー</strong><time>{formatDate(entry.created_at)}</time><p>{entry.body}</p></div>) : <p className="muted">まだメモはありません。</p>}</div>{editable && <div className="comment-composer"><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="例：原本Excelの〇シートと契約書を確認。4F A〜Cを1契約として扱う。" /><button className="secondary-button" onClick={() => void addComment()} disabled={working || !comment.trim()}>メモを追加</button></div>}</section>
        {editable ? <footer className="change-actions"><button className="secondary-button" onClick={() => void setStatus('on_hold')} disabled={working}>保留にする</button><button className="secondary-button" onClick={() => void setStatus('excluded')} disabled={working}>対象外にする</button><button className="primary-button" onClick={() => void resolve()} disabled={working}>{working ? '処理中…' : 'Resolveする'}</button></footer> : selected.status === 'resolved' ? <footer className="change-actions"><button className="primary-button" onClick={() => void apply()} disabled={working}>{working ? '処理中…' : '適用を確定'}</button></footer> : null}
      </> : <p className="change-empty">左側から対応依頼を選択してください。</p>}</main>
    </div>
  </section>;
}
