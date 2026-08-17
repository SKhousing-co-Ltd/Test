import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Dialog } from './components/Dialog';
import { supabase } from './lib/supabase';

type Account = { account_id: string; account_name: string; income_expense_type: '収入' | '支出' };
type LccStatus = 'planned' | 'approved' | 'ordered' | 'completed' | 'deferred' | 'cancelled';
type LccItem = {
  lcc_plan_item_id: string;
  property_id: string;
  account_id: string;
  procurement_order_id: string | null;
  component_category: keyof typeof componentLabels;
  work_name: string;
  description: string | null;
  cycle_years: number | null;
  last_completed_date: string | null;
  next_planned_date: string;
  planned_amount: number;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: LccStatus;
  completed_date: string | null;
  actual_amount: number | null;
  notes: string | null;
  account?: { account_name: string } | null;
};
type Scenario = { financial_scenario_id: string; scenario_name: string; scenario_type: 'baseline' | 'upside' | 'downside' | 'custom'; base_fiscal_year: number; forecast_years: number; status: 'draft' | 'published' | 'archived'; assumptions: Record<string, unknown>; notes: string | null };
type Projection = { financial_scenario_id: string; scenario_name: string; scenario_type: Scenario['scenario_type']; property_id: string; accounting_month: string; contract_income: number; recurring_expense: number; actual_income: number; actual_expense: number; budget_income: number; budget_expense: number; lcc_planned_expense: number; committed_order_expense: number; scheduled_payment_expense: number; paid_cash_expense: number; projected_income: number; projected_expense: number; projected_net_cashflow: number };
type BaselinePreview = { fiscal_year: number; property_count: number; contract_income: number; recurring_income: number; recurring_expense: number; lcc_planned_expense: number; committed_order_expense: number; scheduled_payment_expense: number; projected_income: number; projected_expense: number; projected_net_cashflow: number };
type BaselineCreation = { financial_scenario_id: string; status: 'draft'; generated_line_count: number; preview: BaselinePreview[] };

const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const today = new Date().toISOString().slice(0, 10);
const monthLabel = (value: string) => new Intl.DateTimeFormat('ja-JP', { month: 'short' }).format(new Date(`${value.slice(0, 7)}-01T00:00:00`));
const fiscalMonths = (year: number) => Array.from({ length: 12 }, (_, index) => `${index < 9 ? year : year + 1}-${String((index + 3) % 12 + 1).padStart(2, '0')}-01`);
const componentLabels = { structure: '躯体', exterior: '外装', hvac: '空調', electrical: '電気', plumbing: '給排水', elevator: '昇降機', fire_safety: '消防', interior: '内装', site: '外構', other: 'その他' } as const;
const priorityLabels = { low: '低', medium: '中', high: '高', critical: '最優先' } as const;
const lccStatusLabels: Record<LccStatus, string> = { planned: '計画', approved: '承認済', ordered: '発注済', completed: '完了', deferred: '延期', cancelled: '中止' };
const scenarioTypeLabels = { baseline: '基準', upside: '強気', downside: '弱気', custom: '個別' } as const;
const scenarioStatusLabels: Record<Scenario['status'], string> = { draft: '下書き', published: '公開中', archived: '保管済み' };

