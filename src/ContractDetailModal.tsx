import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog } from './components/Dialog';
import { MainContractEditor } from './MainContractEditor';
import type { ContractCapabilities } from './lib/contract-capabilities';
import { supabase } from './lib/supabase';
import './ContractDetailModal.css';

export type ContractDetail = {
  lease_contract_id: string;
  lease_contract_unit_id: string;
  contract_row_version: number;
  contract_unit_row_version: number;
  tenant_id: string;
  tenant_name: string;
  external_tenant_code: string | null;
  property_id: string;
  property_name: string;
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  floor_label: string | null;
  unit_type: string;
  contract_status: string;
  contract_type: string | null;
  lease_term_type: 'ordinary' | 'fixed_term' | null;
  contract_start_date: string | null;
  contract_end_date: string | null;
  renewal_due_date: string | null;
  actual_end_date: string | null;
  renewed_from_contract_id: string | null;
  lease_start_date: string | null;
  lease_end_date: string | null;
  leased_area_sqm: number | null;
  monthly_rent_amount: number | null;
  monthly_common_charge_amount: number | null;
  monthly_total_amount: number | null;
  deposit_amount: number | null;
  security_deposit_amount: number | null;
  key_money_amount: number | null;
  renewal_fee_amount: number | null;
  renewal_terms: string | null;
  payment_terms: string | null;
  notes: string | null;
  source_system: string | null;
  source_record_key: string | null;
  updated_at: string;
};

export type ContractUnit = {
  lease_contract_unit_id: string;
  row_version: number;
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  floor_label: string | null;
  unit_type: string;
  leased_area_sqm: number | null;
  monthly_rent_amount: number | null;
  monthly_common_charge_amount: number | null;
  monthly_total_amount: number | null;
  lease_start_date: string | null;
  lease_end_date: string | null;
};

type ParkingContract = {
  lease_contract_unit_id: string;
  lease_contract_id: string;
  contract_status: string;
  lease_start_date: string | null;
  lease_end_date: string | null;
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  space_number: string | null;
  parking_scope: 'internal' | 'external' | null;
  monthly_parking_fee?: number | null;
  effective_from?: string | null;
  effective_to?: string | null;
  relationship_source: 'fee_history' | 'contract_header' | 'tenant_property_candidate';
};

type ContractDetailResponse = {
  as_of_date: string;
  contract: ContractDetail;
  contract_units: ContractUnit[];
  related_parking_contracts: ParkingContract[];
  parking_candidates: ParkingContract[];
};

type ContractDetailModalProps = {
  leaseContractUnitId: string;
  asOfDate: string;
  capabilities: ContractCapabilities;
  onClose: () => void;
  onChanged?: () => void;
};

const currency = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });
const statusLabels: Record<string, string> = {
  draft: '下書き', active: '契約中', scheduled: '解約予定', terminated: '終了', expired: '満了',
};

function date(value: string | null): string {
  return value || '—';
}

function money(value: number | null | undefined): string {
  return value == null ? '—' : currency.format(Number(value));
}

function leaseTermLabel(value: ContractDetail['lease_term_type']): string {
  return value === 'ordinary' ? '普通賃貸借' : value === 'fixed_term' ? '定期賃貸借' : '未確認';
}

function contractPeriod(contract: ContractDetail): string {
  if (contract.lease_term_type === 'ordinary') return `${date(contract.contract_start_date)} ～ 無期限`;
  if (contract.lease_term_type === 'fixed_term') return `${date(contract.contract_start_date)} ～ ${date(contract.contract_end_date)}`;
  return `${date(contract.contract_start_date)} ～ ${date(contract.contract_end_date)}（形態未確認）`;
}

function Field({ label, value }: { label: string; value: string }) {
  return <div className="contract-detail-field"><span>{label}</span><strong>{value}</strong></div>;
}

