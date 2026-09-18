import { useEffect, useMemo, useState } from 'react';
import {
  calculateSubItem, calculateTenant, initialBuilding, initialMeters, initialTenants, metersFor,
  roundingModeLabel, sumModeLabel,
  type BuildingConfig, type Category, type CategoryId, type LineItem, type Meter, type RoundingMode, type SubItem, type SumMode, type TenantConfig,
} from './utils/meterReading';
import { supabase } from './lib/supabase';
import { periodRange } from './utils/billingDates';
import type { BillingPeriod } from './TenantBillingControls';
import './MeterReadingPage.css';

// 検針データの画面です。
// 分類（電気・水道・ガス）の中に小分類のタブを持ち、小分類ごとに
// 「使用量の入力」と「メーターの割り当て」を切り替えます。
// 現時点ではサンプルデータで動く試作で、保存はされません。

const yen = new Intl.NumberFormat('ja-JP');
const amount = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const sumModes: SumMode[] = ['aggregate', 'perLabel', 'perMeter'];
const roundingModes: RoundingMode[] = ['floor', 'ceil', 'round'];

// 分類と公共料金の請求種別の対応です。電気の小分類には電気の明細項目だけを出します。
const utilityKindOf: Record<CategoryId, string> = { electric: 'electricity', water: 'water', gas: 'gas' };
const patternMark = (index: number) => '①②③④⑤⑥⑦⑧⑨⑩'.charAt(index) || String(index + 1);
type PeriodPattern = { billing_period_pattern_id: string; pattern_name: string; start_month_offset: number; start_day_type: string; start_meter_day_offset: number; end_month_offset: number; end_day_type: string; end_meter_day_offset: number };

