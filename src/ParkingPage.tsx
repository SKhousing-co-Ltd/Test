import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { supabase } from './lib/supabase';

type ParkingScope = 'internal' | 'external';

type PropertyOption = {
  asset_id: string;
  asset_name: string;
  short_name: string | null;
};

type ParkingType = {
  parking_type_id: number;
  parking_type_name: string;
};

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

type TenantOption = {
  tenant_id: string;
  tenant_name: string;
};

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
      // Circular or host objects fall back to String below.
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
  const headerIndexes = new Map<string, number>();
  sheet.eachRow((row, rowNumber) => {
    if (headerRow) return;
    const labels = row.values as Array<unknown>;
    const hasSpace = labels.some((value) => String(value ?? '').trim() === '枠番');
    const hasTenant = labels.some((value) => String(value ?? '').trim() === 'テナント名');
    if (!hasSpace || !hasTenant) return;
    headerRow = rowNumber;
    row.eachCell((cell, columnNumber) => headerIndexes.set(cell.text.trim(), columnNumber));
  });
  if (!headerRow) throw new Error('「枠番」「テナント名」を含む見出し行が見つかりません。');

  const requiredHeaders = ['枠番', '暗証番号', '階', 'テナント名', '車種', '車両番号', '車台番号', '契約開始日', '備考'];
  const missing = requiredHeaders.filter((header) => !headerIndexes.has(header));
  if (missing.length) throw new Error(`必要な列がありません: ${missing.join('、')}`);

  const rows: ParsedImportRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const cell = (header: string) => row.getCell(headerIndexes.get(header)!);
    const spaceNumber = cell('枠番').text.trim();
    const tenantName = cell('テナント名').text.trim();
    if (!spaceNumber || spaceNumber === '計' || !tenantName) return;
    rows.push({
      source_row_number: rowNumber,
      space_number: spaceNumber,
      access_code: cell('暗証番号').text.trim(),
      tenant_location_label: cell('階').text.trim(),
      tenant_name: tenantName,
      vehicle_model: cell('車種').text.trim(),
      registration_number: cell('車両番号').text.trim(),
      chassis_number: cell('車台番号').text.trim(),
      contract_start_date: excelDate(cell('契約開始日').value, cell('契約開始日').text),
      notes: cell('備考').text.trim(),
    });
  });
  if (!rows.length) throw new Error('取込可能な明細がありません。');
  return { sheetName: sheet.name, rows };
}

