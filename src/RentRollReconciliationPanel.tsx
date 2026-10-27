import { useCallback, useEffect, useState } from 'react';
import type * as ExcelJS from 'exceljs';
import { supabase } from './lib/supabase';
import './RentRollReconciliationPanel.css';

type Batch = { rent_roll_import_batch_id: string; source_file_name: string; as_of_date: string; status: string; row_count: number; issue_count: number };
type Summary = { property_name?: string; source_rent: number; db_rent: number; source_common: number; db_common: number; source_parking: number; db_parking: number; source_other: number; db_other: number; source_total: number; db_total: number; difference: number; matched_count: number; needs_review_count: number; mismatch_count: number };
type ReportRow = Summary & { rent_roll_import_row_id: string; property_name: string; unit_code: string; tenant_name: string | null; source_sheet_name: string; source_row_number: number; reconciliation_status: 'matched' | 'needs_review' | 'mismatch'; match_note: string | null; rent_difference: number; common_difference: number; parking_difference: number; other_difference: number };
type Report = { batch: Batch; rows: ReportRow[]; properties: Summary[]; overall: Summary };
type ImportRow = {
  source_sheet_name: string; source_row_number: number; property_name: string; wing_code: string | null; floor_label: string | null;
  unit_code: string; unit_type: string; tenant_code: string | null; tenant_name: string | null; source_status: string; source_record_key: string;
  source_area_sqm: number | null; source_monthly_rent_amount: number | null; source_monthly_common_charge_amount: number | null;
  source_monthly_parking_amount: number | null; source_other_monthly_amount: number | null; source_monthly_total_amount: number | null;
  contract_start_date: string | null; contract_end_date: string | null; raw_payload: Record<string, unknown>;
};
type ParseIssue = { sheet: string; row: number | null; message: string; blocking: boolean };
type ImportPreview = { fileName: string; hash: string; rows: ImportRow[]; issues: ParseIssue[]; asOfDate: string };

const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const count = new Intl.NumberFormat('ja-JP');
const propertyAliases: Record<string, string> = { '三共郡山ビル北館': '三共ビル郡山北館', '三共郡山ビル南館': '三共ビル郡山南館' };
const normalize = (value: unknown) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const identifier = (value: unknown) => normalize(value).replace(/\s+/g, '').replace(/～/g, '〜');
const numeric = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object' && 'result' in value) return numeric((value as { result?: unknown }).result);
  const text = normalize(value).replace(/[¥￥,]/g, '');
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
};
const cellText = (sheet: ExcelJS.Worksheet, row: number, column: number | null) => column ? normalize(sheet.getCell(row, column).value) : '';
const cellNumber = (sheet: ExcelJS.Worksheet, row: number, column: number | null) => column ? numeric(sheet.getCell(row, column).value) : null;
const isoDate = (value: unknown): string | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const text = normalize(value);
  const match = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : null;
};
const inferUnitType = (unit: string) => /駐輪|自転車|バイク/.test(unit) ? 'bicycle_parking' : /駐車|車庫|パーキング/.test(unit) ? 'parking' : /看板|サイン/.test(unit) ? 'signage' : /アンテナ|基地局/.test(unit) ? 'antenna' : unit.includes('倉庫') ? 'warehouse' : /住居|住宅|居室/.test(unit) ? 'residential' : /ATM|機械/.test(unit) ? 'other' : 'office';
const sha256 = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((byte) => byte.toString(16).padStart(2, '0')).join('');

