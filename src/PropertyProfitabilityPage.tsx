import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from './lib/supabase';
import './PropertyProfitabilityPage.css';

type Property = {
  property_id: string;
  property_name: string;
  short_name: string | null;
  acquisition_date: string | null;
};

type Account = { account_name: string; income_expense_type: string };
type FinancialEntry = {
  financial_entry_id: string;
  account_id: string;
  accounting_month: string;
  amount: number;
  expense_classification: 'opex' | 'capex' | null;
  classification_review_status: 'unreviewed' | 'reviewed' | null;
  account: Account | Account[] | null;
};
type AcquisitionPlan = {
  purchase_price: number;
  acquisition_cost: number;
  initial_capex: number;
  inherited_deposit: number;
} | null;
type YearSummary = {
  year: number;
  income: number | null;
  expenses: number | null;
  depreciation: number | null;
  interest: number | null;
  net: number | null;
  entryCount: number;
  incomeCount: number;
  expenseCount: number;
};

const currency = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
const amount = (value: number | null | undefined) => value == null ? '—' : currency.format(value);
const millions = (value: number | null) => value == null ? '—' : `${(value / 1_000_000).toFixed(1)}百万円`;
const accountOf = (account: FinancialEntry['account']) => Array.isArray(account) ? account[0] ?? null : account;
const fiscalYearOf = (month: string) => {
  const date = new Date(`${month.slice(0, 10)}T00:00:00`);
  return date.getFullYear() - (date.getMonth() < 3 ? 1 : 0);
};
const latestClosedFiscalYear = () => {
  const now = new Date();
  return now.getFullYear() - (now.getMonth() < 3 ? 2 : 1);
};
const fiscalPeriod = (year: number) => `${year}年4月〜${year + 1}年3月`;

