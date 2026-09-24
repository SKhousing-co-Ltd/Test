import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';

type WorkflowItem = {
  appsuite_record_id: string;
  app_id: string;
  data_id: string;
  ringi_number: string | null;
  workflow_type: string | null;
  property_name: string | null;
  tenant_name: string | null;
  approved_at: string | null;
  source_updated_at: string | null;
  workflow_completed_at: string | null;
  workflow_completed_by: string | null;
  match_status: 'not_reflected' | 'waiting_completion' | 'ready_to_process' | 'ambiguous';
  active_contract_count: number;
};
type WorkflowCandidate = { lease_contract_id: string; tenant_name: string; property_name: string; lease_contract_unit_id: string; unit_code: string; floor_label: string | null; contract_start_date: string | null; contract_end_date: string | null };

const matchLabels: Record<WorkflowItem['match_status'], string> = {
  not_reflected: '対応中（レントロール未反映）',
  waiting_completion: '完了待ち（レントロール反映済）',
  ready_to_process: '処理中',
  ambiguous: '照合要確認',
};

function dateTime(value: string | null) {
  return value ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
}

export function ContractWorkflowPage({ canComplete }: { canComplete: boolean }) {
  const [items, setItems] = useState<WorkflowItem[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [linkingItem, setLinkingItem] = useState<WorkflowItem | null>(null);
  const [candidates, setCandidates] = useState<WorkflowCandidate[]>([]);
  const [selectedContractId, setSelectedContractId] = useState('');
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const [confirmLink, setConfirmLink] = useState(false);

  const load = async () => {
    if (!supabase) return;
    setLoading(true);
    setError('');
    const { data, error: loadError } = await supabase.rpc('list_contract_workflow_queue');
    if (loadError) setError(`契約業務フローを読み込めませんでした: ${loadError.message}`);
    else setItems((data ?? []) as WorkflowItem[]);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const complete = async (item: WorkflowItem) => {
    if (!supabase) return;
    setSavingId(item.appsuite_record_id);
    setError('');
    setNotice('');
    const { error: completeError } = await supabase.rpc('complete_contract_workflow', { p_appsuite_record_id: item.appsuite_record_id });
    setSavingId(null);
    if (completeError) return setError(`契約完了を記録できませんでした: ${completeError.message}`);
    setNotice(item.match_status === 'waiting_completion' ? '契約完了を記録し、処理済みにしました。' : '契約完了を記録しました。レントロール反映後に自動で処理済みになります。');
    await load();
  };

  const beginLink = async (item: WorkflowItem) => {
    if (!supabase) return;
    setError(''); setNotice(''); setLinkingItem(item); setCandidates([]); setSelectedContractId(''); setSelectedUnitIds([]); setConfirmLink(false);
    const { data, error: candidateError } = await supabase.rpc('list_workflow_contract_candidates', { p_appsuite_record_id: item.appsuite_record_id });
    if (candidateError) { setError(`契約候補を取得できませんでした: ${candidateError.message}`); return; }
    const next = (data ?? []) as WorkflowCandidate[];
    setCandidates(next);
    if (next.length) setSelectedContractId(next[0].lease_contract_id);
  };

  const linkAndComplete = async () => {
    if (!supabase || !linkingItem || !selectedContractId) return;
    setSavingId(linkingItem.appsuite_record_id); setError(''); setNotice('');
    const { error: linkError } = await supabase.rpc('link_and_complete_contract_workflow', {
      p_appsuite_record_id: linkingItem.appsuite_record_id,
      p_lease_contract_id: selectedContractId,
      p_lease_contract_unit_ids: selectedUnitIds,
      p_effective_date: null,
    });
    setSavingId(null);
    if (linkError) { setError(`契約紐づけに失敗しました: ${linkError.message}`); return; }
    setLinkingItem(null); setConfirmLink(false); setNotice('契約を紐づけ、ワークフローを処理済みにしました。'); await load();
  };

  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ja-JP');
    if (!normalized) return items;
    return items.filter((item) => [item.ringi_number, item.data_id, item.property_name, item.tenant_name, item.workflow_type]
      .some((value) => value?.toLocaleLowerCase('ja-JP').includes(normalized)));
  }, [items, query]);

  return <section className="contract-workflow-page">
    <div className="page-heading"><div><p className="section-kicker">CONTRACT WORKFLOW</p><h2>契約業務フロー</h2><p>AppSuiteで社長決裁済みの申請を、レントロール反映と契約完了まで管理します。</p></div></div>
    {error && <p className="contract-workflow-message error">{error}</p>}
    {notice && <p className="contract-workflow-message">{notice}</p>}
    {linkingItem && <section className="contract-workflow-link-panel"><header><strong>既存契約へ紐づけ</strong><button className="text-button" onClick={() => setLinkingItem(null)}>閉じる</button></header><p>{linkingItem.ringi_number ?? linkingItem.data_id} / {linkingItem.property_name ?? '物件未設定'} / {linkingItem.tenant_name ?? 'テナント未設定'}</p>{!candidates.length ? <p className="contract-workflow-empty">一致する契約候補がありません。</p> : <><label>契約<select value={selectedContractId} onChange={(event) => { setSelectedContractId(event.target.value); setSelectedUnitIds([]); setConfirmLink(false); }}>{Array.from(new Map(candidates.map((candidate) => [candidate.lease_contract_id, candidate])).values()).map((candidate) => <option key={candidate.lease_contract_id} value={candidate.lease_contract_id}>{candidate.tenant_name} / {candidate.property_name} / {candidate.contract_start_date ?? '開始日未設定'} ～ {candidate.contract_end_date ?? '継続中'}</option>)}</select></label><div className="contract-workflow-unit-options">{candidates.filter((candidate) => candidate.lease_contract_id === selectedContractId).map((candidate) => <label key={candidate.lease_contract_unit_id}><input type="checkbox" checked={selectedUnitIds.includes(candidate.lease_contract_unit_id)} onChange={(event) => { setConfirmLink(false); setSelectedUnitIds((current) => event.target.checked ? [...current, candidate.lease_contract_unit_id] : current.filter((id) => id !== candidate.lease_contract_unit_id)); }} /> {candidate.floor_label ?? ''} / {candidate.unit_code}</label>)}</div>{!confirmLink ? <button className="primary-button" disabled={!selectedContractId || savingId === linkingItem.appsuite_record_id} onClick={() => setConfirmLink(true)}>紐づけ内容を確認</button> : <div className="contract-workflow-confirm"><h4>紐づけ内容の確認</h4><dl><dt>ワークフロー</dt><dd>{linkingItem.ringi_number ?? linkingItem.data_id} / {linkingItem.workflow_type ?? '契約ワークフロー'}</dd><dt>物件・テナント</dt><dd>{linkingItem.property_name ?? '物件未設定'} / {linkingItem.tenant_name ?? 'テナント未設定'}</dd><dt>契約期間</dt><dd>{candidates.find((candidate) => candidate.lease_contract_id === selectedContractId)?.contract_start_date ?? '開始日未設定'} ～ {candidates.find((candidate) => candidate.lease_contract_id === selectedContractId)?.contract_end_date ?? '継続中'}</dd><dt>対象区画</dt><dd>{selectedUnitIds.length ? candidates.filter((candidate) => selectedUnitIds.includes(candidate.lease_contract_unit_id)).map((candidate) => `${candidate.floor_label ?? ''} / ${candidate.unit_code}`).join('、') : '契約全体'}</dd></dl><p className="contract-workflow-confirm-warning">実行すると契約との紐づけ、契約完了、一覧からの消し込みを行います。契約本体は変更しません。</p><button className="secondary-button" onClick={() => setConfirmLink(false)}>選択に戻る</button><button className="primary-button" disabled={savingId === linkingItem.appsuite_record_id} onClick={() => void linkAndComplete()}>{savingId === linkingItem.appsuite_record_id ? '処理中…' : '内容を確認して処理済みにする'}</button></div>}</>}</section>}
    <section className="contract-workflow-toolbar"><label className="contract-workflow-search">申請・テナント・物件を検索<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="稟議番号・テナント名・物件名" /></label><span><strong>{filteredItems.length}</strong> 件を表示</span></section>
    <section className="contract-workflow-panel"><div className="table-wrap"><table className="contract-workflow-table"><thead><tr><th>稟議番号</th><th>テナント・物件</th><th>申請種別</th><th>決裁日</th><th>照合状態</th><th>契約完了</th><th /></tr></thead><tbody>
      {loading && <tr><td colSpan={7} className="contract-workflow-empty">読み込み中…</td></tr>}
      {!loading && !filteredItems.length && <tr><td colSpan={7} className="contract-workflow-empty">フロー対象の契約はありません。</td></tr>}
      {!loading && filteredItems.map((item) => <tr key={item.appsuite_record_id}><td><strong>{item.ringi_number ?? item.data_id}</strong><small>AppSuite ID: {item.data_id}</small></td><td><strong>{item.tenant_name ?? '未設定'}</strong><small>{item.property_name ?? '未設定'}</small></td><td>{item.workflow_type ?? '—'}</td><td>{dateTime(item.approved_at)}</td><td><span className={`workflow-match ${item.match_status}`}>{matchLabels[item.match_status]}</span>{item.match_status === 'ambiguous' && <small>{item.active_contract_count} 件のactive契約が一致</small>}</td><td>{item.workflow_completed_at ? <span className="workflow-completed">{dateTime(item.workflow_completed_at)} に記録済み</span> : '未完了'}</td><td>{canComplete && !item.workflow_completed_at && <><button className="primary-button workflow-complete-button" disabled={savingId === item.appsuite_record_id} onClick={() => void beginLink(item)}>契約を紐づけて処理済み</button><button className="secondary-button workflow-complete-button" disabled={savingId === item.appsuite_record_id} onClick={() => void complete(item)}>紐づけず完了</button></>}</td></tr>)}
    </tbody></table></div></section>
  </section>;
}
