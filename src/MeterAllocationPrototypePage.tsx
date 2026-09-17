import { useMemo, useState } from 'react';
import { calculateTenant, initialCommonRates, initialTenants, type CommonRates, type RoundingMode, type TenantConfig } from './utils/meterPrototype';
import './MeterAllocationPrototypePage.css';

// 検針データ集計の試作画面です。肥後橋の集計表と同じ見え方を目指し、
// 単価・丸め・メーターの紐づけは「設定」に隠しています。保存はされません。

const yen = new Intl.NumberFormat('ja-JP');
const amount = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const roundingModeLabel: Record<RoundingMode, string> = { floor: '切り捨て', ceil: '切り上げ', round: '四捨五入' };

export function MeterAllocationPrototypePage() {
  const [tenants, setTenants] = useState<TenantConfig[]>(initialTenants);
  const [rates, setRates] = useState<CommonRates>(initialCommonRates);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);

  const results = useMemo(() => tenants.map((tenant) => calculateTenant(tenant, rates)), [rates, tenants]);
  const totals = results.reduce((sum, result) => ({
    light: sum.light + result.lightAmount, ac: sum.ac + result.acAmount, gas: sum.gas + result.gasAmount,
    surcharge: sum.surcharge + result.surchargeAmount, total: sum.total + result.total,
    expected: sum.expected + result.tenant.expected.total,
  }), { light: 0, ac: 0, gas: 0, surcharge: 0, total: 0, expected: 0 });

  const toggle = (id: string) => setExpanded((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const updateTenant = (tenantId: string, patch: Partial<TenantConfig>) => setTenants((current) => current.map((tenant) => tenant.id === tenantId ? { ...tenant, ...patch } : tenant));
  const updateBlockPrice = (tenantId: string, blockId: string, unitPrice: number) => setTenants((current) => current.map((tenant) => tenant.id === tenantId
    ? { ...tenant, blocks: tenant.blocks.map((block) => block.id === blockId ? { ...block, unitPrice } : block) } : tenant));
  const updateLight = (tenantId: string, blockId: string, code: string, usage: number) => setTenants((current) => current.map((tenant) => tenant.id === tenantId
    ? { ...tenant, blocks: tenant.blocks.map((block) => block.id === blockId ? { ...block, lightMeters: block.lightMeters.map((meter) => meter.code === code ? { ...meter, usage } : meter) } : block) } : tenant));
  const updateAc = (tenantId: string, blockId: string, no: string, field: 'electric' | 'gas', value: number) => setTenants((current) => current.map((tenant) => tenant.id === tenantId
    ? { ...tenant, blocks: tenant.blocks.map((block) => block.id === blockId ? { ...block, acReadings: block.acReadings.map((reading) => reading.no === no ? { ...reading, [field]: value } : reading) } : block) } : tenant));

  return <section className="meter-page">
    <header className="meter-page-heading">
      <div>
        <p className="section-kicker">METER</p>
        <h2>電気検針データ集計</h2>
        <p>三共肥後橋ビル・2026年9月分</p>
      </div>
      <dl className="meter-page-meta">
        <div><dt>検針日</dt><dd>{rates.meterDate}</dd></div>
        <div><dt>電灯</dt><dd>{rates.lightPeriod}</dd></div>
        <div><dt>空調・ガス</dt><dd>{rates.acPeriod}</dd></div>
        <div><dt>増額分単価</dt><dd>{rates.surchargeUnitPrice} 円</dd></div>
        <div><dt>ガス単価</dt><dd>{rates.gasUnitPrice} 円</dd></div>
      </dl>
      <button type="button" className={showSettings ? 'primary-button' : 'text-button'} onClick={() => setShowSettings(!showSettings)}>{showSettings ? '設定を閉じる' : '設定を開く'}</button>
    </header>

    <div className="meter-table-wrap">
      <table className="meter-table">
        <thead>
          <tr>
            <th rowSpan={2} className="meter-col-name">テナント</th>
            <th colSpan={2}>電灯</th>
            <th colSpan={2}>空調</th>
            <th colSpan={2}>ガス</th>
            <th colSpan={2}>電気増額分</th>
            <th rowSpan={2}>請求合計</th>
            <th rowSpan={2}>元表</th>
            <th rowSpan={2}>差</th>
          </tr>
          <tr>
            <th>使用量</th><th>使用料</th><th>使用量</th><th>使用料</th><th>使用量</th><th>使用料</th><th>使用量</th><th>使用料</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result) => {
            const open = expanded.includes(result.tenant.id);
            const diff = result.difference.total;
            return [
              <tr key={result.tenant.id} className={open ? 'meter-row open' : 'meter-row'} onClick={() => toggle(result.tenant.id)}>
                <td className="meter-col-name"><span className="meter-toggle">{open ? '▾' : '▸'}</span><strong>{result.tenant.name}</strong><small>{result.tenant.blocks.map((block) => block.location).join('・')}</small></td>
                <td className="numeric">{amount.format(result.lightUsage)}</td>
                <td className="numeric">{yen.format(result.lightAmount)}</td>
                <td className="numeric">{amount.format(result.acUsage)}</td>
                <td className="numeric">{yen.format(result.acAmount)}</td>
                <td className="numeric">{amount.format(result.gasUsage)}</td>
                <td className="numeric">{yen.format(result.gasAmount)}</td>
                <td className="numeric">{amount.format(result.surchargeUsage)}</td>
                <td className="numeric">{yen.format(result.surchargeAmount)}</td>
                <td className="numeric meter-total">{yen.format(result.total)}</td>
                <td className="numeric meter-muted">{yen.format(result.tenant.expected.total)}</td>
                <td className={diff === 0 ? 'numeric meter-ok' : 'numeric meter-warn'}>{diff === 0 ? '一致' : yen.format(diff)}</td>
              </tr>,
              open ? <tr key={`${result.tenant.id}-detail`} className="meter-detail-row"><td colSpan={12}>
                <div className="meter-detail">
                  {result.blocks.map((blockResult) => <section key={blockResult.block.id}>
                    <header><strong>{blockResult.block.location}</strong><span>電灯単価 {blockResult.block.unitPrice} 円/kWh</span></header>
                    <div className="meter-detail-columns">
                      <div>
                        <h5>電灯メーター</h5>
                        <table><tbody>{blockResult.block.lightMeters.map((meter) => <tr key={meter.code}>
                          <td>{meter.code}</td>
                          <td><input type="number" step="0.1" value={meter.usage} onChange={(event) => updateLight(result.tenant.id, blockResult.block.id, meter.code, Number(event.target.value))} /></td>
                          <td className="meter-unit">kWh</td>
                        </tr>)}</tbody></table>
                        <p className="meter-detail-sum">計 {amount.format(blockResult.lightUsage)} kWh ／ {yen.format(blockResult.lightAmount)} 円</p>
                      </div>
                      <div>
                        <h5>空調（電気・ガス）</h5>
                        <table>
                          <thead><tr><th>空調№</th><th>電気</th><th>ガス</th></tr></thead>
                          <tbody>{blockResult.block.acReadings.map((reading) => <tr key={reading.no}>
                            <td>{reading.no}</td>
                            <td><input type="number" step="0.001" value={reading.electric} onChange={(event) => updateAc(result.tenant.id, blockResult.block.id, reading.no, 'electric', Number(event.target.value))} /></td>
                            <td><input type="number" step="0.001" value={reading.gas} onChange={(event) => updateAc(result.tenant.id, blockResult.block.id, reading.no, 'gas', Number(event.target.value))} /></td>
                          </tr>)}</tbody>
                        </table>
                        <p className="meter-detail-sum">電気 {amount.format(blockResult.acUsage)} kWh ／ {yen.format(blockResult.acAmount)} 円　ガス {amount.format(blockResult.gasUsage)} ㎥</p>
                      </div>
                    </div>
                  </section>)}
                  <p className="meter-detail-formula">
                    端数処理：使用量は {result.tenant.usageRoundingUnit} 単位で{roundingModeLabel[result.tenant.usageRoundingMode]}、金額は {result.tenant.amountRoundingUnit} 円単位で{roundingModeLabel[result.tenant.amountRoundingMode]}
                    {result.tenant.basicCharge ? `／基本料 ${yen.format(result.tenant.basicCharge)} 円` : ''}
                    　電気増額分：（電灯 {amount.format(result.lightUsage)} ＋ 空調 {amount.format(result.acUsage)}）× {rates.surchargeUnitPrice} 円
                  </p>
                </div>
              </td></tr> : null,
            ];
          })}
        </tbody>
        <tfoot>
          <tr>
            <td className="meter-col-name">合計</td>
            <td />
            <td className="numeric">{yen.format(totals.light)}</td>
            <td />
            <td className="numeric">{yen.format(totals.ac)}</td>
            <td />
            <td className="numeric">{yen.format(totals.gas)}</td>
            <td />
            <td className="numeric">{yen.format(totals.surcharge)}</td>
            <td className="numeric meter-total">{yen.format(totals.total)}</td>
            <td className="numeric meter-muted">{yen.format(totals.expected)}</td>
            <td className={totals.total === totals.expected ? 'numeric meter-ok' : 'numeric meter-warn'}>{totals.total === totals.expected ? '一致' : yen.format(totals.total - totals.expected)}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    {showSettings && <section className="meter-settings">
      <header><h3>設定（裏側）</h3><p>この画面は普段は開きません。ビルごとの違いはここのデータだけで吸収し、集計処理は全ビル共通です。</p></header>

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

      <div className="meter-settings-block">
        <h4>テナントごとの単価と端数処理</h4>
        <table className="meter-settings-table">
          <thead><tr><th>テナント</th><th>区画と単価</th><th>基本料</th><th>使用量の丸め</th><th>金額の丸め</th><th>紐づくメーター</th></tr></thead>
          <tbody>{tenants.map((tenant) => <tr key={tenant.id}>
            <td>{tenant.name}</td>
            <td>{tenant.blocks.map((block) => <span key={block.id} className="meter-settings-price">{block.location}<input type="number" step="0.01" value={block.unitPrice} onChange={(event) => updateBlockPrice(tenant.id, block.id, Number(event.target.value))} />円</span>)}</td>
            <td><input type="number" value={tenant.basicCharge} onChange={(event) => updateTenant(tenant.id, { basicCharge: Number(event.target.value) })} /></td>
            <td><span className="meter-settings-pair">
              <select value={tenant.usageRoundingUnit} onChange={(event) => updateTenant(tenant.id, { usageRoundingUnit: Number(event.target.value) })}>{[0.1, 1, 10].map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select>
              <select value={tenant.usageRoundingMode} onChange={(event) => updateTenant(tenant.id, { usageRoundingMode: event.target.value as RoundingMode })}>{(['floor', 'ceil', 'round'] as RoundingMode[]).map((mode) => <option key={mode} value={mode}>{roundingModeLabel[mode]}</option>)}</select>
            </span></td>
            <td><span className="meter-settings-pair">
              <select value={tenant.amountRoundingUnit} onChange={(event) => updateTenant(tenant.id, { amountRoundingUnit: Number(event.target.value) })}>{[1, 10, 100].map((unit) => <option key={unit} value={unit}>{unit}円</option>)}</select>
              <select value={tenant.amountRoundingMode} onChange={(event) => updateTenant(tenant.id, { amountRoundingMode: event.target.value as RoundingMode })}>{(['floor', 'ceil', 'round'] as RoundingMode[]).map((mode) => <option key={mode} value={mode}>{roundingModeLabel[mode]}</option>)}</select>
            </span></td>
            <td className="meter-settings-meters">{tenant.blocks.map((block) => <span key={block.id}>{block.lightMeters.map((meter) => meter.code).join('、')}／空調 {block.acReadings.length}台</span>)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>}
  </section>;
}
