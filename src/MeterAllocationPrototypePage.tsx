import { useMemo, useState } from 'react';
import './MeterAllocationPrototypePage.css';

// 検針データの配賦をノード（箱）と配分（線）で表す試作画面です。
// データベースは使わず画面上の値だけで計算します。運用の形を確かめるためのものです。

type Meter = { id: string; name: string; kind: string; previous: number; current: number };
type Node = { id: string; name: string; kind: 'sum' | 'subtract'; plus: string[]; minus: string[] };
type Edge = { id: string; nodeId: string; codeId: string; basis: 'direct' | 'ratio'; ratio: number };
type RoundingMode = 'floor' | 'ceil' | 'round';
type Code = { id: string; tenantName: string; issueCode: string; basicCharge: number; unitPrice: number; roundingMode: RoundingMode; roundingUnit: number; usageRoundingUnit: number; roundingStage: 'usage' | 'amount' };

const initialMeters: Meter[] = [
  { id: 'M0', name: '親メーター（一括受電）', kind: '電気', previous: 120000, current: 126000 },
  { id: 'M1', name: '3F 電灯', kind: '電灯', previous: 45000, current: 46200 },
  { id: 'M2', name: '3F 空調', kind: '空調', previous: 31000, current: 31800 },
  { id: 'M4', name: '4F 電灯空調', kind: '電気', previous: 22000, current: 23500 },
];

const initialNodes: Node[] = [
  { id: 'N1', name: '3F 専用分（電灯＋空調）', kind: 'sum', plus: ['M1', 'M2'], minus: [] },
  { id: 'N2', name: '4F 専用分', kind: 'sum', plus: ['M4'], minus: [] },
  { id: 'N3', name: '共用分（親－専用）', kind: 'subtract', plus: ['M0'], minus: ['M1', 'M2', 'M4'] },
];

const initialCodes: Code[] = [
  { id: 'C1', tenantName: '3Fテナント', issueCode: '1715', basicCharge: 3000, unitPrice: 27.5, roundingMode: 'floor', roundingUnit: 1, usageRoundingUnit: 1, roundingStage: 'amount' },
  { id: 'C2', tenantName: '4Fテナント', issueCode: '1722', basicCharge: 0, unitPrice: 26, roundingMode: 'round', roundingUnit: 10, usageRoundingUnit: 1, roundingStage: 'amount' },
];

const initialEdges: Edge[] = [
  { id: 'E1', nodeId: 'N1', codeId: 'C1', basis: 'direct', ratio: 100 },
  { id: 'E2', nodeId: 'N2', codeId: 'C2', basis: 'direct', ratio: 100 },
  { id: 'E3', nodeId: 'N3', codeId: 'C1', basis: 'ratio', ratio: 60 },
  { id: 'E4', nodeId: 'N3', codeId: 'C2', basis: 'ratio', ratio: 40 },
];

const yen = new Intl.NumberFormat('ja-JP');
const kwh = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const roundingModeLabel: Record<RoundingMode, string> = { floor: '切り捨て', ceil: '切り上げ', round: '四捨五入' };
const applyRounding = (value: number, unit: number, mode: RoundingMode) => {
  if (!unit) return value;
  const scaled = value / unit;
  const rounded = mode === 'floor' ? Math.floor(scaled) : mode === 'ceil' ? Math.ceil(scaled) : Math.round(scaled);
  return rounded * unit;
};

