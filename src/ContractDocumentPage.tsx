import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from './lib/supabase';

type Values = Record<string, string>;
type WorkflowApplication = { applicationId: string; title: string; approvedAt: string | null; values: Values; source: Record<string, unknown> };
type StoredDocument = { field_values: Values; workflow_defaults: Values; manually_edited_fields: string[]; desknets_application_id: string | null; pdf_file_path: string | null; pdf_generated_at: string | null };

const fields: Array<{ key: string; label: string; type?: 'date' | 'number'; required?: boolean }> = [
  { key: 'propertyName', label: '物件名', required: true }, { key: 'propertyAddress', label: '所在地' }, { key: 'unitNames', label: '貸室・区画' },
  { key: 'tenantName', label: '賃借人（テナント名）', required: true }, { key: 'contractStartDate', label: '契約開始日', type: 'date', required: true },
  { key: 'contractEndDate', label: '契約終了日', type: 'date', required: true }, { key: 'monthlyRentAmount', label: '月額賃料（税込）', type: 'number' },
  { key: 'monthlyCommonChargeAmount', label: '月額共益費（税込）', type: 'number' }, { key: 'depositAmount', label: '敷金', type: 'number' },
  { key: 'securityDepositAmount', label: '保証金', type: 'number' }, { key: 'keyMoneyAmount', label: '礼金', type: 'number' },
];

const emptyValues = (): Values => Object.fromEntries(fields.map(({ key }) => [key, '']));
const formatYen = (value: string) => value ? `${Number(value).toLocaleString('ja-JP')} 円` : '未設定';
const demoApplication: WorkflowApplication = { applicationId: 'DN-DEMO-20260722-001', title: '【デモ】三共横浜ビル・普通賃貸借契約申請', approvedAt: '2026-07-22T09:30:00+09:00', values: { propertyName: '三共横浜ビル', propertyAddress: '神奈川県横浜市中区長者町5丁目85', unitNames: '802号室', tenantName: '株式会社サンプルソリューションズ', contractStartDate: '2026-09-01', contractEndDate: '2028-08-31', monthlyRentAmount: '480000', monthlyCommonChargeAmount: '72000', depositAmount: '2880000', securityDepositAmount: '', keyMoneyAmount: '480000' }, source: { id: 'DN-DEMO-20260722-001', status: 'approved', form: '普通賃貸借契約申請', isDemo: true } };

