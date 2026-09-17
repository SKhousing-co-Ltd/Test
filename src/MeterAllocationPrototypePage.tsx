import { useMemo, useState } from 'react';
import {
  calculateSubItem, calculateTenant, collectInputs, initialAreas, initialBuilding, initialMeters, initialTenants,
  roundingModeLabel, sumModeLabel,
  type Area, type BuildingConfig, type Category, type Meter, type RoundingMode, type SubItem, type SumMode, type TenantConfig,
} from './utils/meterPrototype';
import './MeterAllocationPrototypePage.css';

// 検針データ集計の試作画面です。
// 大分類（集計・電気・水道・ガス・設定）の中に小分類のタブを持ち、
// 小分類ごとに「使用量の入力」と「メーターの割り当て」を切り替えます。保存はされません。

const yen = new Intl.NumberFormat('ja-JP');
const amount = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const sumModes: SumMode[] = ['aggregate', 'perArea', 'perMeter'];
const roundingModes: RoundingMode[] = ['floor', 'ceil', 'round'];

export function MeterAllocationPrototypePage() {
  const [building, setBuilding] = useState<BuildingConfig>(initialBuilding);
  const [tenants, setTenants] = useState<TenantConfig[]>(initialTenants);
  const [areas, setAreas] = useState<Area[]>(initialAreas);
  const [meters, setMeters] = useState<Meter[]>(initialMeters);
  const [tab, setTab] = useState<string>('summary');
  const [subTab, setSubTab] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<'input' | 'assign'>('input');

  const results = useMemo(() => tenants.map((tenant) => calculateTenant(tenant, building, areas, meters)), [areas, building, meters, tenants]);
  const grandTotal = results.reduce((sum, result) => sum + result.total, 0);
  const grandExpected = results.reduce((sum, result) => sum + result.tenant.expected, 0);
  const tenantName = (id: string) => tenants.find((tenant) => tenant.id === id)?.name ?? '—';

  const updateMeter = (id: string, patch: Partial<Meter>) => setMeters((current) => current.map((meter) => meter.id === id ? { ...meter, ...patch } : meter));
  const updateArea = (id: string, patch: Partial<Area>) => setAreas((current) => current.map((area) => area.id === id ? { ...area, ...patch } : area));
  const updateTenant = (id: string, patch: Partial<TenantConfig>) => setTenants((current) => current.map((tenant) => tenant.id === id ? { ...tenant, ...patch } : tenant));
  const updateSumMode = (id: string, key: string, value: SumMode) => setTenants((current) => current.map((tenant) => tenant.id === id ? { ...tenant, sumMode: { ...tenant.sumMode, [key]: value } } : tenant));
  const updateFixed = (id: string, subItemId: string, value: number) => setTenants((current) => current.map((tenant) => tenant.id === id ? { ...tenant, fixedCharges: { ...tenant.fixedCharges, [subItemId]: value } } : tenant));
  const updateCategory = (id: string, patch: Partial<Category>) => setBuilding((current) => ({ ...current, categories: current.categories.map((category) => category.id === id ? { ...category, ...patch } : category) }));
  const updateSubItem = (id: string, patch: Partial<SubItem>) => setBuilding((current) => ({ ...current, subItems: current.subItems.map((subItem) => subItem.id === id ? { ...subItem, ...patch } : subItem) }));
  const addSubItem = (categoryId: string) => {
    const id = `sub${Date.now()}`;
    setBuilding((current) => ({ ...current, subItems: [...current.subItems, { id, categoryId, name: '新しい小分類', source: 'meter', meterKindId: current.meterKinds[0]?.id ?? '', readingField: 'primary', priceSource: 'tenant' }] }));
    setTenants((current) => current.map((tenant) => ({ ...tenant, sumMode: { ...tenant.sumMode, [id]: 'aggregate' } })));
  };
  const removeSubItem = (id: string) => setBuilding((current) => ({ ...current, subItems: current.subItems.filter((subItem) => subItem.id !== id) }));
  const addCategory = () => setBuilding((current) => ({ ...current, categories: [...current.categories, { id: `cat${Date.now()}`, name: '新しい分類', unit: '㎥' }] }));
  const removeCategory = (id: string) => setBuilding((current) => ({ ...current, categories: current.categories.filter((category) => category.id !== id), subItems: current.subItems.filter((subItem) => subItem.categoryId !== id), surcharges: current.surcharges.filter((row) => row.categoryId !== id) }));
  const addArea = () => setAreas((current) => [...current, { id: `A${Date.now()}`, name: '新しい区画', tenantId: tenants[0]?.id ?? '' }]);
  const removeArea = (id: string) => { setAreas((current) => current.filter((area) => area.id !== id)); setMeters((current) => current.filter((meter) => meter.areaId !== id)); };
  const addMeter = (meterKindId: string) => setMeters((current) => [...current, { id: `M${Date.now()}`, code: '新しいメーター', areaId: areas[0]?.id ?? '', meterKindId, primary: 0, secondary: 0 }]);
  const removeMeter = (id: string) => setMeters((current) => current.filter((meter) => meter.id !== id));

  const category = building.categories.find((row) => row.id === tab);
  const categorySubItems = category ? building.subItems.filter((subItem) => subItem.categoryId === category.id) : [];
  const currentSubTab = category ? subTab[category.id] ?? 'summary' : 'summary';
  const subItem = categorySubItems.find((row) => row.id === currentSubTab);
  const meterKind = building.meterKinds.find((kind) => kind.id === subItem?.meterKindId);

  return <section className="meter-page">
    <header className="meter-page-heading">
      <div><p className="section-kicker">METER</p><h2>検針データ集計</h2><p>{building.name}・{building.period}</p></div>
      <dl className="meter-page-meta">
        <div><dt>検針日</dt><dd>{building.meterDate}</dd></div>
        <div><dt>分類</dt><dd>{building.categories.map((row) => row.name).join('・')}</dd></div>
        <div><dt>区画</dt><dd>{areas.length} 区画／メーター {meters.length} 台</dd></div>
      </dl>
    </header>

    <nav className="meter-tabs">
      <button type="button" className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>集計</button>
      {building.categories.map((row) => <button key={row.id} type="button" className={tab === row.id ? 'active' : ''} onClick={() => setTab(row.id)}>{row.name}</button>)}
      <button type="button" className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>設定</button>
    </nav>

    {tab === 'summary' && <div className="meter-panel">
      <div className="meter-panel-heading"><h3>集計</h3><p>分類ごとの金額に、分類全体の使用量にかかる増額分を加えた最終の請求額です。</p></div>
      <div className="meter-table-wrap">
        <table className="meter-table">
          <thead><tr><th className="meter-col-name">テナント</th>{building.categories.map((row) => <th key={row.id}>{row.name}</th>)}{building.surcharges.map((row) => <th key={row.id}>{row.name}</th>)}<th>請求合計</th><th>元表</th><th>差</th></tr></thead>
          <tbody>{results.map((result) => <tr key={result.tenant.id}>
            <td className="meter-col-name"><strong>{result.tenant.name}</strong><small>{areas.filter((area) => area.tenantId === result.tenant.id).map((area) => area.name).join('・') || '区画未割当'}</small></td>
            {result.categories.map((row) => <td key={row.category.id} className="numeric">{yen.format(row.amount)}</td>)}
            {result.surcharges.map((row) => <td key={row.surcharge.id} className="numeric">{yen.format(row.amount)}<small className="meter-note">{amount.format(row.usage)} × {row.surcharge.unitPrice}</small></td>)}
            <td className="numeric meter-total">{yen.format(result.total)}</td>
            <td className="numeric meter-muted">{yen.format(result.tenant.expected)}</td>
            <td className={result.difference === 0 ? 'numeric meter-ok' : 'numeric meter-warn'}>{result.difference === 0 ? '一致' : yen.format(result.difference)}</td>
          </tr>)}</tbody>
          <tfoot><tr>
            <td className="meter-col-name">合計</td>
            {building.categories.map((row) => <td key={row.id} className="numeric">{yen.format(results.reduce((sum, result) => sum + (result.categories.find((item) => item.category.id === row.id)?.amount ?? 0), 0))}</td>)}
            {building.surcharges.map((row) => <td key={row.id} className="numeric">{yen.format(results.reduce((sum, result) => sum + (result.surcharges.find((item) => item.surcharge.id === row.id)?.amount ?? 0), 0))}</td>)}
            <td className="numeric meter-total">{yen.format(grandTotal)}</td>
            <td className="numeric meter-muted">{yen.format(grandExpected)}</td>
            <td className={grandTotal === grandExpected ? 'numeric meter-ok' : 'numeric meter-warn'}>{grandTotal === grandExpected ? '一致' : yen.format(grandTotal - grandExpected)}</td>
          </tr></tfoot>
        </table>
      </div>
    </div>}

    {category && <div className="meter-panel">
      <div className="meter-panel-heading meter-panel-bar">
        <div><h3>{category.name}</h3><p>単位 {category.unit}／小分類 {categorySubItems.map((row) => row.name).join('・') || 'なし'}</p></div>
        {subItem && subItem.source === 'meter' && <div className="meter-switch">
          <button type="button" className={mode === 'input' ? 'active' : ''} onClick={() => setMode('input')}>使用量の入力</button>
          <button type="button" className={mode === 'assign' ? 'active' : ''} onClick={() => setMode('assign')}>メーターの割り当て</button>
        </div>}
      </div>

      <nav className="meter-subtabs">
        <button type="button" className={currentSubTab === 'summary' ? 'active' : ''} onClick={() => setSubTab({ ...subTab, [category.id]: 'summary' })}>集計</button>
        {categorySubItems.map((row) => <button key={row.id} type="button" className={currentSubTab === row.id ? 'active' : ''} onClick={() => setSubTab({ ...subTab, [category.id]: row.id })}>{row.name}</button>)}
      </nav>

      {currentSubTab === 'summary' && <div className="meter-table-wrap">
        <table className="meter-table">
          <thead><tr><th className="meter-col-name">テナント</th>{categorySubItems.map((row) => <th key={row.id}>{row.name}</th>)}<th>使用量計</th><th>{category.name}計</th></tr></thead>
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

      {subItem && subItem.source === 'fixed' && <div className="meter-table-wrap">
        <table className="meter-table">
          <thead><tr><th className="meter-col-name">テナント</th><th>{subItem.name}（円／月）</th></tr></thead>
          <tbody>{tenants.map((tenant) => <tr key={tenant.id}>
            <td className="meter-col-name">{tenant.name}</td>
            <td><input type="number" value={tenant.fixedCharges[subItem.id] ?? 0} onChange={(event) => updateFixed(tenant.id, subItem.id, Number(event.target.value))} /></td>
          </tr>)}</tbody>
        </table>
      </div>}

      {subItem && subItem.source === 'meter' && mode === 'input' && <div className="meter-tenant-list">{tenants.map((tenant) => {
        const inputs = collectInputs(subItem, tenant, areas, meters);
        if (!inputs.length) return null;
        const result = calculateSubItem(subItem, tenant, inputs);
        return <article key={tenant.id} className="meter-tenant">
          <header>
            <div><strong>{tenant.name}</strong><small>単価 {subItem.priceSource === 'common' ? `${subItem.commonUnitPrice} 円（共通）` : `${tenant.unitPrice} 円（契約）`}／{sumModeLabel[tenant.sumMode[subItem.id] ?? 'aggregate']}／金額は{roundingModeLabel[tenant.amountRoundingMode]}</small></div>
            <div className="meter-tenant-amount"><span>{amount.format(result.usage)} {category.unit}</span><b>{yen.format(result.amount)} 円</b></div>
          </header>
          <div className="meter-tenant-areas">{areas.filter((area) => area.tenantId === tenant.id).map((area) => {
            const areaInputs = inputs.filter((input) => input.areaId === area.id);
            if (!areaInputs.length) return null;
            return <div key={area.id} className="meter-area">
              <h5>{area.name}{area.unitPrice ? <em>単価 {area.unitPrice} 円</em> : null}</h5>
              <table><tbody>{areaInputs.map((input) => <tr key={input.meterId}>
                <td>{input.meterCode}</td>
                <td><input type="number" step="0.001" value={input.usage} onChange={(event) => updateMeter(input.meterId, subItem.readingField === 'secondary' ? { secondary: Number(event.target.value) } : { primary: Number(event.target.value) })} /></td>
                <td className="meter-unit">{category.unit}</td>
              </tr>)}</tbody></table>
              <p className="meter-area-sum">区画計 {amount.format(areaInputs.reduce((sum, input) => sum + input.usage, 0))} {category.unit}</p>
            </div>;
          })}</div>
          <footer>{result.groups.map((group) => <span key={group.key}>{group.label}：{amount.format(group.usage)} × {group.unitPrice} ＝ {yen.format(group.amount)} 円</span>)}</footer>
        </article>;
      })}</div>}

      {subItem && subItem.source === 'meter' && mode === 'assign' && <div className="meter-assign">
        <div className="meter-settings-heading"><h4>{meterKind?.name ?? 'メーター'}の割り当て</h4><p>メーターを区画に付けます。テナントは区画を通じて決まります。</p><button type="button" className="text-button" onClick={() => addMeter(subItem.meterKindId ?? '')}>メーターを追加</button></div>
        <div className="meter-table-wrap meter-scroll">
          <table className="meter-table meter-settings-table">
            <thead><tr><th>メーター番号</th><th>区画</th><th>テナント</th><th>区画単価</th><th /></tr></thead>
            <tbody>{meters.filter((meter) => meter.meterKindId === subItem.meterKindId).map((meter) => {
              const area = areas.find((row) => row.id === meter.areaId);
              return <tr key={meter.id}>
                <td><input value={meter.code} onChange={(event) => updateMeter(meter.id, { code: event.target.value })} /></td>
                <td><select value={meter.areaId} onChange={(event) => updateMeter(meter.id, { areaId: event.target.value })}>{areas.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></td>
                <td className="meter-muted">{tenantName(area?.tenantId ?? '')}</td>
                <td className="meter-muted">{area?.unitPrice ? `${area.unitPrice} 円` : '契約単価'}</td>
                <td><button type="button" className="meter-delete" onClick={() => removeMeter(meter.id)}>削除</button></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      </div>}
    </div>}

    {tab === 'settings' && <div className="meter-panel meter-settings-panel">
      <div className="meter-panel-heading"><h3>設定</h3><p>ビルごとの違いはここのデータだけで表します。集計処理は全ビル共通です。</p></div>

      <section className="meter-settings-block">
        <h4>物件</h4>
        <div className="meter-settings-fields">
          <label>物件名<input value={building.name} onChange={(event) => setBuilding({ ...building, name: event.target.value })} /></label>
          <label>対象期間<input value={building.period} onChange={(event) => setBuilding({ ...building, period: event.target.value })} /></label>
          <label>検針日<input value={building.meterDate} onChange={(event) => setBuilding({ ...building, meterDate: event.target.value })} /></label>
        </div>
      </section>

      <section className="meter-settings-block">
        <div className="meter-settings-heading"><h4>分類と小分類</h4><p>ここで登録した分類が上段のタブ、小分類が分類内のタブになります。</p><button type="button" className="text-button" onClick={addCategory}>分類を追加</button></div>
        {building.categories.map((row) => <div key={row.id} className="meter-category-config">
          <div className="meter-category-head">
            <label>分類名<input value={row.name} onChange={(event) => updateCategory(row.id, { name: event.target.value })} /></label>
            <label>使用量の単位<input className="meter-narrow" value={row.unit} onChange={(event) => updateCategory(row.id, { unit: event.target.value })} /></label>
            <button type="button" className="text-button" onClick={() => addSubItem(row.id)}>小分類を追加</button>
            <button type="button" className="meter-delete" onClick={() => removeCategory(row.id)}>分類を削除</button>
          </div>
          <table className="meter-table meter-settings-table">
            <thead><tr><th>小分類</th><th>金額の出どころ</th><th>メーター種別</th><th>読み取る値</th><th>単価</th><th /></tr></thead>
            <tbody>{building.subItems.filter((item) => item.categoryId === row.id).map((item) => <tr key={item.id}>
              <td><input value={item.name} onChange={(event) => updateSubItem(item.id, { name: event.target.value })} /></td>
              <td><select value={item.source} onChange={(event) => updateSubItem(item.id, { source: event.target.value as SubItem['source'] })}><option value="meter">メーターの検針値</option><option value="fixed">テナントごとの固定額</option></select></td>
              <td>{item.source === 'meter' ? <select value={item.meterKindId ?? ''} onChange={(event) => updateSubItem(item.id, { meterKindId: event.target.value })}>{building.meterKinds.map((kind) => <option key={kind.id} value={kind.id}>{kind.name}</option>)}</select> : <span className="meter-muted">—</span>}</td>
              <td>{item.source === 'meter' ? <select value={item.readingField ?? 'primary'} onChange={(event) => updateSubItem(item.id, { readingField: event.target.value as 'primary' | 'secondary' })}>
                <option value="primary">{building.meterKinds.find((kind) => kind.id === item.meterKindId)?.primaryLabel ?? '値1'}</option>
                <option value="secondary">{building.meterKinds.find((kind) => kind.id === item.meterKindId)?.secondaryLabel ?? '値2'}</option>
              </select> : <span className="meter-muted">—</span>}</td>
              <td>{item.source === 'meter' ? <span className="meter-settings-pair">
                <select value={item.priceSource} onChange={(event) => updateSubItem(item.id, { priceSource: event.target.value as SubItem['priceSource'] })}><option value="tenant">テナント契約単価</option><option value="common">共通単価</option></select>
                {item.priceSource === 'common' && <input type="number" step="0.01" className="meter-narrow" value={item.commonUnitPrice ?? 0} onChange={(event) => updateSubItem(item.id, { commonUnitPrice: Number(event.target.value) })} />}
              </span> : <span className="meter-muted">テナントごとに設定</span>}</td>
              <td><button type="button" className="meter-delete" onClick={() => removeSubItem(item.id)}>削除</button></td>
            </tr>)}</tbody>
          </table>
        </div>)}
      </section>

      <section className="meter-settings-block">
        <div className="meter-settings-heading"><h4>増額分</h4><p>小分類ではなく、分類全体の使用量にかかります。集計画面で計算します。</p></div>
        <table className="meter-table meter-settings-table">
          <thead><tr><th>名称</th><th>対象の分類</th><th>単価</th></tr></thead>
          <tbody>{building.surcharges.map((row) => <tr key={row.id}>
            <td><input value={row.name} onChange={(event) => setBuilding({ ...building, surcharges: building.surcharges.map((item) => item.id === row.id ? { ...item, name: event.target.value } : item) })} /></td>
            <td><select value={row.categoryId} onChange={(event) => setBuilding({ ...building, surcharges: building.surcharges.map((item) => item.id === row.id ? { ...item, categoryId: event.target.value } : item) })}>{building.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></td>
            <td><input type="number" step="0.01" className="meter-narrow" value={row.unitPrice} onChange={(event) => setBuilding({ ...building, surcharges: building.surcharges.map((item) => item.id === row.id ? { ...item, unitPrice: Number(event.target.value) } : item) })} /></td>
          </tr>)}</tbody>
        </table>
      </section>

      <section className="meter-settings-block">
        <div className="meter-settings-heading"><h4>区画マスタ</h4><p>区画にテナントを紐づけます。単価が契約と違う区画はここで上書きします。</p><button type="button" className="text-button" onClick={addArea}>区画を追加</button></div>
        <div className="meter-table-wrap meter-scroll">
          <table className="meter-table meter-settings-table">
            <thead><tr><th>区画名</th><th>テナント</th><th>単価の上書き</th><th>メーター</th><th /></tr></thead>
            <tbody>{areas.map((area) => <tr key={area.id}>
              <td><input value={area.name} onChange={(event) => updateArea(area.id, { name: event.target.value })} /></td>
              <td><select value={area.tenantId} onChange={(event) => updateArea(area.id, { tenantId: event.target.value })}>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select></td>
              <td><input type="number" step="0.01" className="meter-narrow" value={area.unitPrice ?? ''} placeholder="契約単価" onChange={(event) => updateArea(area.id, { unitPrice: event.target.value ? Number(event.target.value) : undefined })} /></td>
              <td className="meter-muted">{meters.filter((meter) => meter.areaId === area.id).length} 台</td>
              <td><button type="button" className="meter-delete" onClick={() => removeArea(area.id)}>削除</button></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="meter-settings-block">
        <div className="meter-settings-heading"><h4>テナント契約</h4><p>契約単価・端数処理と、小分類ごとの金額の出し方です。</p></div>
        <div className="meter-table-wrap">
          <table className="meter-table meter-settings-table">
            <thead><tr><th className="meter-col-name">テナント</th><th>契約単価</th><th>使用量の丸め</th><th>金額の丸め</th>{building.subItems.filter((item) => item.source === 'meter').map((item) => <th key={item.id}>{item.name}</th>)}{building.surcharges.map((row) => <th key={row.id}>{row.name}</th>)}</tr></thead>
            <tbody>{tenants.map((tenant) => <tr key={tenant.id}>
              <td className="meter-col-name">{tenant.name}</td>
              <td><input type="number" step="0.01" className="meter-narrow" value={tenant.unitPrice} onChange={(event) => updateTenant(tenant.id, { unitPrice: Number(event.target.value) })} /></td>
              <td><span className="meter-settings-pair">
                <select value={tenant.usageRoundingUnit} onChange={(event) => updateTenant(tenant.id, { usageRoundingUnit: Number(event.target.value) })}>{[0.1, 1, 10].map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select>
                <select value={tenant.usageRoundingMode} onChange={(event) => updateTenant(tenant.id, { usageRoundingMode: event.target.value as RoundingMode })}>{roundingModes.map((row) => <option key={row} value={row}>{roundingModeLabel[row]}</option>)}</select>
              </span></td>
              <td><span className="meter-settings-pair">
                <select value={tenant.amountRoundingUnit} onChange={(event) => updateTenant(tenant.id, { amountRoundingUnit: Number(event.target.value) })}>{[1, 10, 100].map((unit) => <option key={unit} value={unit}>{unit}円</option>)}</select>
                <select value={tenant.amountRoundingMode} onChange={(event) => updateTenant(tenant.id, { amountRoundingMode: event.target.value as RoundingMode })}>{roundingModes.map((row) => <option key={row} value={row}>{roundingModeLabel[row]}</option>)}</select>
              </span></td>
              {[...building.subItems.filter((item) => item.source === 'meter').map((item) => item.id), ...building.surcharges.map((row) => row.id)].map((key) => <td key={key}>
                <select value={tenant.sumMode[key] ?? 'aggregate'} onChange={(event) => updateSumMode(tenant.id, key, event.target.value as SumMode)}>{sumModes.map((row) => <option key={row} value={row}>{sumModeLabel[row]}</option>)}</select>
              </td>)}
            </tr>)}</tbody>
          </table>
        </div>
      </section>
    </div>}
  </section>;
}
