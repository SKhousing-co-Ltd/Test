import { useMemo, useState } from 'react';
import {
  calculateCharge, calculateTenant, chargeInputs, initialCommonRates, initialMeters, initialTenants, sumModeLabel,
  type ChargeKind, type CommonRates, type Meter, type RoundingMode, type SumMode, type TenantConfig,
} from './utils/meterPrototype';
import './MeterAllocationPrototypePage.css';

// 検針データ集計の試作画面です。項目ごとのタブで検針値の入力と割当を行い、
// 金額の出し方（まとめて／区画ごと／メーターごと）をテナント単位で選べます。保存はされません。

const yen = new Intl.NumberFormat('ja-JP');
const amount = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const roundingModeLabel: Record<RoundingMode, string> = { floor: '切り捨て', ceil: '切り上げ', round: '四捨五入' };
const sumModes: SumMode[] = ['aggregate', 'perArea', 'perMeter'];
const tabs: Array<{ id: ChargeKind | 'summary' | 'settings'; label: string }> = [
  { id: 'summary', label: 'テナント別集計' }, { id: 'light', label: '電灯' }, { id: 'ac', label: '空調（電気）' }, { id: 'gas', label: 'ガス' }, { id: 'surcharge', label: '電気増額分' }, { id: 'settings', label: '契約設定' },
];
const chargeUnit: Record<ChargeKind, string> = { light: 'kWh', ac: 'kWh', gas: '㎥', surcharge: 'kWh' };