export function PropertyProfitabilityPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [properties, setProperties] = useState<Property[]>([]);
  const [selectedProperty, setSelectedProperty] = useState<Property | null>(null);
  const [plan, setPlan] = useState<AcquisitionPlan>(null);
  const [entries, setEntries] = useState<FinancialEntry[]>([]);
  const [loadingProperties, setLoadingProperties] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState('');
  const [tableView, setTableView] = useState<'annual' | 'cumulative'>('annual');
  const selectedId = params.get('propertyId') ?? '';
  const latestYear = latestClosedFiscalYear();
  const cutoff = `${latestYear + 1}-03-31`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!supabase) {
        setError('Supabase接続が設定されていません。');
        setLoadingProperties(false);
        return;
      }
      const result = await supabase.from('asset_master')
        .select('asset_id, asset_name, short_name, acquisition_date')
        .order('asset_name');
      if (cancelled) return;
      if (result.error) setError(result.error.message);
      else {
        const list = (result.data ?? []).map((row) => ({
          property_id: row.asset_id,
          property_name: row.asset_name,
          short_name: row.short_name,
          acquisition_date: row.acquisition_date,
        }));
        setProperties(list);
        const requested = list.find((row) => row.property_id === selectedId);
        if (!selectedId && list[0]) setParams({ propertyId: list[0].property_id }, { replace: true });
        else if (selectedId && !requested && list[0]) setParams({ propertyId: list[0].property_id }, { replace: true });
      }
      setLoadingProperties(false);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!supabase || !selectedId) return;
      setLoadingData(true);
      setError('');
      setSelectedProperty(properties.find((property) => property.property_id === selectedId) ?? null);
      setPlan(null);
      setEntries([]);
      const [planResult, entriesResult] = await Promise.all([
        supabase.from('property_acquisition_plan')
          .select('purchase_price, acquisition_cost, initial_capex, inherited_deposit')
          .eq('property_id', selectedId).maybeSingle(),
        loadFinancialEntries(selectedId, cutoff),
      ]);
      if (cancelled) return;
      if (planResult.error) setError(planResult.error.message);
      else setPlan(planResult.data as AcquisitionPlan);
      if (entriesResult.error) setError(entriesResult.error);
      else setEntries(entriesResult.data);
      setSelectedProperty(properties.find((property) => property.property_id === selectedId) ?? null);
      setLoadingData(false);
    })();
    return () => { cancelled = true; };
  }, [selectedId, properties, cutoff]);

  const yearSummaries = useMemo(() => {
    const byYear = new Map<number, FinancialEntry[]>();
    for (const entry of entries) {
      const year = fiscalYearOf(entry.accounting_month);
      const bucket = byYear.get(year) ?? [];
      bucket.push(entry);
      byYear.set(year, bucket);
    }
    return Array.from({ length: 5 }, (_, index) => latestYear - 4 + index).map((year): YearSummary => {
      const rows = byYear.get(year) ?? [];
      if (!rows.length) return { year, income: null, expenses: null, depreciation: null, interest: null, net: null, entryCount: 0, incomeCount: 0, expenseCount: 0 };
      let income = 0;
      let expenses = 0;
      let depreciation = 0;
      let interest = 0;
      let incomeCount = 0;
      let expenseCount = 0;
      let depreciationCount = 0;
      let interestCount = 0;
      for (const row of rows) {
        const account = accountOf(row.account);
        if (account?.income_expense_type === '収入') { income += Number(row.amount); incomeCount += 1; }
        else if (account?.income_expense_type === '支出') {
          expenses += Number(row.amount);
          expenseCount += 1;
          if (account.account_name.includes('減価償却')) { depreciation += Number(row.amount); depreciationCount += 1; }
          if (account.account_name.includes('支払利息')) { interest += Number(row.amount); interestCount += 1; }
        }
      }
      return {
        year,
        income: incomeCount ? income : null,
        expenses: expenseCount ? expenses : null,
        depreciation: depreciationCount ? depreciation : null,
        interest: interestCount ? interest : null,
        net: incomeCount && expenseCount ? income - expenses : null,
        entryCount: rows.length,
        incomeCount,
        expenseCount,
      };
    });
  }, [entries, latestYear]);

  const allTime = useMemo(() => {
    if (!entries.length) return { income: null, expenses: null, net: null };
    let income = 0;
    let expenses = 0;
    let incomeCount = 0;
    let expenseCount = 0;
    for (const row of entries) {
      const account = accountOf(row.account);
      if (account?.income_expense_type === '収入') { income += Number(row.amount); incomeCount += 1; }
      if (account?.income_expense_type === '支出') { expenses += Number(row.amount); expenseCount += 1; }
    }
    return { income: incomeCount ? income : null, expenses: expenseCount ? expenses : null, net: incomeCount && expenseCount ? income - expenses : null };
  }, [entries]);

  const latestEntries = useMemo(() => entries.filter((entry) => fiscalYearOf(entry.accounting_month) === latestYear), [entries, latestYear]);
  const latestIncome = yearSummaries.find((row) => row.year === latestYear)?.income ?? null;
  const latestNet = yearSummaries.find((row) => row.year === latestYear)?.net ?? null;
  const totalInvestment = plan
    ? Number(plan.purchase_price) + Number(plan.acquisition_cost) + Number(plan.initial_capex) - Number(plan.inherited_deposit)
    : null;
  const recoveryRate: number | null = null;
  const expensesByAccount = useMemo(() => {
    const grouped = new Map<string, { name: string; amount: number; rows: number }>();
    for (const entry of latestEntries) {
      const account = accountOf(entry.account);
      if (account?.income_expense_type !== '支出') continue;
      const current = grouped.get(entry.account_id) ?? { name: account.account_name, amount: 0, rows: 0 };
      current.amount += Number(entry.amount);
      current.rows += 1;
      grouped.set(entry.account_id, current);
    }
    return [...grouped.entries()].map(([code, value]) => ({ code, ...value })).sort((a, b) => b.amount - a.amount);
  }, [latestEntries]);
  const latestExpenseTotal = expensesByAccount.length ? expensesByAccount.reduce((sum, row) => sum + row.amount, 0) : null;
  const chartMax = Math.max(...yearSummaries.flatMap((row) => [row.income ?? 0, row.expenses ?? 0, Math.max(0, row.net ?? 0)]), 1);

  return (
    <section className="profitability-page">
      <header className="profitability-heading">
        <div>
          <p className="profitability-eyebrow">PROPERTY PROFITABILITY</p>
          <h2>物件別収益分析</h2>
          <p>年度実績、取得投資額、登録済み明細から算出できる範囲を確認します。</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => navigate(`/property-profitability/plan?propertyId=${selectedId}`)} disabled={!selectedId}>
          購入時計画を編集
        </button>
      </header>

      <div className="profitability-filters">
        <label>物件
          <select value={selectedId} onChange={(event) => setParams({ propertyId: event.target.value })} disabled={loadingProperties}>
            {properties.map((property) => <option value={property.property_id} key={property.property_id}>{property.short_name || property.property_name}</option>)}
          </select>
        </label>
        <span className="profitability-divider" />
        <div><span>年度集計</span><strong>4月〜3月</strong></div>
        <span className="profitability-divider" />
        <div><span>集計基準</span><strong>{cutoff}までの登録明細</strong></div>
      </div>

      {error && <p className="profitability-error" role="alert">{error}</p>}
      {(loadingProperties || loadingData) && <p className="profitability-loading">物件別の実績を読み込んでいます…</p>}

      {!loadingProperties && !properties.length && <p className="profitability-empty">表示できる物件がありません。</p>}

      {!loadingData && selectedProperty && (
        <>
          <section className="profitability-metrics" aria-label="主な指標">
            <Metric label="取得総額" value={totalInvestment} foot="取得価格＋取得諸費用＋初期CAPEX−承継敷金等" />
            <Metric label="直近年度収入" value={latestIncome} foot={`${fiscalPeriod(latestYear)} · 登録明細`} />
            <Metric label="直近年度収支差額" value={latestNet} foot="収入 − 支出（登録明細の集計）" />
            <Metric label="登録実績の収支累計" value={allTime.net} foot="登録済み明細の収入 − 支出" />
            <Metric label="累計資金回収額" value={null} foot="借入返済・非現金項目の照合後に算出" highlight />
          </section>

          {entries.length === 0 && <div className="profitability-alert"><span aria-hidden="true">ⓘ</span><p><strong>実績明細は未登録です。</strong> 取得総額は購入時計画から表示しています。年度実績・損益累計・費目対応は明細が登録されるまで「—」で表示します。</p></div>}

          <div className="profitability-grid">
            <Panel title="年度別の収入・支出・収支差額" subtitle="4月開始年度 · 百万円" badge="登録済み明細">
              {entries.length ? <div className="annual-chart" role="img" aria-label="過去5年度の収入、支出、収支差額">
                <div className="chart-axis"><span>{number.format(Math.ceil(chartMax / 1_000_000))}</span><span>{number.format(Math.ceil(chartMax / 2_000_000))}</span><span>0</span></div>
                {yearSummaries.map((summary) => <div className="annual-chart-year" key={summary.year}>
                  <div className="annual-chart-bars">
                    <ChartBar label="収入" value={summary.income} max={chartMax} className="income" />
                    <ChartBar label="支出" value={summary.expenses} max={chartMax} className="expense" />
                    <ChartBar label="収支差額" value={summary.net} max={chartMax} className="net" />
                  </div>
                  <span>{summary.year}年度</span>
                </div>)}
              </div> : <EmptyChart>実績明細が登録されると年度推移を表示します。</EmptyChart>}
              <div className="profitability-legend"><Legend color="income" label="収入" /><Legend color="expense" label="支出" /><Legend color="net" label="収支差額" /></div>
              <p className="profitability-note">基準日：{cutoff} · 契約予定額や確認用Excelの値は含めていません。</p>
            </Panel>

            <Panel title="投資・回収サマリー" subtitle="取得総額と登録済み実績を表示">
              <div className="profitability-stats">
                <details className="profitability-stat">
                  <summary><span>取得価格・諸費用</span><strong>{amount(totalInvestment)}</strong><i aria-hidden="true">⌄</i><small>{plan ? '購入時計画から算出' : '購入時計画未登録'}</small></summary>
                  <div className="profitability-stat-detail">
                    <Detail label="購入価格" value={amount(plan?.purchase_price)} />
                    <Detail label="取得諸費用" value={amount(plan?.acquisition_cost)} />
                    <Detail label="初期CAPEX" value={amount(plan?.initial_capex)} />
                    <Detail label="承継敷金等（控除）" value={amount(plan?.inherited_deposit)} />
                  </div>
                </details>
                <details className="profitability-stat">
                  <summary><span>登録実績の収支累計</span><strong>{amount(allTime.net)}</strong><i aria-hidden="true">⌄</i><small>{entries.length ? `${number.format(entries.length)}明細` : '実績明細未登録'}</small></summary>
                  <div className="profitability-stat-detail">
                    <Detail label="登録実績の収入" value={amount(allTime.income)} />
                    <Detail label="登録実績の支出" value={amount(allTime.expenses)} />
                    <Detail label="集計方法" value="収入 − 支出" />
                  </div>
                </details>
                <details className="profitability-stat">
                  <summary><span>旧資料の9月決算累計</span><strong>{amount(null)}</strong><i aria-hidden="true">⌄</i><small>旧資料の照合・登録後に表示</small></summary>
                  <div className="profitability-stat-detail"><p>9月決算の累計値は、元資料との照合結果がDBに登録されていないため表示していません。</p></div>
                </details>
                <details className="profitability-stat">
                  <summary><span>累計資金回収額</span><strong>{amount(null)}</strong><i aria-hidden="true">⌄</i><small>キャッシュ項目の確認後に算出</small></summary>
                  <div className="profitability-stat-detail"><p>減価償却などの非現金項目と借入返済の対応が未確認のため、回収額は未算出です。</p></div>
                </details>
                <details className="profitability-stat">
                  <summary><span>投資回収率</span><strong>{recoveryRate == null ? '—' : `${(recoveryRate * 100).toFixed(2)}%`}</strong><i aria-hidden="true">⌄</i><small>回収額 ÷ 取得総額 · 未算出</small></summary>
                  <div className="profitability-stat-detail"><p>累計資金回収額が未算出のため、投資回収率も表示していません。</p></div>
                </details>
              </div>
              <div className="profitability-callout">減価償却費など非現金項目と借入返済の対応が未確定のため、資金回収額・回収率は算出していません。</div>
            </Panel>
          </div>

          <div className="profitability-grid profitability-grid-lower">
            <Panel title="直近年度の支出構成" subtitle={`${latestYear}年度 · 支出計 ${amount(latestExpenseTotal)}`} badge="費目別">
              {expensesByAccount.length ? <div className="expense-composition">
                <div className="expense-donut" style={{ background: donutGradient(expensesByAccount.map((row) => row.amount), latestExpenseTotal ?? 0) }} aria-label="費目別の支出構成" />
                <div className="expense-legend">{expensesByAccount.map((row, index) => <div className="expense-legend-row" key={row.code}>
                  <i style={{ background: chartColors[index % chartColors.length] }} />
                  <span>{row.name}</span><strong>{amount(row.amount)}</strong>
                </div>)}</div>
              </div> : <EmptyChart>直近年度の支出明細は未登録です。</EmptyChart>}
              <p className="profitability-note">支出科目の分類は登録済みの科目コードを使用しています。</p>
            </Panel>

            <Panel title="資金回収の計算イメージ" subtitle="取得投資額に対する運営キャッシュフローの回収" badge="借入返済を除外">
              <div className="recovery-steps">
                <RecoveryStep number="1" title="取得総額" detail="取得価格\n＋取得諸費用" />
                <span className="recovery-arrow" aria-hidden="true">→</span>
                <RecoveryStep number="2" title="年度CF" detail="現金収支を\n年度ごとに集計" />
                <span className="recovery-arrow" aria-hidden="true">→</span>
                <RecoveryStep number="3" title="累計回収" detail="取得年度まで\n積み上げ" />
              </div>
              <div className="recovery-result"><span>累計回収額・回収率</span><strong>—</strong></div>
              <p className="profitability-note">減価償却費は非現金費用です。CAPEX・利息などの科目確認後に算出します。</p>
            </Panel>
          </div>

          <Panel title="年度実績" subtitle="直近年度から取得年度へ遡って確認する想定" className="profitability-table-panel">
            <div className="profitability-table-heading">
              <strong>{selectedProperty.property_name}</strong>
              <div className="profitability-tabs" role="tablist" aria-label="実績表示期間">
                <button type="button" role="tab" aria-selected={tableView === 'annual'} className={tableView === 'annual' ? 'active' : ''} onClick={() => setTableView('annual')}>4月開始年度</button>
                <button type="button" role="tab" aria-selected={tableView === 'cumulative'} className={tableView === 'cumulative' ? 'active' : ''} onClick={() => setTableView('cumulative')}>9月決算の累計</button>
              </div>
            </div>
            {tableView === 'annual' ? <div className="profitability-table-scroll"><table className="profitability-data-table">
              <thead><tr><th>対象期間</th><th className="numeric">賃料収入等</th><th className="numeric">支出計</th><th className="numeric">減価償却費</th><th className="numeric">支払利息</th><th className="numeric">収支差額</th><th>データ状態</th></tr></thead>
              <tbody>{[...yearSummaries].reverse().map((row) => <tr key={row.year}>
                <td className="period-cell">{fiscalPeriod(row.year)}</td><td className="numeric">{amount(row.income)}</td><td className="numeric">{amount(row.expenses)}</td><td className="numeric">{amount(row.depreciation)}</td><td className="numeric">{amount(row.interest)}</td><td className="numeric"><strong>{amount(row.net)}</strong></td><td><span className={`profitability-status ${row.entryCount ? '' : 'missing'}`}>{row.entryCount ? '登録済み' : '未登録'}</span></td>
              </tr>)}</tbody>
            </table></div> : <div className="profitability-cumulative-empty"><strong>—</strong><p>9月決算の累計値は元資料との照合・登録が完了していないため、まだ表示できません。</p></div>}
            <p className="profitability-note">金額は property_monthly_financial_entry の登録内容から集計しています。元資料上の経常利益・9月決算累計とは区別して表示しています。</p>
          </Panel>

          <div className="profitability-grid profitability-grid-lower">
            <Panel title="直近年度の項目対応" subtitle="システム科目と元資料の名称を並べて確認" badge={`${latestYear}年度`}>
              {expensesByAccount.length ? <div className="profitability-table-scroll"><table className="profitability-mapping-table">
                <thead><tr><th>システム科目</th><th>元資料の項目</th><th className="numeric">実績額</th><th>対応</th></tr></thead>
                <tbody>{expensesByAccount.map((row) => <tr key={row.code}><td><span className="account-code">{row.code}</span> {row.name}</td><td>—</td><td className="numeric">{amount(row.amount)}</td><td><span className="profitability-status missing">未登録</span></td></tr>)}</tbody>
              </table></div> : <EmptyChart>元資料との費目対応はまだ登録されていません。</EmptyChart>}
              <p className="profitability-note">費目対応は元資料との照合結果が登録されるまで空欄です。</p>
            </Panel>
            <Panel title="取込時の確認事項" subtitle="元資料の値を分析へ反映する前に確認">
              <ol className="profitability-rules">
                <li>直近年度から取得年度まで、年度ごとに実績を登録します。</li>
                <li>物件名・期間・元項目名を保持し、システム科目との対応を記録します。</li>
                <li>9月決算の過去分は年度内訳を保持し、累計値と照合します。</li>
                <li>売却物件、数式エラー、読取不能値は確定実績に含めません。</li>
                <li>資金回収は取得時の諸費用を含み、借入返済を除外して算出します。</li>
              </ol>
            </Panel>
          </div>
          <p className="profitability-footer">表示対象：{selectedProperty.short_name || selectedProperty.property_name} · 集計終期：{cutoff} · Excel確認用の仮数値は使用していません。</p>
        </>
      )}
    </section>
  );
}