export function LccManager({ propertyId, accounts, canManage }: { propertyId: string; accounts: Account[]; canManage: boolean }) {
  const [items, setItems] = useState<LccItem[]>([]);
  const [editing, setEditing] = useState<LccItem | null>(null);
  const [error, setError] = useState('');
  const expenseAccounts = accounts.filter((account) => account.income_expense_type === '支出');
  const load = async () => {
    if (!supabase || !propertyId) return;
    setError('');
    const { data, error: loadError } = await supabase.from('lcc_plan_item').select('*, account:income_expense_account_master(account_name)').eq('property_id', propertyId).order('next_planned_date');
    if (loadError) setError(loadError.message); else setItems((data ?? []) as LccItem[]);
  };
  useEffect(() => { void load(); }, [propertyId]);
  const activeItems = items.filter((item) => !['completed', 'cancelled'].includes(item.status));
  const fiveYearsLater = new Date(); fiveYearsLater.setFullYear(fiveYearsLater.getFullYear() + 5);
  const fiveYearAmount = activeItems.filter((item) => item.next_planned_date <= fiveYearsLater.toISOString().slice(0, 10)).reduce((sum, item) => sum + Number(item.planned_amount), 0);
  const markCompleted = async (item: LccItem) => { if (!supabase || !confirm(`${item.work_name}を完了にしますか？`)) return; const { error: saveError } = await supabase.from('lcc_plan_item').update({ status: 'completed', completed_date: today, actual_amount: item.planned_amount }).eq('lcc_plan_item_id', item.lcc_plan_item_id); if (saveError) setError(saveError.message); else void load(); };
  const blank = (): LccItem => ({ lcc_plan_item_id: '', property_id: propertyId, account_id: expenseAccounts[0]?.account_id ?? '', procurement_order_id: null, component_category: 'other', work_name: '', description: null, cycle_years: null, last_completed_date: null, next_planned_date: today, planned_amount: 0, priority: 'medium', status: 'planned', completed_date: null, actual_amount: null, notes: null });
  return <section className="content planning-content"><div className="section-heading"><div><h2>長期修繕計画（LCC）</h2><p>設備・部位ごとの更新周期と将来支出を、発注・収支予測へ接続します。</p></div>{canManage && <button className="primary-button" onClick={() => setEditing(blank())}>LCC項目を登録</button>}</div>{error && <p className="notice">{error}</p>}<div className="planning-metrics"><PlanningMetric label="登録項目" value={`${activeItems.length}件`} tone="blue" /><PlanningMetric label="5年以内の計画額" value={yen.format(fiveYearAmount)} tone="orange" /><PlanningMetric label="高・最優先" value={`${activeItems.filter((item) => ['high', 'critical'].includes(item.priority)).length}件`} tone="red" /></div><section className="panel"><div className="table-scroll"><table className="lcc-table"><thead><tr><th>予定時期</th><th>部位・工事</th><th>周期</th><th>優先度</th><th>概算額</th><th>状態</th><th>科目</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.lcc_plan_item_id}><td><strong>{item.next_planned_date}</strong>{item.last_completed_date && <small>前回 {item.last_completed_date}</small>}</td><td><span className="planning-tag">{componentLabels[item.component_category]}</span><strong>{item.work_name}</strong></td><td>{item.cycle_years ? `${item.cycle_years}年` : '単発'}</td><td><span className={`priority-badge ${item.priority}`}>{priorityLabels[item.priority]}</span></td><td className="numeric"><strong>{yen.format(Number(item.planned_amount))}</strong>{item.actual_amount != null && <small>実績 {yen.format(Number(item.actual_amount))}</small>}</td><td><span className={`planning-status ${item.status}`}>{lccStatusLabels[item.status]}</span></td><td>{item.account?.account_name ?? '—'}</td><td>{canManage && <><button className="link-button" onClick={() => setEditing(item)}>編集</button>{!['completed', 'cancelled'].includes(item.status) && <button className="link-button" onClick={() => void markCompleted(item)}>完了</button>}</>}</td></tr>)}{!items.length && <tr><td className="empty" colSpan={8}>LCC項目はまだ登録されていません。</td></tr>}</tbody></table></div></section>{editing && <LccDialog item={editing} accounts={expenseAccounts} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}</section>;
}

