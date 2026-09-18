import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import './CaseProgressMigrationPage.css';

type MatchStatus = 'matched' | 'ambiguous' | 'no_approval_no' | 'workflow_not_found';

type VerificationRow = {
  case_progress_import_staging_id: string;
  legacy_case_id: string | null;
  manager_raw: string | null;
  building_raw: string | null;
  case_name_raw: string | null;
  category_raw: string | null;
  status_raw: string | null;
  approval_no_raw: string | null;
  budget_amount: number | string | null;
  decided_amount: number | string | null;
  identity_quality: 'strong' | 'fallback';
  source_active: boolean;
  validation_errors: Array<{ field?: string; message?: string }>;
  source_row_number: number;
  source_synced_at: string;
  appsuite_match_count: number;
  appsuite_record_id: string | null;
  match_status: MatchStatus;
  summary_group: 'matched' | 'sheet_only' | 'needs_review';
};

type SyncRun = {
  case_progress_sync_run_id: string;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'success' | 'partial' | 'failed';
  trigger_type: 'scheduled' | 'manual';
  source_row_count: number;
  inserted_count: number;
  updated_count: number;
  unchanged_count: number;
  inactive_count: number;
  blank_id_count: number;
  error_count: number;
  error_message: string | null;
};

const dateTimeFormatter = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tokyo' });
const currencyFormatter = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });

const dateTime = (value: string | null) => value ? dateTimeFormatter.format(new Date(value)) : '—';
const currency = (value: number | string | null) => value == null || value === '' ? '—' : currencyFormatter.format(Number(value));
const options = (rows: VerificationRow[], field: 'manager_raw' | 'building_raw' | 'status_raw') =>
  [...new Set(rows.map((row) => row[field]).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, 'ja'));

const matchLabels: Record<MatchStatus, string> = {
  matched: 'AppSuite一致',
  ambiguous: '複数候補',
  no_approval_no: '稟議Noなし',
  workflow_not_found: 'Workflowなし',
};

