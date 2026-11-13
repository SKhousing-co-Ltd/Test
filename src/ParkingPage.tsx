import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from './lib/supabase';
import { ParkingDetailModal } from './ParkingDetailModal';

type ParkingScope = 'internal' | 'external';
export type ParkingSpaceStatus = 'occupied' | 'vacant' | 'unavailable';

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
  unit_type?: string;
  snapshot_as_of_date: string;
  space_status: ParkingSpaceStatus;
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
  termination_in_progress?: boolean;
  termination_date?: string | null;
  termination_scheduled?: boolean;
  contract_status: string | null;
  contract_start_date: string | null;
  contract_end_date: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  parking_scope: ParkingScope | null;
  main_lease_contract_id: string | null;
  main_contract_start_date: string | null;
  main_contract_end_date: string | null;
  main_lease_contract_unit_id: string | null;
  monthly_parking_fee: number;
  parking_fee_effective_from: string | null;
  access_code: string | null;
  tenant_location_label: string | null;
  notes: string | null;
  vehicle_model: string | null;
  registration_number: string | null;
  chassis_number: string | null;
  vehicle_effective_from: string | null;
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

function parkingStatusLabel(status: ParkingSpaceStatus): string {
  if (status === 'occupied') return '契約中';
  if (status === 'unavailable') return '使用不可';
  return '空き';
}

function formatJapaneseDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : value;
}

function parkingRowStatusLabel(row: ParkingCurrentRow): string {
  if (row.termination_in_progress && !row.termination_date) return '契約手続き中';
  return row.termination_scheduled ? '退去予定' : parkingStatusLabel(row.space_status);
}