function ParkingRows({ rows, candidate = false, canEdit }: { rows: ParkingContract[]; candidate?: boolean; canEdit: boolean }) {
  const navigate = useNavigate();
  const [workingId, setWorkingId] = useState('');
  const openParking = async (row: ParkingContract) => {
    if (!canEdit || !supabase) return;
    setWorkingId(row.lease_contract_unit_id);
    if (row.monthly_parking_fee == null) {
      const { error } = await supabase.rpc('enqueue_parking_fee_change_request', {
        p_parking_lease_contract_unit_id: row.lease_contract_unit_id,
        p_import_batch_id: null,
        p_import_row_id: null,
      });
      setWorkingId('');
      if (error) { window.alert(`駐車料対応依頼を作成できませんでした: ${error.message}`); return; }
      navigate(`/change-requests?parking=${row.lease_contract_unit_id}`);
      return;
    }
    setWorkingId('');
    navigate(`/parking?contractUnit=${row.lease_contract_unit_id}`);
  };
  if (rows.length === 0) return <p className="contract-detail-empty">該当する駐車場契約はありません。</p>;
  return <div className="contract-detail-table-wrap"><table className="contract-detail-table">
    <thead><tr><th>車室</th><th>内外</th><th>月額駐車料</th><th>契約期間</th><th>関係</th>{canEdit && <th>操作</th>}</tr></thead>
    <tbody>{rows.map((row) => <tr key={`${row.relationship_source}-${row.lease_contract_unit_id}`}>
      <td><strong>{row.space_number || row.unit_name || row.unit_code}</strong><small>{row.unit_code}</small></td>
      <td>{row.parking_scope === 'internal' ? '内部' : row.parking_scope === 'external' ? '外部' : '—'}</td>
      <td className="numeric">{money(row.monthly_parking_fee)}</td>
      <td>{date(row.lease_start_date)} ～ {date(row.lease_end_date)}</td>
      <td>{candidate ? <span className="contract-relation candidate">未確定候補</span> : row.relationship_source === 'fee_history' ? <span className="contract-relation confirmed">料金履歴で確定</span> : <span className="contract-relation linked">契約ヘッダーで紐付け</span>}</td>
      {canEdit && <td><button type="button" className="secondary-button compact" disabled={workingId === row.lease_contract_unit_id} onClick={() => void openParking(row)}>{row.monthly_parking_fee == null ? '駐車料を登録' : '駐車場台帳で編集'}</button></td>}
    </tr>)}</tbody>
  </table></div>;
}

