import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { supabase } from './lib/supabase';
import type { BillingPeriod } from './TenantBillingControls';
import { periodText } from './utils/billingDates';
import {
  buildInvoiceSheet, csvHeaders, invalidAmountRows, loadSavedInvoiceSheet, numberValue, recalcInvoices, saveInvoiceSheet, taxCategories,
  type DuePattern, type InvoiceRow, type InvoiceSheet, type PeriodPattern,
} from './utils/invoiceSheet';
import './InvoiceCreationPage.css';

const screenHeaders = csvHeaders.map((header, index) => index === 5 ? '請求金額（税抜）' : index === 6 ? '消費税額' : index === 7 ? '請求金額（税込）' : index === 9 ? '請求書備考' : header);
// 幅の狭い列は見出しを2行に分けて表示します。
const headerLines: Record<number, [string, string]> = { 0: ['請求書', '番号'], 1: ['発行先', 'コード'], 5: ['請求金額', '（税抜）'], 7: ['請求金額', '（税込）'] };
// 列ごとの文字ぞろえです。金額は右、コードや区分は中央にします。
const rightAlignedColumns = new Set([5, 6, 7, 14, 15]);
const centerAlignedColumns = new Set([0, 1, 4, 18, 19]);
const cellClass = (column: number) => rightAlignedColumns.has(column) ? 'invoice-cell-right' : centerAlignedColumns.has(column) ? 'invoice-cell-center' : '';
const headerLabel = (column: number) => { const lines = headerLines[column]; return lines ? <span className="invoice-header-label">{lines[0]}<i>{lines[1]}</i></span> : screenHeaders[column]; };
const baseColumns = [0, 1, 2, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 18, 19, 20];
// 請求書備考（9列目）は「請求書備考を表示」を入れたときだけ、締日の次に差し込みます。
const invoiceNoteColumn = 9;
// 請求書ごとの金額（税抜・消費税・税込）は明細から計算し、税率は税区分から決めるため、直接は編集しません。
const calculatedColumns = new Set([0, 5, 6, 7, 19]);
const initialColumnWidths: Record<number, number> = { 0: 88, 1: 72, 2: 150, 4: 130, 5: 100, 6: 100, 7: 100, 9: 150, 10: 132, 11: 135, 12: 48, 13: 52, 14: 96, 15: 96, 18: 70, 19: 70, 20: 130 };
const columnWidthStorageKey = 'invoice-creation-column-widths-v2';
const legacyColumnWidthStorageKey = 'invoice-creation-column-widths';
const loadColumnWidths = (): Record<number, number> => {
  const widths = { ...initialColumnWidths };
  try {
    const stored = JSON.parse(localStorage.getItem(columnWidthStorageKey) ?? 'null');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const column of Object.keys(initialColumnWidths)) { const width = stored[column]; if (typeof width === 'number' && width >= 44) widths[Number(column)] = width; }
      return widths;
    }
    // 旧形式は表示順の配列だったため、請求書備考を除いた並びに対応付けて引き継ぎます。
    const legacy = JSON.parse(localStorage.getItem(legacyColumnWidthStorageKey) ?? 'null');
    if (Array.isArray(legacy) && legacy.length === baseColumns.length) baseColumns.forEach((column, position) => { const width = legacy[position]; if (typeof width === 'number' && width >= 44) widths[column] = width; });
  } catch { return widths; }
  return widths;
};
const yen = new Intl.NumberFormat('ja-JP');
const patternMark = (number: number) => '①②③④⑤⑥⑦⑧⑨⑩'.charAt(number - 1) || String(number);
// 入金期限の見出しです。末日・25日・翌5日のように期日で表し、土日祝が翌日送りの条件だけ書き添えます。
const duePatternMark = (pattern: DuePattern) => `${pattern.month_offset ? '翌' : ''}${pattern.day_of_month === 0 ? '末日' : `${pattern.day_of_month}日`}${pattern.holiday_adjustment === 'next' ? '（休日は翌日）' : ''}`;
const duePatternLabel = (pattern: DuePattern) => `${patternMark(pattern.pattern_number)} ${pattern.month_offset ? '翌月' : '当月'}${pattern.day_of_month === 0 ? '末日' : `${pattern.day_of_month}日`}（休日は${pattern.holiday_adjustment === 'previous' ? '前日' : '翌日'}）`;
const savedAtText = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };
const sheetTotal = (rows: InvoiceRow[]) => { const seen = new Set<string>(); let total = 0; for (const row of recalcInvoices(rows)) if (!seen.has(row.invoiceKey)) { seen.add(row.invoiceKey); total += numberValue(row.values[7]); } return total; };