export function ContractDocumentPage() {
  const { contractId = '' } = useParams(); const navigate = useNavigate();
  const isDemo = contractId === 'demo-ordinary-lease';
  const [values, setValues] = useState<Values>(emptyValues()); const [workflowDefaults, setWorkflowDefaults] = useState<Values>(emptyValues());
  const [manualFields, setManualFields] = useState<string[]>([]); const [applications, setApplications] = useState<WorkflowApplication[]>([]);
  const [notice, setNotice] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [document, setDocument] = useState<StoredDocument | null>(null);
  const selectedApplication = useMemo(() => applications.find((item) => item.applicationId === document?.desknets_application_id), [applications, document?.desknets_application_id]);

  useEffect(() => { void load(); }, [contractId]);
  const load = async () => {
    if (isDemo) { setValues({ ...demoApplication.values }); setWorkflowDefaults({ ...demoApplication.values }); setManualFields([]); setDocument({ field_values: { ...demoApplication.values }, workflow_defaults: { ...demoApplication.values }, manually_edited_fields: [], desknets_application_id: demoApplication.applicationId, pdf_file_path: null, pdf_generated_at: null }); setLoading(false); return; }
    if (!supabase || !contractId) return; setLoading(true); setError('');
    const [{ data: contract, error: contractError }, { data: stored, error: documentError }] = await Promise.all([
      supabase.from('lease_contract').select('lease_contract_id, contract_start_date, contract_end_date, tenant:tenant_master(tenant_name), contract_units:lease_contract_unit(monthly_rent_amount, monthly_common_charge_amount, deposit_amount, security_deposit_amount, key_money_amount, unit:unit_master(unit_code, property:property_master(property_name, address)))').eq('lease_contract_id', contractId).maybeSingle(),
      supabase.from('lease_contract_document').select('field_values, workflow_defaults, manually_edited_fields, desknets_application_id, pdf_file_path, pdf_generated_at').eq('lease_contract_id', contractId).maybeSingle(),
    ]);
    if (contractError || documentError || !contract) { setError(`契約書データを読み込めませんでした: ${(contractError ?? documentError)?.message ?? '対象契約がありません。'}`); setLoading(false); return; }
    const unit = (contract as any).contract_units?.[0];
    const rentalDefaults: Values = {
      ...emptyValues(), propertyName: unit?.unit?.property?.property_name ?? '', propertyAddress: unit?.unit?.property?.address ?? '',
      unitNames: ((contract as any).contract_units ?? []).map((item: any) => item.unit?.unit_code).filter(Boolean).join('、'), tenantName: (contract as any).tenant?.tenant_name ?? '',
      contractStartDate: contract.contract_start_date ?? '', contractEndDate: contract.contract_end_date ?? '', monthlyRentAmount: unit?.monthly_rent_amount?.toString() ?? '',
      monthlyCommonChargeAmount: unit?.monthly_common_charge_amount?.toString() ?? '', depositAmount: unit?.deposit_amount?.toString() ?? '', securityDepositAmount: unit?.security_deposit_amount?.toString() ?? '', keyMoneyAmount: unit?.key_money_amount?.toString() ?? '',
    };
    const existing = stored as StoredDocument | null;
    setValues(existing ? { ...rentalDefaults, ...existing.field_values } : rentalDefaults); setWorkflowDefaults(existing?.workflow_defaults ?? emptyValues()); setManualFields(existing?.manually_edited_fields ?? []); setDocument(existing); setLoading(false);
  };
  const save = async (nextValues = values, nextDefaults = workflowDefaults, nextManualFields = manualFields, application?: WorkflowApplication) => {
    if (isDemo) { setDocument({ field_values: nextValues, workflow_defaults: nextDefaults, manually_edited_fields: nextManualFields, desknets_application_id: application?.applicationId ?? document?.desknets_application_id ?? demoApplication.applicationId, pdf_file_path: null, pdf_generated_at: null }); setNotice('デモ契約書データを保存しました（ブラウザ表示中のみ保持されます）。'); return true; }
    if (!supabase) return false; setSaving(true); setError('');
    const payload: Record<string, unknown> = { lease_contract_id: contractId, document_type: 'ordinary_lease', field_values: nextValues, workflow_defaults: nextDefaults, manually_edited_fields: nextManualFields, desknets_application_id: application?.applicationId ?? document?.desknets_application_id ?? null };
    if (application) { payload.desknets_retrieved_at = new Date().toISOString(); payload.desknets_source_payload = application.source; }
    const { data, error: saveError } = await supabase.from('lease_contract_document').upsert(payload, { onConflict: 'lease_contract_id' }).select('field_values, workflow_defaults, manually_edited_fields, desknets_application_id, pdf_file_path, pdf_generated_at').single();
    setSaving(false); if (saveError) { setError(`保存できませんでした: ${saveError.message}`); return false; } setDocument(data as StoredDocument); setNotice('契約書データを保存しました。'); return true;
  };
  const loadApplications = async () => {
    if (isDemo) { setApplications([demoApplication]); setNotice('デモ用の最終承認済み申請を取得しました。'); return; }
    if (!supabase) return; setError(''); setNotice(''); const { data, error: functionError } = await supabase.functions.invoke('desknets-workflow-applications');
    if (functionError || data?.error) { setError(data?.error ?? `デスクネッツ申請を取得できませんでした: ${functionError?.message ?? ''}`); return; }
    setApplications(data.applications ?? []); setNotice(`${data.applications?.length ?? 0} 件の最終承認済み申請を取得しました。`);
  };
  const applyApplication = async (application: WorkflowApplication) => {
    const nextDefaults = { ...workflowDefaults, ...application.values }; const nextValues = { ...values };
    Object.entries(application.values).forEach(([key, value]) => { if (!manualFields.includes(key)) nextValues[key] = value; });
    setValues(nextValues); setWorkflowDefaults(nextDefaults); await save(nextValues, nextDefaults, manualFields, application);
  };
  const update = (key: string, value: string) => { setValues((current) => ({ ...current, [key]: value })); setManualFields((current) => current.includes(key) ? current : [...current, key]); };
  const resetField = (key: string) => { setValues((current) => ({ ...current, [key]: workflowDefaults[key] ?? '' })); setManualFields((current) => current.filter((item) => item !== key)); };
  const generate = async () => { if (!await save()) return; if (isDemo) { setNotice('デモでは印刷画面を開きます。ブラウザの「PDFに保存」を選択して出力を確認できます。'); window.print(); return; } if (!supabase) return; setSaving(true); setError(''); const { data, error: functionError } = await supabase.functions.invoke('generate-contract-pdf', { body: { leaseContractId: contractId } }); setSaving(false); if (functionError || data?.error) { setError(data?.error ?? `PDFを生成できませんでした: ${functionError?.message ?? ''}`); return; } setNotice('PDFを生成・保存しました。'); await load(); };
  const download = async () => { if (!supabase || !document?.pdf_file_path) return; const { data, error: signedUrlError } = await supabase.storage.from('contract-documents').createSignedUrl(document.pdf_file_path, 60); if (signedUrlError || !data?.signedUrl) { setError(`PDFを開けませんでした: ${signedUrlError?.message ?? ''}`); return; } window.open(data.signedUrl, '_blank', 'noopener,noreferrer'); };

  if (loading) return <section className="contract-document-page"><p>契約書データを読み込み中です…</p></section>;
  return <section className="contract-document-page">
    <header className="document-heading"><div><p className="section-kicker">{isDemo ? 'DEMO / ORDINARY LEASE' : 'ORDINARY LEASE'}</p><h2>普通賃貸借契約書 {isDemo && <span className="demo-badge">ダミーデータ</span>}</h2><p>{isDemo ? 'デスクネッツ転記・手修正保持・PDF印刷を確認できるローカルデモです。' : 'レントロール契約に紐づく契約書を作成・PDF保存します。'}</p></div><div><Link className="secondary-button" to="/contracts">契約一覧へ戻る</Link><button className="primary-button" onClick={() => void generate()} disabled={saving}>{isDemo ? 'PDF出力を確認' : 'PDFを生成・保存'}</button></div></header>
    {error && <div className="document-message error">{error}</div>}{notice && <div className="document-message">{notice}</div>}
    <div className="document-workspace"><div className="document-editor"><section className="document-panel"><header><div><h3>デスクネッツ申請</h3><p>最終承認済みの申請のみを取得します。</p></div><button className="secondary-button" onClick={() => void loadApplications()} disabled={saving}>申請を取得</button></header>{applications.length > 0 && <div className="application-list">{applications.map((application) => <button key={application.applicationId} onClick={() => void applyApplication(application)}><strong>{application.title}</strong><span>承認日: {application.approvedAt ? new Date(application.approvedAt).toLocaleDateString('ja-JP') : '未設定'} / ID: {application.applicationId}</span></button>)}</div>}{selectedApplication && <p className="selected-application">転記元: {selectedApplication.title}</p>}</section>
      <section className="document-panel"><header><div><h3>契約情報</h3><p>変更した項目は再取得時も保持されます。</p></div><button className="secondary-button" onClick={() => void save()} disabled={saving}>入力内容を保存</button></header><div className="document-form">{fields.map((field) => <label key={field.key}>{field.label}{field.required && <b>必須</b>}<div><input type={field.type ?? 'text'} value={values[field.key] ?? ''} onChange={(event) => update(field.key, event.target.value)} />{manualFields.includes(field.key) && <button type="button" title="デスクネッツの取得値へ戻す" onClick={() => resetField(field.key)}>取得値に戻す</button>}</div></label>)}</div></section>
      {document?.pdf_file_path && <section className="document-panel generated-file"><div><strong>最新PDFを保存済み</strong><span>{document.pdf_generated_at ? new Date(document.pdf_generated_at).toLocaleString('ja-JP') : ''}</span></div><button className="primary-button" onClick={() => void download()}>PDFを開く</button></section>}
    </div><aside className="contract-preview"><div className="paper"><h1>建物賃貸借契約書</h1><p>以下の条件により、貸主と賃借人は建物賃貸借契約を締結する。</p><dl>{fields.map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{field.type === 'number' ? formatYen(values[field.key]) : values[field.key] || '未設定'}</dd></div>)}</dl><section><h3>第1条（使用目的）</h3><p>賃借人は、上記貸室を契約で定める用途以外に使用してはならない。</p><h3>第2条（賃料）</h3><p>賃借人は、毎月定められた期日までに賃料その他の負担金を支払う。</p><h3>第3条（原状回復）</h3><p>契約終了時の原状回復は、別途合意した条件に従う。</p></section><div className="seal-row"><div>貸主</div><div>賃借人</div></div></div><p className="template-note">暫定テンプレートです。承認済みWord原本の受領後、条項・レイアウトを置き換えてください。</p></aside></div>
  </section>;
}
