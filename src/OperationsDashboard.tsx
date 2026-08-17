import { useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { supabase } from './lib/supabase';

type DashboardSummary = {
  generated_at: string;
  property_count: number;
  active_unit_count: number;
  occupied_unit_count: number;
  active_contract_count: number;
  expiring_contract_90d_count: number;
  monthly_contract_income: number;
  open_change_request_count: number;
  integration_issue_count: number;
  stale_sync_count: number;
  open_order_amount: number;
  unpaid_amount: number;
  overdue_payment_count: number;
  lcc_12m_amount: number;
  published_scenario_count: number;
  latest_actual_month: string | null;
};

type DashboardAlert = {
  alert_id: string;
  domain: 'integration' | 'procurement' | 'change_request' | 'payment' | 'contract' | 'lcc' | 'financial';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  alert_date: string;
  amount: number | null;
  route: string;
  occurred_at: string;
};

type PropertySnapshot = {
  property_id: string;
  property_code: number | null;
  property_name: string;
  short_name: string | null;
  active_unit_count: number;
  occupied_unit_count: number;
  occupancy_rate: number;
  monthly_contract_income: number;
  open_order_amount: number;
  unpaid_amount: number;
  lcc_12m_amount: number;
  fiscal_ytd_net: number;
};

type CashflowMonth = {
  accounting_month: string;
  period_type: 'actual' | 'current' | 'forecast';
  contract_income: number;
  scheduled_payment: number;
  planned_lcc: number;
  actual_net_cashflow: number;
  known_net_cashflow: number;
};

const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const compactYen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', notation: 'compact', maximumFractionDigits: 1 });
const dateLabel = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const monthLabel = new Intl.DateTimeFormat('ja-JP', { year: '2-digit', month: 'numeric' });
const severityOrder = { critical: 0, warning: 1, info: 2 } as const;
const domainLabel: Record<DashboardAlert['domain'], string> = {
  integration: '外部連携', procurement: '発注・請求', change_request: '対応依頼', payment: '支払', contract: '契約', lcc: 'LCC', financial: '収支',
};

export function OperationsDashboard({ userName }: { userName: string }) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [alerts, setAlerts] = useState<DashboardAlert[]>([]);
  const [properties, setProperties] = useState<PropertySnapshot[]>([]);
  const [cashflow, setCashflow] = useState<CashflowMonth[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      if (!supabase) return;
      setLoading(true);
      setError('');
      const [summaryResult, alertResult, propertyResult, cashflowResult] = await Promise.all([
        supabase.from('operations_dashboard_summary').select('*').single(),
        supabase.from('operations_dashboard_alert').select('*'),
        supabase.from('operations_property_snapshot').select('*'),
        supabase.from('operations_cashflow_monthly').select('*').order('accounting_month'),
      ]);
      const firstError = [summaryResult, alertResult, propertyResult, cashflowResult].find((result) => result.error)?.error;
      if (firstError) setError(`運用データを読み込めませんでした: ${firstError.message}`);
      setSummary(summaryResult.data as DashboardSummary | null);
      setAlerts([...((alertResult.data ?? []) as DashboardAlert[])].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.alert_date.localeCompare(b.alert_date)));
      setProperties([...((propertyResult.data ?? []) as PropertySnapshot[])].sort((a, b) => a.occupancy_rate - b.occupancy_rate || a.property_name.localeCompare(b.property_name, 'ja')));
      setCashflow((cashflowResult.data ?? []) as CashflowMonth[]);
      setLoading(false);
    };
    void load();
  }, []);

  const normalizedQuery = query.trim().toLocaleLowerCase('ja-JP');
  const filteredProperties = useMemo(() => properties.filter((property) => !normalizedQuery
    || [property.property_name, property.short_name ?? '', String(property.property_code ?? '')]
      .some((value) => value.toLocaleLowerCase('ja-JP').includes(normalizedQuery))), [properties, normalizedQuery]);

  const occupancyRate = summary?.active_unit_count
    ? Math.round((summary.occupied_unit_count / summary.active_unit_count) * 1000) / 10
    : 0;
  const attentionCount = (summary?.open_change_request_count ?? 0) + (summary?.integration_issue_count ?? 0);
  const committedOutflow = (summary?.open_order_amount ?? 0) + (summary?.unpaid_amount ?? 0) + (summary?.lcc_12m_amount ?? 0);

  return <section className="operations-dashboard">
    <header className="welcome-row operations-welcome"><div><p className="section-kicker">{dateLabel.format(new Date())}</p><h2>{userName}さん、本日の運用状況です</h2><p>契約・レントロール・発注支払・LCC・外部連携を、データベースの最新状態から集計しています。</p></div><NavLink className="primary-button" to="/change-requests">対応依頼を確認 <span>→</span></NavLink></header>
    {error && <p className="notice">{error}</p>}
    <section className="metric-grid operations-metrics">
      <DashboardMetric label="月額契約収入" value={summary ? yen.format(Number(summary.monthly_contract_income)) : '—'} detail={`${summary?.active_contract_count ?? 0}件の有効契約`} icon="¥" tone="blue" loading={loading} />
      <DashboardMetric label="区画稼働率" value={summary ? `${occupancyRate}%` : '—'} detail={`${summary?.occupied_unit_count ?? 0} / ${summary?.active_unit_count ?? 0}区画`} icon="▦" tone="green" loading={loading} />
      <DashboardMetric label="要対応" value={summary ? `${attentionCount.toLocaleString('ja-JP')}件` : '—'} detail={`対応依頼 ${summary?.open_change_request_count ?? 0}・外部連携 ${summary?.integration_issue_count ?? 0}`} icon="!" tone="red" loading={loading} />
      <DashboardMetric label="確定・計画支出" value={summary ? yen.format(committedOutflow) : '—'} detail={`支払超過 ${summary?.overdue_payment_count ?? 0}件・LCC ${yen.format(Number(summary?.lcc_12m_amount ?? 0))}`} icon="◷" tone="orange" loading={loading} />
    </section>

    <section className="operations-main-grid">
      <article className="panel operations-alert-panel"><div className="panel-title"><div><h3>優先アラート</h3><p>期限・照合・同期・計画整備の問題を横断表示</p></div><span className="operations-count">{alerts.length}件</span></div>
        <div className="operations-alert-list">{loading && <p className="operations-empty">読み込み中…</p>}{!loading && alerts.slice(0, 10).map((alert) => <NavLink className="operations-alert" to={alert.route} key={alert.alert_id}><span className={`alert-severity ${alert.severity}`}>{alert.severity === 'critical' ? '重要' : alert.severity === 'warning' ? '確認' : '情報'}</span><div><small>{domainLabel[alert.domain]}｜{alert.alert_date}</small><strong>{alert.title}</strong><p>{alert.detail}</p></div>{alert.amount != null && <b>{yen.format(Number(alert.amount))}</b>}<i>›</i></NavLink>)}{!loading && alerts.length === 0 && <p className="operations-empty">現在、優先アラートはありません。</p>}</div>
      </article>
      <article className="panel readiness-panel"><div className="panel-title"><div><h3>データ整備状況</h3><p>分析・予測に必要なデータの充足状況</p></div></div><div className="readiness-list">
        <Readiness label="AppSuite定期同期" ready={(summary?.stale_sync_count ?? 1) === 0} value={(summary?.stale_sync_count ?? 0) === 0 ? '正常' : `${summary?.stale_sync_count}アプリ停止`} route="/appsuite-sync" />
        <Readiness label="月次収支実績" ready={Boolean(summary?.latest_actual_month)} value={summary?.latest_actual_month ? `${summary.latest_actual_month.slice(0, 7)}まで` : '未取込'} route="/financial" />
        <Readiness label="公開済み収支シナリオ" ready={(summary?.published_scenario_count ?? 0) > 0} value={`${summary?.published_scenario_count ?? 0}件`} route="/financial" />
        <Readiness label="12か月LCC" ready={(summary?.lcc_12m_amount ?? 0) > 0} value={yen.format(Number(summary?.lcc_12m_amount ?? 0))} route="/financial" />
        <Readiness label="契約終了90日以内" ready={(summary?.expiring_contract_90d_count ?? 0) === 0} value={`${summary?.expiring_contract_90d_count ?? 0}件`} route="/contracts" />
      </div></article>
      <CashflowChart months={cashflow} loading={loading} />
    </section>

    <section className="panel property-snapshot-panel"><div className="panel-title"><div><h3>物件別スナップショット</h3><p>稼働・契約収入・発注・支払・LCC・年度実績を物件単位で比較</p></div><label className="operations-property-search">物件検索<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="物件名・コード" /></label></div><div className="table-wrap"><table className="operations-property-table"><thead><tr><th>物件</th><th>稼働区画</th><th>稼働率</th><th>月額契約収入</th><th>発注残</th><th>未払</th><th>12か月LCC</th><th>年度実績収支</th></tr></thead><tbody>{filteredProperties.map((property) => <tr key={property.property_id}><td><strong>{property.short_name || property.property_name}</strong><small>{property.property_code ?? 'コードなし'}</small></td><td className="numeric">{property.occupied_unit_count} / {property.active_unit_count}</td><td><span className={`occupancy-badge ${property.occupancy_rate < 80 ? 'low' : ''}`}>{property.occupancy_rate}%</span></td><td className="numeric">{yen.format(Number(property.monthly_contract_income))}</td><td className="numeric">{yen.format(Number(property.open_order_amount))}</td><td className="numeric">{yen.format(Number(property.unpaid_amount))}</td><td className="numeric">{yen.format(Number(property.lcc_12m_amount))}</td><td className="numeric">{yen.format(Number(property.fiscal_ytd_net))}</td></tr>)}{!loading && filteredProperties.length === 0 && <tr><td colSpan={8} className="operations-empty">条件に一致する物件はありません。</td></tr>}</tbody></table></div></section>
  </section>;
}

