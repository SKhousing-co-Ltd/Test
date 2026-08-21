import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { supabase } from './lib/supabase';

type ParkingScope = 'internal' | 'external';
type ParkingImportStatus = 'occupied' | 'vacant';

type PropertyOption = { asset_id: string; asset_name: string; short_name: string | null };
type ParkingType = { parking_type_id: number; parking_type_name: string };
type ParkingFacility = {
  parking_facility_id: string;
  property_id: string;
  facility_code: string;
  facility_name: string;
  parking_type_id: number | null;
};

export type ParkingCurrentRow = {
  property_id: string;
  property_name: string;
  parking_facility_id: string;
  facility_code: string;
  facility_name: string;
  parking_type_id: number | null;
  parking_type_name: string | null;
  unit_id: string;
  unit_code: string;
  space_number: string;
  is_active: boolean;
  lease_contract_unit_id: string | null;
  lease_contract_id: string | null;
  contract_status: string | null;
  contract_start_date: string | null;
  contract_end_date: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  parking_scope: ParkingScope | null;
  main_lease_contract_id: string | null;
  main_contract_start_date: string | null;
  main_contract_end_date: string | null;
  access_code: string | null;
  tenant_location_label: string | null;
  notes: string | null;
  vehicle_model: string | null;
  registration_number: string | null;
  chassis_number: string | null;
  vehicle_effective_from: string | null;
};

type MainContractCandidate = {
  property_id: string;
  lease_contract_id: string;
  tenant_id: string;
  tenant_name: string;
  contract_start_date: string | null;
  contract_end_date: string | null;
  unit_labels: string;
};

type TenantOption = { tenant_id: string; tenant_name: string };

type ImportRow = {
  parking_import_row_id: string;
  source_row_number: number;
  space_number: string;
  access_code: string | null;
  tenant_location_label: string | null;
  tenant_name: string;
  matched_tenant_id: string | null;
  parking_scope: ParkingScope | null;
  main_lease_contract_id: string | null;
  contract_start_date: string | null;
  vehicle_model: string | null;
  registration_number: string | null;
  chassis_number: string | null;
  notes: string | null;
  validation_messages: string[];
  raw_payload: Record<string, unknown> | null;
};

type ParsedImportRow = {
  source_row_number: number;
  space_number: string;
  access_code: string;
  tenant_location_label: string;
  tenant_name: string;
  vehicle_model: string;
  registration_number: string;
  chassis_number: string;
  contract_start_date: string;
  notes: string;
  is_vacant: boolean;
};

type VehicleHistory = {
  parking_vehicle_history_id: string;
  vehicle_model: string | null;
  registration_number: string | null;
  chassis_number: string | null;
  effective_from: string;
  effective_to: string | null;
  source_notes: string | null;
};

const today = new Date().toISOString().slice(0, 10);
const collator = new Intl.Collator('ja-JP', { numeric: true, sensitivity: 'base' });

const parkingHeaderAliases = {
  status: ['状態', '契約状態', '稼働状態', '空き状況'],
  space_number: ['枠番', '駐車場番号', '区画番号', '区画', '車室番号', '車室'],
  access_code: ['暗証番号', 'リモコン', 'リモコン番号', 'カード番号', 'アクセスコード'],
  tenant_location_label: ['階', '所在', 'フロア', 'テナント所在'],
  tenant_name: ['テナント名', '契約者', '契約先', '会社名', '利用者'],
  vehicle_model: ['車種', '車名', '車両名'],
  registration_number: ['車両番号', '登録番号', 'ナンバー', '車両登録番号'],
  chassis_number: ['車台番号', '車体番号'],
  contract_start_date: ['契約開始日', '開始日', '契約日', '利用開始日'],
  notes: ['備考', 'メモ', '摘要'],
} as const;

type ParkingHeaderKey = keyof typeof parkingHeaderAliases;

function displayDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat('ja-JP').format(new Date(`${value}T00:00:00`)) : '—';
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['message', 'error_description', 'details', 'hint', 'reason']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // Fall through.
    }
  }
  return String(error);
}

