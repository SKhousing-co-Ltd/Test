import { useEffect, useState } from 'react';
import { Field, contractPeriod, date, leaseTermLabel, money, statusLabels, type ContractDetail, type ContractDetailResponse } from './ContractDetailModal';
import { supabase } from './lib/supabase';
import './ContractInformationPage.css';

type PropertyOption = {
  propertyId: string;
  propertyName: string;
  shortName: string | null;
};

type ContractListRow = {
  unit_id: string;
  lease_contract_unit_id: string | null;
  unit_code: string;
  unit_name: string | null;
  floor_label: string | null;
  unit_type: string;
  contract_status: string | null;
  contract_start_date: string | null;
  contract_end_date: string | null;
  lease_term_type: 'ordinary' | 'fixed_term' | null;
  tenant_id: string | null;
  tenant_name: string | null;
  monthly_rent_amount: number | null;
  monthly_common_charge_amount: number | null;
  monthly_total_amount: number | null;
};

type BillingCodeRow = {
  billing_code_id: string;
  issue_code: string;
  recipient_name: string;
  billing_due_date_pattern_id: string | null;
  billing_period_pattern_id: string | null;
};

type DuePatternRow = {
  billing_due_date_pattern_id: string;
  pattern_number: number;
  month_offset: number;
  day_of_month: number;
  holiday_adjustment: 'previous' | 'next';
};

type PeriodPatternRow = {
  billing_period_pattern_id: string;
  pattern_name: string;
  start_month_offset: number;
  start_day_type: string;
  start_meter_day_offset: number;
  end_month_offset: number;
  end_day_type: string;
  end_meter_day_offset: number;
};

const today = new Date().toISOString().slice(0, 10);

const monthLabel = (n: number) =>
  ({ '-2': '前々月', '-1': '前月', '0': '当月', '1': '翌月', '2': '翌々月' })[String(n)] ?? '当月';
const dayLabel = (day: string, offset: number) =>
  day === 'first' || day === 'day_1'
    ? '1日'
    : day === 'last'
      ? '末日'
      : day === 'meter'
        ? `検針日${offset ? '翌日' : '当日'}`
        : `${day.replace('day_', '')}日`;

function duePatternLabel(pattern: DuePatternRow): string {
  const circled = '①②③④⑤⑥⑦⑧⑨⑩'.charAt(pattern.pattern_number - 1) || String(pattern.pattern_number);
  const month = pattern.month_offset ? '翌月' : '当月';
  const holiday = pattern.holiday_adjustment === 'previous' ? '前日' : '翌日';
  return `${circled}${month}${pattern.day_of_month}日（土日祝は${holiday}）`;
}

function periodPatternLabel(pattern: PeriodPatternRow): string {
  return `${pattern.pattern_name}（${monthLabel(pattern.start_month_offset)}${dayLabel(pattern.start_day_type, pattern.start_meter_day_offset)} ～ ${monthLabel(pattern.end_month_offset)}${dayLabel(pattern.end_day_type, pattern.end_meter_day_offset)}）`;
}