export function MeterReadingPage({ propertyId, propertyName, period }: { propertyId: string; propertyName: string; period: BillingPeriod }) {
  const [building, setBuilding] = useState<BuildingConfig>(initialBuilding);
  const [tenants, setTenants] = useState<TenantConfig[]>(initialTenants);
  const [meters, setMeters] = useState<Meter[]>(initialMeters);
  const [tab, setTab] = useState<string>('summary');
  const [subTab, setSubTab] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<'input' | 'assign'>('input');
  const calendarYear = period.fiscalYear + (period.month <= 3 ? 1 : 0);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [notice, setNotice] = useState('');
  const [meterDate, setMeterDate] = useState('');
  const [previousMeterDate, setPreviousMeterDate] = useState('');
  const [periodPatterns, setPeriodPatterns] = useState<PeriodPattern[]>([]);

  // 請求明細の項目は請求設定から読み込み、請求種別に公共料金が設定されているものだけを対象にします。
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!supabase || !propertyId) { setLineItems([]); return; }
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
  const visibleCategories = building.categories.filter((category) => category.billable);
  const lineItemName = (id: string) => lineItems.find((row) => row.id === id)?.name ?? '未設定';
  const lineItemOptions = <option value="">未設定</option>;
  const lineItemsFor = (categoryId: CategoryId) => lineItems.filter((row) => row.utilityKind === utilityKindOf[categoryId]);

  const updateMeter = (id: string, patch: Partial<Meter>) => setMeters((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const updateTenant = (id: string, patch: Partial<TenantConfig>) => setTenants((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const updateUnitPrice = (id: string, categoryId: CategoryId, value: number | null) => setTenants((current) => current.map((row) => row.id === id ? { ...row, unitPrices: { ...row.unitPrices, [categoryId]: value } } : row));
  const updateSumMode = (id: string, key: string, value: SumMode) => setTenants((current) => current.map((row) => row.id === id ? { ...row, sumMode: { ...row.sumMode, [key]: value } } : row));
  const updateFixed = (id: string, subItemId: string, value: number) => setTenants((current) => current.map((row) => row.id === id ? { ...row, fixedCharges: { ...row.fixedCharges, [subItemId]: value } } : row));
  const updateCategory = (id: string, patch: Partial<Category>) => setBuilding((current) => ({ ...current, categories: current.categories.map((row) => row.id === id ? { ...row, ...patch } : row) }));
  const updateSubItem = (id: string, patch: Partial<SubItem>) => setBuilding((current) => ({ ...current, subItems: current.subItems.map((row) => row.id === id ? { ...row, ...patch } : row) }));
  const addSubItem = (categoryId: CategoryId) => {
    const id = `sub${Date.now()}`;
    setBuilding((current) => ({ ...current, subItems: [...current.subItems, { id, categoryId, name: '新しい小分類', kind: 'custom', lineItemId: '', defaultUnitPrice: null, periodPatternId: '' }] }));
    setTenants((current) => current.map((tenant) => ({ ...tenant, sumMode: { ...tenant.sumMode, [id]: 'aggregate' } })));
  };
  const removeSubItem = (id: string) => { setBuilding((current) => ({ ...current, subItems: current.subItems.filter((row) => row.id !== id) })); setMeters((current) => current.filter((row) => row.subItemId !== id)); };
  const addMeter = (subItemId: string) => setMeters((current) => [...current, { id: `M${Date.now()}`, subItemId, code: '', label: '', tenantId: tenants[0]?.id ?? '', usage: 0 }]);
  const removeMeter = (id: string) => setMeters((current) => current.filter((row) => row.id !== id));

  const category = visibleCategories.find((row) => row.id === tab);
  const categorySubItems = category ? building.subItems.filter((row) => row.categoryId === category.id && (row.kind !== 'basic' || category.fixedBillable)) : [];
  const currentSubTab = category ? subTab[category.id] ?? 'summary' : 'summary';
  const subItem = categorySubItems.find((row) => row.id === currentSubTab);

  return <section className="meter-page">
    <header className="meter-page-heading">
      <div><p className="section-kicker">METER</p><h2>検針データ</h2><p>{propertyName || '物件未選択'}・{calendarYear}年{period.month}月分</p></div>
      <div className="meter-date-fields">
        <label className="meter-date"><span>前回検針日</span><input type="date" value={previousMeterDate} onChange={(event) => setPreviousMeterDate(event.target.value)} /></label>
        <label className="meter-date"><span>検針日</span><input type="date" value={meterDate} onChange={(event) => setMeterDate(event.target.value)} /></label>
      </div>
    </header>

    {periodPatterns.length > 0 && <div className="meter-periods">{periodPatterns.map((pattern, index) => {
      const range = periodRange(calendarYear, period.month, pattern, { current: meterDate, previous: previousMeterDate });
      return <span key={pattern.billing_period_pattern_id}><b>{patternMark(index)} {pattern.pattern_name}</b>{range.start && range.end ? `${range.start}～${range.end}` : '検針日を入力してください'}</span>;
    })}</div>}
    {notice && <p className="tenant-billing-notice">{notice}</p>}
    <nav className="meter-tabs">
      <button type="button" className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>集計</button>
      {visibleCategories.map((row) => <button key={row.id} type="button" className={tab === row.id ? 'active' : ''} onClick={() => setTab(row.id)}>{row.name}</button>)}
      <button type="button" className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>設定</button>
    </nav>

    {tab === 'summary' && <div className="meter-panel">
      {building.surcharges.filter((row) => row.billable).length > 0 && <div className="meter-month-rates">
        {building.surcharges.filter((row) => row.billable).map((row) => <label key={row.id}>
          {row.name}の単価
          <input type="number" step="0.01" value={row.unitPrice} onChange={(event) => setBuilding({ ...building, surcharges: building.surcharges.map((item) => item.id === row.id ? { ...item, unitPrice: Number(event.target.value) } : item) })} />
          <span>円／{building.categories.find((item) => item.id === row.categoryId)?.unit ?? ''}</span>
        </label>)}
      </div>}
      <div className="meter-table-wrap">
        <table className="meter-table">
          <thead><tr><th className="meter-col-name">テナント</th>{visibleCategories.map((row) => <th key={row.id}>{row.name}</th>)}{building.surcharges.filter((row) => row.billable).map((row) => <th key={row.id}>{row.name}</th>)}<th>請求合計</th><th>元表</th><th>差</th></tr></thead>
          <tbody>{results.map((result) => <tr key={result.tenant.id}>
            <td className="meter-col-name"><strong>{result.tenant.name}</strong></td>
            {result.categories.map((row) => <td key={row.category.id} className="numeric">{yen.format(row.amount)}</td>)}
            {result.surcharges.map((row) => <td key={row.surcharge.id} className="numeric">{yen.format(row.amount)}<small className="meter-note">{amount.format(row.usage)} × {row.surcharge.unitPrice}</small></td>)}
            <td className="numeric meter-total">{yen.format(result.total)}</td>
            <td className="numeric meter-muted">{yen.format(result.tenant.expected)}</td>
            <td className={result.difference === 0 ? 'numeric meter-ok' : 'numeric meter-warn'}>{result.difference === 0 ? '一致' : yen.format(result.difference)}</td>
          </tr>)}</tbody>
          <tfoot><tr>
            <td className="meter-col-name">合計</td>
            {visibleCategories.map((row) => <td key={row.id} className="numeric">{yen.format(results.reduce((sum, result) => sum + (result.categories.find((item) => item.category.id === row.id)?.amount ?? 0), 0))}</td>)}
            {building.surcharges.filter((row) => row.billable).map((row) => <td key={row.id} className="numeric">{yen.format(results.reduce((sum, result) => sum + (result.surcharges.find((item) => item.surcharge.id === row.id)?.amount ?? 0), 0))}</td>)}
            <td className="numeric meter-total">{yen.format(grandTotal)}</td>
            <td className="numeric meter-muted">{yen.format(grandExpected)}</td>
            <td className={grandTotal === grandExpected ? 'numeric meter-ok' : 'numeric meter-warn'}>{grandTotal === grandExpected ? '一致' : yen.format(grandTotal - grandExpected)}</td>
          </tr></tfoot>
        </table>
      </div>

      <div className="meter-settings-block">
        <div className="meter-settings-heading"><h4>請求明細の項目別</h4><p>小分類に紐づけた明細項目ごとにまとめた金額です。この単位で請求書作成へ渡します。</p></div>
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
          <thead><tr><th className="meter-col-name">テナント</th>{categorySubItems.map((row) => <th key={row.id}>{row.name}<small className="meter-note">{lineItemName(row.lineItemId)}</small></th>)}<th>使用量計</th><th>{category.name}計</th></tr></thead>
          <tbody>{results.map((result) => {
            const categoryResult = result.categories.find((row) => row.category.id === category.id);
            if (!categoryResult) return null;
            return <tr key={result.tenant.id}>
              <td className="meter-col-name"><strong>{result.tenant.name}</strong></td>
              {categorySubItems.map((row) => {
                const found = categoryResult.subItems.find((item) => item.subItem.id === row.id);
                return <td key={row.id} className="numeric">{yen.format(found?.amount ?? 0)}{found && found.usage ? <small className="meter-note">{amount.format(found.usage)} {category.unit}</small> : null}</td>;
              })}
              <td className="numeric">{amount.format(categoryResult.usage)} {category.unit}</td>
              <td className="numeric meter-total">{yen.format(categoryResult.amount)}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}

      {subItem && subItem.kind === 'basic' && <div className="meter-table-wrap">
        <table className="meter-table">
          <thead><tr><th className="meter-col-name">テナント</th><th>{subItem.name}（円／月）</th></tr></thead>
          <tbody>{tenants.map((tenant) => <tr key={tenant.id}>
            <td className="meter-col-name">{tenant.name}</td>
            <td><input type="number" value={tenant.fixedCharges[subItem.id] ?? 0} onChange={(event) => updateFixed(tenant.id, subItem.id, Number(event.target.value))} /></td>
          </tr>)}</tbody>
        </table>
      </div>}

      {subItem && subItem.kind === 'custom' && mode === 'input' && <div className="meter-tenant-list">{tenants.map((tenant) => {
        const own = metersFor(subItem.id, tenant.id, meters);
        if (!own.length) return null;
        const result = calculateSubItem(subItem, category, tenant, meters);
        const labels = [...new Set(own.map((row) => row.label))];
        return <article key={tenant.id} className="meter-tenant">
          <header>
            <div><strong>{tenant.name}</strong><small>単価 {tenant.unitPrices[category.id] ?? subItem.defaultUnitPrice ?? 0} 円／{sumModeLabel[tenant.sumMode[subItem.id] ?? 'aggregate']}／金額は{roundingModeLabel[tenant.amountRoundingMode]}</small></div>
            <div className="meter-tenant-amount"><span>{amount.format(result.usage)} {category.unit}</span><b>{yen.format(result.amount)} 円</b></div>
          </header>
          <div className="meter-tenant-areas">{labels.map((label) => {
            const rows = own.filter((row) => row.label === label);
            return <div key={label} className="meter-area">
              <h5>{label || '識別なし'}{rows[0].unitPrice ? <em>単価 {rows[0].unitPrice} 円</em> : null}</h5>
              <table><tbody>{rows.map((row) => <tr key={row.id}>
                <td>{row.code}</td>
                <td><input type="number" step="0.001" value={row.usage} onChange={(event) => updateMeter(row.id, { usage: Number(event.target.value) })} /></td>
                <td className="meter-unit">{category.unit}</td>
              </tr>)}</tbody></table>
              <p className="meter-area-sum">計 {amount.format(rows.reduce((sum, row) => sum + row.usage, 0))} {category.unit}</p>
            </div>;
          })}</div>
          <footer>{result.groups.map((group) => <span key={group.key}>{group.label}：{amount.format(group.usage)} × {group.unitPrice} ＝ {yen.format(group.amount)} 円</span>)}</footer>
        </article>;
      })}</div>}

      {subItem && subItem.kind === 'custom' && mode === 'assign' && <div className="meter-assign">
        <div className="meter-settings-heading"><h4>{subItem.name}のメーター割り当て</h4><p>メーター番号と、設置位置などのメーター識別を入力し、テナントを紐づけます。</p><button type="button" className="text-button" onClick={() => addMeter(subItem.id)}>メーターを追加</button></div>
        <div className="meter-table-wrap meter-scroll">
          <table className="meter-table meter-settings-table">
            <thead><tr><th>メーター番号</th><th>メーター識別</th><th>割当テナント</th><th>単価の上書き</th><th /></tr></thead>
            <tbody>{meters.filter((row) => row.subItemId === subItem.id).map((row) => <tr key={row.id}>
              <td><input value={row.code} placeholder="メーター番号" onChange={(event) => updateMeter(row.id, { code: event.target.value })} /></td>
              <td><input value={row.label} placeholder="設置位置・区画など" onChange={(event) => updateMeter(row.id, { label: event.target.value })} /></td>
              <td><select value={row.tenantId} onChange={(event) => updateMeter(row.id, { tenantId: event.target.value })}>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select></td>
              <td><input type="number" step="0.01" className="meter-narrow" value={row.unitPrice ?? ''} placeholder="契約単価" onChange={(event) => updateMeter(row.id, { unitPrice: event.target.value ? Number(event.target.value) : undefined })} /></td>
              <td><button type="button" className="meter-delete" onClick={() => removeMeter(row.id)}>削除</button></td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>}
    </div>}

    {tab === 'settings' && <div className="meter-panel meter-settings-panel">
      <div className="meter-settings-columns">
        <section className="meter-settings-block">
        {building.categories.filter((row) => row.id === 'electric').map((row) => <div key={row.id} className={row.billable ? 'meter-category-config' : 'meter-category-config meter-disabled'}>
          <div className="meter-category-head">
            <h5>{row.name}</h5>
            <label>使用量の単位<input className="meter-narrow" value={row.unit} onChange={(event) => updateCategory(row.id, { unit: event.target.value })} /></label>
            <label className="meter-check"><input type="checkbox" checked={row.billable} onChange={(event) => updateCategory(row.id, { billable: event.target.checked })} />請求する</label>
            <label className="meter-check"><input type="checkbox" checked={row.fixedBillable} onChange={(event) => updateCategory(row.id, { fixedBillable: event.target.checked })} />基本料を請求する</label>
            <button type="button" className="text-button" onClick={() => addSubItem(row.id)}>小分類を追加</button>
          </div>
          <table className="meter-table meter-settings-table">
            <thead><tr><th>小分類</th><th>種類</th><th>請求明細の項目</th><th>既定単価</th><th>既定の請求期間</th><th /></tr></thead>
            <tbody>{building.subItems.filter((item) => item.categoryId === row.id).map((item) => <tr key={item.id}>
              <td>{item.kind === 'basic' ? <span className="meter-fixed-name">{item.name}</span> : <input value={item.name} onChange={(event) => updateSubItem(item.id, { name: event.target.value })} />}</td>
              <td className="meter-muted">{item.kind === 'basic' ? '基本料（固定）' : 'メーター検針'}</td>
              <td><select value={item.lineItemId} onChange={(event) => updateSubItem(item.id, { lineItemId: event.target.value })}>{lineItemOptions}{lineItemsFor(row.id).map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}</select></td>
              <td>{item.kind === 'custom' ? <input type="number" step="0.01" className="meter-narrow" value={item.defaultUnitPrice ?? ''} placeholder="—" onChange={(event) => updateSubItem(item.id, { defaultUnitPrice: event.target.value ? Number(event.target.value) : null })} /> : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' ? <select value={item.periodPatternId} onChange={(event) => updateSubItem(item.id, { periodPatternId: event.target.value })}><option value="">未設定</option>{periodPatterns.map((pattern, index) => <option key={pattern.billing_period_pattern_id} value={pattern.billing_period_pattern_id}>{patternMark(index)} {pattern.pattern_name}</option>)}</select> : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' && <button type="button" className="meter-delete" onClick={() => removeSubItem(item.id)}>削除</button>}</td>
            </tr>)}</tbody>
          </table>
        </div>)}
        </section>

        <section className="meter-settings-block">
        <h4>増額分</h4>
        <table className="meter-table meter-settings-table">
          <thead><tr><th>名称</th><th>請求明細の項目</th><th>請求する</th></tr></thead>
          <tbody>{building.surcharges.map((row) => {
            const patch = (value: Partial<typeof row>) => setBuilding({ ...building, surcharges: building.surcharges.map((item) => item.id === row.id ? { ...item, ...value } : item) });
            return <tr key={row.id}>
              <td><input value={row.name} onChange={(event) => patch({ name: event.target.value })} /></td>
              <td><select value={row.lineItemId} onChange={(event) => patch({ lineItemId: event.target.value })}>{lineItemOptions}{lineItemsFor(row.categoryId).map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}</select></td>
              <td><label className="meter-check"><input type="checkbox" checked={row.billable} onChange={(event) => patch({ billable: event.target.checked })} />請求する</label></td>
            </tr>;
          })}</tbody>
        </table>
        </section>
      </div>

      <div className="meter-settings-columns-right">
        <section className="meter-settings-block">
        {building.categories.filter((row) => row.id !== 'electric').map((row) => <div key={row.id} className={row.billable ? 'meter-category-config' : 'meter-category-config meter-disabled'}>
          <div className="meter-category-head">
            <h5>{row.name}</h5>
            <label>使用量の単位<input className="meter-narrow" value={row.unit} onChange={(event) => updateCategory(row.id, { unit: event.target.value })} /></label>
            <label className="meter-check"><input type="checkbox" checked={row.billable} onChange={(event) => updateCategory(row.id, { billable: event.target.checked })} />請求する</label>
            <label className="meter-check"><input type="checkbox" checked={row.fixedBillable} onChange={(event) => updateCategory(row.id, { fixedBillable: event.target.checked })} />基本料を請求する</label>
            <button type="button" className="text-button" onClick={() => addSubItem(row.id)}>小分類を追加</button>
          </div>
          <table className="meter-table meter-settings-table">
            <thead><tr><th>小分類</th><th>種類</th><th>請求明細の項目</th><th>既定単価</th><th>既定の請求期間</th><th /></tr></thead>
            <tbody>{building.subItems.filter((item) => item.categoryId === row.id).map((item) => <tr key={item.id}>
              <td>{item.kind === 'basic' ? <span className="meter-fixed-name">{item.name}</span> : <input value={item.name} onChange={(event) => updateSubItem(item.id, { name: event.target.value })} />}</td>
              <td className="meter-muted">{item.kind === 'basic' ? '基本料（固定）' : 'メーター検針'}</td>
              <td><select value={item.lineItemId} onChange={(event) => updateSubItem(item.id, { lineItemId: event.target.value })}>{lineItemOptions}{lineItemsFor(row.id).map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}</select></td>
              <td>{item.kind === 'custom' ? <input type="number" step="0.01" className="meter-narrow" value={item.defaultUnitPrice ?? ''} placeholder="—" onChange={(event) => updateSubItem(item.id, { defaultUnitPrice: event.target.value ? Number(event.target.value) : null })} /> : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' ? <select value={item.periodPatternId} onChange={(event) => updateSubItem(item.id, { periodPatternId: event.target.value })}><option value="">未設定</option>{periodPatterns.map((pattern, index) => <option key={pattern.billing_period_pattern_id} value={pattern.billing_period_pattern_id}>{patternMark(index)} {pattern.pattern_name}</option>)}</select> : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' && <button type="button" className="meter-delete" onClick={() => removeSubItem(item.id)}>削除</button>}</td>
            </tr>)}</tbody>
          </table>
        </div>)}
        </section>
      </div>

      <section className="meter-settings-block">
        <h4>テナント契約</h4>
        <div className="meter-table-wrap">
          <table className="meter-table meter-settings-table">
            <thead><tr><th className="meter-col-name">テナント</th>{visibleCategories.map((row) => <th key={row.id}>{row.name}単価</th>)}<th>使用量の丸め</th><th>金額の丸め</th>{building.subItems.filter((row) => row.kind === 'custom').map((row) => <th key={row.id}>{row.name}</th>)}{building.surcharges.map((row) => <th key={row.id}>{row.name}</th>)}</tr></thead>
            <tbody>{tenants.map((tenant) => <tr key={tenant.id}>
              <td className="meter-col-name">{tenant.name}</td>
              {visibleCategories.map((row) => <td key={row.id}><input type="number" step="0.01" className="meter-narrow" value={tenant.unitPrices[row.id] ?? ''} placeholder="既定" onChange={(event) => updateUnitPrice(tenant.id, row.id, event.target.value === '' ? null : Number(event.target.value))} /></td>)}
              <td><span className="meter-settings-pair">
                <select value={tenant.usageRoundingUnit} onChange={(event) => updateTenant(tenant.id, { usageRoundingUnit: Number(event.target.value) })}>{[0.1, 1, 10].map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select>
                <select value={tenant.usageRoundingMode} onChange={(event) => updateTenant(tenant.id, { usageRoundingMode: event.target.value as RoundingMode })}>{roundingModes.map((row) => <option key={row} value={row}>{roundingModeLabel[row]}</option>)}</select>
              </span></td>
              <td><span className="meter-settings-pair">
                <select value={tenant.amountRoundingUnit} onChange={(event) => updateTenant(tenant.id, { amountRoundingUnit: Number(event.target.value) })}>{[1, 10, 100].map((unit) => <option key={unit} value={unit}>{unit}円</option>)}</select>
                <select value={tenant.amountRoundingMode} onChange={(event) => updateTenant(tenant.id, { amountRoundingMode: event.target.value as RoundingMode })}>{roundingModes.map((row) => <option key={row} value={row}>{roundingModeLabel[row]}</option>)}</select>
              </span></td>
              {[...building.subItems.filter((row) => row.kind === 'custom').map((row) => row.id), ...building.surcharges.map((row) => row.id)].map((key) => <td key={key}>
                <select value={tenant.sumMode[key] ?? 'aggregate'} onChange={(event) => updateSumMode(tenant.id, key, event.target.value as SumMode)}>{sumModes.map((row) => <option key={row} value={row}>{sumModeLabel[row]}</option>)}</select>
              </td>)}
            </tr>)}</tbody>
          </table>
        </div>
      </section>
    </div>}
  </section>;
}