export function CaseProgressMigrationPage() {
  const [rows, setRows] = useState<VerificationRow[]>([]);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [manager, setManager] = useState('');
  const [building, setBuilding] = useState('');
  const [status, setStatus] = useState('');
  const [matchStatus, setMatchStatus] = useState('');
  const [idFilter, setIdFilter] = useState<'all' | 'missing'>('all');
  const [activeFilter, setActiveFilter] = useState<'active' | 'inactive' | 'all'>('active');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!supabase) {
        setError('Supabase接続設定を確認できませんでした。');
        setLoading(false);
        return;
      }
      const [rowResult, runResult] = await Promise.all([
        supabase.from('case_progress_migration_verification')
          .select('case_progress_import_staging_id, legacy_case_id, manager_raw, building_raw, case_name_raw, category_raw, status_raw, approval_no_raw, budget_amount, decided_amount, identity_quality, source_active, validation_errors, source_row_number, source_synced_at, appsuite_match_count, appsuite_record_id, match_status, summary_group')
          .order('source_row_number'),
        supabase.from('case_progress_sync_runs')
          .select('case_progress_sync_run_id, started_at, completed_at, status, trigger_type, source_row_count, inserted_count, updated_count, unchanged_count, inactive_count, blank_id_count, error_count, error_message')
          .order('started_at', { ascending: false })
          .limit(10),
      ]);
      if (cancelled) return;
      if (rowResult.error || runResult.error) {
        setError(rowResult.error?.message ?? runResult.error?.message ?? '案件移行検証データを取得できませんでした。');
      } else {
        setRows((rowResult.data ?? []) as VerificationRow[]);
        setRuns((runResult.data ?? []) as SyncRun[]);
      }
      setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  const managerOptions = useMemo(() => options(rows, 'manager_raw'), [rows]);
  const buildingOptions = useMemo(() => options(rows, 'building_raw'), [rows]);
  const statusOptions = useMemo(() => options(rows, 'status_raw'), [rows]);
  const summary = useMemo(() => rows.reduce((result, row) => {
    if (row.source_active) result.active += 1;
    if (row.source_active && row.match_status === 'matched') result.matched += 1;
    if (row.source_active && row.summary_group === 'sheet_only') result.sheetOnly += 1;
    if (row.source_active && row.summary_group === 'needs_review') result.needsReview += 1;
    if (row.source_active && row.match_status === 'no_approval_no') result.noApproval += 1;
    if (row.source_active && row.identity_quality === 'fallback') result.noId += 1;
    return result;
  }, { active: 0, matched: 0, sheetOnly: 0, needsReview: 0, noApproval: 0, noId: 0 }), [rows]);
  const filteredRows = useMemo(() => rows.filter((row) =>
    (!manager || row.manager_raw === manager)
    && (!building || row.building_raw === building)
    && (!status || row.status_raw === status)
    && (!matchStatus || row.match_status === matchStatus)
    && (idFilter === 'all' || row.identity_quality === 'fallback')
    && (activeFilter === 'all' || row.source_active === (activeFilter === 'active'))
  ), [rows, manager, building, status, matchStatus, idFilter, activeFilter]);
  const latestRun = runs[0] ?? null;

  return <section className="case-progress-page">
    <section className="case-progress-heading">
      <div><p className="section-kicker">CASE MIGRATION</p><h2>案件移行検証</h2><p>Google案件シートの取込結果とAppSuiteワークフローの突合状況を確認します。</p></div>
      <div className={`case-progress-run-status ${latestRun?.status ?? 'none'}`}><span>最終同期</span><strong>{dateTime(latestRun?.completed_at ?? latestRun?.started_at ?? null)}</strong><small>{latestRun ? runStatusLabel(latestRun.status) : '未実行'}</small></div>
    </section>
    {error && <p className="case-progress-notice error">{error}</p>}
    {latestRun?.status === 'failed' && <p className="case-progress-notice error">直近の同期に失敗しました：{latestRun.error_message ?? 'エラー内容を確認できません'}</p>}
    <section className="case-progress-metrics" aria-label="案件移行サマリー">
      <Metric label="Google Sheet" value={summary.active} />
      <Metric label="AppSuite一致" value={summary.matched} tone="success" />
      <Metric label="Sheetのみ" value={summary.sheetOnly} />
      <Metric label="要確認" value={summary.needsReview} tone="warning" />
      <Metric label="稟議Noなし" value={summary.noApproval} />
      <Metric label="IDなし" value={summary.noId} tone={summary.noId ? 'warning' : 'success'} />
    </section>
    <section className="case-progress-filters" aria-label="案件一覧フィルター">
      <Filter label="担当者" value={manager} onChange={setManager} values={managerOptions} />
      <Filter label="ビル" value={building} onChange={setBuilding} values={buildingOptions} />
      <Filter label="ステータス" value={status} onChange={setStatus} values={statusOptions} />
      <label>突合結果<select value={matchStatus} onChange={(event) => setMatchStatus(event.target.value)}><option value="">すべて</option>{Object.entries(matchLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label>ID<select value={idFilter} onChange={(event) => setIdFilter(event.target.value as 'all' | 'missing')}><option value="all">すべて</option><option value="missing">IDなし</option></select></label>
      <label>原本状態<select value={activeFilter} onChange={(event) => setActiveFilter(event.target.value as 'active' | 'inactive' | 'all')}><option value="active">有効</option><option value="inactive">原本から未検出</option><option value="all">すべて</option></select></label>
    </section>
    <section className="case-progress-panel">
      <header><div><h3>案件一覧</h3><p>{filteredRows.length}件を表示しています。</p></div></header>
      <div className="case-progress-table-wrap" tabIndex={0}>
        <table><thead><tr><th>ID</th><th>担当者</th><th>ビル</th><th>案件名</th><th>項目</th><th>ステータス</th><th>稟議No</th><th>予算</th><th>決定金額</th><th>AppSuite突合</th><th>原本</th><th>最終同期</th></tr></thead>
          <tbody>{filteredRows.map((row) => <tr key={row.case_progress_import_staging_id} className={row.validation_errors.length ? 'has-warning' : ''}>
            <td><strong>{row.legacy_case_id ?? '—'}</strong><small>行 {row.source_row_number}</small></td><td>{row.manager_raw ?? '—'}</td><td>{row.building_raw ?? '—'}</td><td>{row.case_name_raw ?? '—'}</td><td>{row.category_raw ?? '—'}</td><td>{row.status_raw ?? '—'}</td><td>{row.approval_no_raw ?? '—'}</td><td className="numeric">{currency(row.budget_amount)}</td><td className="numeric">{currency(row.decided_amount)}</td><td><span className={`case-progress-match ${row.match_status}`}>{matchLabels[row.match_status]}</span>{row.match_status === 'ambiguous' && <small>{row.appsuite_match_count}件</small>}{row.validation_errors.length > 0 && <small className="warning-text">変換警告 {row.validation_errors.length}件</small>}</td><td>{row.source_active ? '有効' : '未検出'}</td><td>{dateTime(row.source_synced_at)}</td>
          </tr>)}{!loading && filteredRows.length === 0 && <tr><td className="case-progress-empty" colSpan={12}>条件に一致する案件はありません。</td></tr>}{loading && <tr><td className="case-progress-empty" colSpan={12}>読み込み中です…</td></tr>}</tbody>
        </table>
      </div>
    </section>
    <section className="case-progress-panel">
      <header><div><h3>同期履歴</h3><p>直近10回の実行結果です。</p></div></header>
      <div className="case-progress-table-wrap"><table className="runs"><thead><tr><th>開始日時</th><th>実行</th><th>状態</th><th>取得</th><th>追加</th><th>更新</th><th>未変更</th><th>inactive</th><th>IDなし</th><th>警告</th><th>エラー</th></tr></thead><tbody>{runs.map((run) => <tr key={run.case_progress_sync_run_id}><td>{dateTime(run.started_at)}</td><td>{run.trigger_type === 'manual' ? '手動' : '定期'}</td><td>{runStatusLabel(run.status)}</td><td>{run.source_row_count}</td><td>{run.inserted_count}</td><td>{run.updated_count}</td><td>{run.unchanged_count}</td><td>{run.inactive_count}</td><td>{run.blank_id_count}</td><td>{run.error_count}</td><td>{run.error_message ?? '—'}</td></tr>)}{!runs.length && <tr><td className="case-progress-empty" colSpan={11}>同期履歴はありません。</td></tr>}</tbody></table></div>
    </section>
  </section>;
}

function Metric({ label, value, tone = '' }: { label: string; value: number; tone?: string }) {
  return <article className={tone}><span>{label}</span><strong>{value}<small>件</small></strong></article>;
}

function Filter({ label, value, onChange, values }: { label: string; value: string; onChange: (value: string) => void; values: string[] }) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}><option value="">すべて</option>{values.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>;
}

function runStatusLabel(status: SyncRun['status']) {
  return status === 'success' ? '成功' : status === 'partial' ? '一部警告' : status === 'failed' ? '失敗' : '実行中';
}