async function loadFinancialEntries(propertyId: string, cutoff: string) {
  if (!supabase) return { data: [] as FinancialEntry[], error: '' };
  const pageSize = 1000;
  const data: FinancialEntry[] = [];
  for (let offset = 0; offset < 50000; offset += pageSize) {
    const result = await supabase.from('property_monthly_financial_entry')
      .select('financial_entry_id, account_id, accounting_month, amount, expense_classification, classification_review_status, account:income_expense_account_master(account_name, income_expense_type)')
      .eq('property_id', propertyId).lte('accounting_month', cutoff)
      .order('accounting_month', { ascending: true }).range(offset, offset + pageSize - 1);
    if (result.error) return { data: [] as FinancialEntry[], error: result.error.message };
    const page = (result.data ?? []) as unknown as FinancialEntry[];
    data.push(...page);
    if (page.length < pageSize) return { data, error: '' };
  }
  return { data: [] as FinancialEntry[], error: '明細件数が上限を超えました。期間を絞って再表示してください。' };
}

function Metric({ label, value, foot, highlight = false }: { label: string; value: number | null; foot: string; highlight?: boolean }) {
  return <article className={`profitability-metric${highlight ? ' highlight' : ''}`}><span>{label}</span><strong>{amount(value)}</strong><small>{foot}</small></article>;
}