function LccDialog({ item, accounts, onClose, onSaved }: { item: LccItem; accounts: Account[]; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState(item); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const save = async (event: FormEvent) => { event.preventDefault(); if (!supabase) return; setSaving(true); const payload = { property_id: draft.property_id, account_id: draft.account_id, component_category: draft.component_category, work_name: draft.work_name, description: draft.description || null, cycle_years: draft.cycle_years || null, last_completed_date: draft.last_completed_date || null, next_planned_date: draft.next_planned_date, planned_amount: Number(draft.planned_amount), priority: draft.priority, status: draft.status, notes: draft.notes || null }; const result = draft.lcc_plan_item_id ? await supabase.from('lcc_plan_item').update(payload).eq('lcc_plan_item_id', draft.lcc_plan_item_id) : await supabase.from('lcc_plan_item').insert(payload); setSaving(false); if (result.error) setError(result.error.message); else onSaved(); };
  return <Dialog title={item.lcc_plan_item_id ? 'LCC項目を編集' : 'LCC項目を登録'} onClose={onClose}><form className="planning-form" onSubmit={save}><PlanningField label="部位"><select value={draft.component_category} onChange={(e) => setDraft({ ...draft, component_category: e.target.value as LccItem['component_category'] })}>{Object.entries(componentLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></PlanningField><PlanningField label="収支科目"><select value={draft.account_id} onChange={(e) => setDraft({ ...draft, account_id: e.target.value })}>{accounts.map((account) => <option value={account.account_id} key={account.account_id}>{account.account_name}</option>)}</select></PlanningField><PlanningField label="工事・更新内容"><input value={draft.work_name} onChange={(e) => setDraft({ ...draft, work_name: e.target.value })} required /></PlanningField><PlanningField label="概算額（円）"><input type="number" min="1" value={draft.planned_amount || ''} onChange={(e) => setDraft({ ...draft, planned_amount: Number(e.target.value) })} required /></PlanningField><PlanningField label="次回予定日"><input type="date" value={draft.next_planned_date} onChange={(e) => setDraft({ ...draft, next_planned_date: e.target.value })} required /></PlanningField><PlanningField label="更新周期（年）"><input type="number" min="1" max="100" value={draft.cycle_years ?? ''} onChange={(e) => setDraft({ ...draft, cycle_years: e.target.value ? Number(e.target.value) : null })} placeholder="単発の場合は空欄" /></PlanningField><PlanningField label="前回実施日"><input type="date" value={draft.last_completed_date ?? ''} onChange={(e) => setDraft({ ...draft, last_completed_date: e.target.value || null })} /></PlanningField><PlanningField label="優先度"><select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as LccItem['priority'] })}>{Object.entries(priorityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></PlanningField><PlanningField label="状態"><select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as LccStatus })}>{(['planned', 'approved', 'ordered', 'deferred', 'cancelled'] as LccStatus[]).map((value) => <option value={value} key={value}>{lccStatusLabels[value]}</option>)}</select></PlanningField><PlanningField label="説明・備考"><textarea value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></PlanningField>{error && <p className="planning-form-error">{error}</p>}<div className="planning-form-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '保存中…' : '保存'}</button></div></form></Dialog>;
}