export function ParkingPage({ canManage }: { canManage: boolean }) {
  const [searchParams] = useSearchParams();
  const targetContractUnitId = searchParams.get('contractUnit');
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [facilities, setFacilities] = useState<ParkingFacility[]>([]);
  const [parkingTypes, setParkingTypes] = useState<ParkingType[]>([]);
  const [rows, setRows] = useState<ParkingCurrentRow[]>([]);
  const [ledgerType, setLedgerType] = useState<'parking' | 'bicycle_parking'>('parking');
  const [propertyId, setPropertyId] = useState('');
  const [asOfDate, setAsOfDate] = useState(today);
  const [scopeFilter, setScopeFilter] = useState<'all' | ParkingScope | 'vacant' | 'unavailable'>('all');
  const [facilityFilter, setFacilityFilter] = useState('all');
  const [parkingTypeFilter, setParkingTypeFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ParkingCurrentRow | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [vehicleHistory, setVehicleHistory] = useState<VehicleHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadReferenceData = async () => {
    if (!supabase) return;
    const [propertyResult, facilityResult, typeResult] = await Promise.all([
      supabase.from('asset_master').select('asset_id, asset_name, short_name').eq('is_parking_ledger_visible', true).order('asset_code'),
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
    if (!propertyRows.length) {
      setRows([]);
      setLoading(false);
    }
  };

  const loadParkingRows = async (nextPropertyId: string, nextAsOfDate: string) => {
    if (!supabase || !nextPropertyId) return;
    setLoading(true);
    const { data, error: loadError } = await supabase.rpc('parking_list_at_date', {
      p_property_id: nextPropertyId,
      p_as_of_date: nextAsOfDate,
    });
    if (loadError) setError(`駐車場台帳を読み込めませんでした: ${loadError.message}`);
    else {
      const baseRows = (data ?? []) as unknown as ParkingCurrentRow[];
      const unitIds = [...new Set(baseRows.map((row) => row.unit_id))];
      const unitResults = await Promise.all(Array.from({ length: Math.ceil(unitIds.length / 200) }, (_, index) =>
        supabase!.from('unit_master').select('unit_id, unit_type').in('unit_id', unitIds.slice(index * 200, (index + 1) * 200))));
      const unitError = unitResults.find((result) => result.error)?.error;
      if (unitError) { setError(`区画種別を読み込めませんでした: ${unitError.message}`); setRows([]); setLoading(false); return; }
      const unitTypes = new Map(unitResults.flatMap((result) => result.data ?? []).map((unit) => [unit.unit_id, unit.unit_type]));
      if (unitIds.some((id) => !unitTypes.has(id))) { setError('一部の区画種別を確認できません。再読み込みしてください。'); setRows([]); setLoading(false); return; }
      const contractIds = [...new Set(baseRows.map((row) => row.lease_contract_id).filter((id): id is string => Boolean(id)))];
      const pendingResult = nextAsOfDate < today || !contractIds.length
        ? { data: [], error: null }
        : await supabase.from('appsuite_termination_workflow')
          .select('lease_contract_id, termination_date, target_scope, lease_contract_unit_ids, contract_selections')
          .eq('status', 'in_progress');
      if (pendingResult.error) setError(`解約手続き中の情報を読み込めませんでした: ${pendingResult.error.message}`);
      else {
        const pending = (pendingResult.data ?? []) as Array<{
          lease_contract_id: string;
          termination_date: string;
          target_scope: 'contract' | 'unit' | 'parking';
          lease_contract_unit_ids: string[];
          contract_selections: Array<{ lease_contract_id: string; lease_contract_unit_ids: string[] }> | null;
        }>;
        setRows(baseRows.map((row) => {
          const workflow = pending.find((entry) => {
            const selection = entry.contract_selections?.find((candidate) => candidate.lease_contract_id === row.lease_contract_id);
            const unitIds = selection?.lease_contract_unit_ids ?? entry.lease_contract_unit_ids;
            return (selection ? true : entry.lease_contract_id === row.lease_contract_id)
              && (entry.target_scope === 'contract' || unitIds.includes(row.lease_contract_unit_id ?? ''));
          });
          const futureTerminationDate = workflow?.termination_date && workflow.termination_date > nextAsOfDate
            ? workflow.termination_date
            : null;
          const futureContractEndDate = row.contract_end_date && row.contract_end_date > nextAsOfDate
            ? row.contract_end_date
            : null;
          return {
            ...row,
            unit_type: unitTypes.get(row.unit_id),
            termination_in_progress: Boolean(workflow),
            termination_scheduled: Boolean(futureTerminationDate || futureContractEndDate),
            termination_date: futureTerminationDate ?? futureContractEndDate,
          };
        }));
        setError('');
      }
    }
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
    if (!supabase || !targetContractUnitId || !properties.length) return;
    void supabase.from('lease_contract_unit').select('unit:unit_master(property_id)').eq('lease_contract_unit_id', targetContractUnitId).maybeSingle()
      .then(({ data }) => {
        const unit = (data as { unit?: { property_id?: string } | { property_id?: string }[] } | null)?.unit;
        const property = Array.isArray(unit) ? unit[0]?.property_id : unit?.property_id;
        if (property && properties.some((option) => option.asset_id === property)) setPropertyId(property);
      });
  }, [properties, targetContractUnitId]);

  useEffect(() => {
    if (!targetContractUnitId) return;
    const target = rows.find((row) => row.lease_contract_unit_id === targetContractUnitId);
    if (target) { setLedgerType(target.unit_type === 'bicycle_parking' ? 'bicycle_parking' : 'parking'); setSelected(target); setDetailOpen(true); }
  }, [rows, targetContractUnitId]);

  useEffect(() => {
    if (!supabase || !selected?.lease_contract_unit_id || selected.unit_type === 'bicycle_parking') { setVehicleHistory([]); return; }
    void supabase.from('parking_vehicle_history')
      .select('parking_vehicle_history_id, vehicle_model, registration_number, chassis_number, effective_from, effective_to, source_notes')
      .eq('lease_contract_unit_id', selected.lease_contract_unit_id)
      .order('effective_from', { ascending: false })
      .then(({ data }) => setVehicleHistory((data ?? []) as VehicleHistory[]));
  }, [selected?.lease_contract_unit_id, selected?.unit_type]);

  const propertyFacilities = useMemo(
    () => { const ids = new Set(rows.filter((row) => row.unit_type === ledgerType).map((row) => row.parking_facility_id)); return facilities.filter((facility) => facility.property_id === propertyId && ids.has(facility.parking_facility_id)); },
    [facilities, propertyId, rows, ledgerType],
  );

  const propertyParkingTypes = useMemo(() => {
    const usedTypeIds = new Set(propertyFacilities.map((facility) => facility.parking_type_id).filter((id): id is number => id !== null));
    return parkingTypes.filter((type) => usedTypeIds.has(type.parking_type_id));
  }, [parkingTypes, propertyFacilities]);

  const filteredRows = useMemo(() => {
    const normalized = query.normalize('NFKC').toLocaleLowerCase('ja-JP').trim();
    return rows.filter((row) => {
      if (row.unit_type !== ledgerType) return false;
      const matchesFacility = facilityFilter === 'all' || row.parking_facility_id === facilityFilter;
      const matchesParkingType = parkingTypeFilter === 'all' || String(row.parking_type_id ?? '') === parkingTypeFilter;
      const matchesScope = scopeFilter === 'all'
        || (scopeFilter === 'vacant' || scopeFilter === 'unavailable'
          ? row.space_status === scopeFilter
          : row.space_status === 'occupied' && row.parking_scope === scopeFilter);
      const matchesQuery = !normalized || [row.space_number, row.unit_code, row.facility_name, row.parking_type_name, row.tenant_name,
        ...(ledgerType === 'parking' ? [row.access_code, row.vehicle_model, row.registration_number, row.chassis_number] : [])]
        .some((value) => value?.normalize('NFKC').toLocaleLowerCase('ja-JP').includes(normalized));
      return matchesFacility && matchesParkingType && matchesScope && matchesQuery;
    }).sort((left, right) => collator.compare(left.facility_name, right.facility_name)
      || collator.compare(left.space_number, right.space_number));
  }, [facilityFilter, parkingTypeFilter, query, rows, scopeFilter, ledgerType]);

  const summary = useMemo(() => ({
    total: filteredRows.length,
    occupied: filteredRows.filter((row) => row.space_status === 'occupied').length,
    vacant: filteredRows.filter((row) => row.space_status === 'vacant').length,
    unavailable: filteredRows.filter((row) => row.space_status === 'unavailable').length,
  }), [filteredRows]);

  const selectedProperty = properties.find((property) => property.asset_id === propertyId);

  const changeProperty = (nextPropertyId: string) => {
    setPropertyId(nextPropertyId);
    setFacilityFilter('all');
    setParkingTypeFilter('all');
    setSelected(null);
    setDetailOpen(false);
  };

  return <section className="parking-page">
    <div className="parking-heading">
      <div><p className="section-kicker">PARKING & BICYCLE LEDGER</p><h2>駐車場・駐輪場台帳</h2><p>駐車場・バイク・自転車の契約を物件ごとに確認します。</p></div>

    </div>

    <div className="parking-ledger-tabs" role="tablist" aria-label="台帳の種別">
      {([['parking', '駐車場'], ['bicycle_parking', '駐輪場']] as const).map(([type, label]) => <button key={type} type="button" role="tab" aria-selected={ledgerType === type} className={ledgerType === type ? 'active' : ''} onClick={() => { setLedgerType(type); setFacilityFilter('all'); setParkingTypeFilter('all'); setSelected(null); setDetailOpen(false); }}>{label}</button>)}
    </div>

    <div className="parking-toolbar">
      <label>物件<select value={propertyId} onChange={(event) => changeProperty(event.target.value)}>
        {properties.map((property) => <option key={property.asset_id} value={property.asset_id}>{property.short_name || property.asset_name}</option>)}
      </select></label>
      <label>施設<select value={facilityFilter} onChange={(event) => { setFacilityFilter(event.target.value); setSelected(null); setDetailOpen(false); }}>
        <option value="all">すべての施設</option>
        {propertyFacilities.map((facility) => <option key={facility.parking_facility_id} value={facility.parking_facility_id}>{facility.facility_code}｜{facility.facility_name}</option>)}
      </select></label>
      {ledgerType === 'parking' && <label>駐車場種別<select value={parkingTypeFilter} onChange={(event) => { setParkingTypeFilter(event.target.value); setSelected(null); setDetailOpen(false); }}>
        <option value="all">すべての種別</option>
        {propertyParkingTypes.map((type) => <option key={type.parking_type_id} value={String(type.parking_type_id)}>{type.parking_type_name}</option>)}
      </select></label>}
      <label>基準日<input type="date" value={asOfDate} onChange={(event) => { setAsOfDate(event.target.value); setSelected(null); setDetailOpen(false); }} /></label>
      <label>状態・契約区分<select value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value as typeof scopeFilter)}>
        <option value="all">すべて</option><option value="internal">内部契約</option><option value="external">外部契約</option><option value="vacant">空き枠</option><option value="unavailable">使用不可</option>
      </select></label>
      <label className="parking-search">検索<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={ledgerType === 'parking' ? '枠番、施設、テナント、車両番号' : '枠番、施設、テナント'} /></label>
    </div>

    {error ? <p className="parking-notice">{error}</p> : null}
    <div className="parking-metrics">
      <div><span>表示枠数</span><strong>{summary.total}</strong></div>
      <div><span>契約中</span><strong>{summary.occupied}</strong></div>
      <div><span>空き</span><strong>{summary.vacant}</strong></div>
      <div><span>使用不可</span><strong>{summary.unavailable}</strong></div>
    </div>

    <div className="parking-layout">
      <div className="parking-panel">
        <header><div><h3>{selectedProperty?.asset_name ?? '物件を選択'}（{ledgerType === 'parking' ? '駐車場' : '駐輪場'}）</h3><p>{loading ? '読み込み中…' : `${filteredRows.length} / ${rows.filter((row) => row.unit_type === ledgerType).length} 枠を表示`}</p></div></header>
        <div className="parking-table-wrap"><table className="parking-table">
          <thead><tr><th>状態</th><th>枠番</th><th>内外</th><th>テナント</th>{ledgerType === 'bicycle_parking' && <><th>契約開始日</th><th>契約終了日</th></>}<th>月額駐車料</th>{ledgerType === 'parking' && <><th>暗証番号</th><th>車種</th><th>車両番号</th><th>車台番号</th></>}<th>主契約</th></tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={ledgerType === 'parking' ? 10 : 8} className="parking-empty">台帳を読み込んでいます。</td></tr> : null}
            {!loading && !filteredRows.length ? <tr><td colSpan={ledgerType === 'parking' ? 10 : 8} className="parking-empty">条件に一致する枠がありません。</td></tr> : null}
            {!loading ? filteredRows.map((row) => <tr key={row.unit_id} className={selected?.unit_id === row.unit_id ? 'selected' : ''} onClick={() => { setSelected(row); setDetailOpen(false); }}>
              <td><span className={`parking-state ${row.termination_scheduled ? 'scheduled' : row.space_status}`}>{parkingRowStatusLabel(row)}</span>{row.termination_scheduled && row.termination_date ? <small className="rent-roll-incoming-note">{formatJapaneseDate(row.termination_date)}{row.termination_in_progress ? '（手続き中）' : ''}</small> : null}</td>
              <td><strong>{row.space_number}</strong><small>{row.facility_name}{row.parking_type_name ? ` / ${row.parking_type_name}` : ''}</small></td>
              <td>{row.parking_scope === 'internal' ? '内部' : row.parking_scope === 'external' ? '外部' : '—'}</td>
              <td>{row.tenant_name || '—'}</td>{ledgerType === 'bicycle_parking' && <><td>{row.contract_start_date || '—'}</td><td>{row.space_status === 'occupied' ? row.contract_end_date || '継続中' : '—'}</td></>}<td>{row.space_status !== 'occupied' ? '—' : row.parking_fee_effective_from ? `${row.monthly_parking_fee.toLocaleString('ja-JP')}円` : <Link to={`/change-requests?parking=${encodeURIComponent(row.lease_contract_unit_id ?? '')}`} onClick={(event) => event.stopPropagation()}>未設定（対応依頼）</Link>}</td>{ledgerType === 'parking' && <><td className="access-code">{row.access_code || '—'}</td><td>{row.vehicle_model || '—'}</td><td>{row.registration_number || '—'}</td><td>{row.chassis_number || '—'}</td></>}
              <td>{row.main_lease_contract_id ? <span title={row.main_lease_contract_id}>事務所契約</span> : '—'}</td>
            </tr>) : null}
          </tbody>
        </table></div>
      </div>

      <aside className="parking-detail">
        {selected ? <>
          <header><div><p>SPACE</p><h3>枠 {selected.space_number}</h3></div><button onClick={() => { setSelected(null); setDetailOpen(false); }} aria-label="詳細を閉じる">×</button></header>
          <dl>
            <div><dt>施設</dt><dd>{selected.facility_name}</dd></div>
            {ledgerType === 'parking' && <div><dt>種別</dt><dd>{selected.parking_type_name || '—'}</dd></div>}
            <div><dt>状態</dt><dd>{parkingRowStatusLabel(selected)}{selected.termination_scheduled && selected.termination_date ? <small className="rent-roll-incoming-note">{formatJapaneseDate(selected.termination_date)}{selected.termination_in_progress ? '（手続き中）' : ''}</small> : null}</dd></div>
            <div><dt>区分</dt><dd>{selected.parking_scope === 'internal' ? '内部' : selected.parking_scope === 'external' ? '外部' : '—'}</dd></div>
            <div><dt>契約者</dt><dd>{selected.tenant_name || '—'}</dd></div>
            <div><dt>月額駐車料</dt><dd>{selected.space_status !== 'occupied' ? '—' : selected.parking_fee_effective_from ? `${selected.monthly_parking_fee.toLocaleString('ja-JP')}円` : <Link to={`/change-requests?parking=${encodeURIComponent(selected.lease_contract_unit_id ?? '')}`}>未設定（対応依頼を開く）</Link>}</dd></div>
            <div><dt>所在</dt><dd>{selected.tenant_location_label || '—'}</dd></div>
            <div><dt>子契約期間</dt><dd>{displayDate(selected.contract_start_date)} ～ {displayDate(selected.contract_end_date)}</dd></div>
            <div><dt>主契約期間</dt><dd>{selected.main_lease_contract_id ? `${displayDate(selected.main_contract_start_date)} ～ ${displayDate(selected.main_contract_end_date)}` : '—'}</dd></div>
            {ledgerType === 'parking' && <div><dt>暗証番号</dt><dd className="access-code">{selected.access_code || '—'}</dd></div>}
            <div><dt>備考</dt><dd>{selected.notes || '—'}</dd></div>
          </dl>
          <button className="parking-detail-more" onClick={() => setDetailOpen(true)}>詳細を見る</button>
          {ledgerType === 'parking' && <section><h4>車両履歴</h4>{vehicleHistory.length ? <ol>{vehicleHistory.map((vehicle) => <li key={vehicle.parking_vehicle_history_id}>
            <strong>{vehicle.vehicle_model || '車種未設定'}</strong><span>{vehicle.registration_number || '番号未設定'} / {vehicle.chassis_number || '車台番号未設定'}</span>
            <small>{displayDate(vehicle.effective_from)} ～ {displayDate(vehicle.effective_to)}</small>
          </li>)}</ol> : <p>登録された車両履歴はありません。</p>}</section>}
        </> : <div className="parking-detail-empty"><strong>枠を選択</strong><p>施設と契約の詳細を確認できます。</p></div>}
      </aside>
    </div>

    {detailOpen && selected ? <ParkingDetailModal
      row={selected}
      canManage={canManage}
      onClose={() => setDetailOpen(false)}
      onSaved={async () => {
        setDetailOpen(false);
        setSelected(null);
        await loadParkingRows(propertyId, asOfDate);
      }}
    /> : null}

  </section>;
}
