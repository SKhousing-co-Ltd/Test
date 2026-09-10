import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from './lib/supabase';
import './ParkingFeeCleanupPage.css';

type Role = 'admin' | 'manager' | 'staff' | 'viewer';
type Request = { change_request_id: string; row_version: number; proposed_payload: Record<string, unknown> | null; items: { entity_id: string | null }[] | null };
type ParkingCurrent = { property_id: string; property_name: string; lease_contract_unit_id: string | null; contract_status: string | null; contract_start_date: string | null; contract_end_date: string | null; tenant_name: string | null; parking_scope: string | null; space_number: string; parking_type_name: string | null; monthly_parking_fee: number; parking_fee_effective_from: string | null };
type MainContractCandidate = { lease_contract_unit_id: string; unit_code: string; unit_name: string | null; lease_start_date: string | null; lease_end_date: string | null };
type Row = { requestId: string; rowVersion: number; unitId: string; propertyId: string; property: string; tenant: string; space: string; start: string | null; end: string | null; eligible: boolean; status: string; parkingScope: string | null; mainContractCandidates: MainContractCandidate[] };
type Failure = Pick<Row, 'requestId' | 'property' | 'tenant' | 'space'> & { message: string };
const today = new Date().toISOString().slice(0, 10);

const text = (payload: Record<string, unknown> | null, name: string) => typeof payload?.[name] === 'string' && payload[name].trim() ? payload[name] as string : null;