export function ContractDetailModal({ leaseContractUnitId, asOfDate, capabilities, onClose, onChanged }: ContractDetailModalProps) {
  const [detail, setDetail] = useState<ContractDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  const load = useCallback(async (cancelled: () => boolean = () => false) => {
      setLoading(true);
      setError('');
      if (!supabase || !capabilities.canViewContract) {
        setError('契約情報を閲覧する権限がありません。');
        setLoading(false);
        return;
      }
      const { data, error: loadError } = await supabase.rpc('contract_term_detail_for_audit', {
        p_lease_contract_unit_id: leaseContractUnitId,
        p_as_of_date: asOfDate,
      });
      if (cancelled()) return;
      if (loadError) {
        setError(`契約情報を取得できませんでした: ${loadError.message}`);
      } else {
        setDetail(data as ContractDetailResponse);
      }
      setLoading(false);
  }, [asOfDate, capabilities.canViewContract, leaseContractUnitId]);

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => { cancelled = true; };
  }, [load]);

  const contract = detail?.contract;
  return <Dialog title="契約詳細" onClose={onClose} className="contract-detail-dialog">
    {loading && <p className="contract-detail-loading">契約情報を読み込んでいます。</p>}
    {error && <div className="contract-detail-error"><p>{error}</p><button type="button" className="secondary-button" onClick={onClose}>閉じる</button></div>}
    {!loading && contract && <div className="contract-detail-body">
      {editing ? <MainContractEditor contract={contract} asOfDate={asOfDate} onCancel={() => setEditing(false)} onApplied={async () => { setEditing(false); await load(); onChanged?.(); }} /> : <>
      <section className="contract-detail-summary">
        <header>
          <div><p className="section-kicker">{contract.unit_type === 'parking' ? 'PARKING CONTRACT' : 'MAIN CONTRACT'}</p><h3>{contract.tenant_name}</h3><p>{contract.property_name}｜{contract.floor_label || '階未設定'}｜{contract.unit_name || contract.unit_code}</p></div>
          <div className="contract-detail-badges"><span className={`contract-detail-status ${contract.contract_status}`}>{statusLabels[contract.contract_status] ?? contract.contract_status}</span>{capabilities.canEditContract && contract.unit_type !== 'parking' ? <button type="button" className="primary-button compact" onClick={() => setEditing(true)}>契約を編集</button> : <span className="contract-view-only">閲覧専用</span>}</div>
        </header>
        <div className="contract-detail-grid">
          <Field label="物件" value={contract.property_name} />
          <Field label="区画" value={[contract.floor_label, contract.unit_name || contract.unit_code].filter(Boolean).join(' ') || '—'} />
          <Field label="契約形態" value={leaseTermLabel(contract.lease_term_type)} />
          <Field label="契約期間" value={contractPeriod(contract)} />
          <Field label="次回更新予定日" value={contract.lease_term_type === 'ordinary' ? date(contract.renewal_due_date) : '—'} />
          <Field label="実終了日" value={date(contract.actual_end_date)} />
          <Field label="再契約元" value={contract.renewed_from_contract_id || '—'} />
          <Field label="面積" value={contract.leased_area_sqm == null ? '—' : `${number.format(Number(contract.leased_area_sqm))} ㎡`} />
          <Field label="契約カテゴリ" value={contract.contract_type || '未設定'} />
          <Field label="賃料（DB登録値）" value={money(contract.monthly_rent_amount)} />
          <Field label="共益費" value={money(contract.monthly_common_charge_amount)} />
          <Field label="月額合計" value={money(contract.monthly_total_amount)} />
          <Field label="敷金" value={money(contract.deposit_amount)} />
          <Field label="保証金" value={money(contract.security_deposit_amount)} />
          <Field label="礼金" value={money(contract.key_money_amount)} />
          <Field label="更新料" value={money(contract.renewal_fee_amount)} />
          <Field label="支払条件" value={contract.payment_terms || '—'} />
          <Field label="更新条件" value={contract.renewal_terms || '—'} />
          <Field label="契約状態" value={statusLabels[contract.contract_status] ?? contract.contract_status} />
          <Field label="備考" value={contract.notes || '—'} />
          <Field label="最終更新" value={new Date(contract.updated_at).toLocaleString('ja-JP')} />
        </div>
      </section>

      <section>
        <div className="contract-detail-section-heading"><div><h3>同一契約の区画</h3><p>契約ヘッダーではなく、契約区画ID単位で表示しています。</p></div></div>
        <div className="contract-detail-table-wrap"><table className="contract-detail-table">
          <thead><tr><th>区画</th><th>種別</th><th>面積</th><th>賃料</th><th>共益費</th><th>契約期間</th></tr></thead>
          <tbody>{detail.contract_units.map((unit) => <tr key={unit.lease_contract_unit_id} className={unit.lease_contract_unit_id === leaseContractUnitId ? 'current' : ''}>
            <td><strong>{[unit.floor_label, unit.unit_name || unit.unit_code].filter(Boolean).join(' ')}</strong><small>{unit.unit_code}</small></td><td>{unit.unit_type}</td>
            <td className="numeric">{unit.leased_area_sqm == null ? '—' : number.format(Number(unit.leased_area_sqm))}</td><td className="numeric">{money(unit.monthly_rent_amount)}</td><td className="numeric">{money(unit.monthly_common_charge_amount)}</td><td>{date(unit.lease_start_date)} ～ {date(unit.lease_end_date)}</td>
          </tr>)}</tbody>
        </table></div>
      </section>

      <section>
        <div className="contract-detail-section-heading"><div><h3>明示的に紐づく駐車場契約</h3><p>駐車料履歴または駐車場契約ヘッダーで関係が確認できる契約です。</p></div></div>
        <ParkingRows rows={detail.related_parking_contracts} canEdit={capabilities.canEditParkingContract} />
      </section>

      {detail.parking_candidates.length > 0 && <section className="contract-detail-candidates">
        <div className="contract-detail-section-heading"><div><h3>同一テナント・同一物件の未紐付け候補</h3><p>名称一致だけでは関連契約と確定しません。確認対象として分離表示しています。</p></div></div>
        <ParkingRows rows={detail.parking_candidates} candidate canEdit={capabilities.canEditParkingContract} />
      </section>}
      </>}
    </div>}
  </Dialog>;
}
