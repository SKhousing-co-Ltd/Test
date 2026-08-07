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
    <section className="contract-workflow-toolbar"><label className="contract-workflow-search">申請・テナント・物件を検索<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="稟議番号・テナント名・物件名" /></label><span><strong>{filteredItems.length}</strong> 件を表示</span></section>
    <section className="contract-workflow-panel"><div className="table-wrap"><table className="contract-workflow-table"><thead><tr><th>稟議番号</th><th>テナント・物件</th><th>申請種別</th><th>決裁日</th><th>照合状態</th><th>契約完了</th><th /></tr></thead><tbody>
      {loading && <tr><td colSpan={7} className="contract-workflow-empty">読み込み中…</td></tr>}
      {!loading && !filteredItems.length && <tr><td colSpan={7} className="contract-workflow-empty">フロー対象の契約はありません。</td></tr>}
      {!loading && filteredItems.map((item) => <tr key={item.appsuite_record_id}><td><strong>{item.ringi_number ?? item.data_id}</strong><small>AppSuite ID: {item.data_id}</small></td><td><strong>{item.tenant_name ?? '未設定'}</strong><small>{item.property_name ?? '未設定'}</small></td><td>{item.workflow_type ?? '—'}</td><td>{dateTime(item.approved_at)}</td><td><span className={`workflow-match ${item.match_status}`}>{matchLabels[item.match_status]}</span>{item.match_status === 'ambiguous' && <small>{item.active_contract_count} 件のactive契約が一致</small>}</td><td>{item.workflow_completed_at ? <span className="workflow-completed">{dateTime(item.workflow_completed_at)} に記録済み</span> : '未完了'}</td><td>{canComplete && !item.workflow_completed_at && <button className="primary-button workflow-complete-button" disabled={savingId === item.appsuite_record_id} onClick={() => void complete(item)}>{savingId === item.appsuite_record_id ? '記録中…' : '契約完了にする'}</button>}</td></tr>)}
    </tbody></table></div></section>
  </section>;
}