export function ForecastManager({ propertyId, accounts, year, canManage }: { propertyId: string; accounts: Account[]; year: number; canManage: boolean }) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [rows, setRows] = useState<Projection[]>([]);
  const [scenarioId, setScenarioId] = useState('');
  const [scenarioDialog, setScenarioDialog] = useState(false);
  const [baselineDialog, setBaselineDialog] = useState(false);
  const [budgetMonth, setBudgetMonth] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [publishing, setPublishing] = useState(false);
  const months = useMemo(() => fiscalMonths(year), [year]);

  const loadScenarios = async (preferredId?: string) => {
    if (!supabase) return;
    const { data, error: loadError } = await supabase.from('financial_scenario').select('*').neq('status', 'archived').order('created_at');
    if (loadError) { setError(loadError.message); return; }
    const next = (data ?? []) as Scenario[];
    setScenarios(next);
    setScenarioId((current) => {
      if (preferredId && next.some((item) => item.financial_scenario_id === preferredId)) return preferredId;
      return current && next.some((item) => item.financial_scenario_id === current) ? current : next[0]?.financial_scenario_id ?? '';
    });
  };

  const loadRows = async () => {
    if (!supabase || !propertyId) return;
    const { data, error: loadError } = await supabase.from('property_financial_scenario_monthly').select('*').eq('property_id', propertyId).gte('accounting_month', months[0]).lte('accounting_month', months[11]);
    if (loadError) setError(loadError.message); else setRows((data ?? []) as Projection[]);
  };

  useEffect(() => { void loadScenarios(); }, []);
  useEffect(() => { setError(''); void loadRows(); }, [propertyId, year, scenarios.length]);

  const selectedRows = rows.filter((row) => row.financial_scenario_id === scenarioId);
  const selectedScenario = scenarios.find((scenario) => scenario.financial_scenario_id === scenarioId);
  const total = (key: keyof Pick<Projection, 'projected_income' | 'projected_expense' | 'projected_net_cashflow' | 'lcc_planned_expense'>) => selectedRows.reduce((sum, row) => sum + Number(row[key]), 0);
  const comparison = scenarios.map((scenario) => { const values = rows.filter((row) => row.financial_scenario_id === scenario.financial_scenario_id); return { scenario, income: values.reduce((sum, row) => sum + Number(row.projected_income), 0), expense: values.reduce((sum, row) => sum + Number(row.projected_expense), 0), net: values.reduce((sum, row) => sum + Number(row.projected_net_cashflow), 0) }; });

  const refresh = async (preferredId?: string) => {
    setRows([]);
    await loadScenarios(preferredId);
    await loadRows();
  };

  const publish = async () => {
    if (!supabase || !selectedScenario || !confirm(`${selectedScenario.scenario_name}を公開しますか？`)) return;
    setPublishing(true); setError(''); setNotice('');
    const { error: publishError } = await supabase.rpc('publish_financial_scenario', { p_financial_scenario_id: selectedScenario.financial_scenario_id });
    setPublishing(false);
    if (publishError) setError(publishError.message);
    else { setNotice('シナリオを公開しました。'); await refresh(selectedScenario.financial_scenario_id); }
  };

  return <section className="content planning-content">
    <div className="section-heading"><div><h2>予算・将来予測</h2><p>シナリオ別に予算、LCC、発注残、支払予定を統合して資金需要を比較します。</p></div>{canManage && <div className="planning-actions"><button className="secondary-button" onClick={() => setScenarioDialog(true)}>個別シナリオ作成</button><button className="primary-button" onClick={() => setBaselineDialog(true)}>ベースライン自動作成</button><button className="secondary-button" onClick={() => setBudgetMonth(months[0])} disabled={!scenarioId}>月次予算を調整</button></div>}</div>
    {error && <p className="notice error-notice">{error}</p>}
    {notice && <p className="notice">{notice}</p>}
    {!scenarios.length ? <section className="panel planning-empty"><h3>予測シナリオがありません</h3><p>契約・定期収支・LCCから基準シナリオを自動作成し、確認後に公開できます。</p>{canManage && <button className="primary-button" onClick={() => setBaselineDialog(true)}>ベースラインを試算</button>}</section> : <>
      <div className="scenario-selector"><label>表示シナリオ<select value={scenarioId} onChange={(event) => setScenarioId(event.target.value)}>{scenarios.map((scenario) => <option key={scenario.financial_scenario_id} value={scenario.financial_scenario_id}>{scenario.scenario_name}（{scenarioTypeLabels[scenario.scenario_type]}）</option>)}</select></label><div className="scenario-meta"><span>{selectedScenario?.base_fiscal_year}年度から{selectedScenario?.forecast_years}年間</span>{selectedScenario && <span className={`scenario-status ${selectedScenario.status}`}>{scenarioStatusLabels[selectedScenario.status]}</span>}{canManage && selectedScenario?.status === 'draft' && <button className="primary-button compact" onClick={() => void publish()} disabled={publishing}>{publishing ? '公開中…' : '確認して公開'}</button>}</div></div>
      <div className="planning-metrics four"><PlanningMetric label="予測収入" value={yen.format(total('projected_income'))} tone="green" /><PlanningMetric label="予測支出" value={yen.format(total('projected_expense'))} tone="orange" /><PlanningMetric label="予測収支" value={yen.format(total('projected_net_cashflow'))} tone="blue" /><PlanningMetric label="LCC計画額" value={yen.format(total('lcc_planned_expense'))} tone="red" /></div>
      <section className="panel"><h3>{year}年度 月次予測</h3><div className="table-scroll"><table className="forecast-table"><thead><tr><th>月</th><th>契約収入</th><th>シナリオ収入</th><th>シナリオ支出</th><th>定期支出</th><th>LCC</th><th>発注残</th><th>支払予定</th><th>実績収支</th><th>予測収支</th><th /></tr></thead><tbody>{months.map((month) => { const row = selectedRows.find((item) => item.accounting_month === month); const actualNet = Number(row?.actual_income ?? 0) - Number(row?.actual_expense ?? 0); return <tr key={month}><td><strong>{monthLabel(month)}</strong></td><td>{yen.format(Number(row?.contract_income ?? 0))}</td><td>{yen.format(Number(row?.budget_income ?? 0))}</td><td>{yen.format(Number(row?.budget_expense ?? 0))}</td><td>{yen.format(Number(row?.recurring_expense ?? 0))}</td><td>{yen.format(Number(row?.lcc_planned_expense ?? 0))}</td><td>{yen.format(Number(row?.committed_order_expense ?? 0))}</td><td>{yen.format(Number(row?.scheduled_payment_expense ?? 0))}</td><td>{yen.format(actualNet)}</td><td className="amount-balance">{yen.format(Number(row?.projected_net_cashflow ?? 0))}</td><td>{canManage && <button className="link-button" onClick={() => setBudgetMonth(month)}>調整</button>}</td></tr>; })}</tbody></table></div></section>
      <section className="panel scenario-comparison"><h3>シナリオ比較</h3><div className="table-scroll"><table><thead><tr><th>シナリオ</th><th>種別</th><th>状態</th><th>予測収入</th><th>予測支出</th><th>予測収支</th></tr></thead><tbody>{comparison.map(({ scenario, income, expense, net }) => <tr key={scenario.financial_scenario_id}><td><strong>{scenario.scenario_name}</strong></td><td><span className={`scenario-type ${scenario.scenario_type}`}>{scenarioTypeLabels[scenario.scenario_type]}</span></td><td><span className={`scenario-status ${scenario.status}`}>{scenarioStatusLabels[scenario.status]}</span></td><td>{yen.format(income)}</td><td>{yen.format(expense)}</td><td className="amount-balance">{yen.format(net)}</td></tr>)}</tbody></table></div></section>
    </>}
    {baselineDialog && <BaselineDialog defaultYear={year} onClose={() => setBaselineDialog(false)} onSaved={(created) => { setBaselineDialog(false); setNotice(`${created.generated_line_count.toLocaleString('ja-JP')}件の予測明細を下書きとして作成しました。内容を確認して公開してください。`); void refresh(created.financial_scenario_id); }} />}
    {scenarioDialog && <ScenarioDialog scenarios={scenarios} defaultYear={year} onClose={() => setScenarioDialog(false)} onSaved={() => { setScenarioDialog(false); setNotice('個別シナリオを作成しました。'); void refresh(); }} />}
    {budgetMonth && selectedScenario && <BudgetDialog scenario={selectedScenario} propertyId={propertyId} month={budgetMonth} accounts={accounts} onClose={() => setBudgetMonth(null)} onSaved={() => { setBudgetMonth(null); setNotice('予算を保存しました。'); void loadRows(); }} />}
  </section>;
}