function Panel({ title, subtitle, badge, className = '', children }: { title: string; subtitle: string; badge?: string; className?: string; children: ReactNode }) {
  return <section className={`profitability-panel ${className}`}><header className="profitability-panel-head"><div><h3>{title}</h3><p>{subtitle}</p></div>{badge && <span>{badge}</span>}</header>{children}</section>;
}

function ChartBar({ label, value, max, className }: { label: string; value: number | null; max: number; className: string }) {
  const height = value == null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return <div className={`profitability-chart-bar ${className}`} style={{ height: `${height}%` }} title={`${label}: ${amount(value)}`} />;
}

function EmptyChart({ children }: { children: ReactNode }) {
  return <div className="profitability-empty-chart">{children}</div>;
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="profitability-legend-item"><i className={color} />{label}</span>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="profitability-detail-row"><span>{label}</span><strong>{value}</strong></div>;
}

function RecoveryStep({ number: stepNumber, title, detail }: { number: string; title: string; detail: string }) {
  return <div className="profitability-recovery-step"><i>{stepNumber}</i><strong>{title}</strong><span>{detail}</span></div>;
}

const chartColors = ['#286e66', '#79a99f', '#aac8c2', '#d4a454', '#8d9bb0', '#c8d1d9', '#e4c993', '#dae3e0'];
function donutGradient(values: number[], total: number) {
  if (!total) return '#edf0f3';
  let current = 0;
  const ranges = values.map((value, index) => {
    const start = current;
    current += (value / total) * 100;
    return `${chartColors[index % chartColors.length]} ${start.toFixed(2)}% ${current.toFixed(2)}%`;
  });
  return `conic-gradient(${ranges.join(', ')})`;
}