export function MeterAllocationPrototypePage() {
  const [meters, setMeters] = useState(initialMeters);
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState(initialEdges);
  const [codes, setCodes] = useState(initialCodes);

  const meterUsage = useMemo(() => new Map(meters.map((meter) => [meter.id, Math.max(0, meter.current - meter.previous)])), [meters]);
  const nodeUsage = useMemo(() => new Map(nodes.map((node) => {
    const plus = node.plus.reduce((sum, id) => sum + (meterUsage.get(id) ?? 0), 0);
    const minus = node.minus.reduce((sum, id) => sum + (meterUsage.get(id) ?? 0), 0);
    return [node.id, plus - minus];
  })), [meterUsage, nodes]);

  const results = useMemo(() => codes.map((code) => {
    const lines = edges.filter((edge) => edge.codeId === code.id).map((edge) => {
      const node = nodes.find((row) => row.id === edge.nodeId);
      const total = nodeUsage.get(edge.nodeId) ?? 0;
      const usage = edge.basis === 'direct' ? total : total * edge.ratio / 100;
      return { edge, nodeName: node?.name ?? '—', total, usage };
    });
    const rawUsage = lines.reduce((sum, line) => sum + line.usage, 0);
    const usage = code.roundingStage === 'usage' ? applyRounding(rawUsage, code.usageRoundingUnit, code.roundingMode) : rawUsage;
    const rawAmount = code.basicCharge + usage * code.unitPrice;
    const amount = code.roundingStage === 'amount' ? applyRounding(rawAmount, code.roundingUnit, code.roundingMode) : applyRounding(rawAmount, 1, code.roundingMode);
    return { code, lines, rawUsage, usage, rawAmount, amount };
  }), [codes, edges, nodeUsage, nodes]);

  // 配分に使った箱の量と、テナントへ配られた量が一致しているかを検算します。
  const usedNodeIds = [...new Set(edges.map((edge) => edge.nodeId))];
  const nodeTotal = usedNodeIds.reduce((sum, id) => sum + (nodeUsage.get(id) ?? 0), 0);
  const allocatedTotal = results.reduce((sum, result) => sum + result.rawUsage, 0);
  const unallocated = nodeTotal - allocatedTotal;
  const ratioCheck = usedNodeIds.map((id) => {
    const node = nodes.find((row) => row.id === id);
    const share = edges.filter((edge) => edge.nodeId === id).reduce((sum, edge) => sum + (edge.basis === 'direct' ? 100 : edge.ratio), 0);
    return { id, name: node?.name ?? '—', share };
  });

  const updateMeter = (id: string, key: 'previous' | 'current', value: number) => setMeters((current) => current.map((meter) => meter.id === id ? { ...meter, [key]: value } : meter));
  const updateEdge = (id: string, patch: Partial<Edge>) => setEdges((current) => current.map((edge) => edge.id === id ? { ...edge, ...patch } : edge));
  const updateCode = (id: string, patch: Partial<Code>) => setCodes((current) => current.map((code) => code.id === id ? { ...code, ...patch } : code));
  const addEdge = () => setEdges((current) => [...current, { id: `E${Date.now()}`, nodeId: nodes[0]?.id ?? '', codeId: codes[0]?.id ?? '', basis: 'ratio', ratio: 0 }]);
  const removeEdge = (id: string) => setEdges((current) => current.filter((edge) => edge.id !== id));
  const toggleNodeMember = (id: string, meterId: string, side: 'plus' | 'minus') => setNodes((current) => current.map((node) => {
    if (node.id !== id) return node;
    const members = node[side];
    const next = members.includes(meterId) ? members.filter((value) => value !== meterId) : [...members, meterId];
    return side === 'plus' ? { ...node, plus: next } : { ...node, minus: next };
  }));

  return <section className="meter-prototype">
    <header className="meter-prototype-heading">
      <div><p className="section-kicker">PROTOTYPE</p><h2>検針データ配賦の試作</h2><p>検針値を箱（ノード）へまとめ、線（配分）でテナントコードへ配る流れを試せます。保存はされません。</p></div>
    </header>

    <div className="meter-prototype-grid">
      <section className="meter-prototype-panel">
        <h3>1. 検針値</h3>
        <p className="meter-prototype-note">毎月入力するのはここだけです。</p>
        <table>
          <thead><tr><th>メーター</th><th>用途</th><th>前回指針</th><th>今回指針</th><th>使用量</th></tr></thead>
          <tbody>{meters.map((meter) => <tr key={meter.id}>
            <td>{meter.id}｜{meter.name}</td><td>{meter.kind}</td>
            <td><input type="number" value={meter.previous} onChange={(event) => updateMeter(meter.id, 'previous', Number(event.target.value))} /></td>
            <td><input type="number" value={meter.current} onChange={(event) => updateMeter(meter.id, 'current', Number(event.target.value))} /></td>
            <td className="numeric"><strong>{kwh.format(meterUsage.get(meter.id) ?? 0)}</strong> kWh</td>
          </tr>)}</tbody>
        </table>
      </section>

      <section className="meter-prototype-panel">
        <h3>2. 箱（ノード）</h3>
        <p className="meter-prototype-note">メーターを足したり、親から子を引いたりして、配る単位を作ります。ビルごとの違いはここで吸収します。</p>
        <table>
          <thead><tr><th>箱</th><th>種類</th><th>構成（＋で加算・−で減算）</th><th>使用量</th></tr></thead>
          <tbody>{nodes.map((node) => <tr key={node.id}>
            <td>{node.name}</td>
            <td>{node.kind === 'sum' ? '合算' : '差引'}</td>
            <td><div className="meter-prototype-members">{meters.map((meter) => <span key={meter.id}>
              <button type="button" className={node.plus.includes(meter.id) ? 'selected plus' : ''} onClick={() => toggleNodeMember(node.id, meter.id, 'plus')}>＋{meter.id}</button>
              <button type="button" className={node.minus.includes(meter.id) ? 'selected minus' : ''} onClick={() => toggleNodeMember(node.id, meter.id, 'minus')}>−{meter.id}</button>
            </span>)}</div></td>
            <td className="numeric"><strong>{kwh.format(nodeUsage.get(node.id) ?? 0)}</strong> kWh</td>
          </tr>)}</tbody>
        </table>
      </section>

      <section className="meter-prototype-panel">
        <h3>3. 配分（線）</h3>
        <p className="meter-prototype-note">箱からテナントコードへ配ります。直課は全量、按分は比率で分けます。</p>
        <table>
          <thead><tr><th>箱</th><th>配分先</th><th>方式</th><th>比率</th><th>配分量</th><th /></tr></thead>
          <tbody>{edges.map((edge) => {
            const total = nodeUsage.get(edge.nodeId) ?? 0;
            const usage = edge.basis === 'direct' ? total : total * edge.ratio / 100;
            return <tr key={edge.id}>
              <td><select value={edge.nodeId} onChange={(event) => updateEdge(edge.id, { nodeId: event.target.value })}>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></td>
              <td><select value={edge.codeId} onChange={(event) => updateEdge(edge.id, { codeId: event.target.value })}>{codes.map((code) => <option key={code.id} value={code.id}>{code.tenantName}（{code.issueCode}）</option>)}</select></td>
              <td><select value={edge.basis} onChange={(event) => updateEdge(edge.id, { basis: event.target.value as Edge['basis'] })}><option value="direct">直課</option><option value="ratio">按分</option></select></td>
              <td>{edge.basis === 'ratio' ? <span className="meter-prototype-ratio"><input type="number" value={edge.ratio} onChange={(event) => updateEdge(edge.id, { ratio: Number(event.target.value) })} />%</span> : <span className="meter-prototype-muted">全量</span>}</td>
              <td className="numeric">{kwh.format(usage)} kWh</td>
              <td><button type="button" className="meter-prototype-delete" onClick={() => removeEdge(edge.id)}>削除</button></td>
            </tr>;
          })}</tbody>
        </table>
        <button type="button" className="text-button" onClick={addEdge}>配分を追加</button>
      </section>

      <section className="meter-prototype-panel">
        <h3>4. テナントコードごとの単価と端数処理</h3>
        <p className="meter-prototype-note">単価も丸め方もコードごとに設定します。契約書の書き方に合わせて、丸める段階も選べます。</p>
        <table>
          <thead><tr><th>テナント</th><th>コード</th><th>基本料</th><th>従量単価</th><th>丸め方</th><th>丸め単位</th><th>丸める段階</th></tr></thead>
          <tbody>{codes.map((code) => <tr key={code.id}>
            <td>{code.tenantName}</td><td>{code.issueCode}</td>
            <td><input type="number" value={code.basicCharge} onChange={(event) => updateCode(code.id, { basicCharge: Number(event.target.value) })} /></td>
            <td><input type="number" step="0.01" value={code.unitPrice} onChange={(event) => updateCode(code.id, { unitPrice: Number(event.target.value) })} /></td>
            <td><select value={code.roundingMode} onChange={(event) => updateCode(code.id, { roundingMode: event.target.value as RoundingMode })}>{(['floor', 'ceil', 'round'] as RoundingMode[]).map((mode) => <option key={mode} value={mode}>{roundingModeLabel[mode]}</option>)}</select></td>
            <td><select value={code.roundingStage === 'usage' ? code.usageRoundingUnit : code.roundingUnit} onChange={(event) => updateCode(code.id, code.roundingStage === 'usage' ? { usageRoundingUnit: Number(event.target.value) } : { roundingUnit: Number(event.target.value) })}>{(code.roundingStage === 'usage' ? [0.1, 1, 10] : [1, 10, 100]).map((unit) => <option key={unit} value={unit}>{unit}{code.roundingStage === 'usage' ? ' kWh' : ' 円'}</option>)}</select></td>
            <td><select value={code.roundingStage} onChange={(event) => updateCode(code.id, { roundingStage: event.target.value as Code['roundingStage'] })}><option value="amount">金額を丸める</option><option value="usage">使用量を丸める</option></select></td>
          </tr>)}</tbody>
        </table>
      </section>
    </div>

    <section className="meter-prototype-panel meter-prototype-result">
      <h3>5. 請求額と内訳</h3>
      <div className="meter-prototype-results">{results.map((result) => <article key={result.code.id}>
        <header><strong>{result.code.tenantName}</strong><span>{result.code.issueCode}</span></header>
        <ul>
          {result.lines.map((line) => <li key={line.edge.id}><span>{line.nodeName}</span><span className="meter-prototype-muted">{kwh.format(line.total)} kWh × {line.edge.basis === 'direct' ? '全量' : `${line.edge.ratio}%`}</span><b>{kwh.format(line.usage)} kWh</b></li>)}
          {!result.lines.length && <li className="meter-prototype-muted">配分がありません。</li>}
        </ul>
        <dl>
          <div><dt>使用量</dt><dd>{kwh.format(result.usage)} kWh{result.code.roundingStage === 'usage' && result.usage !== result.rawUsage ? <small>（{kwh.format(result.rawUsage)} を{roundingModeLabel[result.code.roundingMode]}）</small> : null}</dd></div>
          <div><dt>計算</dt><dd>{yen.format(result.code.basicCharge)} ＋ {kwh.format(result.usage)} × {result.code.unitPrice} ＝ {result.rawAmount.toFixed(2)}</dd></div>
          <div className="meter-prototype-total"><dt>請求額</dt><dd>{yen.format(result.amount)} 円<small>（{roundingModeLabel[result.code.roundingMode]}・{result.code.roundingStage === 'amount' ? `${result.code.roundingUnit}円単位` : '使用量で調整'}）</small></dd></div>
        </dl>
      </article>)}</div>
    </section>

    <section className="meter-prototype-panel meter-prototype-check">
      <h3>6. 検算</h3>
      <ul className="meter-prototype-check-list">
        <li>配分対象の箱の合計：<strong>{kwh.format(nodeTotal)} kWh</strong></li>
        <li>テナントへ配分した合計：<strong>{kwh.format(allocatedTotal)} kWh</strong></li>
        <li className={Math.abs(unallocated) < 0.001 ? 'ok' : 'warn'}>未配分：<strong>{kwh.format(unallocated)} kWh</strong>{Math.abs(unallocated) < 0.001 ? '（一致）' : '（配分比率を確認してください）'}</li>
      </ul>
      <table>
        <thead><tr><th>箱</th><th>配分比率の合計</th><th>判定</th></tr></thead>
        <tbody>{ratioCheck.map((row) => <tr key={row.id}><td>{row.name}</td><td className="numeric">{row.share}%</td><td className={row.share === 100 ? 'ok' : 'warn'}>{row.share === 100 ? '一致' : row.share > 100 ? '配りすぎ' : '配り残し'}</td></tr>)}</tbody>
      </table>
    </section>
  </section>;
}