function BaselineDialog({ defaultYear, onClose, onSaved }: { defaultYear: number; onClose: () => void; onSaved: (created: BaselineCreation) => void }) {
  const [name, setName] = useState(`基準シナリオ ${defaultYear}年度`);
  const [baseYear, setBaseYear] = useState(defaultYear);
  const [years, setYears] = useState(5);
  const [notes, setNotes] = useState('契約・定期収支・LCC・発注残・支払予定を基準に自動作成');
  const [preview, setPreview] = useState<BaselinePreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!supabase) return;
      setLoading(true); setError('');
      const { data, error: previewError } = await supabase.rpc('preview_financial_baseline', { p_base_fiscal_year: baseYear, p_forecast_years: years });
      if (cancelled) return;
      setLoading(false);
      if (previewError) setError(previewError.message); else setPreview((data ?? []) as BaselinePreview[]);
    })();
    return () => { cancelled = true; };
  }, [baseYear, years]);

  const total = (key: keyof Pick<BaselinePreview, 'projected_income' | 'projected_expense' | 'projected_net_cashflow'>) => preview.reduce((sum, row) => sum + Number(row[key]), 0);
  const missingExpenseSources = preview.every((row) => Number(row.recurring_expense) === 0 && Number(row.lcc_planned_expense) === 0 && Number(row.committed_order_expense) === 0 && Number(row.scheduled_payment_expense) === 0);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!supabase) return;
    setSaving(true); setError('');
    const { data, error: saveError } = await supabase.rpc('create_financial_baseline_scenario', { p_scenario_name: name, p_base_fiscal_year: baseYear, p_forecast_years: years, p_notes: notes || null });
    setSaving(false);
    if (saveError) setError(saveError.message); else onSaved(data as BaselineCreation);
  };

  return <Dialog title="ベースラインを自動作成" onClose={onClose}><form className="planning-form baseline-form" onSubmit={save}>
    <PlanningField label="シナリオ名"><input value={name} onChange={(event) => setName(event.target.value)} required /></PlanningField>
    <PlanningField label="開始年度"><input type="number" min="2000" max="2200" value={baseYear} onChange={(event) => setBaseYear(Number(event.target.value))} required /></PlanningField>
    <PlanningField label="予測年数"><input type="number" min="1" max="20" value={years} onChange={(event) => setYears(Number(event.target.value))} required /></PlanningField>
    <PlanningField label="前提・メモ"><textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></PlanningField>
    <section className="baseline-preview" aria-live="polite">
      <h3>全物件の作成前プレビュー</h3>
      {loading ? <p className="baseline-loading">試算中…</p> : <><div className="baseline-totals"><PlanningMetric label="期間収入" value={yen.format(total('projected_income'))} tone="green" /><PlanningMetric label="期間支出" value={yen.format(total('projected_expense'))} tone="orange" /><PlanningMetric label="期間収支" value={yen.format(total('projected_net_cashflow'))} tone="blue" /></div><div className="table-scroll"><table className="baseline-table"><thead><tr><th>年度</th><th>契約収入</th><th>定期支出</th><th>LCC</th><th>発注・支払予定</th><th>予測収支</th></tr></thead><tbody>{preview.map((row) => <tr key={row.fiscal_year}><td>{row.fiscal_year}年度</td><td>{yen.format(Number(row.contract_income))}</td><td>{yen.format(Number(row.recurring_expense))}</td><td>{yen.format(Number(row.lcc_planned_expense))}</td><td>{yen.format(Number(row.committed_order_expense) + Number(row.scheduled_payment_expense))}</td><td className="amount-balance">{yen.format(Number(row.projected_net_cashflow))}</td></tr>)}</tbody></table></div>{missingExpenseSources && <p className="baseline-warning">支出見通しが0円です。定期収支・LCC・発注・支払予定を登録すると自動反映されます。</p>}</>}
    </section>
    {error && <p className="planning-form-error">{error}</p>}
    <div className="planning-form-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || loading || !preview.length}>{saving ? '作成中…' : '下書きを作成'}</button></div>
  </form></Dialog>;
}