export function InvoiceCreationPage({ propertyId, propertyName, period }: { propertyId: string; propertyName: string; period: BillingPeriod }) {
  const [rows, setRowsState] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showInvoiceNote, setShowInvoiceNote] = useState(false);
  const [invoiceNote, setInvoiceNote] = useState('');
  const [duePatterns, setDuePatterns] = useState<DuePattern[]>([]);
  const [duePatternByInvoice, setDuePatternByInvoice] = useState<Record<string, string>>({});
  const [dueDateByPattern, setDueDateByPattern] = useState<Record<string, string>>({});
  const [periodPatterns, setPeriodPatterns] = useState<PeriodPattern[]>([]);
  const [periodPatternByRow, setPeriodPatternByRow] = useState<Record<string, string>>({});
  const [periodRangeByPattern, setPeriodRangeByPattern] = useState<Record<string, { start: string; end: string }>>({});
  const [meterNotice, setMeterNotice] = useState('');
  const [termsNotice, setTermsNotice] = useState('');
  const [lineItem1Filter, setLineItem1Filter] = useState('all');
  const [lineItem2Filter, setLineItem2Filter] = useState('all');
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>(loadColumnWidths);
  // 保存状態です。保存済みなら保存日時、未保存（最新データから作成）なら空です。
  const [savedAt, setSavedAt] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // 合計行の高さは内容で変わるため、見出し行の吸着位置を実測値に合わせて2行をまとめて固定します。
  const totalRowRef = useRef<HTMLTableRowElement>(null);
  const [totalRowHeight, setTotalRowHeight] = useState(42);
  const calendarYear = period.fiscalYear + (period.month <= 3 ? 1 : 0);

  // 明細を変えたら、請求書ごとの金額（税抜・消費税・税込）と税率を出し直します。
  // 保存中に直した内容を保存済み扱いにしないよう、編集のたびに版を進めます。
  const revision = useRef(0);
  const setRows = (update: (current: InvoiceRow[]) => InvoiceRow[]) => { setRowsState((current) => recalcInvoices(update(current))); revision.current += 1; setDirty(true); };
  const applySheet = (sheet: InvoiceSheet) => {
    setRowsState(recalcInvoices(sheet.rows)); setDuePatternByInvoice(sheet.duePatternByInvoice); setDueDateByPattern(sheet.dueDateByPattern);
    setPeriodPatternByRow(sheet.periodPatternByRow); setPeriodRangeByPattern(sheet.periodRangeByPattern);
    setInvoiceNote(sheet.invoiceNote); setShowInvoiceNote(sheet.showInvoiceNote);
    setLineItem1Filter('all'); setLineItem2Filter('all');
  };
  const currentSheet = (): InvoiceSheet => ({ rows, duePatternByInvoice, dueDateByPattern, periodPatternByRow, periodRangeByPattern, invoiceNote, showInvoiceNote });

  // 保存した内容があればそれを、無ければレントロール・検針データから作った内容を表示します。
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!supabase || !propertyId) { setRowsState([]); setLoading(false); return; }
      setLoading(true); setError(''); setNotice('');
      try {
        // 最新データから作れなくても（レントロールの読み込み失敗など）、保存した内容は開けるようにします。
        const [builtResult, savedResult] = await Promise.allSettled([
          buildInvoiceSheet(supabase, propertyId, propertyName, calendarYear, period.month),
          loadSavedInvoiceSheet(supabase, propertyId, calendarYear, period.month),
        ]);
        if (cancelled) return;
        if (savedResult.status === 'rejected') throw savedResult.reason;
        const saved = savedResult.value;
        const built = builtResult.status === 'fulfilled' ? builtResult.value : null;
        if (!built && !saved) throw builtResult.status === 'rejected' ? builtResult.reason : new Error('請求データを読み込めませんでした');
        if (!built && builtResult.status === 'rejected') setError(`最新データから作れなかったため、保存した内容を表示しています: ${builtResult.reason instanceof Error ? builtResult.reason.message : ''}`);
        setDuePatterns(built?.duePatterns ?? []); setPeriodPatterns(built?.periodPatterns ?? []); setMeterNotice(built?.meterNotice ?? ''); setTermsNotice(built?.termsNotice ?? '');

        applySheet(saved?.sheet ?? built!.sheet);
        setSavedAt(saved?.savedAt ?? '');
        setDirty(false);
        if (saved && built && sheetTotal(saved.sheet.rows) !== sheetTotal(built.sheet.rows)) {
          setNotice(`保存した後に、レントロール・検針データの金額が変わっています（保存した内容 ${yen.format(sheetTotal(saved.sheet.rows))}円／最新 ${yen.format(sheetTotal(built.sheet.rows))}円）。最新の内容にするには「最新データで作り直す」を押してください。`);
        }
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : '請求データを読み込めませんでした'); setRowsState([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load(); return () => { cancelled = true; };
  // applySheet は state の setter だけを使うため、依存に含めません。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, propertyName, period.fiscalYear, period.month, calendarYear]);

  const save = async () => {
    if (!supabase || !propertyId) return;
    // 数値として読めない金額があると請求額が狂うため、保存させません。
    const invalid = invalidAmountRows(rows);
    if (invalid.length) { setError(`金額が数値として読めない明細があります（請求書番号 ${[...new Set(invalid.map((row) => rows.find((item) => item.invoiceKey === row.invoiceKey)?.values[0] ?? ''))].join('・')}）。直してから保存してください。`); return; }
    setSaving(true); setError('');
    const savingRevision = revision.current;
    try {
      const at = await saveInvoiceSheet(supabase, propertyId, calendarYear, period.month, currentSheet());
      setSavedAt(at); setDirty(revision.current !== savingRevision);
      setNotice(revision.current !== savingRevision ? '保存しました。保存中に直した内容はまだ保存されていません。もう一度保存してください。' : '保存しました。入金明細・請求明細にこの内容を表示します。');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存できませんでした');
    } finally {
      setSaving(false);
    }
  };
  // 手で直した内容を捨てて、最新のレントロール・検針データから作り直します（保存するまでDBは変わりません）。
  // 押した時点のデータで作り直します。
  const rebuild = async () => {
    if (!supabase || !propertyId) return;
    if (!window.confirm('手で直した内容を捨てて、最新のレントロール・検針データから作り直します。よろしいですか（保存するまで確定しません）。')) return;
    setLoading(true); setError('');
    try {
      const built = await buildInvoiceSheet(supabase, propertyId, propertyName, calendarYear, period.month);
      setDuePatterns(built.duePatterns); setPeriodPatterns(built.periodPatterns); setMeterNotice(built.meterNotice); setTermsNotice(built.termsNotice);
      applySheet(built.sheet); revision.current += 1; setDirty(true); setNotice('最新データで作り直しました。内容を確認して保存してください。');
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : '最新データから作り直せませんでした');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { localStorage.setItem(columnWidthStorageKey, JSON.stringify(columnWidths)); }, [columnWidths]);

  useEffect(() => {
    const row = totalRowRef.current;
    if (!row) return;
    const measure = () => setTotalRowHeight(row.getBoundingClientRect().height);
    const observer = new ResizeObserver(measure); observer.observe(row); measure();
    return () => observer.disconnect();
  }, []);

  const lineItem1Options = useMemo(() => [...new Set(rows.map((row) => row.values[10]).filter(Boolean))].sort(), [rows]);
  const lineItem2Options = useMemo(() => [...new Set(rows.map((row) => row.values[11]).filter(Boolean))].sort(), [rows]);
  const filteredRows = useMemo(() => rows.filter((row) => (lineItem1Filter === 'all' || row.values[10] === lineItem1Filter) && (lineItem2Filter === 'all' || row.values[11] === lineItem2Filter)), [lineItem1Filter, lineItem2Filter, rows]);
  const invoiceSummaryByKey = useMemo(() => { const result = new Map<string, InvoiceRow>(); for (const row of rows) if (!result.has(row.invoiceKey)) result.set(row.invoiceKey, row); return result; }, [rows]);
  const firstVisibleRowIds = useMemo(() => { const result = new Set<string>(); const seen = new Set<string>(); for (const row of filteredRows) if (!seen.has(row.invoiceKey)) { seen.add(row.invoiceKey); result.add(row.id); } return result; }, [filteredRows]);
  const visibleInvoiceKeys = useMemo(() => [...new Set(filteredRows.map((row) => row.invoiceKey))], [filteredRows]);
  const totals = useMemo(() => ({
    5: visibleInvoiceKeys.reduce((sum, key) => sum + numberValue(invoiceSummaryByKey.get(key)?.values[5] ?? ''), 0),
    6: visibleInvoiceKeys.reduce((sum, key) => sum + numberValue(invoiceSummaryByKey.get(key)?.values[6] ?? ''), 0),
    7: visibleInvoiceKeys.reduce((sum, key) => sum + numberValue(invoiceSummaryByKey.get(key)?.values[7] ?? ''), 0),
    12: filteredRows.reduce((sum, row) => sum + numberValue(row.values[12]), 0),
    15: filteredRows.reduce((sum, row) => sum + numberValue(row.values[15]), 0),
  }), [filteredRows, invoiceSummaryByKey, visibleInvoiceKeys]);
  const updateCell = (rowId: string, column: number, value: string) => setRows((current) => current.map((row) => row.id === rowId ? { ...row, values: row.values.map((cell, index) => index === column ? value : cell) } : row));
  const updateInvoiceCell = (invoiceKey: string, column: number, value: string) => setRows((current) => { let updated = false; return current.map((row) => { if (updated || row.invoiceKey !== invoiceKey) return row; updated = true; return { ...row, values: row.values.map((cell, index) => index === column ? value : cell) }; }); });
  const setInvoiceValue = (matches: (invoiceKey: string) => boolean, column: number, value: string) => setRows((current) => { const written = new Set<string>(); return current.map((row) => { if (written.has(row.invoiceKey) || !matches(row.invoiceKey)) return row; written.add(row.invoiceKey); return { ...row, values: row.values.map((cell, index) => index === column ? value : cell) }; }); });
  // 上部の入金期限を書き換えると、そのパターンを使う請求書すべてに反映します。
  const changeDueDate = (patternId: string, value: string) => { setDueDateByPattern((current) => ({ ...current, [patternId]: value })); setInvoiceValue((invoiceKey) => (duePatternByInvoice[invoiceKey] ?? '') === patternId, 4, value); };
  // 明細行の請求期間パターンを切り替えると、上部で確認・編集している期間をそのまま取り込みます。
  const selectPeriodPattern = (rowId: string, patternId: string) => { const range = periodRangeByPattern[patternId]; setPeriodPatternByRow((current) => ({ ...current, [rowId]: patternId })); setLineItem1Filter('all'); updateCell(rowId, 10, patternId ? periodText(range?.start ?? '', range?.end ?? '') : '未設定'); };
  // 上部の請求期間を書き換えると、そのパターンを選んでいる明細すべてに反映します。
  const changePeriodRange = (patternId: string, edge: 'start' | 'end', value: string) => {
    const range = { ...(periodRangeByPattern[patternId] ?? { start: '', end: '' }), [edge]: value };
    setPeriodRangeByPattern((current) => ({ ...current, [patternId]: range })); setLineItem1Filter('all');
    setRows((current) => current.map((row) => (periodPatternByRow[row.id] ?? '') === patternId ? { ...row, values: row.values.map((cell, index) => index === 10 ? periodText(range.start, range.end) : cell) } : row));
  };
  const updateInvoiceNote = (value: string) => { setInvoiceNote(value); setRows((current) => { const written = new Set<string>(); return current.map((row) => { if (written.has(row.invoiceKey)) return row; written.add(row.invoiceKey); return { ...row, values: row.values.map((cell, index) => index === 9 ? value : cell) }; }); }); };
  const setInvoiceNoteEnabled = (enabled: boolean) => { setShowInvoiceNote(enabled); if (!enabled) updateInvoiceNote(''); else setDirty(true); };
  const startColumnResize = (column: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX; const startWidth = columnWidths[column];
    const resize = (moveEvent: PointerEvent) => setColumnWidths((current) => ({ ...current, [column]: Math.max(44, startWidth + moveEvent.clientX - startX) }));
    const stop = () => { window.removeEventListener('pointermove', resize); window.removeEventListener('pointerup', stop); document.body.classList.remove('invoice-column-resizing'); };
    document.body.classList.add('invoice-column-resizing'); window.addEventListener('pointermove', resize); window.addEventListener('pointerup', stop);
  };
  // 明細項目１は、パターン名ではなく実際の請求期間（YYYY/M/D～YYYY/M/D分）を出します。
  // 期間が決まらないパターン（検針日が未入力など）は、パターン名に未確定と添えます。
  const periodOptionLabel = (pattern: PeriodPattern) => { const range = periodRangeByPattern[pattern.billing_period_pattern_id]; return periodText(range?.start ?? '', range?.end ?? '') || `${pattern.pattern_name}（期間未確定）`; };
  const invoiceLevelColumns = new Set([0, 1, 2, 4, 5, 6, 7, invoiceNoteColumn]);
  const totalColumns = new Set([5, 6, 7, 12, 15]);
  const visibleColumns = showInvoiceNote ? [...baseColumns.slice(0, 7), invoiceNoteColumn, ...baseColumns.slice(7)] : baseColumns;
  const tableWidth = visibleColumns.reduce((sum, column) => sum + columnWidths[column], 0);
  const cellEditor = (row: InvoiceRow, column: number, summary: InvoiceRow) => {
    if (column === 10) return <select className="invoice-due-pattern" aria-label={`請求期間パターン ${row.id}`} title={row.values[10]} value={periodPatternByRow[row.id] ?? ''} onChange={(event) => selectPeriodPattern(row.id, event.target.value)}><option value="">未設定</option>{periodPatterns.map((pattern) => <option key={pattern.billing_period_pattern_id} value={pattern.billing_period_pattern_id}>{periodOptionLabel(pattern)}</option>)}</select>;
    // 税区分は課税・非課税・不課税から選びます。課税の明細だけ税率10%で、消費税の対象になります。
    if (column === 18) return <select className="invoice-due-pattern" aria-label={`税区分 ${row.id}`} value={row.values[18]} onChange={(event) => updateCell(row.id, 18, event.target.value)}>{!taxCategories.includes(row.values[18] as (typeof taxCategories)[number]) && <option value={row.values[18]}>{row.values[18] || '未設定'}</option>}{taxCategories.map((category) => <option key={category} value={category}>{category}</option>)}</select>;
    const invoiceLevel = invoiceLevelColumns.has(column);
    return <input aria-label={`${screenHeaders[column]} ${row.id}`} value={(invoiceLevel ? summary : row).values[column]} readOnly={calculatedColumns.has(column)} onChange={(event) => invoiceLevel ? updateInvoiceCell(row.invoiceKey, column, event.target.value) : updateCell(row.id, column, event.target.value)} />;
  };

  return <section className="invoice-creation-page"><header className="invoice-creation-heading"><div><p className="section-kicker">INVOICE CSV</p><h3>請求書作成</h3><p>{propertyName}・{calendarYear}年{period.month}月分</p><p className="invoice-save-state">{savedAt ? `保存済み：${savedAtText(savedAt)}` : '未保存（最新データから作成）'}{dirty ? '・未保存の変更あり' : ''}</p></div><div className="invoice-date-panel">
      <section><h4>入金期限</h4>{duePatterns.length ? <ul>{duePatterns.map((pattern) => <li key={pattern.billing_due_date_pattern_id}><span title={duePatternLabel(pattern)}>{duePatternMark(pattern)}</span><input value={dueDateByPattern[pattern.billing_due_date_pattern_id] ?? ''} placeholder="YYYY/M/D" aria-label={`入金期限 ${duePatternLabel(pattern)}`} onChange={(event) => changeDueDate(pattern.billing_due_date_pattern_id, event.target.value)} /></li>)}</ul> : <p>契約情報の請求条件で設定してください</p>}</section>
      <section><h4>請求期間</h4>{periodPatterns.length ? <ul>{periodPatterns.map((pattern) => <li key={pattern.billing_period_pattern_id}><span>{pattern.pattern_name}</span><input value={periodRangeByPattern[pattern.billing_period_pattern_id]?.start ?? ''} placeholder="YYYY/M/D" aria-label={`請求期間 ${pattern.pattern_name} 開始日`} onChange={(event) => changePeriodRange(pattern.billing_period_pattern_id, 'start', event.target.value)} /><em>～</em><input value={periodRangeByPattern[pattern.billing_period_pattern_id]?.end ?? ''} placeholder="YYYY/M/D" aria-label={`請求期間 ${pattern.pattern_name} 終了日`} onChange={(event) => changePeriodRange(pattern.billing_period_pattern_id, 'end', event.target.value)} /><em>分</em></li>)}</ul> : <p>請求設定で登録してください</p>}</section>
    </div>
    <div className="invoice-creation-actions"><div className="invoice-note-field"><label><input type="checkbox" checked={showInvoiceNote} onChange={(event) => setInvoiceNoteEnabled(event.target.checked)} />請求書備考を表示</label><input value={invoiceNote} disabled={!showInvoiceNote} onChange={(event) => updateInvoiceNote(event.target.value)} placeholder="全請求書共通の備考" /></div><button type="button" className="secondary-button" disabled={loading || saving || !propertyId} onClick={() => void rebuild()}>最新データで作り直す</button><button type="button" className="primary-button" disabled={loading || saving || !dirty || !propertyId} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button><button className="primary-button" disabled>CSVを出力</button></div></header>
    {error && <p className="invoice-creation-notice invoice-creation-error">{error}</p>}
    {notice && <p className="invoice-creation-notice">{notice}</p>}
    {meterNotice && <p className="invoice-creation-notice invoice-creation-error">{meterNotice}</p>}
    {termsNotice && <p className="invoice-creation-notice invoice-creation-error">{termsNotice}</p>}
    <div className="invoice-creation-table-wrap invoice-csv-table-wrap"><table className="invoice-csv-table" style={{ width: tableWidth }}><colgroup>{visibleColumns.map((column) => <col key={column} style={{ width: columnWidths[column] }} />)}</colgroup><thead><tr className="invoice-total-row" ref={totalRowRef}>{visibleColumns.map((column) => <th key={`total-${column}`} className={cellClass(column)}>{column === visibleColumns[0] ? <span>表示中合計</span> : totalColumns.has(column) ? <strong>{yen.format(totals[column as keyof typeof totals])}</strong> : null}</th>)}</tr><tr>{visibleColumns.map((column) => <th key={column} style={{ top: totalRowHeight }}>{column === 10 || column === 11 ? <label>{screenHeaders[column]}<select value={column === 10 ? lineItem1Filter : lineItem2Filter} onChange={(event) => column === 10 ? setLineItem1Filter(event.target.value) : setLineItem2Filter(event.target.value)}><option value="all">すべて</option>{(column === 10 ? lineItem1Options : lineItem2Options).map((option) => <option key={option} value={option}>{option}</option>)}</select></label> : headerLabel(column)}<button type="button" className="invoice-column-resizer" aria-label={`${screenHeaders[column]}の列幅を変更`} onPointerDown={(event) => startColumnResize(column, event)} /></th>)}</tr></thead><tbody>{loading ? <tr><td colSpan={visibleColumns.length} className="invoice-creation-empty">レントロールを読み込み中…</td></tr> : !filteredRows.length ? <tr><td colSpan={visibleColumns.length} className="invoice-creation-empty">条件に一致する固定費の契約データがありません。</td></tr> : filteredRows.map((row) => { const firstVisible = firstVisibleRowIds.has(row.id); const summary = invoiceSummaryByKey.get(row.invoiceKey) ?? row; return <tr key={row.id} className={firstVisible ? 'invoice-start-row' : 'invoice-continuation-row'}>{visibleColumns.map((column) => <td key={`${row.id}-${column}`} className={cellClass(column)}>{invoiceLevelColumns.has(column) && !firstVisible ? null : cellEditor(row, column, summary)}</td>)}</tr>; })}</tbody></table></div>
  </section>;
}
