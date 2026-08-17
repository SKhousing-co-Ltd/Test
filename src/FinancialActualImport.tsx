import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { supabase } from './lib/supabase';
import type { FinancialAccount, FinancialProperty } from './FinancialPage';

type ImportStatus = 'staged' | 'action_required' | 'ready' | 'applying' | 'applied' | 'failed';
type MatchStatus = 'action_required' | 'ready' | 'applied' | 'ignored';

type ImportBatch = {
  financial_actual_import_batch_id: string;
  source_file_name: string;
  status: ImportStatus;
  row_count: number;
  ready_count: number;
  issue_count: number;
  applied_count: number;
  error_message: string | null;
  created_at: string;
  applied_at: string | null;
};

type ImportRow = {
  financial_actual_import_row_id: string;
  source_row_number: number;
  property_code: string | null;
  property_name: string | null;
  account_id_text: string | null;
  account_name: string | null;
  accounting_month_text: string | null;
  entry_date_text: string | null;
  amount_text: string | null;
  description: string | null;
  matched_property_id: string | null;
  matched_account_id: string | null;
  match_status: MatchStatus;
  issues: string[];
};

const headers = ['物件コード', '物件名', '科目ID', '科目名', '計上月', '発生日', '金額', '内容', '相手先', '備考'] as const;
const statusLabels: Record<ImportStatus, string> = {
  staged: '取込中', action_required: '要確認', ready: '確定可能', applying: '確定中', applied: '確定済み', failed: '失敗',
};
const dateTime = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short' });

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field); field = '';
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else field += character;
  }
  if (quoted) throw new Error('CSVの引用符が閉じられていません。');
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function decodeCsv(buffer: ArrayBuffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return new TextDecoder('shift-jis').decode(buffer); }
}

