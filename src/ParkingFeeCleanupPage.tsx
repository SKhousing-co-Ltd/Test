import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from './lib/supabase';
import './ParkingFeeCleanupPage.css';

type Role = 'admin' | 'manager' | 'staff' | 'viewer';
type Request = { change_request_id: string; row_version: number; proposed_payload: Record<string, unknown> | null; items: { entity_id: string | null }[] | null };
type Unit = { lease_contract_unit_id: string; lease_start_date: string | null; lease_end_date: string | null; unit: { unit_code: string; unit_name: string | null; unit_type: string; property_id: string; asset: { asset_name: string } | null } | null; contract: { contract_status: string; contract_start_date: string | null; tenant: { tenant_name: string } | null } | null };
type Row = { requestId: string; rowVersion: number; unitId: string; propertyId: string; property: string; tenant: string; space: string; start: string | null; end: string | null; eligible: boolean; status: string };
type Failure = Pick<Row, 'requestId' | 'property' | 'tenant' | 'space'> & { message: string };
const today = new Date().toISOString().slice(0, 10);

const text = (payload: Record<string, unknown> | null, name: string) => typeof payload?.[name] === 'string' && payload[name].trim() ? payload[name] as string : null;

export function ParkingFeeCleanupPage({ role }: { role: Role }) {
  const allowed = role === 'admin' || role === 'manager';
  const [rows, setRows] = useState<Row[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [propertyFilter, setPropertyFilter] = useState('all');
  const [bulkAmount, setBulkAmount] = useState('');
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ success: number; failures: Failure[] } | null>(null);

  const load = useCallback(async () => {
    if (!supabase || !allowed) return;
    setLoading(true); setError('');
    const { data: requestData, error: requestError } = await supabase.from('change_request').select('change_request_id, row_version, proposed_payload, items:change_request_item!inner(entity_id)').eq('request_type', 'parking_fee_setup').in('status', ['open', 'in_review', 'on_hold']);
    if (requestError) { setError(`対応依頼を読み込めませんでした: ${requestError.message}`); setLoading(false); return; }
    const byUnit = new Map<string, Request>();
    for (const request of (requestData ?? []) as unknown as Request[]) { const id = text(request.proposed_payload, 'parking_lease_contract_unit_id') ?? request.items?.[0]?.entity_id; if (id && !byUnit.has(id)) byUnit.set(id, request); }
    const ids = [...byUnit.keys()];
    if (!ids.length) { setRows([]); setSelected(new Set()); setLoading(false); return; }
    const [unitResult, feeResult] = await Promise.all([
      supabase.from('lease_contract_unit').select('lease_contract_unit_id, lease_start_date, lease_end_date, unit:unit_master(unit_code, unit_name, unit_type, property_id, asset:asset_master(asset_name)), contract:lease_contract(contract_status, contract_start_date, tenant:tenant_master(tenant_name))').in('lease_contract_unit_id', ids),
      supabase.from('parking_fee_history').select('parking_lease_contract_unit_id').in('parking_lease_contract_unit_id', ids).lte('effective_from', today).or(`effective_to.is.null,effective_to.gte.${today}`),
    ]);
    const loadError = unitResult.error ?? feeResult.error;
    if (loadError) { setError(`正本データを読み込めませんでした: ${loadError.message}`); setLoading(false); return; }
    const hasFee = new Set((feeResult.data ?? []).map((fee) => fee.parking_lease_contract_unit_id));
    const unitById = new Map(((unitResult.data ?? []) as unknown as Unit[]).map((unit) => [unit.lease_contract_unit_id, unit]));
    const next: Row[] = [];
    for (const [unitId, request] of byUnit) {
      const unit = unitById.get(unitId);
      if (!unit || unit.unit?.unit_type !== 'parking' || unit.contract?.contract_status !== 'active' || hasFee.has(unitId)) continue;
      const scope = text(request.proposed_payload, 'parking_scope'); const start = unit.lease_start_date ?? unit.contract?.contract_start_date ?? null; const end = unit.lease_end_date;
      const eligible = scope === 'external' && Boolean(start && end);
      next.push({ requestId: request.change_request_id, rowVersion: request.row_version, unitId, propertyId: unit.unit?.property_id ?? '', property: unit.unit?.asset?.asset_name ?? '物件未設定', tenant: unit.contract?.tenant?.tenant_name ?? 'テナント未設定', space: unit.unit?.unit_name ? `${unit.unit.unit_code} ${unit.unit.unit_name}` : unit.unit?.unit_code ?? '区画未設定', start, end, eligible, status: scope === 'internal' ? '内部契約のため個別処理' : !scope ? '契約区分を確認してください' : !start ? '契約開始日を確認してください' : !end ? '契約終了日を確認してください' : '一括確定可能' });
    }
    next.sort((a, b) => `${a.property}${a.space}`.localeCompare(`${b.property}${b.space}`, 'ja-JP', { numeric: true }));
    setRows(next); setSelected((current) => new Set([...current].filter((id) => next.some((row) => row.requestId === id && row.eligible)))); setLoading(false);
  }, [allowed]);
  useEffect(() => { void load(); }, [load]);

  const properties = useMemo(() => [...new Map(rows.map((row) => [row.propertyId, row.property])).entries()], [rows]);
  const visible = rows.filter((row) => propertyFilter === 'all' || row.propertyId === propertyFilter);
  const selectedRows = visible.filter((row) => selected.has(row.requestId));
  const selectable = visible.filter((row) => row.eligible);
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const applyBulk = () => { const amount = Number(bulkAmount); if (!bulkAmount.trim() || !Number.isSafeInteger(amount) || amount < 0) { setError('一括反映する料金は0以上の整数で入力してください。'); return; } setAmounts((current) => ({ ...current, ...Object.fromEntries(selectedRows.map((row) => [row.requestId, String(amount)])) })); setError(''); };
  const confirm = async () => {
    if (!supabase || !selectedRows.length) return;
    const invalid = selectedRows.find((row) => !amounts[row.requestId]?.trim() || !Number.isSafeInteger(Number(amounts[row.requestId])) || Number(amounts[row.requestId]) < 0);
    if (invalid) { setError(`${invalid.property} / ${invalid.space} の料金を0以上の整数で入力してください。`); return; }
    if (!window.confirm(`${selectedRows.length}件を既存の確定処理で順次反映します。よろしいですか？`)) return;
    setProcessing(true); setError(''); setResult(null); let success = 0; const failures: Failure[] = [];
    for (const row of selectedRows) {
      const { data, error: rpcError } = await supabase.rpc('apply_parking_fee_change_request', { p_change_request_id: row.requestId, p_expected_row_version: row.rowVersion, p_monthly_parking_fee: Number(amounts[row.requestId]), p_effective_from: row.start!, p_parking_contract_end_date: row.end!, p_main_lease_contract_unit_id: null });
      const applied = (Array.isArray(data) ? data[0] : data) as { status?: string } | null;
      if (rpcError) failures.push({ ...row, message: rpcError.message }); else if (applied?.status !== 'applied') failures.push({ ...row, message: '確定済みへの更新を確認できませんでした。' }); else success += 1;
    }
    setProcessing(false); setResult({ success, failures }); await load();
  };
  if (!allowed) return <section className="parking-fee-cleanup"><div className="panel parking-fee-cleanup-empty"><h2>駐車料金一括整備</h2><p>この一時管理ページは管理者またはマネージャーだけが利用できます。</p></div></section>;
  return <section className="parking-fee-cleanup"><header className="page-header"><div><p className="eyebrow">TEMPORARY DATA CLEANUP</p><h2>駐車料金一括整備</h2><p>終了日が登録済みの外部駐車場契約だけを、既存の確定処理で順次反映します。</p></div><button className="secondary-button" onClick={() => void load()} disabled={loading || processing}>再読み込み</button></header><section className="panel parking-fee-cleanup-panel"><div className="parking-fee-cleanup-tools"><label>ビル<select value={propertyFilter} onChange={(event) => setPropertyFilter(event.target.value)}><option value="all">すべてのビル</option>{properties.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label>選択行へ同額反映<input type="number" min="0" step="1" value={bulkAmount} onChange={(event) => setBulkAmount(event.target.value)} placeholder="例: 30000" /></label><button className="secondary-button" onClick={applyBulk} disabled={!selectedRows.length || processing}>料金を反映</button><button className="primary-button" onClick={() => void confirm()} disabled={!selectedRows.length || processing}>{processing ? '確定中…' : `選択した${selectedRows.length}件を一括確定`}</button></div>{error ? <p className="parking-fee-cleanup-message error">{error}</p> : null}{result ? <section className="parking-fee-cleanup-result"><strong>成功：{result.success}件　失敗：{result.failures.length}件</strong>{result.failures.length ? <ul>{result.failures.map((failure) => <li key={failure.requestId}>{failure.property} / {failure.tenant} / {failure.space}：{failure.message}</li>)}</ul> : null}</section> : null}<div className="table-scroll"><table className="parking-fee-cleanup-table"><thead><tr><th><input type="checkbox" aria-label="表示中の選択可能案件をすべて選択" checked={selectable.length > 0 && selectable.every((row) => selected.has(row.requestId))} onChange={(event) => setSelected((current) => { const next = new Set(current); selectable.forEach((row) => event.target.checked ? next.add(row.requestId) : next.delete(row.requestId)); return next; })} /></th><th>ビル</th><th>テナント</th><th>駐車場区画</th><th>区画種別</th><th>契約開始日</th><th>契約終了日</th><th>現在料金</th><th>設定料金</th><th>状態</th></tr></thead><tbody>{loading ? <tr><td colSpan={10} className="parking-fee-cleanup-empty">読み込み中です…</td></tr> : visible.length ? visible.map((row) => <tr key={row.requestId}><td><input type="checkbox" checked={selected.has(row.requestId)} disabled={!row.eligible || processing} onChange={() => toggle(row.requestId)} /></td><td>{row.property}</td><td>{row.tenant}</td><td>{row.space}</td><td>駐車場</td><td>{row.start ?? '—'}</td><td>{row.end ?? '—'}</td><td>未設定</td><td><input type="number" min="0" step="1" value={amounts[row.requestId] ?? ''} disabled={!row.eligible || processing} onChange={(event) => setAmounts((current) => ({ ...current, [row.requestId]: event.target.value }))} placeholder="円" /></td><td>{row.eligible ? <span className="parking-fee-cleanup-status ready">{row.status}</span> : <span className="parking-fee-cleanup-status review">{row.status}<Link to={`/change-requests?parking=${encodeURIComponent(row.unitId)}`}>個別処理を開く</Link></span>}</td></tr>) : <tr><td colSpan={10} className="parking-fee-cleanup-empty">現在の正本データで料金設定が必要な案件はありません。</td></tr>}</tbody></table></div></section></section>;
}