function ScenarioDialog({ scenarios, defaultYear, onClose, onSaved }: { scenarios: Scenario[]; defaultYear: number; onClose: () => void; onSaved: () => void }) { const [name, setName] = useState('基準シナリオ'); const [type, setType] = useState<Scenario['scenario_type']>('baseline'); const [baseYear, setBaseYear] = useState(defaultYear); const [years, setYears] = useState(5); const [copyFrom, setCopyFrom] = useState(''); const [notes, setNotes] = useState(''); const [error, setError] = useState(''); const [saving, setSaving] = useState(false); const save = async (event: FormEvent) => { event.preventDefault(); if (!supabase) return; setSaving(true); const { error: saveError } = await supabase.rpc('create_financial_scenario', { p_scenario_name: name, p_scenario_type: type, p_base_fiscal_year: baseYear, p_forecast_years: years, p_copy_from: copyFrom || null, p_notes: notes || null }); setSaving(false); if (saveError) setError(saveError.message); else onSaved(); }; return <Dialog title="予測シナリオを作成" onClose={onClose}><form className="planning-form" onSubmit={save}><PlanningField label="シナリオ名"><input value={name} onChange={(e) => setName(e.target.value)} required /></PlanningField><PlanningField label="種別"><select value={type} onChange={(e) => setType(e.target.value as Scenario['scenario_type'])}>{Object.entries(scenarioTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></PlanningField><PlanningField label="開始年度"><input type="number" min="2000" max="2200" value={baseYear} onChange={(e) => setBaseYear(Number(e.target.value))} /></PlanningField><PlanningField label="予測年数"><input type="number" min="1" max="20" value={years} onChange={(e) => setYears(Number(e.target.value))} /></PlanningField><PlanningField label="既存予算を複製"><select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}><option value="">複製しない</option>{scenarios.map((scenario) => <option value={scenario.financial_scenario_id} key={scenario.financial_scenario_id}>{scenario.scenario_name}</option>)}</select></PlanningField><PlanningField label="前提・メモ"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></PlanningField>{error && <p className="planning-form-error">{error}</p>}<div className="planning-form-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '作成中…' : '作成'}</button></div></form></Dialog>; }
function BudgetDialog({ scenario, propertyId, month, accounts, onClose, onSaved }: { scenario: Scenario; propertyId: string; month: string; accounts: Account[]; onClose: () => void; onSaved: () => void }) { const [accountId, setAccountId] = useState(accounts[0]?.account_id ?? ''); const [amount, setAmount] = useState(0); const [description, setDescription] = useState(''); const [error, setError] = useState(''); const save = async (event: FormEvent) => { event.preventDefault(); if (!supabase) return; const { error: saveError } = await supabase.from('financial_scenario_line').upsert({ financial_scenario_id: scenario.financial_scenario_id, property_id: propertyId, account_id: accountId, accounting_month: month, amount: Number(amount), line_type: 'budget', description: description || null }, { onConflict: 'financial_scenario_id,property_id,account_id,accounting_month,line_type' }); if (saveError) setError(saveError.message); else onSaved(); }; return <Dialog title={`${monthLabel(month)}の予算を入力`} onClose={onClose}><form className="planning-form" onSubmit={save}><PlanningField label="科目"><select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((account) => <option value={account.account_id} key={account.account_id}>{account.income_expense_type}｜{account.account_name}</option>)}</select></PlanningField><PlanningField label="予算額（円）"><input type="number" min="0" value={amount || ''} onChange={(e) => setAmount(Number(e.target.value))} required /></PlanningField><PlanningField label="説明"><input value={description} onChange={(e) => setDescription(e.target.value)} /></PlanningField>{error && <p className="planning-form-error">{error}</p>}<div className="planning-form-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button">保存</button></div></form></Dialog>; }
function PlanningMetric({ label, value, tone }: { label: string; value: string; tone: string }) { return <article className={`planning-metric ${tone}`}><span>{label}</span><strong>{value}</strong></article>; }
function PlanningField({ label, children }: { label: string; children: React.ReactNode }) { return <label className="planning-field"><span>{label}</span>{children}</label>; }
