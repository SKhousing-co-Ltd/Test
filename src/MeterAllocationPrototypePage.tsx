import { useMemo, useState } from 'react';
import {
  calculateItem, calculateTenant, collectInputs, initialAreas, initialBuilding, initialMeters, initialTenants,
  roundingModeLabel, sumModeLabel,
  type Area, type BuildingConfig, type ChargeItem, type Meter, type RoundingMode, type SumMode, type TenantConfig,
} from './utils/meterPrototype';
import './MeterAllocationPrototypePage.css';

// 検針データ集計の試作画面です。
// 入力タブ … テナントごとに、割り当てられた区画とメーターを並べて使用量を入力します。
// 設定タブ … 請求項目・区画・メーター・テナント契約を登録し、ページの構成そのものを組み立てます。
// 保存はされません。

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

  const results = useMemo(() => tenants.map((tenant) => calculateTenant(tenant, building, areas, meters)), [areas, building, meters, tenants]);
  const grandTotal = results.reduce((sum, result) => sum + result.total, 0);
  const grandExpected = results.reduce((sum, result) => sum + result.tenant.expected, 0);

  const updateMeter = (id: string, patch: Partial<Meter>) => setMeters((current) => current.map((meter) => meter.id === id ? { ...meter, ...patch } : meter));
  const updateArea = (id: string, patch: Partial<Area>) => setAreas((current) => current.map((area) => area.id === id ? { ...area, ...patch } : area));
  const updateTenant = (id: string, patch: Partial<TenantConfig>) => setTenants((current) => current.map((tenant) => tenant.id === id ? { ...tenant, ...patch } : tenant));
  const updateSumMode = (id: string, itemId: string, mode: SumMode) => setTenants((current) => current.map((tenant) => tenant.id === id ? { ...tenant, sumMode: { ...tenant.sumMode, [itemId]: mode } } : tenant));
  const updateItem = (id: string, patch: Partial<ChargeItem>) => setBuilding((current) => ({ ...current, items: current.items.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  const moveItem = (id: string, step: number) => setBuilding((current) => {
    const index = current.items.findIndex((item) => item.id === id);
    const next = [...current.items];
    const target = index + step;
    if (index < 0 || target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target], next[index]];
    return { ...current, items: next };
  });
  const addItem = () => {
    const id = `item${Date.now()}`;
    setBuilding((current) => ({ ...current, items: [...current.items, { id, name: '新しい項目', unit: 'kWh', source: 'meter', meterKindId: current.meterKinds[0]?.id ?? '', readingField: 'electric', priceSource: 'tenant' }] }));
    setTenants((current) => current.map((tenant) => ({ ...tenant, sumMode: { ...tenant.sumMode, [id]: 'aggregate' } })));
  };
  const removeItem = (id: string) => setBuilding((current) => ({ ...current, items: current.items.filter((item) => item.id !== id) }));
  const addArea = () => setAreas((current) => [...current, { id: `A${Date.now()}`, name: '新しい区画', tenantId: tenants[0]?.id ?? '' }]);
  const removeArea = (id: string) => { setAreas((current) => current.filter((area) => area.id !== id)); setMeters((current) => current.filter((meter) => meter.areaId !== id)); };
  const addMeter = () => setMeters((current) => [...current, { id: `M${Date.now()}`, code: '新しいメーター', areaId: areas[0]?.id ?? '', meterKindId: building.meterKinds[0]?.id ?? '', electric: 0, gas: 0 }]);
  const removeMeter = (id: string) => setMeters((current) => current.filter((meter) => meter.id !== id));

  const tabs = [{ id: 'summary', label: 'テナント別集計' }, ...building.items.map((item) => ({ id: item.id, label: item.name })), { id: 'settings', label: '設定' }];
  const activeItem = building.items.find((item) => item.id === tab);

  return <section className="meter-page">
    <header className="meter-page-heading">
      <div><p className="section-kicker">METER</p><h2>検針データ集計</h2><p>{building.name}・{building.period}</p></div>
      <dl className="meter-page-meta">
        <div><dt>検針日</dt><dd>{building.meterDate}</dd></div>
        <div><dt>請求項目</dt><dd>{building.items.map((item) => item.name).join('・')}</dd></div>
        <div><dt>区画</dt><dd>{areas.length} 区画／メーター {meters.length} 台</dd></div>
      </dl>
    </header>

    <nav className="meter-tabs">{tabs.map((item) => <button key={item.id} type="button" className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>

    {tab === 'summary' && <div className="meter-panel">
      <div className="meter-panel-heading"><h3>テナント別集計</h3><p>各項目タブで入力した使用量を、テナントの契約情報で金額にしたものです。</p></div>
      <div className="meter-table-wrap">
        <table className="meter-table">
          <thead><tr><th className="meter-col-name">テナント</th>{building.items.map((item) => <th key={item.id}>{item.name}</th>)}<th>基本料</th><th>請求合計</th><th>元表</th><th>差</th></tr></thead>
          <tbody>{results.map((result) => <tr key={result.tenant.id}>
            <td className="meter-col-name"><strong>{result.tenant.name}</strong><small>{areas.filter((area) => area.tenantId === result.tenant.id).map((area) => area.name).join('・') || '区画未割当'}</small></td>
            {result.charges.map((charge) => <td key={charge.item.id} className="numeric">{yen.format(charge.amount)}</td>)}
            <td className="numeric meter-muted">{result.tenant.basicCharge ? yen.format(result.tenant.basicCharge) : '—'}</td>
            <td className="numeric meter-total">{yen.format(result.total)}</td>
            <td className="numeric meter-muted">{yen.format(result.tenant.expected)}</td>
            <td className={result.difference === 0 ? 'numeric meter-ok' : 'numeric meter-warn'}>{result.difference === 0 ? '一致' : yen.format(result.difference)}</td>
          </tr>)}</tbody>
          <tfoot><tr>
            <td className="meter-col-name">合計</td>
            {building.items.map((item) => <td key={item.id} className="numeric">{yen.format(results.reduce((sum, result) => sum + (result.charges.find((charge) => charge.item.id === item.id)?.amount ?? 0), 0))}</td>)}
            <td className="numeric">{yen.format(results.reduce((sum, result) => sum + result.tenant.basicCharge, 0))}</td>
            <td className="numeric meter-total">{yen.format(grandTotal)}</td>
            <td className="numeric meter-muted">{yen.format(grandExpected)}</td>
            <td className={grandTotal === grandExpected ? 'numeric meter-ok' : 'numeric meter-warn'}>{grandTotal === grandExpected ? '一致' : yen.format(grandTotal - grandExpected)}</td>
          </tr></tfoot>
        </table>
      </div>
    </div>}

    {activeItem && <div className="meter-panel">
      <div className="meter-panel-heading">
        <h3>{activeItem.name}</h3>
        <p>{activeItem.source === 'derived' ? `${(activeItem.derivedFrom ?? []).map((id) => building.items.find((item) => item.id === id)?.name).filter(Boolean).join('＋')} の使用量に ${activeItem.commonUnitPrice} 円をかけます。使用量は元の項目の入力を参照します。` : 'テナントごとに、割り当てられた区画のメーターへ使用量を入力します。'}</p>
      </div>
      <div className="meter-tenant-list">{tenants.map((tenant) => {
        const inputs = collectInputs(activeItem, tenant, areas, meters, building.items);
        if (!inputs.length) return null;
        const result = calculateItem(activeItem, tenant, inputs);
        const tenantAreas = areas.filter((area) => area.tenantId === tenant.id);
        return <article key={tenant.id} className="meter-tenant">
          <header>
            <div><strong>{tenant.name}</strong><small>単価 {activeItem.priceSource === 'common' ? `${activeItem.commonUnitPrice} 円（共通）` : `${tenant.unitPrice} 円（契約）`}／{sumModeLabel[tenant.sumMode[activeItem.id] ?? 'aggregate']}／金額は{roundingModeLabel[tenant.amountRoundingMode]}</small></div>
            <div className="meter-tenant-amount"><span>{amount.format(result.usage)} {activeItem.unit}</span><b>{yen.format(result.amount)} 円</b></div>
          </header>
          <div className="meter-tenant-areas">{tenantAreas.map((area) => {
            const areaInputs = inputs.filter((input) => input.areaId === area.id);
            if (!areaInputs.length) return null;
            const areaUsage = areaInputs.reduce((sum, input) => sum + input.usage, 0);
            return <div key={area.id} className="meter-area">
              <h5>{area.name}{area.unitPrice ? <em>単価 {area.unitPrice} 円</em> : null}</h5>
              <table>
                <tbody>{areaInputs.map((input) => <tr key={`${input.meterId}-${input.areaId}`}>
                  <td>{input.meterCode}</td>
                  <td>{activeItem.source === 'derived'
                    ? <span className="meter-readonly">{amount.format(input.usage)} {activeItem.unit}</span>
                    : <input type="number" step={activeItem.readingField === 'gas' || activeItem.meterKindId === 'ac' ? '0.001' : '0.1'} value={input.usage}
                        onChange={(event) => updateMeter(input.meterId, activeItem.readingField === 'gas' ? { gas: Number(event.target.value) } : { electric: Number(event.target.value) })} />}
                  </td>
                  <td className="meter-unit">{activeItem.unit}</td>
                </tr>)}</tbody>
              </table>
              <p className="meter-area-sum">区画計 {amount.format(areaUsage)} {activeItem.unit}</p>
            </div>;
          })}</div>
          <footer>{result.groups.map((group) => <span key={group.key}>{group.label}：{amount.format(group.usage)} × {group.unitPrice} ＝ {yen.format(group.amount)} 円</span>)}</footer>
        </article>;
      })}</div>
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
        <div className="meter-settings-heading"><h4>請求項目マスタ</h4><p>ここで登録した項目が、そのままこのページのタブになります。</p><button type="button" className="text-button" onClick={addItem}>項目を追加</button></div>
        <div className="meter-table-wrap">
          <table className="meter-table meter-settings-table">
            <thead><tr><th>並び</th><th>項目名</th><th>単位</th><th>使用量の取り方</th><th>対象</th><th>単価</th><th /></tr></thead>
            <tbody>{building.items.map((item) => <tr key={item.id}>
              <td className="meter-order"><button type="button" onClick={() => moveItem(item.id, -1)} aria-label="上へ">▲</button><button type="button" onClick={() => moveItem(item.id, 1)} aria-label="下へ">▼</button></td>
              <td><input value={item.name} onChange={(event) => updateItem(item.id, { name: event.target.value })} /></td>
              <td><input className="meter-narrow" value={item.unit} onChange={(event) => updateItem(item.id, { unit: event.target.value })} /></td>
              <td><select value={item.source} onChange={(event) => updateItem(item.id, { source: event.target.value as ChargeItem['source'] })}><option value="meter">メーターの検針値</option><option value="derived">他の項目の合計</option></select></td>
              <td>{item.source === 'meter'
                ? <span className="meter-settings-pair">
                    <select value={item.meterKindId ?? ''} onChange={(event) => updateItem(item.id, { meterKindId: event.target.value })}>{building.meterKinds.map((kind) => <option key={kind.id} value={kind.id}>{kind.name}</option>)}</select>
                    <select value={item.readingField ?? 'electric'} onChange={(event) => updateItem(item.id, { readingField: event.target.value as 'electric' | 'gas' })}><option value="electric">電気</option><option value="gas">ガス</option></select>
                  </span>
                : <span className="meter-settings-pair">{building.items.filter((row) => row.source === 'meter').map((row) => <label key={row.id} className="meter-check">
                    <input type="checkbox" checked={(item.derivedFrom ?? []).includes(row.id)} onChange={(event) => updateItem(item.id, { derivedFrom: event.target.checked ? [...(item.derivedFrom ?? []), row.id] : (item.derivedFrom ?? []).filter((value) => value !== row.id) })} />{row.name}
                  </label>)}</span>}
              </td>
              <td><span className="meter-settings-pair">
                <select value={item.priceSource} onChange={(event) => updateItem(item.id, { priceSource: event.target.value as ChargeItem['priceSource'] })}><option value="tenant">テナント契約単価</option><option value="common">共通単価</option></select>
                {item.priceSource === 'common' && <input type="number" step="0.01" className="meter-narrow" value={item.commonUnitPrice ?? 0} onChange={(event) => updateItem(item.id, { commonUnitPrice: Number(event.target.value) })} />}
              </span></td>
              <td><button type="button" className="meter-delete" onClick={() => removeItem(item.id)}>削除</button></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="meter-settings-block">
        <div className="meter-settings-heading"><h4>区画マスタ</h4><p>区画にテナントを紐づけます。単価が契約と違う区画はここで上書きします。</p><button type="button" className="text-button" onClick={addArea}>区画を追加</button></div>
        <div className="meter-table-wrap">
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
        <div className="meter-settings-heading"><h4>メーターマスタ</h4><p>メーターは区画に付けます。テナントは区画を通じて決まります。</p><button type="button" className="text-button" onClick={addMeter}>メーターを追加</button></div>
        <div className="meter-table-wrap meter-scroll">
          <table className="meter-table meter-settings-table">
            <thead><tr><th>メーター番号</th><th>種別</th><th>区画</th><th>テナント</th><th /></tr></thead>
            <tbody>{meters.map((meter) => <tr key={meter.id}>
              <td><input value={meter.code} onChange={(event) => updateMeter(meter.id, { code: event.target.value })} /></td>
              <td><select value={meter.meterKindId} onChange={(event) => updateMeter(meter.id, { meterKindId: event.target.value })}>{building.meterKinds.map((kind) => <option key={kind.id} value={kind.id}>{kind.name}</option>)}</select></td>
              <td><select value={meter.areaId} onChange={(event) => updateMeter(meter.id, { areaId: event.target.value })}>{areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></td>
              <td className="meter-muted">{tenants.find((tenant) => tenant.id === areas.find((area) => area.id === meter.areaId)?.tenantId)?.name ?? '—'}</td>
              <td><button type="button" className="meter-delete" onClick={() => removeMeter(meter.id)}>削除</button></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="meter-settings-block">
        <div className="meter-settings-heading"><h4>テナント契約</h4><p>単価・基本料・端数処理と、項目ごとの金額の出し方です。</p></div>
        <div className="meter-table-wrap">
          <table className="meter-table meter-settings-table">
            <thead><tr><th className="meter-col-name">テナント</th><th>契約単価</th><th>基本料</th><th>使用量の丸め</th><th>金額の丸め</th>{building.items.map((item) => <th key={item.id}>{item.name}</th>)}</tr></thead>
            <tbody>{tenants.map((tenant) => <tr key={tenant.id}>
              <td className="meter-col-name">{tenant.name}</td>
              <td><input type="number" step="0.01" className="meter-narrow" value={tenant.unitPrice} onChange={(event) => updateTenant(tenant.id, { unitPrice: Number(event.target.value) })} /></td>
              <td><input type="number" className="meter-narrow" value={tenant.basicCharge} onChange={(event) => updateTenant(tenant.id, { basicCharge: Number(event.target.value) })} /></td>
              <td><span className="meter-settings-pair">
                <select value={tenant.usageRoundingUnit} onChange={(event) => updateTenant(tenant.id, { usageRoundingUnit: Number(event.target.value) })}>{[0.1, 1, 10].map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select>
                <select value={tenant.usageRoundingMode} onChange={(event) => updateTenant(tenant.id, { usageRoundingMode: event.target.value as RoundingMode })}>{roundingModes.map((mode) => <option key={mode} value={mode}>{roundingModeLabel[mode]}</option>)}</select>
              </span></td>
              <td><span className="meter-settings-pair">
                <select value={tenant.amountRoundingUnit} onChange={(event) => updateTenant(tenant.id, { amountRoundingUnit: Number(event.target.value) })}>{[1, 10, 100].map((unit) => <option key={unit} value={unit}>{unit}円</option>)}</select>
                <select value={tenant.amountRoundingMode} onChange={(event) => updateTenant(tenant.id, { amountRoundingMode: event.target.value as RoundingMode })}>{roundingModes.map((mode) => <option key={mode} value={mode}>{roundingModeLabel[mode]}</option>)}</select>
              </span></td>
              {building.items.map((item) => <td key={item.id}>
                <select value={tenant.sumMode[item.id] ?? 'aggregate'} onChange={(event) => updateSumMode(tenant.id, item.id, event.target.value as SumMode)}>{sumModes.map((mode) => <option key={mode} value={mode}>{sumModeLabel[mode]}</option>)}</select>
              </td>)}
            </tr>)}</tbody>
          </table>
        </div>
      </section>
    </div>}
  </section>;
}