function DashboardMetric({ label, value, detail, icon, tone, loading }: { label: string; value: string; detail: string; icon: string; tone: string; loading: boolean }) {
  return <article className="metric-card"><div><p>{label}</p><strong>{loading ? '…' : value}</strong><span className={tone === 'red' ? 'negative' : ''}>{detail}</span></div><i className={`metric-icon ${tone}`}>{icon}</i></article>;
}

function Readiness({ label, ready, value, route }: { label: string; ready: boolean; value: string; route: string }) {
  return <NavLink to={route}><span className={`readiness-mark ${ready ? 'ready' : 'missing'}`}>{ready ? '✓' : '!'}</span><div><strong>{label}</strong><small>{value}</small></div><i>›</i></NavLink>;
}

function CashflowChart({ months, loading }: { months: CashflowMonth[]; loading: boolean }) {
  const maxAbsolute = Math.max(...months.map((month) => Math.abs(Number(month.known_net_cashflow))), 1);
  return <article className="panel cashflow-panel"><div className="panel-title"><div><h3>月別の既知資金見通し</h3><p>過去実績／契約収入 − 支払予定 − LCC計画</p></div><NavLink to="/financial">詳細を見る</NavLink></div>{loading ? <p className="operations-empty">読み込み中…</p> : <div className="cashflow-chart" role="img" aria-label="月別の既知資金見通しグラフ">{months.map((month) => { const value = Number(month.known_net_cashflow); const height = value === 0 ? 2 : Math.max(Math.abs(value) / maxAbsolute * 100, 5); return <div className={`cashflow-column ${month.period_type}`} key={month.accounting_month} title={`${month.accounting_month}: ${yen.format(value)}`}><span>{compactYen.format(value)}</span><div className="cashflow-track"><i className={value < 0 ? 'negative' : ''} style={{ height: `${height}%` }} /></div><small>{monthLabel.format(new Date(`${month.accounting_month}T00:00:00+09:00`))}</small></div>; })}</div>}</article>;
}