function parseUploadedWorkbook(book: ExcelJS.Workbook): { rows: Omit<ImportRow, 'source_record_key'>[]; issues: ParseIssue[] } {
  const rows: Omit<ImportRow, 'source_record_key'>[] = [];
  const issues: ParseIssue[] = [];
  const add = (sheet: ExcelJS.Worksheet, rowNo: number, value: Omit<ImportRow, 'source_record_key' | 'source_sheet_name' | 'source_row_number'>) => {
    rows.push({ ...value, source_sheet_name: sheet.name, source_row_number: rowNo });
    if (/〜|~|・/.test(value.unit_code)) issues.push({ sheet: sheet.name, row: rowNo, message: '結合区画として取り込みます。', blocking: false });
    if (value.tenant_code && /[\n/・]/.test(value.tenant_code)) issues.push({ sheet: sheet.name, row: rowNo, message: 'テナントコードが複数記載されています。', blocking: false });
  };
  const create = (sheet: ExcelJS.Worksheet, rowNo: number, fields: Omit<ImportRow, 'source_record_key' | 'source_sheet_name' | 'source_row_number' | 'raw_payload' | 'source_monthly_total_amount'>) => {
    const monthly = [fields.source_monthly_rent_amount, fields.source_monthly_common_charge_amount, fields.source_monthly_parking_amount, fields.source_other_monthly_amount];
    return { ...fields, source_monthly_total_amount: monthly.some((v) => v !== null) ? monthly.reduce<number>((sum, v) => sum + (v ?? 0), 0) : null,
      raw_payload: { source_sheet_name: sheet.name, source_row_number: rowNo, ...fields } };
  };
  for (const sheet of book.worksheets) {
    const titleText = Array.from({ length: Math.min(sheet.columnCount, 8) }, (_, i) => normalize(sheet.getCell(1, i + 1).value)).join(' ');
    const titleProperty = titleText.match(/【(.+?)】/)?.[1] ?? sheet.name;
    const propertyName = propertyAliases[titleProperty] ?? titleProperty;
    if (sheet.name === '中之島') {
      for (let r = 4; r <= sheet.rowCount; r++) {
        const unit = identifier(sheet.getCell(r, 3).value);
        if (!/^\d{3,4}$/.test(unit)) continue;
        const fields = create(sheet, r, { property_name: 'リバーサイドタワー中之島', source_status: '', wing_code: null, floor_label: `${Number(unit.slice(0, -2))}F`, unit_code: unit, unit_type: 'residential', tenant_code: null, tenant_name: cellText(sheet, r, 4) || null, source_area_sqm: cellNumber(sheet, r, 6), source_monthly_rent_amount: cellNumber(sheet, r, 9), source_monthly_common_charge_amount: null, source_monthly_parking_amount: cellNumber(sheet, r, 14), source_other_monthly_amount: null, contract_start_date: isoDate(sheet.getCell(r, 20).value), contract_end_date: null });
        add(sheet, r, fields);
      }
      continue;
    }
    if (sheet.name === '神戸' || sheet.name === '福島') {
      let wing = ''; let floor = '';
      for (let r = 4; r <= sheet.rowCount; r++) {
        const unit = identifier(sheet.getCell(r, 5).value);
        const status = cellText(sheet, r, 1);
        const tenant = cellText(sheet, r, 7) || null;
        const area = numeric(sheet.getCell(r, 8).value);
        if (!unit || /合計/.test(unit) || /^[〈《【]/.test(unit) || (!tenant && !status) || (unit === 'H' && area === null)) continue;
        wing = cellText(sheet, r, 3) || wing; floor = cellText(sheet, r, 4) || floor;
        const type = inferUnitType(unit); const ancillary = ['parking', 'antenna', 'signage', 'bicycle_parking'].includes(type);
        const otherCols = sheet.name === '神戸' ? [21] : [21, 22];
        const other = otherCols.map((c) => numeric(sheet.getCell(r, c).value)).filter((v): v is number => v !== null);
        add(sheet, r, create(sheet, r, { property_name: sheet.name === '神戸' ? '三共神戸ツインビル' : '三共福島ビル', source_status: status, wing_code: ancillary ? (cellText(sheet, r, 3) || null) : (cellText(sheet, r, 3) || wing || null), floor_label: ancillary ? (cellText(sheet, r, 4) || null) : (cellText(sheet, r, 4) || floor || null), unit_code: unit, unit_type: type, tenant_code: cellText(sheet, r, 6) || null, tenant_name: tenant, source_area_sqm: area, source_monthly_rent_amount: numeric(sheet.getCell(r, 10).value), source_monthly_common_charge_amount: numeric(sheet.getCell(r, 12).value), source_monthly_parking_amount: numeric(sheet.getCell(r, 18).value), source_other_monthly_amount: other.length ? other.reduce((a, b) => a + b, 0) : null, contract_start_date: isoDate(sheet.getCell(r, sheet.name === '神戸' ? 23 : 25).value), contract_end_date: isoDate(sheet.getCell(r, sheet.name === '神戸' ? 24 : 26).value) }));
      }
      continue;
    }
    const headerParts = Array.from({ length: sheet.columnCount }, (_, i) => [1, 2, 3].map((r) => normalize(sheet.getCell(r, i + 1).value)).filter(Boolean).join(' '));
    const headerRows = [1, 2, 3].filter((r) => Array.from({ length: sheet.columnCount }, (_, i) => normalize(sheet.getCell(r, i + 1).value)).some((v) => ['室', 'テナント名', 'コード', '棟'].includes(v)));
    const headerRow = Math.max(...headerRows, 0);
    const find = (predicate: (header: string) => boolean) => headerParts.findIndex((header) => predicate(header) && !/(坪単価|台数|敷金|敷引|単価)/.test(header)) + 1 || null;
    const floorCol = find((header) => /階-室|(^|\s)階/.test(header));
    let unitCol = find((header) => /階-室|(^|\s)室/.test(header));
    if (!unitCol && floorCol && sheet.name === '梅田') unitCol = 4;
    if (!unitCol && floorCol) unitCol = floorCol + 1;
    const tenantCol = find((header) => header.includes('テナント名'));
    const areaCol = find((header) => header.includes('面積'));
    if (!headerRow || !unitCol || !tenantCol || !areaCol) {
      issues.push({ sheet: sheet.name, row: null, message: '区画・テナント・面積の列を特定できません。シートは未取込です。', blocking: true });
      continue;
    }
    const codeCol = find((header) => header.includes('コード'));
    const wingCol = find((header) => header.includes('棟'));
    const rentCol = find((header) => header.includes('賃料') && !header.includes('賃料+共益費'));
    const commonCol = find((header) => header.includes('共益費'));
    const parkingCol = find((header) => /駐車場|駐車料/.test(header));
    const otherCols = headerParts.map((header, i) => /TVアンテナ|アンテナ料|看板代|清掃代|その他|駐輪場|駐輪代|倉庫代/.test(header) && !/(坪単価|台数|敷金|敷引|単価)/.test(header) ? i + 1 : 0).filter(Boolean);
    let inheritedFloor = ''; let inheritedWing = '';
    for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
      const unit = identifier(sheet.getCell(r, unitCol).value);
      if (!unit || unit.includes('合計')) continue;
      const floor = floorCol ? cellText(sheet, r, floorCol) : '';
      const rowWing = wingCol ? cellText(sheet, r, wingCol) : '';
      inheritedFloor = floor || inheritedFloor; inheritedWing = rowWing || inheritedWing;
      const tenant = cellText(sheet, r, tenantCol) || null;
      const other = otherCols.map((c) => numeric(sheet.getCell(r, c).value)).filter((v): v is number => v !== null);
      add(sheet, r, create(sheet, r, { property_name: propertyName, source_status: cellText(sheet, r, 1), wing_code: inheritedWing || null, floor_label: inheritedFloor || null, unit_code: unit, unit_type: inferUnitType(unit), tenant_code: (codeCol ? cellText(sheet, r, codeCol) : '') || null, tenant_name: tenant, source_area_sqm: cellNumber(sheet, r, areaCol), source_monthly_rent_amount: cellNumber(sheet, r, rentCol), source_monthly_common_charge_amount: cellNumber(sheet, r, commonCol), source_monthly_parking_amount: cellNumber(sheet, r, parkingCol), source_other_monthly_amount: other.length ? other.reduce((a, b) => a + b, 0) : null, contract_start_date: null, contract_end_date: null }));
    }
  }
  const duplicateCounts = new Map<string, number>();
  for (const row of rows) {
    const key = [row.property_name, row.wing_code ?? '', row.floor_label ?? '', row.unit_code].join('|');
    duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
  }
  for (const row of rows) if ((duplicateCounts.get([row.property_name, row.wing_code ?? '', row.floor_label ?? '', row.unit_code].join('|')) ?? 0) > 1) issues.push({ sheet: row.source_sheet_name, row: row.source_row_number, message: '同じ階・区画が複数行あります。行単位で保持し、照合結果を要確認として扱います。', blocking: false });
  return { rows, issues };
}