async function sha256(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function downloadTemplate() {
  const sample = ['1001', '○○ビル', 'E01', '修繕費', '2026/07', '2026/07/31', '120000', '空調修理', '○○設備株式会社', '請求書No.123'];
  const blob = new Blob([`\uFEFF${headers.join(',')}\r\n${sample.join(',')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '月次実績取込テンプレート.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

export function FinancialActualImport({ properties, accounts }: { properties: FinancialProperty[]; accounts: FinancialAccount[] }) {
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [resolutions, setResolutions] = useState<Record<string, { propertyId: string; accountId: string }>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const selectedBatch = batches.find((batch) => batch.financial_actual_import_batch_id === selectedBatchId);
  const propertyNames = useMemo(() => new Map(properties.map((item) => [item.property_id, item.short_name || item.property_name])), [properties]);
  const accountNames = useMemo(() => new Map(accounts.map((item) => [item.account_id, item.account_name])), [accounts]);

  const loadBatches = useCallback(async (preferredId?: string) => {
    if (!supabase) return;
    const { data, error: queryError } = await supabase.from('financial_actual_import_batch').select('*').order('created_at', { ascending: false }).limit(30);
    if (queryError) { setError(queryError.message); return; }
    const next = (data ?? []) as ImportBatch[];
    setBatches(next);
    setSelectedBatchId((current) => preferredId || (next.some((batch) => batch.financial_actual_import_batch_id === current) ? current : next[0]?.financial_actual_import_batch_id || ''));
  }, []);

  const loadRows = useCallback(async (batchId: string) => {
    if (!supabase || !batchId) { setRows([]); return; }
    const { data, error: queryError } = await supabase.from('financial_actual_import_row').select('financial_actual_import_row_id, source_row_number, property_code, property_name, account_id_text, account_name, accounting_month_text, entry_date_text, amount_text, description, matched_property_id, matched_account_id, match_status, issues').eq('financial_actual_import_batch_id', batchId).order('source_row_number').limit(1000);
    if (queryError) { setError(queryError.message); return; }
    const next = (data ?? []) as ImportRow[];
    setRows(next);
    setResolutions(Object.fromEntries(next.map((item) => [item.financial_actual_import_row_id, {
      propertyId: item.matched_property_id ?? '', accountId: item.matched_account_id ?? '',
    }])));
  }, []);

  useEffect(() => { void loadBatches(); }, [loadBatches]);
  useEffect(() => { void loadRows(selectedBatchId); }, [loadRows, selectedBatchId]);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !supabase) return;
    setBusy(true); setError(''); setNotice('');
    let batchId = '';
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('CSVは10MB以下にしてください。');
      const buffer = await file.arrayBuffer();
      const parsed = parseCsv(decodeCsv(buffer));
      if (parsed.length < 2) throw new Error('ヘッダーと1行以上の実績データが必要です。');
      if (parsed.length - 1 > 5000) throw new Error('一度に取り込める明細は5,000行までです。');
      const actualHeaders = parsed[0].map((value) => value.trim());
      const indexes = Object.fromEntries(headers.map((header) => [header, actualHeaders.indexOf(header)])) as Record<(typeof headers)[number], number>;
      if (indexes.計上月 < 0 || indexes.金額 < 0 || indexes.内容 < 0) throw new Error('「計上月」「金額」「内容」列が必要です。');
      if (indexes.物件コード < 0 && indexes.物件名 < 0) throw new Error('「物件コード」または「物件名」列が必要です。');
      if (indexes.科目ID < 0 && indexes.科目名 < 0) throw new Error('「科目ID」または「科目名」列が必要です。');
      const value = (values: string[], header: (typeof headers)[number]) => indexes[header] < 0 ? null : values[indexes[header]]?.trim() || null;
      const { data: created, error: createError } = await supabase.from('financial_actual_import_batch').insert({
        source_file_name: file.name, source_file_size: file.size, source_sha256: await sha256(buffer),
      }).select('financial_actual_import_batch_id').single();
      if (createError) throw createError;
      batchId = created.financial_actual_import_batch_id;
      const payload = parsed.slice(1).map((values, index) => ({
        financial_actual_import_batch_id: batchId,
        source_row_number: index + 2,
        property_code: value(values, '物件コード'), property_name: value(values, '物件名'),
        account_id_text: value(values, '科目ID'), account_name: value(values, '科目名'),
        accounting_month_text: value(values, '計上月'), entry_date_text: value(values, '発生日'),
        amount_text: value(values, '金額'), description: value(values, '内容'),
        counterparty_name: value(values, '相手先'), notes: value(values, '備考'),
        raw_payload: Object.fromEntries(actualHeaders.map((header, column) => [header || `列${column + 1}`, values[column] ?? ''])),
      }));
      for (let offset = 0; offset < payload.length; offset += 500) {
        const { error: insertError } = await supabase.from('financial_actual_import_row').insert(payload.slice(offset, offset + 500));
        if (insertError) throw insertError;
      }
      const { error: refreshError } = await supabase.rpc('refresh_financial_actual_import_batch', { target_batch_id: batchId });
      if (refreshError) throw refreshError;
      await loadBatches(batchId);
      await loadRows(batchId);
      setNotice(`${payload.length.toLocaleString()}行を取り込みました。要確認行を解消してから確定してください。`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      if (batchId) await supabase.from('financial_actual_import_batch').update({ status: 'failed', error_message: message }).eq('financial_actual_import_batch_id', batchId);
      await loadBatches(batchId || undefined);
    } finally { setBusy(false); }
  };

  const resolve = async (row: ImportRow) => {
    if (!supabase) return;
    const resolution = resolutions[row.financial_actual_import_row_id];
    if (!resolution?.propertyId || !resolution.accountId) { setError('物件と科目を選択してください。'); return; }
    setBusy(true); setError(''); setNotice('');
    const { error: rpcError } = await supabase.rpc('resolve_financial_actual_import_row', {
      target_row_id: row.financial_actual_import_row_id,
      target_property_id: resolution.propertyId,
      target_account_id: resolution.accountId,
    });
    if (rpcError) setError(rpcError.message);
    else { await Promise.all([loadRows(selectedBatchId), loadBatches(selectedBatchId)]); setNotice(`${row.source_row_number}行目の照合先を保存しました。`); }
    setBusy(false);
  };

  const applyBatch = async () => {
    if (!supabase || !selectedBatch || !confirm(`${selectedBatch.row_count.toLocaleString()}行の月次実績を確定しますか？`)) return;
    setBusy(true); setError(''); setNotice('');
    const { data, error: rpcError } = await supabase.rpc('apply_financial_actual_import_batch', { target_batch_id: selectedBatch.financial_actual_import_batch_id });
    if (rpcError) setError(rpcError.message);
    else { await Promise.all([loadRows(selectedBatchId), loadBatches(selectedBatchId)]); setNotice(`${Number(data).toLocaleString()}行を月次実績へ反映しました。`); }
    setBusy(false);
  };

  return <section className="content">
    <div className="section-heading"><div><h2>月次実績CSV取込</h2><p>CSV原文、照合結果、確定先を行単位で保存し、同じ取込の二重計上を防止します。</p></div><div className="form-actions"><button type="button" onClick={downloadTemplate}>テンプレート</button><label className="primary-button">{busy ? '処理中…' : 'CSVを取り込む'}<input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={(event) => void upload(event)} /></label></div></div>
    {notice ? <p className="form-notice">{notice}</p> : null}
    {error ? <p className="notice">{error}</p> : null}
    <section className="panel"><h3>取込履歴</h3><div className="table-scroll"><table><thead><tr><th>取込日時</th><th>ファイル</th><th>状態</th><th>総数</th><th>確定可能</th><th>要確認</th><th>確定済み</th><th></th></tr></thead><tbody>{batches.map((batch) => <tr key={batch.financial_actual_import_batch_id}><td>{dateTime.format(new Date(batch.created_at))}</td><td><strong>{batch.source_file_name}</strong>{batch.error_message ? <small>{batch.error_message}</small> : null}</td><td><span className={`status-badge ${batch.status === 'applied' ? 'complete' : batch.status === 'ready' ? 'document' : batch.status === 'action_required' || batch.status === 'failed' ? 'review' : 'draft'}`}>{statusLabels[batch.status]}</span></td><td>{batch.row_count}</td><td>{batch.ready_count}</td><td>{batch.issue_count}</td><td>{batch.applied_count}</td><td><button className="link-button" onClick={() => setSelectedBatchId(batch.financial_actual_import_batch_id)}>明細</button></td></tr>)}{!batches.length ? <tr><td colSpan={8} className="empty">取込履歴はありません。</td></tr> : null}</tbody></table></div></section>
    {selectedBatch ? <section className="panel"><div className="section-heading"><div><h3>{selectedBatch.source_file_name}</h3><p>{selectedBatch.row_count > 1000 ? '先頭1,000行を表示しています。' : `${selectedBatch.row_count.toLocaleString()}行`}</p></div>{selectedBatch.status === 'ready' ? <button className="primary-button" disabled={busy} onClick={() => void applyBatch()}>月次実績へ確定</button> : null}</div><div className="table-scroll"><table><thead><tr><th>行</th><th>CSVの物件</th><th>CSVの科目</th><th>計上月</th><th>金額・内容</th><th>照合結果</th></tr></thead><tbody>{rows.map((row) => {
      const resolution = resolutions[row.financial_actual_import_row_id] ?? { propertyId: '', accountId: '' };
      return <tr key={row.financial_actual_import_row_id}><td>{row.source_row_number}</td><td>{row.property_code || '—'}<small>{row.property_name || ''}</small></td><td>{row.account_id_text || '—'}<small>{row.account_name || ''}</small></td><td>{row.accounting_month_text || '—'}<small>{row.entry_date_text || ''}</small></td><td>{row.amount_text || '—'}<small>{row.description || ''}</small></td><td>{row.match_status === 'action_required' ? <div className="inline-filter"><small>{row.issues.join('／')}</small><label>物件<select value={resolution.propertyId} onChange={(event) => setResolutions((current) => ({ ...current, [row.financial_actual_import_row_id]: { ...resolution, propertyId: event.target.value } }))}><option value="">選択</option>{properties.map((property) => <option key={property.property_id} value={property.property_id}>{property.short_name || property.property_name}</option>)}</select></label><label>科目<select value={resolution.accountId} onChange={(event) => setResolutions((current) => ({ ...current, [row.financial_actual_import_row_id]: { ...resolution, accountId: event.target.value } }))}><option value="">選択</option>{accounts.map((account) => <option key={account.account_id} value={account.account_id}>{account.account_id}｜{account.account_name}</option>)}</select></label><button disabled={busy} onClick={() => void resolve(row)}>保存</button></div> : <><span className={`status-badge ${row.match_status === 'applied' ? 'complete' : 'document'}`}>{row.match_status === 'applied' ? '確定済み' : '照合済み'}</span><small>{propertyNames.get(row.matched_property_id ?? '') || '—'}｜{accountNames.get(row.matched_account_id ?? '') || '—'}</small></>}</td></tr>;
    })}{!rows.length ? <tr><td colSpan={6} className="empty">明細はありません。</td></tr> : null}</tbody></table></div></section> : null}
  </section>;
}