async function atImportStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${stage}: ${describeUnknownError(error)}`);
  }
}

function excelDate(value: unknown, text: string): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return new Date(Date.UTC(1899, 11, 30) + value * 86_400_000).toISOString().slice(0, 10);
  const normalized = text.trim().replace(/[./]/g, '-').replace(/年|月/g, '-').replace(/日/g, '');
  const matched = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return matched ? `${matched[1]}-${matched[2].padStart(2, '0')}-${matched[3].padStart(2, '0')}` : '';
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/[\s　_\-・]/g, '').trim();
}

function normalizeHeader(value: string): string {
  return value.normalize('NFKC').replace(/[\s　\r\n]/g, '').trim();
}

function resolveHeaderKey(label: string): ParkingHeaderKey | null {
  const normalized = normalizeHeader(label);
  const entry = (Object.entries(parkingHeaderAliases) as Array<[ParkingHeaderKey, readonly string[]]>)
    .find(([, aliases]) => aliases.some((alias) => normalizeHeader(alias) === normalized));
  return entry?.[0] ?? null;
}

function statusMeansVacant(status: string): boolean {
  return ['空き', '空', '未契約', '募集中', 'vacant'].includes(normalizeText(status));
}

function isVacantImportRow(row: ImportRow): boolean {
  return row.raw_payload?.is_vacant === true || row.raw_payload?.is_vacant === 'true';
}

async function hashFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function parseParkingWorkbook(file: File): Promise<{ sheetName: string; rows: ParsedImportRow[] }> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer() as never);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('ワークシートがありません。');

  let headerRow = 0;
  const headerIndexes = new Map<ParkingHeaderKey, number>();
  sheet.eachRow((row, rowNumber) => {
    if (headerRow) return;
    const rowHeaders = new Map<ParkingHeaderKey, number>();
    row.eachCell((cell, columnNumber) => {
      const key = resolveHeaderKey(cell.text);
      if (key && !rowHeaders.has(key)) rowHeaders.set(key, columnNumber);
    });
    if (!rowHeaders.has('space_number') || !rowHeaders.has('tenant_name')) return;
    headerRow = rowNumber;
    rowHeaders.forEach((columnNumber, key) => headerIndexes.set(key, columnNumber));
  });
  if (!headerRow) throw new Error('枠番とテナント名に相当する見出し行が見つかりません。標準ひな型の利用をおすすめします。');

  const rows: ParsedImportRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const cell = (key: ParkingHeaderKey) => {
      const column = headerIndexes.get(key);
      return column ? row.getCell(column) : null;
    };
    const text = (key: ParkingHeaderKey) => cell(key)?.text.trim() ?? '';
    const spaceNumber = text('space_number');
    if (!spaceNumber || ['計', '合計', 'total'].includes(normalizeText(spaceNumber))) return;

    const tenantName = text('tenant_name');
    const status = text('status');
    const isVacant = status ? statusMeansVacant(status) : !tenantName;
    if (!isVacant && !tenantName) return;

    const contractStartCell = cell('contract_start_date');
    rows.push({
      source_row_number: rowNumber,
      space_number: spaceNumber,
      access_code: text('access_code'),
      tenant_location_label: text('tenant_location_label'),
      tenant_name: tenantName,
      vehicle_model: text('vehicle_model'),
      registration_number: text('registration_number'),
      chassis_number: text('chassis_number'),
      contract_start_date: contractStartCell ? excelDate(contractStartCell.value, contractStartCell.text) : '',
      notes: text('notes'),
      is_vacant: isVacant,
    });
  });
  if (!rows.length) throw new Error('取込可能な明細がありません。');
  return { sheetName: sheet.name, rows };
}

async function downloadParkingTemplate(): Promise<void> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('駐車場台帳');
  sheet.columns = [
    { header: '状態', key: 'status', width: 12 },
    { header: '枠番', key: 'space_number', width: 12 },
    { header: '暗証番号', key: 'access_code', width: 16 },
    { header: 'テナント名', key: 'tenant_name', width: 34 },
    { header: '車種', key: 'vehicle_model', width: 20 },
    { header: '車両番号', key: 'registration_number', width: 20 },
    { header: '車台番号', key: 'chassis_number', width: 22 },
    { header: '契約開始日', key: 'contract_start_date', width: 16 },
    { header: '備考', key: 'notes', width: 32 },
  ];
  sheet.addRow({ status: '契約中', space_number: '1', tenant_name: '株式会社サンプル', contract_start_date: today });
  sheet.addRow({ status: '空き', space_number: '2' });
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'I1' };
  for (let rowNumber = 2; rowNumber <= 501; rowNumber += 1) {
    sheet.getCell(`A${rowNumber}`).dataValidation = {
      type: 'list', allowBlank: false, formulae: ['"契約中,空き"'], showErrorMessage: true,
      errorTitle: '状態を選択してください', error: '「契約中」または「空き」を選択してください。',
    };
  }

  const guide = workbook.addWorksheet('入力ガイド');
  guide.columns = [{ header: '項目', width: 22 }, { header: '入力ルール', width: 76 }];
  guide.addRows([
    ['状態', '契約中または空きを選択。空きの場合はテナント名・契約開始日は空欄で構いません。'],
    ['枠番', '必須。駐車場施設内で重複しない番号を入力してください。'],
    ['テナント名', '契約中の場合に入力。取込後、物件内の契約先候補から照合します。'],
    ['契約開始日', '任意。YYYY/MM/DD またはExcelの日付形式で入力してください。'],
    ['その他', '暗証番号・車両情報・備考は分かる範囲で入力してください。'],
  ]);
  guide.getRow(1).font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer as unknown as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '駐車場台帳_標準ひな型.xlsx';
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ParkingPage({ canManage }: { canManage: boolean }) {
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [facilities, setFacilities] = useState<ParkingFacility[]>([]);
  const [parkingTypes, setParkingTypes] = useState<ParkingType[]>([]);
  const [rows, setRows] = useState<ParkingCurrentRow[]>([]);
  const [propertyId, setPropertyId] = useState('');
  const [asOfDate, setAsOfDate] = useState(today);
  const [scopeFilter, setScopeFilter] = useState<'all' | ParkingScope | 'vacant'>('all');
  const [facilityFilter, setFacilityFilter] = useState('all');
  const [parkingTypeFilter, setParkingTypeFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ParkingCurrentRow | null>(null);
  const [vehicleHistory, setVehicleHistory] = useState<VehicleHistory[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadReferenceData = async () => {
    if (!supabase) return;
    const [propertyResult, facilityResult, typeResult] = await Promise.all([
      supabase.from('asset_master').select('asset_id, asset_name, short_name').order('asset_name'),
      supabase.from('parking_facility_master').select('parking_facility_id, property_id, facility_code, facility_name, parking_type_id').eq('is_active', true).order('facility_name'),
      supabase.from('parking_type_master').select('parking_type_id, parking_type_name').order('parking_type_id'),
    ]);
    const loadError = propertyResult.error ?? facilityResult.error ?? typeResult.error;
    if (loadError) throw loadError;
    const propertyRows = (propertyResult.data ?? []) as PropertyOption[];
    setProperties(propertyRows);
    setFacilities((facilityResult.data ?? []) as ParkingFacility[]);
    setParkingTypes((typeResult.data ?? []) as ParkingType[]);
    setPropertyId((current) => current || propertyRows[0]?.asset_id || '');
  };

  const loadParkingRows = async (nextPropertyId: string, nextAsOfDate: string) => {
    if (!supabase || !nextPropertyId) return;
    setLoading(true);
    const { data, error: loadError } = await supabase.rpc('parking_list_at_date', {
      p_property_id: nextPropertyId,
      p_as_of_date: nextAsOfDate,
    });
    if (loadError) setError(`駐車場台帳を読み込めませんでした: ${loadError.message}`);
    else { setRows((data ?? []) as unknown as ParkingCurrentRow[]); setError(''); }
    setLoading(false);
  };

  useEffect(() => {
    void loadReferenceData().catch((loadError: Error) => {
      setError(`マスタを読み込めませんでした: ${loadError.message}`);
      setLoading(false);
    });
  }, []);

  useEffect(() => { void loadParkingRows(propertyId, asOfDate); }, [asOfDate, propertyId]);

  useEffect(() => {
    if (!supabase || !selected?.lease_contract_unit_id) { setVehicleHistory([]); return; }
    void supabase.from('parking_vehicle_history')
      .select('parking_vehicle_history_id, vehicle_model, registration_number, chassis_number, effective_from, effective_to, source_notes')
      .eq('lease_contract_unit_id', selected.lease_contract_unit_id)
      .order('effective_from', { ascending: false })
      .then(({ data }) => setVehicleHistory((data ?? []) as VehicleHistory[]));
  }, [selected?.lease_contract_unit_id]);

  const propertyFacilities = useMemo(
    () => facilities.filter((facility) => facility.property_id === propertyId),
    [facilities, propertyId],
  );

  const propertyParkingTypes = useMemo(() => {
    const usedTypeIds = new Set(propertyFacilities.map((facility) => facility.parking_type_id).filter((id): id is number => id !== null));
    return parkingTypes.filter((type) => usedTypeIds.has(type.parking_type_id));
  }, [parkingTypes, propertyFacilities]);

  const filteredRows = useMemo(() => {
    const normalized = query.normalize('NFKC').toLocaleLowerCase('ja-JP').trim();
    return rows.filter((row) => {
      const matchesFacility = facilityFilter === 'all' || row.parking_facility_id === facilityFilter;
      const matchesParkingType = parkingTypeFilter === 'all' || String(row.parking_type_id ?? '') === parkingTypeFilter;
      const matchesScope = scopeFilter === 'all'
        || (scopeFilter === 'vacant' ? !row.lease_contract_id : row.parking_scope === scopeFilter);
      const matchesQuery = !normalized || [row.space_number, row.unit_code, row.facility_name, row.parking_type_name, row.tenant_name,
        row.access_code, row.vehicle_model, row.registration_number, row.chassis_number]
        .some((value) => value?.normalize('NFKC').toLocaleLowerCase('ja-JP').includes(normalized));
      return matchesFacility && matchesParkingType && matchesScope && matchesQuery;
    }).sort((left, right) => collator.compare(left.facility_name, right.facility_name)
      || collator.compare(left.space_number, right.space_number));
  }, [facilityFilter, parkingTypeFilter, query, rows, scopeFilter]);

  const summary = useMemo(() => ({
    total: filteredRows.length,
    occupied: filteredRows.filter((row) => row.lease_contract_id).length,
    vacant: filteredRows.filter((row) => !row.lease_contract_id).length,
    internal: filteredRows.filter((row) => row.parking_scope === 'internal').length,
  }), [filteredRows]);

  const selectedProperty = properties.find((property) => property.asset_id === propertyId);

  const changeProperty = (nextPropertyId: string) => {
    setPropertyId(nextPropertyId);
    setFacilityFilter('all');
    setParkingTypeFilter('all');
    setSelected(null);
  };

  return <section className="parking-page">
    <div className="parking-heading">
      <div><p className="section-kicker">PARKING LEDGER</p><h2>駐車場台帳</h2><p>物件内の複数駐車場を横断して、空き状況・契約・車両情報を確認します。</p></div>
      {canManage ? <button className="primary-button" onClick={() => setImportOpen(true)}>Excelを取り込む</button> : null}
    </div>

    <div className="parking-toolbar">
      <label>物件<select value={propertyId} onChange={(event) => changeProperty(event.target.value)}>
        {properties.map((property) => <option key={property.asset_id} value={property.asset_id}>{property.short_name || property.asset_name}</option>)}
      </select></label>
      <label>駐車場<select value={facilityFilter} onChange={(event) => { setFacilityFilter(event.target.value); setSelected(null); }}>
        <option value="all">すべての駐車場</option>
        {propertyFacilities.map((facility) => <option key={facility.parking_facility_id} value={facility.parking_facility_id}>{facility.facility_name}</option>)}
      </select></label>
      <label>駐車場種別<select value={parkingTypeFilter} onChange={(event) => { setParkingTypeFilter(event.target.value); setSelected(null); }}>
        <option value="all">すべての種別</option>
        {propertyParkingTypes.map((type) => <option key={type.parking_type_id} value={String(type.parking_type_id)}>{type.parking_type_name}</option>)}
      </select></label>
      <label>基準日<input type="date" value={asOfDate} onChange={(event) => { setAsOfDate(event.target.value); setSelected(null); }} /></label>
      <label>契約区分<select value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value as typeof scopeFilter)}>
        <option value="all">すべて</option><option value="internal">内部</option><option value="external">外部</option><option value="vacant">空き枠</option>
      </select></label>
      <label className="parking-search">検索<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="枠番、駐車場、テナント、車両番号" /></label>
    </div>

    {error ? <p className="parking-notice">{error}</p> : null}
    <div className="parking-metrics">
      <div><span>表示枠数</span><strong>{summary.total}</strong></div>
      <div><span>契約中</span><strong>{summary.occupied}</strong></div>
      <div><span>空き</span><strong>{summary.vacant}</strong></div>
      <div><span>内部</span><strong>{summary.internal}</strong></div>
    </div>

    <div className="parking-layout">
      <div className="parking-panel">
        <header><div><h3>{selectedProperty?.asset_name ?? '物件を選択'}</h3><p>{loading ? '読み込み中…' : `${filteredRows.length} / ${rows.length} 枠を表示`}</p></div></header>
        <div className="parking-table-wrap"><table className="parking-table">
          <thead><tr><th>状態</th><th>枠番</th><th>内外</th><th>テナント</th><th>暗証番号</th><th>車種</th><th>車両番号</th><th>車台番号</th><th>主契約</th></tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={9} className="parking-empty">駐車場台帳を読み込んでいます。</td></tr> : null}
            {!loading && !filteredRows.length ? <tr><td colSpan={9} className="parking-empty">条件に一致する駐車枠がありません。</td></tr> : null}
            {!loading ? filteredRows.map((row) => <tr key={row.unit_id} className={selected?.unit_id === row.unit_id ? 'selected' : ''} onClick={() => setSelected(row)}>
              <td><span className={`parking-state ${row.lease_contract_id ? 'occupied' : 'vacant'}`}>{row.lease_contract_id ? '契約中' : '空き'}</span></td>
              <td><strong>{row.space_number}</strong><small>{row.facility_name}{row.parking_type_name ? ` / ${row.parking_type_name}` : ''}</small></td>
              <td>{row.parking_scope === 'internal' ? '内部' : row.parking_scope === 'external' ? '外部' : '—'}</td>
              <td>{row.tenant_name || '—'}</td><td className="access-code">{row.access_code || '—'}</td>
              <td>{row.vehicle_model || '—'}</td><td>{row.registration_number || '—'}</td><td>{row.chassis_number || '—'}</td>
              <td>{row.main_lease_contract_id ? <span title={row.main_lease_contract_id}>事務所契約</span> : '—'}</td>
            </tr>) : null}
          </tbody>
        </table></div>
      </div>

      <aside className="parking-detail">
        {selected ? <>
          <header><div><p>SPACE</p><h3>枠 {selected.space_number}</h3></div><button onClick={() => setSelected(null)} aria-label="詳細を閉じる">×</button></header>
          <dl>
            <div><dt>駐車場</dt><dd>{selected.facility_name}</dd></div>
            <div><dt>種別</dt><dd>{selected.parking_type_name || '—'}</dd></div>
            <div><dt>状態</dt><dd>{selected.lease_contract_id ? '契約中' : '空き'}</dd></div>
            <div><dt>区分</dt><dd>{selected.parking_scope === 'internal' ? '内部' : selected.parking_scope === 'external' ? '外部' : '—'}</dd></div>
            <div><dt>契約者</dt><dd>{selected.tenant_name || '—'}</dd></div>
            <div><dt>所在</dt><dd>{selected.tenant_location_label || '—'}</dd></div>
            <div><dt>子契約期間</dt><dd>{displayDate(selected.contract_start_date)} ～ {displayDate(selected.contract_end_date)}</dd></div>
            <div><dt>主契約期間</dt><dd>{selected.main_lease_contract_id ? `${displayDate(selected.main_contract_start_date)} ～ ${displayDate(selected.main_contract_end_date)}` : '—'}</dd></div>
            <div><dt>暗証番号</dt><dd className="access-code">{selected.access_code || '—'}</dd></div>
            <div><dt>備考</dt><dd>{selected.notes || '—'}</dd></div>
          </dl>
          <section><h4>車両履歴</h4>{vehicleHistory.length ? <ol>{vehicleHistory.map((vehicle) => <li key={vehicle.parking_vehicle_history_id}>
            <strong>{vehicle.vehicle_model || '車種未設定'}</strong><span>{vehicle.registration_number || '番号未設定'} / {vehicle.chassis_number || '車台番号未設定'}</span>
            <small>{displayDate(vehicle.effective_from)} ～ {displayDate(vehicle.effective_to)}</small>
          </li>)}</ol> : <p>登録された車両履歴はありません。</p>}</section>
        </> : <div className="parking-detail-empty"><strong>枠を選択</strong><p>駐車場・契約・暗証番号・車両履歴を確認できます。</p></div>}
      </aside>
    </div>

    {importOpen ? <ParkingImportDialog
      propertyId={propertyId} properties={properties} facilities={facilities} parkingTypes={parkingTypes}
      onFacilitiesChanged={loadReferenceData} onClose={() => setImportOpen(false)}
      onCommitted={async () => { setImportOpen(false); await loadParkingRows(propertyId, asOfDate); }}
    /> : null}
  </section>;
}

function ParkingImportDialog({ propertyId, properties, facilities, parkingTypes, onFacilitiesChanged, onClose, onCommitted }: {
  propertyId: string;
  properties: PropertyOption[];
  facilities: ParkingFacility[];
  parkingTypes: ParkingType[];
  onFacilitiesChanged: () => Promise<void>;
  onClose: () => void;
  onCommitted: () => Promise<void>;
}) {
  const [selectedPropertyId, setSelectedPropertyId] = useState(propertyId);
  const [facilityId, setFacilityId] = useState(facilities.find((facility) => facility.property_id === propertyId)?.parking_facility_id ?? '');
  const [asOfDate, setAsOfDate] = useState(today);
  const [batchId, setBatchId] = useState('');
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [mainContracts, setMainContracts] = useState<MainContractCandidate[]>([]);
  const [tenantQueries, setTenantQueries] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [showFacilityForm, setShowFacilityForm] = useState(false);
  const [facilityCode, setFacilityCode] = useState('MAIN');
  const [facilityName, setFacilityName] = useState('');
  const [parkingTypeId, setParkingTypeId] = useState('');

  const propertyFacilities = facilities.filter((facility) => facility.property_id === selectedPropertyId);
  const selectedProperty = properties.find((property) => property.asset_id === selectedPropertyId);
  const propertyTenantIds = useMemo(() => new Set(mainContracts.map((contract) => contract.tenant_id)), [mainContracts]);
  const tenantById = useMemo(() => new Map(tenants.map((tenant) => [tenant.tenant_id, tenant])), [tenants]);

  useEffect(() => {
    if (!supabase) return;
    void Promise.all([
      supabase.from('tenant_master').select('tenant_id, tenant_name').order('tenant_name'),
      supabase.from('parking_main_contract_candidate').select('*').eq('property_id', selectedPropertyId),
    ]).then(([tenantResult, contractResult]) => {
      setTenants((tenantResult.data ?? []) as TenantOption[]);
      setMainContracts((contractResult.data ?? []) as MainContractCandidate[]);
    });
  }, [selectedPropertyId]);

  const createFacility = async () => {
    if (!supabase || !facilityCode.trim() || !facilityName.trim()) return;
    setBusy(true); setMessage('');
    const { data, error } = await supabase.from('parking_facility_master').insert({
      property_id: selectedPropertyId,
      facility_code: facilityCode.trim().toUpperCase(),
      facility_name: facilityName.trim(),
      parking_type_id: parkingTypeId ? Number(parkingTypeId) : null,
    }).select('parking_facility_id').single();
    if (error) setMessage(`施設を登録できませんでした: ${error.message}`);
    else { await onFacilitiesChanged(); setFacilityId(data.parking_facility_id); setShowFacilityForm(false); }
    setBusy(false);
  };

  const loadBatchRows = async (nextBatchId: string) => {
    if (!supabase) return;
    const { data, error } = await supabase.from('parking_import_row').select('*')
      .eq('parking_import_batch_id', nextBatchId).order('source_row_number');
    if (error) throw error;
    setRows((data ?? []) as ImportRow[]);
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !supabase || !facilityId) return;
    setBusy(true); setMessage('Excelを解析しています…');
    try {
      const [{ sheetName, rows: parsedRows }, fileHash] = await Promise.all([
        atImportStage('Excel解析', () => parseParkingWorkbook(file)),
        atImportStage('ファイル照合値の計算', () => hashFile(file)),
      ]);
      const { data, error } = await supabase.rpc('prepare_parking_import', {
        p_property_id: selectedPropertyId,
        p_parking_facility_id: facilityId,
        p_as_of_date: asOfDate,
        p_source_file_name: file.name,
        p_source_sheet_name: sheetName,
        p_source_file_hash: fileHash,
        p_rows: parsedRows,
      });
      if (error) throw new Error(`取込準備RPC: ${describeUnknownError(error)}`);
      setBatchId(String(data));
      await loadBatchRows(String(data));
      setMessage(`${parsedRows.length}行を読み込みました。状態・契約先・内外区分を確認してください。`);
    } catch (loadError) {
      console.error('Parking Excel import failed', loadError);
      setMessage(`Excelを読み込めませんでした: ${describeUnknownError(loadError)}`);
    }
    setBusy(false);
  };

  const updateRow = (rowId: string, patch: Partial<ImportRow>) => {
    setRows((current) => current.map((row) => row.parking_import_row_id === rowId ? { ...row, ...patch } : row));
  };

  const setImportStatus = (row: ImportRow, status: ParkingImportStatus) => {
    updateRow(row.parking_import_row_id, { raw_payload: { ...(row.raw_payload ?? {}), is_vacant: status === 'vacant' } });
  };

  const applyScopeToAll = (scope: ParkingScope) => {
    setRows((current) => current.map((row) => isVacantImportRow(row) ? row : ({
      ...row, parking_scope: scope, main_lease_contract_id: scope === 'external' ? null : row.main_lease_contract_id,
    })));
  };

  const tenantChoices = (row: ImportRow): TenantOption[] => {
    const search = normalizeText(tenantQueries[row.parking_import_row_id] ?? '');
    const selectedTenant = row.matched_tenant_id ? tenantById.get(row.matched_tenant_id) : undefined;
    let choices = search
      ? tenants.filter((tenant) => normalizeText(tenant.tenant_name).includes(search))
      : tenants.filter((tenant) => propertyTenantIds.has(tenant.tenant_id));
    choices = [...choices].sort((left, right) => {
      const leftProperty = propertyTenantIds.has(left.tenant_id) ? 0 : 1;
      const rightProperty = propertyTenantIds.has(right.tenant_id) ? 0 : 1;
      return leftProperty - rightProperty || collator.compare(left.tenant_name, right.tenant_name);
    }).slice(0, 50);
    if (selectedTenant && !choices.some((tenant) => tenant.tenant_id === selectedTenant.tenant_id)) choices.unshift(selectedTenant);
    return choices;
  };

  const ready = rows.length > 0 && rows.every((row) => isVacantImportRow(row) || Boolean(
    row.matched_tenant_id && row.parking_scope && (row.parking_scope === 'external' || row.main_lease_contract_id),
  ));

  const commit = async () => {
    if (!supabase || !batchId || !ready) return;
    setBusy(true); setMessage('取込内容を反映しています…');
    try {
      const results = await Promise.all(rows.map((row) => {
        const vacant = isVacantImportRow(row);
        return supabase!.from('parking_import_row').update({
          matched_tenant_id: vacant ? null : row.matched_tenant_id,
          parking_scope: vacant ? null : row.parking_scope,
          main_lease_contract_id: vacant || row.parking_scope !== 'internal' ? null : row.main_lease_contract_id,
          raw_payload: { ...(row.raw_payload ?? {}), is_vacant: vacant },
          validation_status: 'ready',
          validation_messages: vacant ? ['空き区画として登録します'] : [],
        }).eq('parking_import_row_id', row.parking_import_row_id);
      }));
      const updateError = results.find((result) => result.error)?.error;
      if (updateError) throw updateError;
      const { error } = await supabase.rpc('commit_parking_import', { p_batch_id: batchId });
      if (error) throw error;
      await onCommitted();
    } catch (commitError) {
      console.error('Parking Excel commit failed', commitError);
      setMessage(`反映できませんでした: ${describeUnknownError(commitError)}`);
    }
    setBusy(false);
  };

  const completedRows = rows.filter((row) => isVacantImportRow(row) || Boolean(
    row.matched_tenant_id && row.parking_scope && (row.parking_scope === 'external' || row.main_lease_contract_id),
  )).length;

  return <div className="parking-import-backdrop"><div className="parking-import-dialog" role="dialog" aria-modal="true" aria-labelledby="parking-import-title">
    <header><div><p className="section-kicker">PARKING IMPORT</p><h2 id="parking-import-title">駐車場Excel取込</h2></div><button onClick={onClose} aria-label="取込画面を閉じる">×</button></header>
    <div className="parking-import-controls">
      <label>物件<select value={selectedPropertyId} disabled={Boolean(batchId)} onChange={(event) => {
        const next = event.target.value;
        setSelectedPropertyId(next);
        setFacilityId(facilities.find((facility) => facility.property_id === next)?.parking_facility_id ?? '');
        setTenantQueries({});
      }}>{properties.map((property) => <option key={property.asset_id} value={property.asset_id}>{property.asset_name}</option>)}</select></label>
      <label>駐車場施設<select value={facilityId} disabled={Boolean(batchId)} onChange={(event) => setFacilityId(event.target.value)}>
        <option value="">施設を選択</option>{propertyFacilities.map((facility) => <option key={facility.parking_facility_id} value={facility.parking_facility_id}>{facility.facility_name}</option>)}
      </select></label>
      <label>基準日<input type="date" value={asOfDate} disabled={Boolean(batchId)} onChange={(event) => setAsOfDate(event.target.value)} /></label>
      {!batchId ? <button className="secondary-button" onClick={() => void downloadParkingTemplate()}>標準ひな型</button> : null}
      {!batchId ? <button className="secondary-button" onClick={() => { setFacilityName(`${selectedProperty?.asset_name ?? ''} 駐車場`); setShowFacilityForm(true); }}>施設を追加</button> : null}
      {!batchId ? <label className="parking-file-button">Excelを選択<input type="file" accept=".xlsx" disabled={!facilityId || busy} onChange={(event) => void handleFile(event)} /></label> : null}
    </div>

    {showFacilityForm ? <div className="parking-facility-form">
      <label>施設コード<input value={facilityCode} onChange={(event) => setFacilityCode(event.target.value)} /></label>
      <label>施設名<input value={facilityName} onChange={(event) => setFacilityName(event.target.value)} /></label>
      <label>駐車場種別<select value={parkingTypeId} onChange={(event) => setParkingTypeId(event.target.value)}><option value="">未設定</option>{parkingTypes.map((type) => <option key={type.parking_type_id} value={type.parking_type_id}>{type.parking_type_name}</option>)}</select></label>
      <button className="primary-button" disabled={busy || !facilityCode.trim() || !facilityName.trim()} onClick={() => void createFacility()}>施設を登録</button>
    </div> : null}

    {message ? <p className="parking-import-message">{message}</p> : null}
    {rows.length ? <>
      <div className="parking-import-bulk"><span>契約中の行を一括設定</span><button onClick={() => applyScopeToAll('internal')}>すべて内部</button><button onClick={() => applyScopeToAll('external')}>すべて外部</button></div>
      <div className="parking-import-table-wrap"><table className="parking-import-table"><thead><tr><th>行</th><th>枠</th><th>状態</th><th>契約先</th><th>内外</th><th>主契約</th><th>暗証番号</th><th>車両</th><th>備考</th></tr></thead><tbody>
        {rows.map((row) => {
          const vacant = isVacantImportRow(row);
          const candidates = mainContracts.filter((contract) => contract.tenant_id === row.matched_tenant_id);
          const choices = tenantChoices(row);
          const needsAction = !vacant && (!row.matched_tenant_id || !row.parking_scope || row.parking_scope === 'internal' && !row.main_lease_contract_id);
          return <tr key={row.parking_import_row_id} className={needsAction ? 'needs-action' : ''}>
            <td>{row.source_row_number}</td><td><strong>{row.space_number}</strong></td>
            <td><select value={vacant ? 'vacant' : 'occupied'} onChange={(event) => setImportStatus(row, event.target.value as ParkingImportStatus)}><option value="occupied">契約中</option><option value="vacant">空き</option></select></td>
            <td>{vacant ? <strong>空き区画</strong> : <>
              <span>{row.tenant_name}</span>
              <input value={tenantQueries[row.parking_import_row_id] ?? ''} onChange={(event) => setTenantQueries((current) => ({ ...current, [row.parking_import_row_id]: event.target.value }))} placeholder="契約先を検索" aria-label={`枠${row.space_number}の契約先を検索`} />
              <select value={row.matched_tenant_id ?? ''} onChange={(event) => updateRow(row.parking_import_row_id, { matched_tenant_id: event.target.value || null, main_lease_contract_id: null })}>
                <option value="">契約先を選択</option>{choices.map((tenant) => <option key={tenant.tenant_id} value={tenant.tenant_id}>{propertyTenantIds.has(tenant.tenant_id) ? '【物件内】' : ''}{tenant.tenant_name}</option>)}
              </select>
              <small>{tenantQueries[row.parking_import_row_id]?.trim() ? `検索結果 ${choices.length}件` : `物件内候補 ${propertyTenantIds.size}件。見つからない場合は検索`}</small>
            </>}</td>
            <td>{vacant ? '—' : <select value={row.parking_scope ?? ''} onChange={(event) => updateRow(row.parking_import_row_id, { parking_scope: event.target.value as ParkingScope || null, main_lease_contract_id: event.target.value === 'external' ? null : row.main_lease_contract_id })}><option value="">未選択</option><option value="internal">内部</option><option value="external">外部</option></select>}</td>
            <td>{!vacant && row.parking_scope === 'internal' ? <select value={row.main_lease_contract_id ?? ''} onChange={(event) => updateRow(row.parking_import_row_id, { main_lease_contract_id: event.target.value || null })}><option value="">主契約を選択</option>{candidates.map((contract) => <option key={contract.lease_contract_id} value={contract.lease_contract_id}>{contract.unit_labels} / {displayDate(contract.contract_start_date)}</option>)}</select> : '—'}</td>
            <td className="access-code">{row.access_code || '—'}</td>
            <td>{vacant ? '—' : <>{row.vehicle_model || '—'}<small>{row.registration_number || ''}</small></>}</td><td>{row.notes || '—'}</td>
          </tr>;
        })}
      </tbody></table></div>
    </> : <div className="parking-import-empty"><strong>.xlsxを選択してください</strong><p>標準ひな型を利用すると、列名の表記ゆれを気にせず取り込めます。既存ファイルも代表的な表記ゆれを吸収します。</p></div>}
    <footer><span>{rows.length ? `${completedRows} / ${rows.length} 行の確認完了` : ''}</span><div><button className="secondary-button" onClick={onClose}>キャンセル</button><button className="primary-button" disabled={!ready || busy} onClick={() => void commit()}>{busy ? '処理中…' : '確認して反映'}</button></div></footer>
  </div></div>;
}