export function RentRollReconciliationPanel({ canManage }: { canManage: boolean }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchId, setBatchId] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);

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

  const prepareImport = async (file?: File) => {
    if (!file) return;
    setError(''); setPreview(null);
    if (!file.name.toLowerCase().endsWith('.xlsx')) { setError('最新帳票の .xlsx ファイルを選択してください。'); return; }
    try {
      const bytes = await file.arrayBuffer();
      const { default: ExcelJSRuntime } = await import('exceljs');
      const workbook = new ExcelJSRuntime.Workbook();
      await workbook.xlsx.load(bytes);
      const parsed = parseUploadedWorkbook(workbook);
      if (!parsed.rows.length) throw new Error('比較に使える行を読み取れませんでした。');
      const hash = await sha256(bytes);
      const rows: ImportRow[] = await Promise.all(parsed.rows.map(async (row) => {
        const identity = row.tenant_code || normalize(row.tenant_name).toLowerCase();
        const source_record_key = `rr:v2:${await sha256(new TextEncoder().encode([row.property_name, row.wing_code ?? '', row.floor_label ?? '', row.unit_code, identity, row.source_sheet_name, row.source_row_number].join('|')).buffer)}`;
        return { ...row, source_record_key };
      }));
      const now = new Date();
      const asOfDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      setPreview({ fileName: file.name, hash, rows, issues: parsed.issues, asOfDate });
    } catch (e) {
      setError(e instanceof Error ? `帳票を読み取れませんでした: ${e.message}` : '帳票を読み取れませんでした。');
    }
  };

  const importComparisonData = async () => {
    if (!supabase || !preview || preview.issues.some((issue) => issue.blocking)) return;
    setImporting(true); setError('');
    const existing = await supabase.from('rent_roll_import_batch').select('rent_roll_import_batch_id').eq('source_sha256', preview.hash).eq('as_of_date', preview.asOfDate).maybeSingle();
    if (existing.error) { setError(`既存データを確認できません: ${existing.error.message}`); setImporting(false); return; }
    if (existing.data) {
      setError('このファイルは本日すでに取り込み済みです。既存の比較結果を表示します。');
      setPreview(null); setBatchId(existing.data.rent_roll_import_batch_id); await loadReport(existing.data.rent_roll_import_batch_id); setImporting(false); return;
    }
    const { data: batch, error: batchError } = await supabase.from('rent_roll_import_batch').insert({ source_file_name: preview.fileName, source_sha256: preview.hash, as_of_date: preview.asOfDate, status: 'uploaded', row_count: preview.rows.length, issue_count: preview.issues.length }).select('rent_roll_import_batch_id').single();
    if (batchError || !batch) { setError(`取込バッチを作成できません: ${batchError?.message ?? '応答がありません'}`); setImporting(false); return; }
    const batchId = batch.rent_roll_import_batch_id as string;
    let rowError: string | null = null;
    for (let offset = 0; offset < preview.rows.length; offset += 200) {
      const payload = preview.rows.slice(offset, offset + 200).map((row) => ({ ...row, rent_roll_import_batch_id: batchId }));
      const { error: insertError } = await supabase.from('rent_roll_import_row').insert(payload);
      if (insertError) { rowError = insertError.message; break; }
    }
    if (rowError) {
      const { error: cleanupError } = await supabase.from('rent_roll_import_batch').delete().eq('rent_roll_import_batch_id', batchId);
      setError(`明細を登録できませんでした: ${rowError}${cleanupError ? `。未完了バッチの削除にも失敗しました: ${cleanupError.message}` : '。未完了バッチは削除しました。'}`);
      setImporting(false); return;
    }
    setPreview(null); setBatchId(batchId);
    const { error: matchError } = await supabase.rpc('match_rent_roll_import_batch', { p_batch_id: batchId });
    const { data: refreshed } = await supabase.from('rent_roll_import_batch').select('rent_roll_import_batch_id, source_file_name, as_of_date, status, row_count, issue_count').order('as_of_date', { ascending: false }).order('created_at', { ascending: false }).limit(20);
    setBatches((refreshed ?? []) as Batch[]);
    await loadReport(batchId);
    if (matchError) setError(`帳票の登録は完了しましたが、照合に失敗しました: ${matchError.message}`);
    setImporting(false);
  };

  return <section className="reconciliation-panel">
    <header><div><p className="section-kicker">PROPERTY TOTALS</p><h3>最新の比較元レントロールとシステムの物件別合計</h3><p>比較元を取り込み、賃料等を物件単位で照合します。契約正本は更新しません。</p></div><div className="reconciliation-actions">{canManage && <label className="reconciliation-upload">{importing ? '取込中…' : '賃貸借状況表を取り込む'}<input type="file" accept=".xlsx" disabled={importing} onChange={(event) => { void prepareImport(event.target.files?.[0]); event.currentTarget.value = ''; }} /></label>}<select aria-label="比較元レントロール" value={batchId} onChange={(event) => { setBatchId(event.target.value); void loadReport(event.target.value); }}><option value="">比較元を選択</option>{batches.map((batch) => <option key={batch.rent_roll_import_batch_id} value={batch.rent_roll_import_batch_id}>{batch.as_of_date}｜{batch.source_file_name}</option>)}</select>{canManage && <button type="button" className="secondary-button" disabled={!batchId || loading || importing} onClick={() => void recalculate()}>再照合</button>}</div></header>
    {preview && <div className="reconciliation-import-preview"><div><strong>取込プレビュー</strong><span>{preview.fileName}｜比較基準日 {preview.asOfDate}</span><span>{count.format(preview.rows.length)}行を登録予定 / 確認事項 {count.format(preview.issues.length)}件</span></div>{preview.issues.length > 0 && <ul>{preview.issues.slice(0, 12).map((issue, index) => <li key={`${issue.sheet}-${issue.row}-${index}`} className={issue.blocking ? 'blocking' : ''}><strong>{issue.sheet}{issue.row ? ` ${issue.row}行` : ''}</strong>：{issue.message}</li>)}</ul>}{preview.issues.length > 12 && <small>ほか {preview.issues.length - 12} 件</small>}{preview.issues.some((issue) => issue.blocking) && <p className="reconciliation-error">未対応レイアウトがあるため、誤った合計を防ぐため取込できません。</p>}<div className="reconciliation-import-buttons"><button type="button" className="primary-button" disabled={importing || preview.issues.some((issue) => issue.blocking)} onClick={() => void importComparisonData()}>{importing ? '取込中…' : '照合元として登録'}</button><button type="button" className="secondary-button" disabled={importing} onClick={() => setPreview(null)}>取消</button></div></div>}
    {error && <p className="reconciliation-error">{error}</p>}
    {!loading && batches.length === 0 && <p className="reconciliation-empty">比較元のレントロールがまだ登録されていません。</p>}
    {loading && <p className="reconciliation-empty">整合性を集計しています。</p>}
    {report && !loading && <>
      <div className="reconciliation-metrics"><div><span>比較元</span><strong>{report.batch.as_of_date}</strong><small>{report.batch.source_file_name}</small></div><div><span>比較元行数</span><strong>{count.format(report.batch.row_count)}件</strong></div><div><span>差異</span><strong>{count.format(report.overall.mismatch_count ?? 0)}件</strong></div><div><span>要確認</span><strong>{count.format(report.overall.needs_review_count ?? 0)}件</strong></div><div><span>取込時の確認件数</span><strong>{count.format(report.batch.issue_count)}件</strong></div></div>
      <div className="reconciliation-table-wrap"><table><thead><tr><th>物件</th><th>比較元合計</th><th>システム合計</th><th>差額</th><th>賃料差</th><th>共益費差</th><th>駐車場差</th><th>その他月額差</th><th>差異 / 要確認</th></tr></thead><tbody>{report.properties.map((item) => <tr key={item.property_name}><td>{item.property_name}</td><td>{yen.format(item.source_total)}</td><td>{yen.format(item.db_total)}</td><td className={item.difference === 0 ? '' : 'reconciliation-different'}>{yen.format(item.difference)}</td><td>{yen.format(item.db_rent - item.source_rent)}</td><td>{yen.format(item.db_common - item.source_common)}</td><td>{yen.format(item.db_parking - item.source_parking)}</td><td>{yen.format(item.db_other - item.source_other)}</td><td>{item.mismatch_count}/{item.needs_review_count}</td></tr>)}</tbody></table></div>
      <p className="reconciliation-footnote">差額はシステム合計－比較元合計です。個別区画の一覧は表示せず、物件単位・項目単位で確認します。</p>
    </>}
  </section>;
}