export function ParkingPage({ canManage }: { canManage: boolean }) {
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [facilities, setFacilities] = useState<ParkingFacility[]>([]);
  const [parkingTypes, setParkingTypes] = useState<ParkingType[]>([]);
  const [rows, setRows] = useState<ParkingCurrentRow[]>([]);
  const [propertyId, setPropertyId] = useState('');
  const [asOfDate, setAsOfDate] = useState(today);
  const [scopeFilter, setScopeFilter] = useState<'all' | ParkingScope | 'vacant'>('all');
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
    void loadReferenceData().catch((loadError: Error) => { setError(`マスタを読み込めませんでした: ${loadError.message}`); setLoading(false); });
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

  const filteredRows = useMemo(() => {
    const normalized = query.normalize('NFKC').toLocaleLowerCase('ja-JP').trim();
    return rows.filter((row) => {
      const matchesScope = scopeFilter === 'all'
        || (scopeFilter === 'vacant' ? !row.lease_contract_id : row.parking_scope === scopeFilter);
      const matchesQuery = !normalized || [row.space_number, row.unit_code, row.tenant_name, row.access_code,
        row.vehicle_model, row.registration_number, row.chassis_number]
        .some((value) => value?.normalize('NFKC').toLocaleLowerCase('ja-JP').includes(normalized));
      return matchesScope && matchesQuery;
    }).sort((left, right) => collator.compare(left.space_number, right.space_number));
  }, [query, rows, scopeFilter]);

  const summary = useMemo(() => ({
    total: rows.length,
    occupied: rows.filter((row) => row.lease_contract_id).length,
    vacant: rows.filter((row) => !row.lease_contract_id).length,
    internal: rows.filter((row) => row.parking_scope === 'internal').length,
  }), [rows]);

  const selectedProperty = properties.find((property) => property.asset_id === propertyId);

  return <section className="parking-page">
    <div className="parking-heading">
      <div><p className="section-kicker">PARKING LEDGER</p><h2>駐車場台帳</h2><p>レントロールに統合された駐車枠を、空き状況・暗証番号・車両情報から確認します。</p></div>
      {canManage ? <button className="primary-button" onClick={() => setImportOpen(true)}>Excelを取り込む</button> : null}
    </div>

    <div className="parking-toolbar">
      <label>物件<select value={propertyId} onChange={(event) => { setPropertyId(event.target.value); setSelected(null); }}>
        {properties.map((property) => <option key={property.asset_id} value={property.asset_id}>{property.short_name || property.asset_name}</option>)}
      </select></label>
      <label>基準日<input type="date" value={asOfDate} onChange={(event) => { setAsOfDate(event.target.value); setSelected(null); }} /></label>
      <label>区分<select value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value as typeof scopeFilter)}>
        <option value="all">すべて</option><option value="internal">内部</option><option value="external">外部</option><option value="vacant">空き枠</option>
      </select></label>
      <label className="parking-search">枠・テナント・車両を検索<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="枠番、テナント名、車両番号、暗証番号" /></label>
    </div>

    {error ? <p className="parking-notice">{error}</p> : null}
    <div className="parking-metrics">
      <div><span>総枠数</span><strong>{summary.total}</strong></div>
      <div><span>契約中</span><strong>{summary.occupied}</strong></div>
      <div><span>空き</span><strong>{summary.vacant}</strong></div>
      <div><span>内部</span><strong>{summary.internal}</strong></div>
    </div>

    <div className="parking-layout">
      <div className="parking-panel">
        <header><div><h3>{selectedProperty?.asset_name ?? '物件を選択'}</h3><p>{loading ? '読み込み中…' : `${filteredRows.length} / ${rows.length} 枠`}</p></div></header>
        <div className="parking-table-wrap"><table className="parking-table">
          <thead><tr><th>状態</th><th>枠番</th><th>内外</th><th>テナント</th><th>暗証番号</th><th>車種</th><th>車両番号</th><th>車台番号</th><th>主契約</th></tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={9} className="parking-empty">駐車場台帳を読み込んでいます。</td></tr> : null}
            {!loading && !filteredRows.length ? <tr><td colSpan={9} className="parking-empty">条件に一致する駐車枠がありません。</td></tr> : null}
            {!loading ? filteredRows.map((row) => <tr key={row.unit_id} className={selected?.unit_id === row.unit_id ? 'selected' : ''} onClick={() => setSelected(row)}>
              <td><span className={`parking-state ${row.lease_contract_id ? 'occupied' : 'vacant'}`}>{row.lease_contract_id ? '契約中' : '空き'}</span></td>
              <td><strong>{row.space_number}</strong><small>{row.facility_name}</small></td>
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
        </> : <div className="parking-detail-empty"><strong>枠を選択</strong><p>契約・暗証番号・車両履歴を確認できます。</p></div>}
      </aside>
    </div>

    {importOpen ? <ParkingImportDialog
      propertyId={propertyId}
      properties={properties}
      facilities={facilities}
      parkingTypes={parkingTypes}
      onFacilitiesChanged={loadReferenceData}
      onClose={() => setImportOpen(false)}
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
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [showFacilityForm, setShowFacilityForm] = useState(false);
  const [facilityCode, setFacilityCode] = useState('MAIN');
  const [facilityName, setFacilityName] = useState('');
  const [parkingTypeId, setParkingTypeId] = useState('');

  const propertyFacilities = facilities.filter((facility) => facility.property_id === selectedPropertyId);
  const selectedProperty = properties.find((property) => property.asset_id === selectedPropertyId);

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
      setMessage(`${parsedRows.length}行を読み込みました。内外区分と契約を確認してください。`);
    } catch (loadError) {
      console.error('Parking Excel import failed', loadError);
      setMessage(`Excelを読み込めませんでした: ${describeUnknownError(loadError)}`);
    }
    setBusy(false);
  };

  const updateRow = (rowId: string, patch: Partial<ImportRow>) => {
    setRows((current) => current.map((row) => row.parking_import_row_id === rowId ? { ...row, ...patch } : row));
  };

  const applyScopeToAll = (scope: ParkingScope) => {
    setRows((current) => current.map((row) => ({ ...row, parking_scope: scope, main_lease_contract_id: scope === 'external' ? null : row.main_lease_contract_id })));
  };

  const ready = rows.length > 0 && rows.every((row) => row.matched_tenant_id && row.parking_scope
    && (row.parking_scope === 'external' || row.main_lease_contract_id));

  const commit = async () => {
    if (!supabase || !batchId || !ready) return;
    setBusy(true); setMessage('取込内容を反映しています…');
    try {
      const results = await Promise.all(rows.map((row) => supabase!.from('parking_import_row').update({
        matched_tenant_id: row.matched_tenant_id,
        parking_scope: row.parking_scope,
        main_lease_contract_id: row.parking_scope === 'internal' ? row.main_lease_contract_id : null,
        validation_status: 'ready', validation_messages: [],
      }).eq('parking_import_row_id', row.parking_import_row_id)));
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

  return <div className="parking-import-backdrop"><div className="parking-import-dialog" role="dialog" aria-modal="true" aria-labelledby="parking-import-title">
    <header><div><p className="section-kicker">PARKING IMPORT</p><h2 id="parking-import-title">駐車場Excel取込</h2></div><button onClick={onClose} aria-label="取込画面を閉じる">×</button></header>
    <div className="parking-import-controls">
      <label>物件<select value={selectedPropertyId} disabled={Boolean(batchId)} onChange={(event) => {
        const next = event.target.value; setSelectedPropertyId(next); setFacilityId(facilities.find((facility) => facility.property_id === next)?.parking_facility_id ?? '');
      }}>{properties.map((property) => <option key={property.asset_id} value={property.asset_id}>{property.asset_name}</option>)}</select></label>
      <label>駐車場施設<select value={facilityId} disabled={Boolean(batchId)} onChange={(event) => setFacilityId(event.target.value)}>
        <option value="">施設を選択</option>{propertyFacilities.map((facility) => <option key={facility.parking_facility_id} value={facility.parking_facility_id}>{facility.facility_name}</option>)}
      </select></label>
      <label>基準日<input type="date" value={asOfDate} disabled={Boolean(batchId)} onChange={(event) => setAsOfDate(event.target.value)} /></label>
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
      <div className="parking-import-bulk"><span>一括設定</span><button onClick={() => applyScopeToAll('internal')}>すべて内部</button><button onClick={() => applyScopeToAll('external')}>すべて外部</button></div>
      <div className="parking-import-table-wrap"><table className="parking-import-table"><thead><tr><th>行</th><th>枠</th><th>テナント</th><th>内外</th><th>主契約</th><th>暗証番号</th><th>車両</th><th>備考</th></tr></thead><tbody>
        {rows.map((row) => {
          const candidates = mainContracts.filter((contract) => contract.tenant_id === row.matched_tenant_id);
          return <tr key={row.parking_import_row_id} className={!row.matched_tenant_id || !row.parking_scope || row.parking_scope === 'internal' && !row.main_lease_contract_id ? 'needs-action' : ''}>
            <td>{row.source_row_number}</td><td><strong>{row.space_number}</strong></td>
            <td><span>{row.tenant_name}</span><select value={row.matched_tenant_id ?? ''} onChange={(event) => updateRow(row.parking_import_row_id, { matched_tenant_id: event.target.value || null, main_lease_contract_id: null })}>
              <option value="">テナントを選択</option>{tenants.map((tenant) => <option key={tenant.tenant_id} value={tenant.tenant_id}>{tenant.tenant_name}</option>)}
            </select></td>
            <td><select value={row.parking_scope ?? ''} onChange={(event) => updateRow(row.parking_import_row_id, { parking_scope: event.target.value as ParkingScope || null, main_lease_contract_id: event.target.value === 'external' ? null : row.main_lease_contract_id })}>
              <option value="">未選択</option><option value="internal">内部</option><option value="external">外部</option>
            </select></td>
            <td>{row.parking_scope === 'internal' ? <select value={row.main_lease_contract_id ?? ''} onChange={(event) => updateRow(row.parking_import_row_id, { main_lease_contract_id: event.target.value || null })}>
              <option value="">主契約を選択</option>{candidates.map((contract) => <option key={contract.lease_contract_id} value={contract.lease_contract_id}>{contract.unit_labels} / {displayDate(contract.contract_start_date)}</option>)}
            </select> : '—'}</td>
            <td className="access-code">{row.access_code || '—'}</td>
            <td>{row.vehicle_model || '—'}<small>{row.registration_number || ''}</small></td><td>{row.notes || '—'}</td>
          </tr>;
        })}
      </tbody></table></div>
    </> : <div className="parking-import-empty"><strong>.xlsxを選択してください</strong><p>枠番・テナント・車両情報を解析し、契約候補を表示します。</p></div>}
    <footer><span>{rows.length ? `${rows.filter((row) => row.parking_scope).length} / ${rows.length} 行の内外区分を設定` : ''}</span><div><button className="secondary-button" onClick={onClose}>キャンセル</button><button className="primary-button" disabled={!ready || busy} onClick={() => void commit()}>{busy ? '処理中…' : '確認して反映'}</button></div></footer>
  </div></div>;
}