export function ContractInformationPage({ canEditBillingTerms }: { canEditBillingTerms: boolean }) {
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [propertyId, setPropertyId] = useState('');
  const [asOfDate, setAsOfDate] = useState(today);
  const [rows, setRows] = useState<ContractListRow[]>([]);
  const [loadingProperties, setLoadingProperties] = useState(true);
  const [loadingRows, setLoadingRows] = useState(false);
  const [error, setError] = useState('');

  const [selectedLeaseContractUnitId, setSelectedLeaseContractUnitId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContractDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [billingCodes, setBillingCodes] = useState<BillingCodeRow[]>([]);
  const [duePatterns, setDuePatterns] = useState<DuePatternRow[]>([]);
  const [periodPatterns, setPeriodPatterns] = useState<PeriodPatternRow[]>([]);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingError, setBillingError] = useState('');
  const [savingBillingCodeId, setSavingBillingCodeId] = useState('');

  useEffect(() => {
    let cancelled = false;
    const loadProperties = async () => {
      setLoadingProperties(true);
      setError('');
      if (!supabase) {
        setError('Supabaseの接続設定が見つかりません。');
        setLoadingProperties(false);
        return;
      }
      const { data, error: loadError } = await supabase
        .from('asset_master')
        .select('asset_id, asset_name, short_name')
        .eq('is_tenant_billing_enabled', true)
        .order('asset_code');
      if (cancelled) return;
      if (loadError) {
        setError(`物件の取得に失敗しました: ${loadError.message}`);
        setLoadingProperties(false);
        return;
      }
      const options = ((data ?? []) as Array<{ asset_id: string; asset_name: string; short_name: string | null }>).map((asset) => ({
        propertyId: asset.asset_id,
        propertyName: asset.asset_name,
        shortName: asset.short_name,
      }));
      setProperties(options);
      setPropertyId((current) => current || options[0]?.propertyId || '');
      setLoadingProperties(false);
    };
    void loadProperties();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setSelectedLeaseContractUnitId(null);
    if (!propertyId) {
      setRows([]);
      return;
    }
    let cancelled = false;
    const loadRows = async () => {
      setLoadingRows(true);
      setError('');
      if (!supabase) {
        setError('Supabaseの接続設定が見つかりません。');
        setLoadingRows(false);
        return;
      }
      const { data, error: loadError } = await supabase.rpc('rent_roll_list_with_terms_at_date', {
        p_property_id: propertyId,
        p_as_of_date: asOfDate,
      });
      if (cancelled) return;
      if (loadError) {
        setRows([]);
        setError(`契約一覧の取得に失敗しました: ${loadError.message}`);
      } else {
        setRows(((data ?? []) as ContractListRow[]).filter((row) => row.lease_contract_unit_id));
      }
      setLoadingRows(false);
    };
    void loadRows();
    return () => { cancelled = true; };
  }, [propertyId, asOfDate]);

  useEffect(() => {
    if (!selectedLeaseContractUnitId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    const loadDetail = async () => {
      setDetailLoading(true);
      setDetailError('');
      if (!supabase) {
        setDetailError('Supabaseの接続設定が見つかりません。');
        setDetailLoading(false);
        return;
      }
      const { data, error: loadError } = await supabase.rpc('contract_term_detail_for_audit', {
        p_lease_contract_unit_id: selectedLeaseContractUnitId,
        p_as_of_date: asOfDate,
      });
      if (cancelled) return;
      if (loadError) {
        setDetail(null);
        setDetailError(`契約情報を取得できませんでした: ${loadError.message}`);
      } else {
        setDetail(data as ContractDetailResponse);
      }
      setDetailLoading(false);
    };
    void loadDetail();
    return () => { cancelled = true; };
  }, [selectedLeaseContractUnitId, asOfDate]);

  useEffect(() => {
    const tenantId = detail?.contract.tenant_id;
    if (!tenantId || !propertyId) {
      setBillingCodes([]);
      setDuePatterns([]);
      setPeriodPatterns([]);
      return;
    }
    let cancelled = false;
    const loadBilling = async () => {
      setBillingLoading(true);
      setBillingError('');
      if (!supabase) {
        setBillingError('Supabaseの接続設定が見つかりません。');
        setBillingLoading(false);
        return;
      }
      const [codeResult, dueResult, periodResult] = await Promise.all([
        supabase
          .from('billing_code')
          .select('billing_code_id, issue_code, recipient_name, billing_due_date_pattern_id, billing_period_pattern_id')
          .eq('property_id', propertyId)
          .eq('tenant_id', tenantId)
          .eq('is_active', true)
          .order('issue_code'),
        supabase
          .from('asset_billing_due_date_pattern')
          .select('billing_due_date_pattern_id, pattern_number, month_offset, day_of_month, holiday_adjustment')
          .eq('asset_id', propertyId)
          .order('pattern_number'),
        supabase
          .from('asset_billing_period_pattern')
          .select('billing_period_pattern_id, pattern_name, start_month_offset, start_day_type, start_meter_day_offset, end_month_offset, end_day_type, end_meter_day_offset')
          .eq('asset_id', propertyId)
          .order('sort_order'),
      ]);
      if (cancelled) return;
      if (codeResult.error || dueResult.error || periodResult.error) {
        setBillingError(`請求条件を読み込めませんでした: ${codeResult.error?.message ?? dueResult.error?.message ?? periodResult.error?.message}`);
      }
      setBillingCodes((codeResult.data ?? []) as BillingCodeRow[]);
      setDuePatterns((dueResult.data ?? []) as DuePatternRow[]);
      setPeriodPatterns((periodResult.data ?? []) as PeriodPatternRow[]);
      setBillingLoading(false);
    };
    void loadBilling();
    return () => { cancelled = true; };
  }, [detail?.contract.tenant_id, propertyId]);

  const updateBillingTerms = async (code: BillingCodeRow, field: 'due' | 'period', value: string) => {
    if (!supabase || !canEditBillingTerms) return;
    const nextDueId = field === 'due' ? (value || null) : code.billing_due_date_pattern_id;
    const nextPeriodId = field === 'period' ? (value || null) : code.billing_period_pattern_id;
    setSavingBillingCodeId(code.billing_code_id);
    setBillingError('');
    const { error: saveError } = await supabase.rpc('update_billing_code_billing_terms', {
      p_billing_code_id: code.billing_code_id,
      p_billing_due_date_pattern_id: nextDueId,
      p_billing_period_pattern_id: nextPeriodId,
    });
    setSavingBillingCodeId('');
    if (saveError) {
      setBillingError(`請求条件を更新できませんでした: ${saveError.message}`);
      return;
    }
    setBillingCodes((current) => current.map((item) => item.billing_code_id === code.billing_code_id
      ? { ...item, billing_due_date_pattern_id: nextDueId, billing_period_pattern_id: nextPeriodId }
      : item));
  };

  const selectedProperty = properties.find((property) => property.propertyId === propertyId);
  const contract = detail?.contract;

  return <section className="contract-information-page">
    <div className="contract-information-heading">
      <div>
        <p className="section-kicker">CONTRACT INFORMATION</p>
        <h2>契約情報</h2>
        <p>物件を選択して契約を確認し、テナント請求の支払期日・請求スパンを確認・設定できます。</p>
      </div>
    </div>

    <div className="contract-information-toolbar">
      <label>基準日
        <input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} />
      </label>
      <label>物件
        <select value={propertyId} onChange={(event) => setPropertyId(event.target.value)} disabled={loadingProperties}>
          {properties.map((property) => <option key={property.propertyId} value={property.propertyId}>{property.shortName || property.propertyName}</option>)}
        </select>
      </label>
    </div>

    {error && <p className="contract-information-notice">{error}</p>}
    {!loadingProperties && properties.length === 0 && !error && <p className="contract-information-notice">対象の物件がありません。</p>}

    <div className="contract-information-panel">
      <div className="contract-information-panel-heading"><div><h3>{selectedProperty?.propertyName ?? '物件を選択'}</h3><p>{loadingRows ? '読み込み中…' : `${rows.length} 件の契約`}</p></div></div>
      <div className="contract-information-table-wrap">
        <table className="contract-information-table">
          <thead><tr><th>テナント名</th><th>区画</th><th>契約形態</th><th>契約期間</th><th>賃料</th><th>共益費</th><th>月額合計</th></tr></thead>
          <tbody>
            {loadingRows && <tr><td colSpan={7} className="contract-information-empty">契約情報を読み込んでいます。</td></tr>}
            {!loadingRows && rows.length === 0 && <tr><td colSpan={7} className="contract-information-empty">条件に一致する契約はありません。</td></tr>}
            {!loadingRows && rows.map((row) => <tr key={row.lease_contract_unit_id} className={row.lease_contract_unit_id === selectedLeaseContractUnitId ? 'current' : ''} onClick={() => setSelectedLeaseContractUnitId(row.lease_contract_unit_id)}>
              <td><strong>{row.tenant_name || '—'}</strong></td>
              <td>{[row.floor_label, row.unit_name || row.unit_code].filter(Boolean).join(' ')}</td>
              <td>{leaseTermLabel(row.lease_term_type)}</td>
              <td>{contractPeriod(row as unknown as ContractDetail)}</td>
              <td className="numeric">{money(row.monthly_rent_amount)}</td>
              <td className="numeric">{money(row.monthly_common_charge_amount)}</td>
              <td className="numeric">{money(row.monthly_total_amount)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>

    {selectedLeaseContractUnitId && <section className="contract-information-detail">
      {detailLoading && <p className="contract-information-empty">契約情報を読み込んでいます。</p>}
      {detailError && <p className="contract-information-notice">{detailError}</p>}
      {!detailLoading && contract && <>
        <div className="contract-information-section-heading"><div><h3>契約詳細</h3><p>{contract.tenant_name}｜{contract.property_name}</p></div></div>
        <div className="contract-detail-grid">
          <Field label="契約名義" value={contract.tenant_name} />
          <Field label="物件" value={contract.property_name} />
          <Field label="区画" value={[contract.floor_label, contract.unit_name || contract.unit_code].filter(Boolean).join(' ') || '—'} />
          <Field label="契約形態" value={leaseTermLabel(contract.lease_term_type)} />
          <Field label="契約期間" value={contractPeriod(contract)} />
          <Field label="賃料" value={money(contract.monthly_rent_amount)} />
          <Field label="共益費" value={money(contract.monthly_common_charge_amount)} />
          <Field label="敷金" value={money(contract.deposit_amount)} />
          <Field label="保証金" value={money(contract.security_deposit_amount)} />
          <Field label="礼金" value={money(contract.key_money_amount)} />
          <Field label="更新料" value={money(contract.renewal_fee_amount)} />
          <Field label="契約状態" value={statusLabels[contract.contract_status] ?? contract.contract_status} />
          <Field label="備考" value={contract.notes || '—'} />
          <Field label="最終更新" value={date(contract.updated_at.slice(0, 10))} />
        </div>

        <div className="contract-information-section-heading"><div><h3>請求条件（支払期日・請求スパン）</h3><p>請求コードごとに、入金期日パターン・請求期間パターンを設定します。</p></div></div>
        {!canEditBillingTerms && <p className="contract-information-notice muted">編集は総務経理部の担当者のみ行えます。</p>}
        {billingError && <p className="contract-information-notice">{billingError}</p>}
        <div className="contract-information-table-wrap">
          <table className="contract-information-table">
            <thead><tr><th>請求コード</th><th>請求先</th><th>入金期日パターン</th><th>請求期間パターン</th></tr></thead>
            <tbody>
              {billingLoading && <tr><td colSpan={4} className="contract-information-empty">読み込み中…</td></tr>}
              {!billingLoading && billingCodes.length === 0 && <tr><td colSpan={4} className="contract-information-empty">この契約に紐づく請求コードがありません。</td></tr>}
              {!billingLoading && billingCodes.map((code) => <tr key={code.billing_code_id}>
                <td><strong>{code.issue_code}</strong></td>
                <td>{code.recipient_name}</td>
                <td>
                  <select
                    value={code.billing_due_date_pattern_id ?? ''}
                    disabled={!canEditBillingTerms || savingBillingCodeId === code.billing_code_id}
                    onChange={(event) => void updateBillingTerms(code, 'due', event.target.value)}
                  >
                    <option value="">未設定</option>
                    {duePatterns.map((pattern) => <option key={pattern.billing_due_date_pattern_id} value={pattern.billing_due_date_pattern_id}>{duePatternLabel(pattern)}</option>)}
                  </select>
                </td>
                <td>
                  <select
                    value={code.billing_period_pattern_id ?? ''}
                    disabled={!canEditBillingTerms || savingBillingCodeId === code.billing_code_id}
                    onChange={(event) => void updateBillingTerms(code, 'period', event.target.value)}
                  >
                    <option value="">未設定</option>
                    {periodPatterns.map((pattern) => <option key={pattern.billing_period_pattern_id} value={pattern.billing_period_pattern_id}>{periodPatternLabel(pattern)}</option>)}
                  </select>
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </>}
    </section>}
  </section>;
}
