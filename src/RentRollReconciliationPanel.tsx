import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import './RentRollReconciliationPanel.css';

type Batch = { rent_roll_import_batch_id: string; source_file_name: string; as_of_date: string; status: string; row_count: number; issue_count: number };
type Summary = { property_name?: string; source_rent: number; db_rent: number; source_common: number; db_common: number; source_parking: number; db_parking: number; source_other: number; db_other: number; source_total: number; db_total: number; difference: number; matched_count: number; needs_review_count: number; mismatch_count: number };
type ReportRow = Summary & { rent_roll_import_row_id: string; property_name: string; unit_code: string; tenant_name: string | null; source_sheet_name: string; source_row_number: number; reconciliation_status: 'matched' | 'needs_review' | 'mismatch'; match_note: string | null; rent_difference: number; common_difference: number; parking_difference: number; other_difference: number };
type Report = { batch: Batch; rows: ReportRow[]; properties: Summary[]; overall: Summary };

const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const count = new Intl.NumberFormat('ja-JP');

export function RentRollReconciliationPanel({ selectedPropertyName, canManage }: { selectedPropertyName?: string; canManage: boolean }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchId, setBatchId] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadReport = useCallback(async (nextBatchId: string) => {
    if (!supabase || !nextBatchId) { setReport(null); setLoading(false); return; }
    setLoading(true); setError('');
    const { data, error: loadError } = await supabase.rpc('rent_roll_reconciliation_report', { p_batch_id: nextBatchId, p_property_id: null });
    if (loadError) setError(`整合性レポートを取得できませんでした: ${loadError.message}`);
    else setReport(data as Report);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    void supabase.from('rent_roll_import_batch').select('rent_roll_import_batch_id, source_file_name, as_of_date, status, row_count, issue_count').order('as_of_date', { ascending: false }).order('created_at', { ascending: false }).limit(20)
      .then(({ data, error: batchError }) => {
        if (batchError) { setError(`比較バッチを取得できませんでした: ${batchError.message}`); setLoading(false); return; }
        const next = (data ?? []) as Batch[];
        setBatches(next); setBatchId(next[0]?.rent_roll_import_batch_id ?? '');
        void loadReport(next[0]?.rent_roll_import_batch_id ?? '');
      });
  }, [loadReport]);

  const recalculate = async () => {
    if (!supabase || !batchId) return;
    setLoading(true); setError('');
    const { error: matchError } = await supabase.rpc('match_rent_roll_import_batch', { p_batch_id: batchId });
    if (matchError) { setError(`照合を再実行できませんでした: ${matchError.message}`); setLoading(false); return; }
    await loadReport(batchId);
  };
  const discrepancies = useMemo(() => (report?.rows ?? []).filter((row) => row.reconciliation_status !== 'matched'), [report]);
  const selectedSummary = report?.properties.find((item) => item.property_name === selectedPropertyName);

  return <section className="reconciliation-panel">
    <header><div><p className="section-kicker">RECONCILIATION</p><h3>旧レントロールとの整合性確認</h3><p>正本を更新せず、賃料・共益費・駐車場代・その他を独立して比較します。</p></div><div className="reconciliation-actions"><select value={batchId} onChange={(event) => { setBatchId(event.target.value); void loadReport(event.target.value); }}>{batches.map((batch) => <option key={batch.rent_roll_import_batch_id} value={batch.rent_roll_import_batch_id}>{batch.as_of_date}｜{batch.source_file_name}</option>)}</select>{canManage && <button type="button" className="secondary-button" disabled={!batchId || loading} onClick={() => void recalculate()}>再照合</button>}</div></header>
    {error && <p className="reconciliation-error">{error}</p>}
    {!loading && batches.length === 0 && <p className="reconciliation-empty">比較元のレントロールがまだ登録されていません。</p>}
    {loading && <p className="reconciliation-empty">整合性を集計しています。</p>}
    {report && !loading && <>
      <div className="reconciliation-metrics"><div><span>全体差額</span><strong>{yen.format(report.overall.difference ?? 0)}</strong></div><div><span>一致</span><strong>{count.format(report.overall.matched_count ?? 0)}件</strong></div><div><span>差異</span><strong>{count.format(report.overall.mismatch_count ?? 0)}件</strong></div><div><span>要確認</span><strong>{count.format(report.overall.needs_review_count ?? 0)}件</strong></div>{selectedSummary && <div className="selected"><span>{selectedPropertyName} 差額</span><strong>{yen.format(selectedSummary.difference ?? 0)}</strong></div>}</div>
      <div className="reconciliation-table-wrap"><table><thead><tr><th>物件</th><th>旧RR合計</th><th>DB合計</th><th>差額</th><th>賃料差</th><th>共益費差</th><th>駐車場差</th><th>その他差</th><th>差異/要確認</th></tr></thead><tbody>{report.properties.map((item) => <tr key={item.property_name} className={item.property_name === selectedPropertyName ? 'selected' : ''}><td>{item.property_name}</td><td>{yen.format(item.source_total)}</td><td>{yen.format(item.db_total)}</td><td>{yen.format(item.difference)}</td><td>{yen.format(item.db_rent - item.source_rent)}</td><td>{yen.format(item.db_common - item.source_common)}</td><td>{yen.format(item.db_parking - item.source_parking)}</td><td>{yen.format(item.db_other - item.source_other)}</td><td>{item.mismatch_count}/{item.needs_review_count}</td></tr>)}</tbody></table></div>
      <details><summary>差異・要確認の明細（{discrepancies.length}件）</summary><div className="reconciliation-table-wrap"><table><thead><tr><th>物件</th><th>区画</th><th>テナント</th><th>状態</th><th>賃料差</th><th>共益費差</th><th>駐車場差</th><th>その他差</th><th>確認メモ</th></tr></thead><tbody>{discrepancies.map((row) => <tr key={row.rent_roll_import_row_id}><td>{row.property_name}</td><td>{row.unit_code}</td><td>{row.tenant_name || '—'}</td><td>{row.reconciliation_status === 'mismatch' ? '差異' : '要確認'}</td><td>{yen.format(row.rent_difference)}</td><td>{yen.format(row.common_difference)}</td><td>{yen.format(row.parking_difference)}</td><td>{yen.format(row.other_difference)}</td><td>{row.match_note || `${row.source_sheet_name} ${row.source_row_number}行`}</td></tr>)}</tbody></table></div></details>
    </>}
  </section>;
}
