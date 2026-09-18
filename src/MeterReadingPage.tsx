import { useEffect, useMemo, useState } from 'react';
import {
  calculateSubItem, calculateTenant, metersFor,
  priceModeLabel, roundingModeLabel, sumModeLabel, taxModeLabel,
  type BuildingConfig, type Category, type CategoryId, type ContractRow, type LineItem, type Meter,
  type PriceMode, type RoundingMode, type SubItem, type SumMode, type TaxMode, type TenantConfig,
} from './utils/meterReading';
import { loadMeterReading, newId, saveMeterReading, type MeterReadingSnapshot } from './utils/meterReadingStore';
import { periodRange } from './utils/billingDates';
import { supabase } from './lib/supabase';
import type { BillingPeriod } from './TenantBillingControls';
import './MeterReadingPage.css';

// 検針データの画面です。
// 分類（電気・水道・ガス）の中に小分類のタブを持ち、小分類ごとに
// 「使用量の入力」と「メーターの割り当て」を切り替えます。
// 設定と検針値は画面上で編集し、「保存」でまとめてSupabaseへ書き込みます。

const yen = new Intl.NumberFormat('ja-JP');
const amount = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const sumModes: SumMode[] = ['aggregate', 'perMeter'];
const roundingModes: RoundingMode[] = ['floor', 'ceil', 'round'];
const taxModes: TaxMode[] = ['exclusive', 'inclusive'];
const priceModes: PriceMode[] = ['fixed', 'variable'];
const utilityKindOf: Record<CategoryId, string> = { electric: 'electricity', water: 'water', gas: 'gas' };
const patternMark = (index: number) => '①②③④⑤⑥⑦⑧⑨⑩'.charAt(index) || String(index + 1);
// 物件を読み込むまでの空の状態です。分類は読み込み時にDBの設定で置き換えます。
const emptyBuilding: BuildingConfig = { categories: [], subItems: [], surcharges: [], taxRate: 0.1 };
type PeriodPattern = { billing_period_pattern_id: string; pattern_name: string; start_month_offset: number; start_day_type: string; start_meter_day_offset: number; end_month_offset: number; end_day_type: string; end_meter_day_offset: number };