export function ParkingFeeCleanupPage({ role }: { role: Role }) {
  const allowed = role === 'admin' || role === 'manager';
  const [rows, setRows] = useState<Row[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [endDates, setEndDates] = useState<Record<string, string>>({});
  const [mainContractUnitIds, setMainContractUnitIds] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [propertyFilter, setPropertyFilter] = useState('all');
  const [bulkAmount, setBulkAmount] = useState('');
  const [bulkEndDate, setBulkEndDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ success: number; failures: Failure[] } | null>(null);

  const load = useCallback(async () => {
    if (!supabase || !allowed) return;
    const client = supabase;
    setLoading(true); setError('');
    const { data: requestData, error: requestError } = await supabase.from('change_request').select('change_request_id, row_version, proposed_payload, items:change_request_item!inner(entity_id)').eq('request_type', 'parking_fee_setup').in('status', ['open', 'in_review', 'on_hold']);
    if (requestError) { setError(`対応依頼を読み込めませんでした: ${requestError.message}`); setLoading(false); return; }
    const byUnit = new Map<string, Request>();
    for (const request of (requestData ?? []) as unknown as Request[]) { const id = text(request.proposed_payload, 'parking_lease_contract_unit_id') ?? request.items?.[0]?.entity_id; if (id && !byUnit.has(id)) byUnit.set(id, request); }
    if (!byUnit.size) { setRows([]); setSelected(new Set()); setLoading(false); return; }
    const propertyIds = [...new Set([...byUnit.values()].map((request) => text(request.proposed_payload, 'property_id')).filter((id): id is string => Boolean(id)))];
    const listResults = await Promise.all(propertyIds.map((propertyId) => client.rpc('parking_list_at_date', { p_property_id: propertyId, p_as_of_date: today })));
    const loadError = listResults.find((item) => item.error)?.error;
    if (loadError) { setError(`正本データを読み込めませんでした: ${loadError.message}`); setLoading(false); return; }
    const parkingByUnit = new Map<string, ParkingCurrent>();
    for (const result of listResults) for (const parking of (result.data ?? []) as unknown as ParkingCurrent[]) if (parking.lease_contract_unit_id) parkingByUnit.set(parking.lease_contract_unit_id, parking);
    const next: Row[] = [];
    for (const [unitId, request] of byUnit) {
      const parking = parkingByUnit.get(unitId);
      if (!parking || parking.contract_status !== 'active' || parking.parking_fee_effective_from) continue;
      const scope = text(request.proposed_payload, 'parking_scope') ?? parking.parking_scope;
      // parking_list_at_date は親契約の終了日を返す。複数区画契約では親契約が未確定でも、
      // 対応依頼の再評価時に保存された区画単位の期間は確定RPCへそのまま渡せる。
      const start = parking.contract_start_date ?? text(request.proposed_payload, 'contract_start_date');
      const end = parking.contract_end_date ?? text(request.proposed_payload, 'contract_end_date');
      const eligible = Boolean(scope && start);
      next.push({ requestId: request.change_request_id, rowVersion: request.row_version, unitId, propertyId: parking.property_id, property: parking.property_name, tenant: parking.tenant_name ?? 'テナント未設定', space: parking.space_number, start, end, eligible, parkingScope: scope, mainContractCandidates: [], status: !scope ? '契約区分を確認してください' : !start ? '契約開始日を確認してください' : !end ? '契約終了日を入力してください' : scope === 'internal' ? '主契約候補を読み込み中' : '一括確定可能' });
    }
    const candidateResults = await Promise.all(next.filter((row) => row.parkingScope === 'internal' && row.start && row.end).map(async (row) => ({ row, result: await client.rpc('list_parking_fee_main_contract_candidates', { p_parking_lease_contract_unit_id: row.unitId, p_effective_from: row.start!, p_parking_contract_end_date: row.end! }) })));
    const candidateError = candidateResults.find(({ result }) => result.error)?.result.error;
    if (candidateError) { setError(`主契約候補を読み込めませんでした: ${candidateError.message}`); setLoading(false); return; }
    for (const { row, result } of candidateResults) {
      row.mainContractCandidates = (result.data ?? []) as MainContractCandidate[];
      row.status = row.mainContractCandidates.length === 0 ? '主契約候補がありません' : row.mainContractCandidates.length === 1 ? '主契約を自動選択して確定' : '主契約を選択してください';
    }
    next.sort((a, b) => `${a.property}${a.space}`.localeCompare(`${b.property}${b.space}`, 'ja-JP', { numeric: true }));
    setRows(next);
    setMainContractUnitIds((current) => Object.fromEntries(next.map((row) => [row.requestId, row.parkingScope === 'internal' && row.mainContractCandidates.length === 1 ? row.mainContractCandidates[0].lease_contract_unit_id : current[row.requestId] ?? ''])));
    setSelected((current) => new Set([...current].filter((id) => next.some((row) => row.requestId === id && row.eligible)))); setLoading(false);
  }, [allowed]);
  useEffect(() => { void load(); }, [load]);

  const updateEndDate = async (row: Row, end: string) => {
    setEndDates((current) => ({ ...current, [row.requestId]: end }));
    if (row.parkingScope !== 'internal' || !row.start || !end || !supabase) return;
    const { data, error: candidateError } = await supabase.rpc('list_parking_fee_main_contract_candidates', { p_parking_lease_contract_unit_id: row.unitId, p_effective_from: row.start, p_parking_contract_end_date: end });
    if (candidateError) { setError(`主契約候補を読み込めませんでした: ${candidateError.message}`); return; }
    const candidates = (data ?? []) as MainContractCandidate[];
    setRows((current) => current.map((item) => item.requestId === row.requestId ? { ...item, mainContractCandidates: candidates, status: candidates.length === 0 ? '主契約候補がありません' : candidates.length === 1 ? '主契約を自動選択して確定' : '主契約を選択してください' } : item));
    setMainContractUnitIds((current) => ({ ...current, [row.requestId]: candidates.length === 1 ? candidates[0].lease_contract_unit_id : candidates.some((candidate) => candidate.lease_contract_unit_id === current[row.requestId]) ? current[row.requestId] : '' }));
  };

  const properties = useMemo(() => [...new Map(rows.map((row) => [row.propertyId, row.property])).entries()], [rows]);
  const visible = rows.filter((row) => propertyFilter === 'all' || row.propertyId === propertyFilter);
  const selectedRows = visible.filter((row) => selected.has(row.requestId));
  const selectable = visible.filter((row) => row.eligible);
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const applyBulk = () => { const amount = Number(bulkAmount); if (!bulkAmount.trim() || !Number.isSafeInteger(amount) || amount < 0) { setError('一括反映する料金は0以上の整数で入力してください。'); return; } setAmounts((current) => ({ ...current, ...Object.fromEntries(selectedRows.map((row) => [row.requestId, String(amount)])) })); setError(''); };
  const applyBulkEndDate = () => {
    if (!bulkEndDate) { setError('一括反映する契約終了日を入力してください。'); return; }
    const invalid = selectedRows.find((row) => bulkEndDate < row.start!);
    if (invalid) { setError(`${invalid.property} / ${invalid.space} の契約終了日は開始日以降で入力してください。`); return; }
    setEndDates((current) => ({ ...current, ...Object.fromEntries(selectedRows.map((row) => [row.requestId, bulkEndDate])) }));
    void Promise.all(selectedRows.map((row) => updateEndDate(row, bulkEndDate))); setError('');
  };
  const confirm = async () => {
    if (!supabase || !selectedRows.length) return;
    const invalidAmount = selectedRows.find((row) => !amounts[row.requestId]?.trim() || !Number.isSafeInteger(Number(amounts[row.requestId])) || Number(amounts[row.requestId]) < 0);
    if (invalidAmount) { setError(`${invalidAmount.property} / ${invalidAmount.space} の料金を0以上の整数で入力してください。`); return; }
    const invalidEnd = selectedRows.find((row) => { const end = endDates[row.requestId] ?? row.end; return !end || end < row.start!; });
    if (invalidEnd) { setError(`${invalidEnd.property} / ${invalidEnd.space} の契約終了日は開始日以降で入力してください。`); return; }
    const missingMainContract = selectedRows.find((row) => row.parkingScope === 'internal' && !mainContractUnitIds[row.requestId]);
    if (missingMainContract) { setError(`${missingMainContract.property} / ${missingMainContract.space} の主契約を選択してください。`); return; }
    if (!window.confirm(`${selectedRows.length}件を既存の確定処理で順次反映します。よろしいですか？`)) return;
    setProcessing(true); setError(''); setResult(null); let success = 0; const failures: Failure[] = [];
    for (const row of selectedRows) {
      // A preceding row can recheck related requests and advance their row_version.
      // Read the authoritative version immediately before each independent RPC call.
      const { data: latestRequest, error: latestError } = await supabase.from('change_request')
        .select('row_version, status').eq('change_request_id', row.requestId).maybeSingle();
      if (latestError) { failures.push({ ...row, message: `対応依頼を再確認できませんでした: ${latestError.message}` }); continue; }
      if (!latestRequest || !['open', 'in_review', 'on_hold'].includes(latestRequest.status)) { success += 1; continue; }
      const { data, error: rpcError } = await supabase.rpc('apply_parking_fee_change_request', { p_change_request_id: row.requestId, p_expected_row_version: latestRequest.row_version, p_monthly_parking_fee: Number(amounts[row.requestId]), p_effective_from: row.start!, p_parking_contract_end_date: endDates[row.requestId] ?? row.end!, p_main_lease_contract_unit_id: row.parkingScope === 'internal' ? mainContractUnitIds[row.requestId] : null });
      const applied = (Array.isArray(data) ? data[0] : data) as { status?: string } | null;
      if (rpcError) failures.push({ ...row, message: rpcError.message }); else if (applied?.status !== 'applied') failures.push({ ...row, message: '確定済みへの更新を確認できませんでした。' }); else success += 1;
    }
    setProcessing(false); setResult({ success, failures }); await load();
  };
  if (!allowed) return <section className="parking-fee-cleanup"><div className="panel parking-fee-cleanup-empty"><h2>駐車料金一括整備</h2><p>この一時管理ページは管理者またはマネージャーだけが利用できます。</p></div></section>;
  return <section className="parking-fee-cleanup"><header className="page-header"><div><p className="eyebrow">TEMPORARY DATA CLEANUP</p><h2>駐車料金一括整備</h2><p>月額料金と契約終了日を入力し、内部契約は主契約を選択して順次反映します。</p></div><button className="secondary-button" onClick={() => void load()} disabled={loading || processing}>再読み込み</button></header><section className="panel parking-fee-cleanup-panel"><div className="parking-fee-cleanup-tools"><label>ビル<select value={propertyFilter} onChange={(event) => setPropertyFilter(event.target.value)}><option value="all">すべてのビル</option>{properties.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label>選択行へ同額反映<input type="number" min="0" step="1" value={bulkAmount} onChange={(event) => setBulkAmount(event.target.value)} placeholder="例: 30000" /></label><button className="secondary-button" onClick={applyBulk} disabled={!selectedRows.length || processing}>料金を反映</button><label>選択行へ終了日反映<input type="date" value={bulkEndDate} onChange={(event) => setBulkEndDate(event.target.value)} /></label><button className="secondary-button" onClick={applyBulkEndDate} disabled={!selectedRows.length || processing}>終了日を反映</button><button className="primary-button" onClick={() => void confirm()} disabled={!selectedRows.length || processing}>{processing ? '確定中…' : `選択した${selectedRows.length}件を一括確定`}</button></div>{error ? <p className="parking-fee-cleanup-message error">{error}</p> : null}{result ? <section className="parking-fee-cleanup-result"><strong>成功：{result.success}件　失敗：{result.failures.length}件</strong>{result.failures.length ? <ul>{result.failures.map((failure) => <li key={failure.requestId}>{failure.property} / {failure.tenant} / {failure.space}：{failure.message}</li>)}</ul> : null}</section> : null}<div className="table-scroll"><table className="parking-fee-cleanup-table"><thead><tr><th><input type="checkbox" aria-label="表示中の選択可能案件をすべて選択" checked={selectable.length > 0 && selectable.every((row) => selected.has(row.requestId))} onChange={(event) => setSelected((current) => { const next = new Set(current); selectable.forEach((row) => event.target.checked ? next.add(row.requestId) : next.delete(row.requestId)); return next; })} /></th><th>ビル</th><th>テナント</th><th>駐車場区画</th><th>区画種別</th><th>契約開始日</th><th>契約終了日</th><th>主契約（内部）</th><th>現在料金</th><th>設定料金</th><th>状態</th></tr></thead><tbody>{loading ? <tr><td colSpan={11} className="parking-fee-cleanup-empty">読み込み中です…</td></tr> : visible.length ? visible.map((row) => <tr key={row.requestId}><td><input type="checkbox" checked={selected.has(row.requestId)} disabled={!row.eligible || processing} onChange={() => toggle(row.requestId)} /></td><td>{row.property}</td><td>{row.tenant}</td><td>{row.space}</td><td>駐車場</td><td>{row.start ?? '—'}</td><td><input type="date" value={endDates[row.requestId] ?? row.end ?? ''} disabled={!row.eligible || processing} onChange={(event) => void updateEndDate(row, event.target.value)} /></td><td>{row.parkingScope === 'internal' ? <select className="parking-fee-main-contract" value={mainContractUnitIds[row.requestId] ?? ''} disabled={!row.eligible || processing || row.mainContractCandidates.length === 0} onChange={(event) => setMainContractUnitIds((current) => ({ ...current, [row.requestId]: event.target.value }))}><option value="">{row.mainContractCandidates.length > 1 ? '選択してください' : '候補なし'}</option>{row.mainContractCandidates.map((candidate) => <option key={candidate.lease_contract_unit_id} value={candidate.lease_contract_unit_id}>{candidate.unit_name || candidate.unit_code}（{candidate.lease_start_date ?? '開始日未設定'} ～ {candidate.lease_end_date ?? '継続中'}）</option>)}</select> : '—'}</td><td>未設定</td><td><input type="number" min="0" step="1" value={amounts[row.requestId] ?? ''} disabled={!row.eligible || processing} onChange={(event) => setAmounts((current) => ({ ...current, [row.requestId]: event.target.value }))} placeholder="円" /></td><td>{row.eligible ? <span className="parking-fee-cleanup-status ready">{row.status}</span> : <span className="parking-fee-cleanup-status review">{row.status}<Link to={`/change-requests?parking=${encodeURIComponent(row.unitId)}`}>個別処理を開く</Link></span>}</td></tr>) : <tr><td colSpan={11} className="parking-fee-cleanup-empty">現在の正本データで料金設定が必要な案件はありません。</td></tr>}</tbody></table></div></section></section>;
}
