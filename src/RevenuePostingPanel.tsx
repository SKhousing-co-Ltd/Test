import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Encoding from 'encoding-japanese';
import { supabase } from './lib/supabase';
import type { BillingPeriod } from './TenantBillingControls';
import { loadSavedInvoiceSheet, type InvoiceRow, type InvoiceSheet } from './utils/invoiceSheet';
import { buildRevenueEntries, renderRevenueCsv, type JournalEntry, type PostingSource, type RevenueAccount } from './utils/revenuePostingCsv';
import './RevenuePostingPanel.css';

type Candidate = PostingSource & { label: string };
type Confirmed = { id: string; source_kind: string; source_key: string; billing_month: string; confirmed_at: string; version: number; released_at: string | null; invoice_snapshot: { label?: string } | null };
type Batch = { id: string; created_at: string };
const keyOf = (source: { sourceKind: string; sourceKey: string }) => `${source.sourceKind}:${source.sourceKey}`;
const issuedOn = (timestamp: string | undefined) => timestamp && !Number.isNaN(Date.parse(timestamp)) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp)) : '';
const download = (bytes: number[], fileName: string) => {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'text/csv;charset=shift_jis' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const encode = (csv: string) => Encoding.convert(Encoding.stringToCode(csv), { to: 'SJIS', from: 'UNICODE', type: 'array', fallback: 'error' }) as number[];

export function RevenuePostingPanel({ propertyId, propertyName, period }: { propertyId: string; propertyName: string; period: BillingPeriod }) {
  const year = period.fiscalYear + (period.month <= 3 ? 1 : 0);
  const billingMonth = `${year}-${String(period.month).padStart(2, '0')}-01`;
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [confirmed, setConfirmed] = useState<Confirmed[]>([]);
  const [accounts, setAccounts] = useState<RevenueAccount[]>([]);
  const [dueEntries, setDueEntries] = useState<JournalEntry[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = async () => {
    if (!supabase || !propertyId) return;
    const client = supabase;
    setLoading(true); setError('');
    try {
      const [saved, allSheets, asset, types, sources, dueResult, batchResult] = await Promise.all([
        loadSavedInvoiceSheet(client, propertyId, year, period.month),
        client.from('tenant_invoice_sheet').select('sheet,billing_month').eq('asset_id', propertyId).order('billing_month', { ascending: false }),
        client.from('asset_master').select('asset_code').eq('asset_id', propertyId).single(),
        client.from('billing_charge_type').select('charge_type_name,is_fixed_charge,revenue_account_code,revenue_subaccount_code').eq('is_active', true),
        client.from('revenue_posting_source').select('id,source_kind,source_key,billing_month,confirmed_at,version,released_at,invoice_snapshot').eq('asset_id', propertyId).eq('billing_month', billingMonth).order('confirmed_at', { ascending: false }),
        client.rpc('list_due_revenue_posting_entries', { p_asset_id: propertyId, p_billing_month: billingMonth }),
        client.from('revenue_posting_batch').select('id,created_at').eq('asset_id', propertyId).eq('billing_month', billingMonth).order('created_at', { ascending: false }).limit(20),
      ]);
      if (allSheets.error || asset.error || types.error || sources.error || dueResult.error || batchResult.error) throw new Error(allSheets.error?.message ?? asset.error?.message ?? types.error?.message ?? sources.error?.message ?? dueResult.error?.message ?? batchResult.error?.message ?? '読み込みに失敗しました。');
      const active = ((sources.data ?? []) as Confirmed[]).filter((row) => !row.released_at);
      const activeKeys = new Set(active.map((row) => `${row.source_kind}:${row.source_key}`));
      const propertyCode = String(asset.data?.asset_code ?? '');
      const next: Candidate[] = [];
      if (saved) {
        const sheet = saved.sheet;
        const grouped = new Map<string, InvoiceRow[]>();
        for (const row of sheet.rows) if (sheet.invoiceStatuses?.[row.invoiceKey]?.state === 'issued') grouped.set(row.invoiceKey, [...(grouped.get(row.invoiceKey) ?? []), row]);
        for (const [sourceKey, rows] of grouped) next.push({ sourceKind: 'monthly', sourceKey, rows, sheet, billingMonth, issuedOn: issuedOn(sheet.invoiceStatuses?.[sourceKey]?.issuedAt), propertyCode, propertyName, label: `${rows[0].values[1]} ${rows[0].values[2] || rows[0].tenantName}` });
      }
      const seenSpots = new Set<string>();
      for (const record of allSheets.data ?? []) {
        const sheet = record.sheet as InvoiceSheet;
        for (const spot of sheet.spotInvoices ?? []) {
          if (spot.postingMonth !== billingMonth || spot.state !== 'issued' || seenSpots.has(spot.id)) continue;
          seenSpots.add(spot.id);
          next.push({ sourceKind: 'spot', sourceKey: spot.id, rows: spot.rows, sheet, billingMonth, issuedOn: issuedOn(spot.issuedAt), propertyCode, propertyName, label: `${spot.rows[0]?.values[1] ?? ''} ${spot.rows[0]?.values[2] || spot.rows[0]?.tenantName || 'スポット'}` });
        }
      }
      const due = ((dueResult.data ?? []) as Array<{ postingMonth: string; cells: string[] }>).map((entry) => ({ ...entry, immediate: false }));
      setCandidates(next.filter((source) => !activeKeys.has(keyOf(source))));
      setConfirmed((sources.data ?? []) as Confirmed[]);
      setAccounts((types.data ?? []) as RevenueAccount[]);
      setDueEntries(due);
      setBatches((batchResult.data ?? []) as Batch[]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '売上計上データを読み込めませんでした。'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [propertyId, billingMonth]);
  const exportCsv = async () => {
    if (!supabase || busy || (!candidates.length && !dueEntries.length)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const payload = candidates.map((source) => ({ sourceKind: source.sourceKind, sourceKey: source.sourceKey, snapshot: { label: source.label, rows: source.rows, billingMonth: source.billingMonth, issuedOn: source.issuedOn, propertyCode: source.propertyCode, accounts }, entries: buildRevenueEntries(source, accounts) }));
      // Confirm encoding before committing the export so an unsupported character cannot strand a confirmed batch.
      encode(renderRevenueCsv([...dueEntries, ...payload.flatMap((source) => source.entries.filter((entry) => entry.immediate))]));
      const { data, error: rpcError } = await supabase.rpc('confirm_revenue_posting_export', { p_asset_id: propertyId, p_billing_month: billingMonth, p_sources: payload });
      if (rpcError) throw rpcError;
      const result = data as { batchId: string; sourceCount: number; rows: string[][] };
      const csv = renderRevenueCsv(result.rows.map((cells) => ({ postingMonth: '', immediate: true, cells })));
      download(encode(csv), `売上計上_${propertyName.replace(/[\\/:*?"<>|]/g, '_')}_${year}${String(period.month).padStart(2, '0')}_${result.batchId.slice(0, 8)}.csv`);
      setNotice(`${result.sourceCount}件の請求明細を確定し、${result.rows.length}行の仕訳を出力しました。`);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'CSVを出力できませんでした。'); }
    finally { setBusy(false); }
  };
  const release = async (source: Confirmed) => {
    if (!supabase || busy || !window.confirm('確定を解除しますか？ 既に出力した仕訳をミロク側で取消・差替えしないまま再出力すると、二重計上になります。')) return;
    setBusy(true); setError(''); setNotice('');
    const { data, error: releaseError } = await supabase.rpc('release_revenue_posting_source', { p_source_id: source.id });
    if (releaseError || !data) setError(releaseError?.message ?? '確定を解除できませんでした。');
    else { setNotice('確定を解除しました。ミロク側の仕訳を取消・差替えしてから再出力してください。'); await load(); }
    setBusy(false);
  };
  const redownload = async (batch: Batch) => {
    if (!supabase || busy || !window.confirm('この CSV は確定時に出力済みです。ミロクへ再取込すると二重計上になる可能性があります。ファイルだけ再取得しますか？')) return;
    setBusy(true); setError('');
    const { data, error: rowsError } = await supabase.from('revenue_posting_entry').select('csv_cells,sort_order,source:revenue_posting_source!inner(billing_month,source_key)').eq('exported_batch_id', batch.id);
    if (rowsError) setError(rowsError.message);
    else if (!data?.length) setError('この出力履歴に仕訳行がありません。');
    else try {
      const sorted = (data as unknown as Array<{ csv_cells: string[]; sort_order: number; source: { billing_month: string; source_key: string } }>).sort((a, b) => a.source.billing_month.localeCompare(b.source.billing_month) || a.source.source_key.localeCompare(b.source.source_key) || a.sort_order - b.sort_order);
      const csv = renderRevenueCsv(sorted.map((row) => ({ postingMonth: '', immediate: true, cells: row.csv_cells })));
      download(encode(csv), `売上計上_再取得_${propertyName.replace(/[\\/:*?"<>|]/g, '_')}_${year}${String(period.month).padStart(2, '0')}_${batch.id.slice(0, 8)}.csv`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '再取得できませんでした。'); }
    setBusy(false);
  };
  const monthConfirmed = confirmed.filter((row) => row.billing_month === billingMonth && !row.released_at);
  const toolbar = document.getElementById('revenue-posting-toolbar');
  return <>{toolbar && createPortal(<button className="revenue-posting-export-button" type="button" disabled={loading || busy || (!candidates.length && !dueEntries.length)} onClick={() => void exportCsv()}>{busy ? '処理中…' : '未確定分を確定して CSV 出力'}</button>, toolbar)}<section className="revenue-posting-panel">
    {error && <p role="alert" className="revenue-posting-error">{error}</p>}{notice && <p role="status" className="revenue-posting-notice">{notice}</p>}
    {monthConfirmed.length > 0 && <details><summary>確定済みの請求明細（{monthConfirmed.length}件）</summary><ul>{monthConfirmed.map((source) => <li key={source.id}><span>{source.source_kind === 'spot' ? 'スポット' : '月次'}・{source.invoice_snapshot?.label || source.source_key.slice(0, 18)}・第{source.version}版</span><button type="button" disabled={busy} onClick={() => void release(source)}>確定解除</button></li>)}</ul></details>}
    {batches.length > 0 && <details><summary>CSV 出力履歴（{batches.length}件）</summary><ul>{batches.map((batch) => <li key={batch.id}><span>{new Date(batch.created_at).toLocaleString('ja-JP')}・{batch.id.slice(0, 8)}</span><button type="button" disabled={busy} onClick={() => void redownload(batch)}>再取得</button></li>)}</ul></details>}
  </section></>;
}