export function MeterReadingPage({ propertyId, period }: { propertyId: string; propertyName: string; period: BillingPeriod }) {
  const [building, setBuildingState] = useState<BuildingConfig>(emptyBuilding);
  const [tenants, setTenantsState] = useState<TenantConfig[]>([]);
  const [meters, setMetersState] = useState<Meter[]>([]);
  // 読み込んだ時点の内容です。保存時に「消えた行」を見つけるために使います。
  const [baseline, setBaseline] = useState<MeterReadingSnapshot | null>(null);
  const [status, setStatus] = useState<'draft' | 'confirmed'>('draft');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<string>('summary');
  const [subTab, setSubTab] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<'input' | 'assign'>('input');
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [periodPatterns, setPeriodPatterns] = useState<PeriodPattern[]>([]);
  const [notice, setNotice] = useState('');
  // 検針日は月ごとの検針データに持たせ、前回検針日は前月の行から読みます。
  const [meterDate, setMeterDateState] = useState('');
  const [previousMeterDate, setPreviousMeterDate] = useState('');

  const calendarYear = period.fiscalYear + (period.month <= 3 ? 1 : 0);

  // 編集はすべてここを通し、未保存かどうかを覚えておきます。
  const setBuilding: typeof setBuildingState = (value) => { setBuildingState(value); setDirty(true); };
  const setTenants: typeof setTenantsState = (value) => { setTenantsState(value); setDirty(true); };
  const setMeters: typeof setMetersState = (value) => { setMetersState(value); setDirty(true); };
  const setMeterDate = (value: string) => { setMeterDateState(value); setDirty(true); };

  // 物件と対象月の検針データを読み込みます。
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!supabase || !propertyId) { setBaseline(null); setBuildingState(emptyBuilding); setTenantsState([]); setMetersState([]); return; }
      setLoading(true);
      try {
        const snapshot = await loadMeterReading(supabase, propertyId, calendarYear, period.month);
        if (cancelled) return;
        setBaseline(snapshot);
        setBuildingState(snapshot.building);
        setTenantsState(snapshot.tenants);
        setMetersState(snapshot.meters);
        setMeterDateState(snapshot.meterDate);
        setPreviousMeterDate(snapshot.previousMeterDate);
        setStatus(snapshot.status);
        setDirty(false);
        setNotice('');
      } catch (error) {
        if (!cancelled) setNotice(error instanceof Error ? error.message : '検針データを読み込めませんでした');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [propertyId, calendarYear, period.month]);

  const save = async () => {
    if (!supabase || !propertyId || !baseline) return;
    setSaving(true);
    try {
      const snapshot: MeterReadingSnapshot = { building, tenants, meters, meterDate, previousMeterDate, status };
      await saveMeterReading(supabase, propertyId, calendarYear, period.month, snapshot, baseline);
      setBaseline(snapshot);
      setDirty(false);
      setNotice('保存しました。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存できませんでした');
    } finally {
      setSaving(false);
    }
  };

  // 請求明細の項目は請求設定から読み込み、請求種別に公共料金が設定されているものだけを対象にします。
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!supabase || !propertyId) { setLineItems([]); setPeriodPatterns([]); return; }
      const patternResult = await supabase
        .from('asset_billing_period_pattern')
        .select('billing_period_pattern_id, pattern_name, start_month_offset, start_day_type, start_meter_day_offset, end_month_offset, end_day_type, end_meter_day_offset')
        .eq('asset_id', propertyId).order('sort_order');
      if (!cancelled) setPeriodPatterns((patternResult.data ?? []) as PeriodPattern[]);
      const { data, error } = await supabase
        .from('asset_billing_line_item')
        .select('asset_billing_line_item_id, line_item_name, display_name, charge:billing_charge_type!inner(charge_type_name, utility_kind)')
        .eq('asset_id', propertyId).eq('is_active', true).not('charge.utility_kind', 'is', null)
        .order('sort_order');
      if (cancelled) return;
      if (error) { setNotice(`請求明細の項目を読み込めませんでした: ${error.message}`); setLineItems([]); return; }
      const rows = (data ?? []) as unknown as Array<{ asset_billing_line_item_id: string; line_item_name: string; display_name: string | null; charge: { charge_type_name: string; utility_kind: string | null } | Array<{ charge_type_name: string; utility_kind: string | null }> | null }>;
      setNotice('');
      setLineItems(rows.map((row) => {
        const charge = Array.isArray(row.charge) ? row.charge[0] : row.charge;
        return { id: row.asset_billing_line_item_id, name: row.display_name || row.line_item_name, utilityKind: charge?.utility_kind ?? null, chargeTypeName: charge?.charge_type_name ?? '' };
      }));
    };
    void load();
    return () => { cancelled = true; };
  }, [propertyId]);

  const results = useMemo(() => tenants.map((tenant) => calculateTenant(tenant, building, meters)), [building, meters, tenants]);
  const grandTotal = results.reduce((sum, result) => sum + result.total, 0);
  const grandExpected = results.reduce((sum, result) => sum + result.tenant.expected, 0);
  // 元表との突き合わせ列は、期待値を持つサンプルデータのときだけ出します。
  const showExpected = results.some((result) => result.tenant.expected);
  const visibleCategories = building.categories.filter((category) => category.billable);
  const customSubItems = building.subItems.filter((row) => row.kind === 'custom');
  const billableSurcharges = building.surcharges.filter((row) => row.billable);
  const digitOptions = [0, 1, 2, 3].map((digits) => <option key={digits} value={digits}>{digits === 0 ? '整数' : `小数第${digits}位`}</option>);
  const roundingOptions = roundingModes.map((row) => <option key={row} value={row}>{roundingModeLabel[row]}</option>);
  const lineItemsFor = (categoryId: CategoryId) => lineItems.filter((row) => row.utilityKind === utilityKindOf[categoryId]);
  // 分類ごとの色分けです。電気は黄、水道は青、ガスは赤にします。
  const categoryClass = (id: CategoryId) => `meter-cat-${id}`;
  const rowLabel = (tenant: TenantConfig, index: number) => tenant.rows.length > 1 ? `${tenant.name}（${index + 1}）` : tenant.name;

  const updateMeter = (id: string, patch: Partial<Meter>) => setMeters((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const updateCategory = (id: string, patch: Partial<Category>) => setBuilding((current) => ({ ...current, categories: current.categories.map((row) => row.id === id ? { ...row, ...patch } : row) }));
  const updateSubItem = (id: string, patch: Partial<SubItem>) => setBuilding((current) => ({ ...current, subItems: current.subItems.map((row) => row.id === id ? { ...row, ...patch } : row) }));
  const updateRow = (tenantId: string, index: number, patch: Partial<ContractRow>) => setTenants((current) => current.map((tenant) => tenant.id === tenantId
    ? { ...tenant, rows: tenant.rows.map((row, position) => position === index ? { ...row, ...patch } : row) } : tenant));
  const updateTenant = (id: string, patch: Partial<TenantConfig>) => setTenants((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const setSplitCount = (tenant: TenantConfig, count: number) => {
    const next = Math.max(1, Math.min(9, count));
    const rows = Array.from({ length: next }, (_, index) => tenant.rows[index] ?? { ...tenant.rows[0], id: newId(), invoiceNo: index + 1, fixedCharges: {} });
    updateTenant(tenant.id, { rows });
    // 行を減らしたときは、行きどころのないメーターを1行目へ戻します。
    setMeters((current) => current.map((row) => row.tenantId === tenant.id && row.rowIndex >= next ? { ...row, rowIndex: 0 } : row));
  };
  const addSubItem = (categoryId: CategoryId) => {
    const id = newId();
    setBuilding((current) => ({ ...current, subItems: [...current.subItems, { id, categoryId, name: '新しい小分類', kind: 'custom', lineItemId: '', priceMode: 'fixed', defaultUnitPrice: null, periodPatternId: '', taxMode: 'exclusive', taxRoundingDigits: 2, taxRoundingMode: 'floor', usageRoundingDigits: 1, usageRoundingMode: 'round' }] }));
    setTenants((current) => current.map((tenant) => ({ ...tenant, rows: tenant.rows.map((row) => ({ ...row, billable: { ...row.billable, [id]: true }, unitPrices: { ...row.unitPrices, [id]: null } })) })));
  };
  const removeSubItem = (id: string) => { setBuilding((current) => ({ ...current, subItems: current.subItems.filter((row) => row.id !== id) })); setMeters((current) => current.filter((row) => row.subItemId !== id)); };
  const addMeter = (subItemId: string) => setMeters((current) => [...current, { id: newId(), subItemId, code: '', label: '', tenantId: tenants[0]?.id ?? '', rowIndex: 0, usage: 0 }]);
  const removeMeter = (id: string) => setMeters((current) => current.filter((row) => row.id !== id));

  const category = visibleCategories.find((row) => row.id === tab);
  const categorySubItems = category ? building.subItems.filter((row) => row.categoryId === category.id && (row.kind !== 'basic' || category.fixedBillable)) : [];
  const currentSubTab = category ? subTab[category.id] ?? 'summary' : 'summary';
  const subItem = categorySubItems.find((row) => row.id === currentSubTab);

  return <section className="meter-page">
    <header className="meter-page-heading">
      <div><p className="section-kicker">METER</p><h2>検針データ</h2></div>
      <div className="meter-date-fields">
        <label className="meter-date"><span>検針日</span><input type="date" value={meterDate} onChange={(event) => setMeterDate(event.target.value)} /></label>
        <span className="meter-date-previous">前回検針日<b>{previousMeterDate ? previousMeterDate.replace(/-/g, '/') : '前月の検針データなし'}</b></span>
        <button type="button" className="meter-save" disabled={!dirty || saving || loading || !baseline} onClick={() => void save()}>{saving ? '保存中…' : dirty ? '保存' : '保存済み'}</button>
      </div>
    </header>

    {periodPatterns.length > 0 && <div className="meter-periods">{periodPatterns.map((pattern, index) => {
      const range = periodRange(calendarYear, period.month, pattern, { current: meterDate, previous: previousMeterDate });
      return <span key={pattern.billing_period_pattern_id}><b>{patternMark(index)} {pattern.pattern_name}</b>{range.start && range.end ? `${range.start}～${range.end}` : '検針日を入力してください'}</span>;
    })}</div>}
    {notice && <p className="tenant-billing-notice">{notice}</p>}
    {loading && <p className="tenant-billing-notice">検針データを読み込んでいます…</p>}
    {!loading && baseline && !tenants.length && <p className="tenant-billing-notice">対象月に契約中のテナントがありません。</p>}

    <nav className="meter-tabs">
      <button type="button" className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>集計</button>
      {visibleCategories.map((row) => <button key={row.id} type="button" className={tab === row.id ? 'active' : ''} onClick={() => setTab(row.id)}>{row.name}</button>)}
      <button type="button" className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>設定</button>
    </nav>

    {tab === 'summary' && <div className="meter-panel">
      {billableSurcharges.length > 0 && <div className="meter-month-rates">
        {billableSurcharges.map((row) => <label key={row.id}>
          {row.name}の単価
          <input type="number" step="0.01" value={row.unitPrice} onChange={(event) => setBuilding({ ...building, surcharges: building.surcharges.map((item) => item.id === row.id ? { ...item, unitPrice: Number(event.target.value) } : item) })} />
          <span>円／{building.categories.find((item) => item.id === row.categoryId)?.unit ?? ''}</span>
        </label>)}
      </div>}
      <div className="meter-table-wrap">
        <table className="meter-table">
          <thead><tr><th className="meter-col-name">テナント</th>{visibleCategories.map((row) => <th key={row.id}>{row.name}</th>)}{billableSurcharges.map((row) => <th key={row.id}>{row.name}</th>)}<th>請求合計</th>{showExpected ? <><th>元表</th><th>差</th></> : null}</tr></thead>
          <tbody>{results.flatMap((result) => [
            <tr key={result.tenant.id}>
              <td className="meter-col-name"><strong>{result.tenant.name}</strong>{result.tenant.splitEnabled ? <small>{result.tenant.rows.length} 分割</small> : null}</td>
              {visibleCategories.map((row) => <td key={row.id} className="numeric">{yen.format(result.rows.reduce((sum, item) => sum + (item.categories.find((value) => value.category.id === row.id)?.amount ?? 0), 0))}</td>)}
              {billableSurcharges.map((row) => <td key={row.id} className="numeric">{yen.format(result.rows.reduce((sum, item) => sum + (item.surcharges.find((value) => value.surcharge.id === row.id)?.amount ?? 0), 0))}</td>)}
              <td className="numeric meter-total">{yen.format(result.total)}</td>
              {showExpected ? <>
                <td className="numeric meter-muted">{yen.format(result.tenant.expected)}</td>
                <td className={result.difference === 0 ? 'numeric meter-ok' : 'numeric meter-warn'}>{result.difference === 0 ? '一致' : yen.format(result.difference)}</td>
              </> : null}
            </tr>,
            ...(result.tenant.splitEnabled ? result.rows.map((row) => <tr key={`${result.tenant.id}-${row.index}`} className="meter-split-row">
              <td className="meter-col-name">分割 {row.index + 1}{result.tenant.invoiceSplitByUnit ? <small>請求書 {row.row.invoiceNo}</small> : null}</td>
              {visibleCategories.map((item) => <td key={item.id} className="numeric">{yen.format(row.categories.find((value) => value.category.id === item.id)?.amount ?? 0)}</td>)}
              {billableSurcharges.map((item) => <td key={item.id} className="numeric">{yen.format(row.surcharges.find((value) => value.surcharge.id === item.id)?.amount ?? 0)}</td>)}
              <td className="numeric">{yen.format(row.total)}</td>
              {showExpected ? <><td /><td /></> : null}
            </tr>) : []),
          ])}</tbody>
          <tfoot><tr>
            <td className="meter-col-name">合計</td>
            {visibleCategories.map((row) => <td key={row.id} className="numeric">{yen.format(results.reduce((sum, result) => sum + result.rows.reduce((value, item) => value + (item.categories.find((target) => target.category.id === row.id)?.amount ?? 0), 0), 0))}</td>)}
            {billableSurcharges.map((row) => <td key={row.id} className="numeric">{yen.format(results.reduce((sum, result) => sum + result.rows.reduce((value, item) => value + (item.surcharges.find((target) => target.surcharge.id === row.id)?.amount ?? 0), 0), 0))}</td>)}
            <td className="numeric meter-total">{yen.format(grandTotal)}</td>
            {showExpected ? <>
              <td className="numeric meter-muted">{yen.format(grandExpected)}</td>
              <td className={grandTotal === grandExpected ? 'numeric meter-ok' : 'numeric meter-warn'}>{grandTotal === grandExpected ? '一致' : yen.format(grandTotal - grandExpected)}</td>
            </> : null}
          </tr></tfoot>
        </table>
      </div>

      <div className="meter-settings-block">
        <div className="meter-settings-heading"><h4>請求明細の項目別</h4><p>小分類に紐づけた明細項目ごとの金額です。この単位で請求書作成へ渡します。</p></div>
        <div className="meter-table-wrap">
          <table className="meter-table">
            <thead><tr><th className="meter-col-name">テナント</th>{lineItems.length ? lineItems.map((row) => <th key={row.id}>{row.name}</th>) : <th>明細項目が未登録です</th>}</tr></thead>
            <tbody>{results.map((result) => <tr key={result.tenant.id}>
              <td className="meter-col-name">{result.tenant.name}</td>
              {lineItems.length ? lineItems.map((row) => <td key={row.id} className="numeric">{result.byLineItem.get(row.id) ? yen.format(result.byLineItem.get(row.id) ?? 0) : <span className="meter-muted">—</span>}</td>) : <td className="meter-muted">請求設定で公共料金の明細項目を登録してください。</td>}
            </tr>)}</tbody>
          </table>
        </div>
      </div>
    </div>}

    {category && <div className="meter-panel">
      <div className="meter-panel-bar">
        <nav className="meter-subtabs">
          <button type="button" className={currentSubTab === 'summary' ? 'active' : ''} onClick={() => setSubTab({ ...subTab, [category.id]: 'summary' })}>集計</button>
          {categorySubItems.map((row) => <button key={row.id} type="button" className={currentSubTab === row.id ? 'active' : ''} onClick={() => setSubTab({ ...subTab, [category.id]: row.id })}>{row.name}</button>)}
        </nav>
        {subItem && subItem.kind === 'custom' && <div className="meter-switch">
          <button type="button" className={mode === 'input' ? 'active' : ''} onClick={() => setMode('input')}>使用量の入力</button>
          <button type="button" className={mode === 'assign' ? 'active' : ''} onClick={() => setMode('assign')}>メーターの割り当て</button>
        </div>}
      </div>

      {currentSubTab === 'summary' && <div className="meter-table-wrap">
        <table className="meter-table">
          <thead><tr><th className="meter-col-name">テナント</th>{categorySubItems.map((row) => <th key={row.id}>{row.name}</th>)}<th>使用量計</th><th>{category.name}計</th></tr></thead>
          <tbody>{results.flatMap((result) => result.rows.map((row) => {
            const categoryResult = row.categories.find((item) => item.category.id === category.id);
            if (!categoryResult) return null;
            return <tr key={`${result.tenant.id}-${row.index}`}>
              <td className="meter-col-name"><strong>{rowLabel(result.tenant, row.index)}</strong></td>
              {categorySubItems.map((item) => {
                const found = categoryResult.subItems.find((value) => value.subItem.id === item.id);
                return <td key={item.id} className="numeric">{yen.format(found?.amount ?? 0)}{found && found.usage ? <small className="meter-note">{amount.format(found.usage)} {category.unit}</small> : null}</td>;
              })}
              <td className="numeric">{amount.format(categoryResult.usage)} {category.unit}</td>
              <td className="numeric meter-total">{yen.format(categoryResult.amount)}</td>
            </tr>;
          }))}</tbody>
        </table>
      </div>}

      {subItem && subItem.kind === 'basic' && <div className="meter-table-wrap">
        <table className="meter-table">
          <thead><tr><th className="meter-col-name">テナント</th><th>{subItem.name}（円／月）</th></tr></thead>
          <tbody>{tenants.flatMap((tenant) => tenant.rows.map((row, index) => <tr key={row.id}>
            <td className="meter-col-name">{rowLabel(tenant, index)}</td>
            <td>{row.billable[subItem.id]
              ? <input type="number" value={row.fixedCharges[subItem.id] ?? 0} onChange={(event) => updateRow(tenant.id, index, { fixedCharges: { ...row.fixedCharges, [subItem.id]: Number(event.target.value) } })} />
              : <span className="meter-muted">請求しない</span>}</td>
          </tr>))}</tbody>
        </table>
      </div>}

      {subItem && subItem.kind === 'custom' && mode === 'input' && <div className="meter-tenant-list">{tenants.flatMap((tenant) => tenant.rows.map((row, index) => {
        const own = metersFor(subItem.id, tenant.id, index, meters);
        if (!own.length) return null;
        const result = calculateSubItem(subItem, category, row, tenant.id, index, meters, building.taxRate);
        const labels = [...new Set(own.map((item) => item.label))];
        return <article key={`${tenant.id}-${index}`} className="meter-tenant">
          <header>
            <div><strong>{rowLabel(tenant, index)}</strong><small>単価 {subItem.priceMode === 'variable' ? '変動（未実装）' : `${row.unitPrices[subItem.id] ?? subItem.defaultUnitPrice ?? 0} 円（${taxModeLabel[subItem.taxMode]}）`}／{sumModeLabel[row.sumMode[category.id] ?? 'aggregate']}／金額は{roundingModeLabel[row.amountRoundingMode]}</small></div>
            <div className="meter-tenant-amount"><span>{amount.format(result.usage)} {category.unit}</span><b>{yen.format(result.amount)} 円</b></div>
          </header>
          <div className="meter-tenant-areas">{labels.map((label) => {
            const rows = own.filter((item) => item.label === label);
            return <div key={label} className="meter-area">
              <h5>{label || '識別なし'}{rows[0].unitPrice ? <em>単価 {rows[0].unitPrice} 円</em> : null}</h5>
              <table><tbody>{rows.map((item) => <tr key={item.id}>
                <td>{item.code}</td>
                <td><input type="number" step="0.001" value={item.usage} onChange={(event) => updateMeter(item.id, { usage: Number(event.target.value) })} /></td>
                <td className="meter-unit">{category.unit}</td>
              </tr>)}</tbody></table>
              <p className="meter-area-sum">計 {amount.format(rows.reduce((sum, item) => sum + item.usage, 0))} {category.unit}</p>
            </div>;
          })}</div>
          <footer>{result.groups.map((group) => <span key={group.key}>{group.label}：{amount.format(group.usage)} × {group.unitPrice} ＝ {yen.format(group.amount)} 円</span>)}</footer>
        </article>;
      }))}</div>}

      {subItem && subItem.kind === 'custom' && mode === 'assign' && <div className="meter-assign">
        <div className="meter-settings-heading"><h4>{subItem.name}のメーター割り当て</h4><p>メーター番号と、設置位置などのメーター識別を入力し、テナントと分割行を紐づけます。</p><button type="button" className="text-button" onClick={() => addMeter(subItem.id)}>メーターを追加</button></div>
        <div className="meter-table-wrap meter-scroll">
          <table className="meter-table meter-settings-table">
            <thead><tr><th>メーター番号</th><th>メーター識別</th><th>割当テナント</th><th>分割</th><th>単価の上書き</th><th /></tr></thead>
            <tbody>{meters.filter((row) => row.subItemId === subItem.id).map((row) => {
              const target = tenants.find((item) => item.id === row.tenantId);
              return <tr key={row.id}>
                <td><input value={row.code} placeholder="メーター番号" onChange={(event) => updateMeter(row.id, { code: event.target.value })} /></td>
                <td><input value={row.label} placeholder="設置位置・区画など" onChange={(event) => updateMeter(row.id, { label: event.target.value })} /></td>
                <td><select value={row.tenantId} onChange={(event) => updateMeter(row.id, { tenantId: event.target.value, rowIndex: 0 })}><option value="">未割当</option>{tenants.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></td>
                <td>{target && target.rows.length > 1
                  ? <select value={row.rowIndex} onChange={(event) => updateMeter(row.id, { rowIndex: Number(event.target.value) })}>{target.rows.map((item, index) => <option key={item.id} value={index}>分割 {index + 1}</option>)}</select>
                  : <span className="meter-muted">—</span>}</td>
                <td><input type="number" step="0.01" className="meter-narrow" value={row.unitPrice ?? ''} placeholder="契約単価" onChange={(event) => updateMeter(row.id, { unitPrice: event.target.value ? Number(event.target.value) : undefined })} /></td>
                <td><button type="button" className="meter-delete" onClick={() => removeMeter(row.id)}>削除</button></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      </div>}
    </div>}

    {tab === 'settings' && <div className="meter-panel meter-settings-panel">
      <section className="meter-settings-block">
        {building.categories.map((row) => <div key={row.id} className={`meter-category-config ${categoryClass(row.id)}${row.billable ? '' : ' meter-disabled'}`}>
          <div className="meter-category-head">
            <h5>{row.name}</h5>
            <label>使用量の単位<input className="meter-narrow" value={row.unit} onChange={(event) => updateCategory(row.id, { unit: event.target.value })} /></label>
            <label className="meter-check"><input type="checkbox" checked={row.billable} onChange={(event) => updateCategory(row.id, { billable: event.target.checked })} />請求する</label>
            <label className="meter-check"><input type="checkbox" checked={row.fixedBillable} onChange={(event) => updateCategory(row.id, { fixedBillable: event.target.checked })} />基本料を請求する</label>
            {building.surcharges.filter((item) => item.categoryId === row.id).map((item) => <label key={item.id} className="meter-check">
              <input type="checkbox" checked={item.billable} onChange={(event) => setBuilding({ ...building, surcharges: building.surcharges.map((target) => target.id === item.id ? { ...target, billable: event.target.checked } : target) })} />{item.name}を請求する
            </label>)}
            <button type="button" className="text-button" onClick={() => addSubItem(row.id)}>小分類を追加</button>
          </div>
          <table className="meter-table meter-settings-table meter-subitem-table">
            <colgroup><col style={{ width: 132 }} /><col style={{ width: 104 }} /><col style={{ width: 260 }} /><col style={{ width: 88 }} /><col style={{ width: 104 }} /><col style={{ width: 88 }} /><col style={{ width: 186 }} /><col style={{ width: 186 }} /><col style={{ width: 150 }} /><col style={{ width: 56 }} /></colgroup>
            <thead><tr><th>小分類</th><th>種類</th><th>請求明細の項目</th><th>税区分</th><th>単価計算方法</th><th>既定単価</th><th>税抜換算の丸め</th><th>使用量の丸め</th><th>既定の請求期間</th><th /></tr></thead>
            <tbody>{building.subItems.filter((item) => item.categoryId === row.id && (item.kind !== 'basic' || row.fixedBillable)).map((item) => <tr key={item.id}>
              <td>{item.kind === 'basic' ? <span className="meter-fixed-name">{item.name}</span> : <input value={item.name} onChange={(event) => updateSubItem(item.id, { name: event.target.value })} />}</td>
              <td className="meter-muted">{item.kind === 'basic' ? '基本料（固定）' : 'メーター検針'}</td>
              <td><select value={item.lineItemId} onChange={(event) => updateSubItem(item.id, { lineItemId: event.target.value })}><option value="">未設定</option>{lineItemsFor(row.id).map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}</select></td>
              <td>{item.kind === 'custom' ? <select value={item.taxMode} onChange={(event) => updateSubItem(item.id, { taxMode: event.target.value as TaxMode })}>{taxModes.map((value) => <option key={value} value={value}>{taxModeLabel[value]}</option>)}</select> : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' ? <select value={item.priceMode} onChange={(event) => updateSubItem(item.id, { priceMode: event.target.value as PriceMode })}>{priceModes.map((value) => <option key={value} value={value}>{priceModeLabel[value]}</option>)}</select> : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' && item.priceMode === 'fixed' ? <input type="number" step="0.01" className="meter-narrow" value={item.defaultUnitPrice ?? ''} placeholder="—" onChange={(event) => updateSubItem(item.id, { defaultUnitPrice: event.target.value ? Number(event.target.value) : null })} /> : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' && item.taxMode === 'inclusive' ? <span className="meter-settings-pair">
                <select value={item.taxRoundingDigits} onChange={(event) => updateSubItem(item.id, { taxRoundingDigits: Number(event.target.value) })}>{digitOptions}</select>
                <select value={item.taxRoundingMode} onChange={(event) => updateSubItem(item.id, { taxRoundingMode: event.target.value as RoundingMode })}>{roundingOptions}</select>
              </span> : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' ? <span className="meter-settings-pair">
                <select value={item.usageRoundingDigits} onChange={(event) => updateSubItem(item.id, { usageRoundingDigits: Number(event.target.value) })}>{digitOptions}</select>
                <select value={item.usageRoundingMode} onChange={(event) => updateSubItem(item.id, { usageRoundingMode: event.target.value as RoundingMode })}>{roundingOptions}</select>
              </span> : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' ? <select value={item.periodPatternId} onChange={(event) => updateSubItem(item.id, { periodPatternId: event.target.value })}><option value="">未設定</option>{periodPatterns.map((pattern, index) => <option key={pattern.billing_period_pattern_id} value={pattern.billing_period_pattern_id}>{patternMark(index)} {pattern.pattern_name}</option>)}</select> : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' && <button type="button" className="meter-delete" onClick={() => removeSubItem(item.id)}>削除</button>}</td>
            </tr>)}
            {building.surcharges.filter((item) => item.categoryId === row.id && item.billable).map((item) => <tr key={item.id} className="meter-surcharge-row">
              <td><span className="meter-fixed-name">{item.name}</span></td>
              <td className="meter-muted">使用量にかかる加算</td>
              <td><select value={item.lineItemId} onChange={(event) => setBuilding({ ...building, surcharges: building.surcharges.map((target) => target.id === item.id ? { ...target, lineItemId: event.target.value } : target) })}><option value="">未設定</option>{lineItemsFor(item.categoryId).map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}</select></td>
              <td className="meter-muted">—</td><td className="meter-muted">—</td><td className="meter-muted">—</td><td className="meter-muted">—</td><td className="meter-muted">—</td><td className="meter-muted">—</td><td />
            </tr>)}</tbody>
          </table>
        </div>)}
      </section>

      <section className="meter-settings-block">
        <h4>テナント一覧</h4>
        <div className="meter-table-wrap">
          <table className="meter-table meter-settings-table meter-contract-table">
            <thead>
              <tr>
                <th className="meter-col-name" rowSpan={2}>テナント</th>
                {visibleCategories.map((item) => {
                  const customs = building.subItems.filter((value) => value.categoryId === item.id && value.kind === 'custom');
                  const priceColumns = customs.filter((value) => value.priceMode === 'fixed').length;
                  return <th key={item.id} colSpan={(item.fixedBillable ? 3 : 2) + (customs.length === 1 ? priceColumns : customs.length + priceColumns)} className={`meter-contract-group ${categoryClass(item.id)}`}>{item.name}</th>;
                })}
                <th rowSpan={2}>小数点</th>
                <th rowSpan={2}>備考</th>
                <th rowSpan={2}>データ分割設定</th>
                {tenants.some((item) => item.invoiceSplitByUnit) && <th rowSpan={2}>請求書</th>}
              </tr>
              <tr>{visibleCategories.flatMap((item) => [
                <th key={`${item.id}-billable`} className={`meter-contract-group ${categoryClass(item.id)}`}>請求</th>,
                ...(item.fixedBillable ? [<th key={`${item.id}-basic`} className={categoryClass(item.id)}>基本料</th>] : []),
...(() => {
                  const customs = building.subItems.filter((value) => value.categoryId === item.id && value.kind === 'custom');
                  if (customs.length === 1) return customs[0].priceMode === 'fixed' ? [<th key={`${customs[0].id}-p`} className={categoryClass(item.id)}>単価</th>] : [];
                  return customs.flatMap((value) => [
                    <th key={`${value.id}-b`} className={categoryClass(item.id)}>{value.name}</th>,
                    ...(value.priceMode === 'fixed' ? [<th key={`${value.id}-p`} className={categoryClass(item.id)}>単価</th>] : []),
                  ]);
                })(),
                <th key={`${item.id}-sum`} className={categoryClass(item.id)}>計算方法</th>,
              ])}</tr>
            </thead>
            <tbody>{tenants.flatMap((tenant) => tenant.rows.map((row, index) => <tr key={row.id} className={`${index === 0 ? 'meter-contract-first' : 'meter-contract-sub'}${tenant.splitEnabled ? ' meter-contract-split' : ''}`}>
              <td className="meter-col-name">{index === 0 ? <strong>{tenant.name}</strong> : <span className="meter-contract-continued">{tenant.name}</span>}{tenant.splitEnabled ? <small>分割 {index + 1} ／ {tenant.rows.length}</small> : null}</td>
              {visibleCategories.flatMap((item) => {
                const basic = building.subItems.find((value) => value.categoryId === item.id && value.kind === 'basic');
                const customs = building.subItems.filter((value) => value.categoryId === item.id && value.kind === 'custom');
                const enabled = row.categoryBillable[item.id] !== false;
                return [
                  <td key={`${item.id}-billable`} className={`meter-contract-group ${categoryClass(item.id)}`}>
                    <input type="checkbox" checked={enabled} onChange={(event) => updateRow(tenant.id, index, { categoryBillable: { ...row.categoryBillable, [item.id]: event.target.checked } })} />
                  </td>,
                  ...(item.fixedBillable && basic ? [<td key={`${item.id}-basic`} className={categoryClass(item.id)}>
                    <input type="checkbox" checked={row.billable[basic.id] ?? false} disabled={!enabled} onChange={(event) => updateRow(tenant.id, index, { billable: { ...row.billable, [basic.id]: event.target.checked } })} />
                  </td>] : []),
                  ...customs.flatMap((value) => {
                    const price = <td key={`${value.id}-p`} className={categoryClass(item.id)}><input type="number" step="0.01" className="meter-narrow" value={row.unitPrices[value.id] ?? ''} placeholder="既定" disabled={!enabled || (customs.length > 1 && !row.billable[value.id])} onChange={(event) => updateRow(tenant.id, index, { unitPrices: { ...row.unitPrices, [value.id]: event.target.value === '' ? null : Number(event.target.value) } })} /></td>;
                    if (customs.length === 1) return value.priceMode === 'fixed' ? [price] : [];
                    return [
                      <td key={`${value.id}-b`} className={categoryClass(item.id)}><input type="checkbox" checked={row.billable[value.id] ?? false} disabled={!enabled} onChange={(event) => updateRow(tenant.id, index, { billable: { ...row.billable, [value.id]: event.target.checked } })} /></td>,
                      ...(value.priceMode === 'fixed' ? [price] : []),
                    ];
                  }),
                  <td key={`${item.id}-sum`} className={categoryClass(item.id)}>
                    <select value={row.sumMode[item.id] ?? 'aggregate'} disabled={!enabled} onChange={(event) => updateRow(tenant.id, index, { sumMode: { ...row.sumMode, [item.id]: event.target.value as SumMode } })}>{sumModes.map((value) => <option key={value} value={value}>{sumModeLabel[value]}</option>)}</select>
                  </td>,
                ];
              })}
              <td><select value={row.amountRoundingMode} onChange={(event) => updateRow(tenant.id, index, { amountRoundingMode: event.target.value as RoundingMode })}>{roundingOptions}</select></td>
              <td><input className="meter-note-input" value={row.note} placeholder="—" onChange={(event) => updateRow(tenant.id, index, { note: event.target.value })} /></td>
              <td className="meter-split-cell">{index === 0 ? <span className="meter-settings-pair">
                <label className="meter-check"><input type="checkbox" checked={tenant.splitEnabled} onChange={(event) => { updateTenant(tenant.id, { splitEnabled: event.target.checked }); if (!event.target.checked) setSplitCount(tenant, 1); else if (tenant.rows.length < 2) setSplitCount(tenant, 2); }} />分割する</label>
                {tenant.splitEnabled && <input type="number" min="1" max="9" className="meter-narrow" value={tenant.rows.length} onChange={(event) => setSplitCount(tenant, Number(event.target.value))} />}
              </span> : null}</td>
              {tenants.some((item) => item.invoiceSplitByUnit) && <td>{tenant.invoiceSplitByUnit
                ? <select value={row.invoiceNo} onChange={(event) => updateRow(tenant.id, index, { invoiceNo: Number(event.target.value) })}>{[1, 2, 3].map((no) => <option key={no} value={no}>請求書 {no}</option>)}</select>
                : <span className="meter-muted">—</span>}</td>}
            </tr>))}</tbody>
          </table>
        </div>
        <p className="meter-hint">請求書は、請求設定の請求書分割設定で区画ごとに分けているテナントだけ選べます。</p>
      </section>
    </div>}
  </section>;
}