export function MeterAllocationPrototypePage() {
  const [tenants, setTenants] = useState<TenantConfig[]>(initialTenants);
  const [meters, setMeters] = useState<Meter[]>(initialMeters);
  const [rates, setRates] = useState<CommonRates>(initialCommonRates);
  const [tab, setTab] = useState<ChargeKind | 'summary' | 'settings'>('summary');

  const results = useMemo(() => tenants.map((tenant) => calculateTenant(tenant, meters, rates)), [meters, rates, tenants]);
  const totals = results.reduce((sum, result) => ({
    light: sum.light + result.lightAmount, ac: sum.ac + result.acCharge.amount, gas: sum.gas + result.gasCharge.amount,
    surcharge: sum.surcharge + result.surchargeCharge.amount, total: sum.total + result.total, expected: sum.expected + result.tenant.expected.total,
  }), { light: 0, ac: 0, gas: 0, surcharge: 0, total: 0, expected: 0 });

  const updateMeter = (id: string, patch: Partial<Meter>) => setMeters((current) => current.map((meter) => meter.id === id ? { ...meter, ...patch } : meter));
  const updateTenant = (id: string, patch: Partial<TenantConfig>) => setTenants((current) => current.map((tenant) => tenant.id === id ? { ...tenant, ...patch } : tenant));
  const updateSumMode = (id: string, kind: ChargeKind, mode: SumMode) => setTenants((current) => current.map((tenant) => tenant.id === id ? { ...tenant, sumMode: { ...tenant.sumMode, [kind]: mode } } : tenant));
  const tenantName = (id: string) => tenants.find((tenant) => tenant.id === id)?.name ?? '未割当';

  return <section className="meter-page">
    <header className="meter-page-heading">
      <div><p className="section-kicker">METER</p><h2>電気検針データ集計</h2><p>三共肥後橋ビル・2026年9月分</p></div>
      <dl className="meter-page-meta">
        <div><dt>検針日</dt><dd>{rates.meterDate}</dd></div>
        <div><dt>電灯</dt><dd>{rates.lightPeriod}</dd></div>
        <div><dt>空調・ガス</dt><dd>{rates.acPeriod}</dd></div>
        <div><dt>増額分単価</dt><dd>{rates.surchargeUnitPrice} 円</dd></div>
        <div><dt>ガス単価</dt><dd>{rates.gasUnitPrice} 円</dd></div>
      </dl>
    </header>

    <nav className="meter-tabs">{tabs.map((item) => <button key={item.id} type="button" className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>

    {tab === 'summary' && <div className="meter-panel">
      <div className="meter-panel-heading"><h3>テナント別集計</h3><p>各タブで入力した使用量を、テナントの契約情報で金額にしたものです。</p></div>
      <div className="meter-table-wrap">
        <table className="meter-table">
          <thead><tr><th className="meter-col-name">テナント</th><th>電灯</th><th>空調</th><th>ガス</th><th>電気増額分</th><th>基本料</th><th>請求合計</th><th>元表</th><th>差</th></tr></thead>
          <tbody>{results.map((result) => <tr key={result.tenant.id}>
            <td className="meter-col-name"><strong>{result.tenant.name}</strong><small>単価 {result.tenant.unitPrice} 円／{roundingModeLabel[result.tenant.amountRoundingMode]}</small></td>
            <td className="numeric">{yen.format(result.lightCharge.amount)}</td>
            <td className="numeric">{yen.format(result.acCharge.amount)}</td>
            <td className="numeric">{yen.format(result.gasCharge.amount)}</td>
            <td className="numeric">{yen.format(result.surchargeCharge.amount)}</td>
            <td className="numeric meter-muted">{result.tenant.basicCharge ? yen.format(result.tenant.basicCharge) : '—'}</td>
            <td className="numeric meter-total">{yen.format(result.total)}</td>
            <td className="numeric meter-muted">{yen.format(result.tenant.expected.total)}</td>
            <td className={result.difference.total === 0 ? 'numeric meter-ok' : 'numeric meter-warn'}>{result.difference.total === 0 ? '一致' : yen.format(result.difference.total)}</td>
          </tr>)}</tbody>
          <tfoot><tr>
            <td className="meter-col-name">合計</td>
            <td className="numeric">{yen.format(totals.light)}</td><td className="numeric">{yen.format(totals.ac)}</td><td className="numeric">{yen.format(totals.gas)}</td><td className="numeric">{yen.format(totals.surcharge)}</td><td />
            <td className="numeric meter-total">{yen.format(totals.total)}</td>
            <td className="numeric meter-muted">{yen.format(totals.expected)}</td>
            <td className={totals.total === totals.expected ? 'numeric meter-ok' : 'numeric meter-warn'}>{totals.total === totals.expected ? '一致' : yen.format(totals.total - totals.expected)}</td>
          </tr></tfoot>
        </table>
      </div>
    </div>}

    {(tab === 'light' || tab === 'ac' || tab === 'gas' || tab === 'surcharge') && (() => {
      const kind = tab;
      const readOnly = kind === 'surcharge';
      const targetMeters = kind === 'light' ? meters.filter((meter) => meter.kind === 'light') : kind === 'surcharge' ? meters : meters.filter((meter) => meter.kind === 'ac');
      const usageField = kind === 'gas' ? 'gas' : 'electric';
      return <div className="meter-panel">
        <div className="meter-panel-heading">
          <h3>{tabs.find((item) => item.id === kind)?.label}</h3>
          <p>{readOnly ? '電灯と空調の使用量に増額分単価をかけます。使用量は各タブの入力を参照します。' : 'メーターごとに使用量を入力し、割り当てるテナントを選びます。単価はテナントの契約単価を使い、違う場合だけ上書きします。'}</p>
        </div>

        {!readOnly && <div className="meter-table-wrap">
          <table className="meter-table meter-input-table">
            <thead><tr><th className="meter-col-name">メーター</th><th>区画</th><th>割当テナント</th><th>単価</th><th>使用量</th></tr></thead>
            <tbody>{targetMeters.map((meter) => <tr key={meter.id}>
              <td className="meter-col-name">{meter.code}</td>
              <td>{meter.area}</td>
              <td><select value={meter.tenantId} onChange={(event) => updateMeter(meter.id, { tenantId: event.target.value })}>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select></td>
              <td className="numeric">{kind === 'gas' ? <span className="meter-muted">{rates.gasUnitPrice} 円（共通）</span>
                : <input type="number" step="0.01" value={meter.unitPrice ?? tenants.find((tenant) => tenant.id === meter.tenantId)?.unitPrice ?? 0} onChange={(event) => updateMeter(meter.id, { unitPrice: Number(event.target.value) })} />}</td>
              <td className="numeric"><input type="number" step={kind === 'light' ? '0.1' : '0.001'} value={meter[usageField]} onChange={(event) => updateMeter(meter.id, { [usageField]: Number(event.target.value) } as Partial<Meter>)} /></td>
            </tr>)}</tbody>
          </table>
        </div>}

        <div className="meter-subtotals">
          <h4>テナント別の集計</h4>
          <table className="meter-table">
            <thead><tr><th className="meter-col-name">テナント</th><th>使用量</th><th>金額の出し方</th><th>内訳</th><th>金額</th></tr></thead>
            <tbody>{tenants.map((tenant) => {
              const inputs = chargeInputs(meters, tenant, kind, rates);
              if (!inputs.length) return null;
              const result = calculateCharge(tenant, inputs, tenant.sumMode[kind]);
              return <tr key={tenant.id}>
                <td className="meter-col-name"><strong>{tenant.name}</strong><small>{inputs.length} メーター</small></td>
                <td className="numeric">{amount.format(result.usage)} {chargeUnit[kind]}</td>
                <td><select value={tenant.sumMode[kind]} onChange={(event) => updateSumMode(tenant.id, kind, event.target.value as SumMode)}>{sumModes.map((mode) => <option key={mode} value={mode}>{sumModeLabel[mode]}</option>)}</select></td>
                <td className="meter-breakdown">{result.groups.map((group) => <span key={group.label}>{group.label}：{amount.format(group.usage)} × {group.unitPrice} ＝ {yen.format(group.amount)}</span>)}</td>
                <td className="numeric meter-total">{yen.format(result.amount)}</td>
              </tr>;
            })}</tbody>
          </table>
          <p className="meter-hint">「まとめて計算」は使用量を合計してから単価をかけます。「区画ごと」「メーターごと」はそれぞれで金額を出して合算します。単価が違うメーターは、どの方式でも必ず分けて計算します。</p>
        </div>
      </div>;
    })()}

    {tab === 'settings' && <div className="meter-panel">
      <div className="meter-panel-heading"><h3>契約設定</h3><p>ビルごとの違いはここのデータだけで吸収します。集計処理は全ビル共通です。</p></div>
      <div className="meter-settings-block">
        <h4>物件共通</h4>
        <div className="meter-settings-fields">
          <label>電気増額分の単価<input type="number" step="0.01" value={rates.surchargeUnitPrice} onChange={(event) => setRates({ ...rates, surchargeUnitPrice: Number(event.target.value) })} /></label>
          <label>ガス単価<input type="number" step="1" value={rates.gasUnitPrice} onChange={(event) => setRates({ ...rates, gasUnitPrice: Number(event.target.value) })} /></label>
          <label>検針日<input value={rates.meterDate} onChange={(event) => setRates({ ...rates, meterDate: event.target.value })} /></label>
          <label>電灯期間<input value={rates.lightPeriod} onChange={(event) => setRates({ ...rates, lightPeriod: event.target.value })} /></label>
          <label>空調・ガス期間<input value={rates.acPeriod} onChange={(event) => setRates({ ...rates, acPeriod: event.target.value })} /></label>
        </div>
      </div>
      <div className="meter-table-wrap">
        <table className="meter-table meter-settings-table">
          <thead><tr><th className="meter-col-name">テナント</th><th>電気単価</th><th>基本料</th><th>使用量の丸め</th><th>金額の丸め</th><th>電灯</th><th>空調</th><th>ガス</th><th>増額分</th></tr></thead>
          <tbody>{tenants.map((tenant) => <tr key={tenant.id}>
            <td className="meter-col-name">{tenant.name}</td>
            <td><input type="number" step="0.01" value={tenant.unitPrice} onChange={(event) => updateTenant(tenant.id, { unitPrice: Number(event.target.value) })} /></td>
            <td><input type="number" value={tenant.basicCharge} onChange={(event) => updateTenant(tenant.id, { basicCharge: Number(event.target.value) })} /></td>
            <td><span className="meter-settings-pair">
              <select value={tenant.usageRoundingUnit} onChange={(event) => updateTenant(tenant.id, { usageRoundingUnit: Number(event.target.value) })}>{[0.1, 1, 10].map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select>
              <select value={tenant.usageRoundingMode} onChange={(event) => updateTenant(tenant.id, { usageRoundingMode: event.target.value as RoundingMode })}>{(['floor', 'ceil', 'round'] as RoundingMode[]).map((mode) => <option key={mode} value={mode}>{roundingModeLabel[mode]}</option>)}</select>
            </span></td>
            <td><span className="meter-settings-pair">
              <select value={tenant.amountRoundingUnit} onChange={(event) => updateTenant(tenant.id, { amountRoundingUnit: Number(event.target.value) })}>{[1, 10, 100].map((unit) => <option key={unit} value={unit}>{unit}円</option>)}</select>
              <select value={tenant.amountRoundingMode} onChange={(event) => updateTenant(tenant.id, { amountRoundingMode: event.target.value as RoundingMode })}>{(['floor', 'ceil', 'round'] as RoundingMode[]).map((mode) => <option key={mode} value={mode}>{roundingModeLabel[mode]}</option>)}</select>
            </span></td>
            {(['light', 'ac', 'gas', 'surcharge'] as ChargeKind[]).map((kind) => <td key={kind}>
              <select value={tenant.sumMode[kind]} onChange={(event) => updateSumMode(tenant.id, kind, event.target.value as SumMode)}>{sumModes.map((mode) => <option key={mode} value={mode}>{sumModeLabel[mode]}</option>)}</select>
            </td>)}
          </tr>)}</tbody>
        </table>
      </div>
      <div className="meter-settings-block">
        <h4>メーターの割当</h4>
        <div className="meter-table-wrap">
          <table className="meter-table meter-settings-table">
            <thead><tr><th className="meter-col-name">メーター</th><th>種別</th><th>区画</th><th>割当テナント</th><th>単価の上書き</th></tr></thead>
            <tbody>{meters.map((meter) => <tr key={meter.id}>
              <td className="meter-col-name">{meter.code}</td>
              <td>{meter.kind === 'light' ? '電灯' : '空調'}</td>
              <td>{meter.area}</td>
              <td>{tenantName(meter.tenantId)}</td>
              <td className="numeric">{meter.unitPrice ? `${meter.unitPrice} 円` : <span className="meter-muted">契約単価</span>}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>
    </div>}
  </section>;
}
