import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from './lib/supabase';

type Values = Record<string, string>;
type Geometry = { type: 'MultiPolygon'; coordinates: number[][][][] };
type WorkflowApplication = { applicationId: string; title: string; approvedAt: string | null; values: Values; source: Record<string, unknown> };
type StoredDocument = { lease_contract_document_id: string; field_values: Values; workflow_defaults: Values; manually_edited_fields: string[]; desknets_application_id: string | null; pdf_file_path: string | null; pdf_generated_at: string | null };
type PlanCandidate = { unitId: string; unitCode: string; floorLabel: string; revisionId: string; previewPath: string; previewUrl: string; geometry: Geometry };
type StoredPlan = { revisionId: string; floorLabel: string; unitIds: string[]; snapshotPath: string; snapshotUrl: string };

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

function imageFromBlob(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob); const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('平面図プレビューを描画できませんでした。')); };
    image.src = url;
  });
}

export function ContractDocumentPage() {
  const { contractId = '' } = useParams(); const isDemo = contractId === 'demo-ordinary-lease';
  const [values, setValues] = useState<Values>(emptyValues()); const [workflowDefaults, setWorkflowDefaults] = useState<Values>(emptyValues());
  const [manualFields, setManualFields] = useState<string[]>([]); const [applications, setApplications] = useState<WorkflowApplication[]>([]);
  const [notice, setNotice] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [document, setDocument] = useState<StoredDocument | null>(null);
  const [planCandidates, setPlanCandidates] = useState<PlanCandidate[]>([]); const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]); const [storedPlans, setStoredPlans] = useState<StoredPlan[]>([]); const [plansDirty, setPlansDirty] = useState(false);
  const selectedApplication = useMemo(() => applications.find((item) => item.applicationId === document?.desknets_application_id), [applications, document?.desknets_application_id]);
  const candidateGroups = useMemo(() => [...planCandidates.reduce((groups, candidate) => { const group = groups.get(candidate.revisionId) ?? []; group.push(candidate); groups.set(candidate.revisionId, group); return groups; }, new Map<string, PlanCandidate[]>()).entries()], [planCandidates]);

  useEffect(() => { void load(); }, [contractId]);

  const loadStoredPlans = async (documentId: string) => {
    if (!supabase) return;
    const client = supabase;
    const { data, error: planError } = await client.from('lease_contract_document_plan').select('floor_plan_revision_id, target_unit_ids, snapshot_file_path, floor_plan_revision:floor_plan_revision_id(floor_plan:floor_plan_id(floor_label))').eq('lease_contract_document_id', documentId);
    if (planError) { setError(`対象区画図を読み込めませんでした: ${planError.message}`); return; }
    const plans = await Promise.all((data ?? []).map(async (row: any) => {
      const { data: signed } = await client.storage.from('contract-documents').createSignedUrl(row.snapshot_file_path, 3600);
      return { revisionId: row.floor_plan_revision_id, floorLabel: row.floor_plan_revision?.floor_plan?.floor_label ?? 'フロア未設定', unitIds: row.target_unit_ids ?? [], snapshotPath: row.snapshot_file_path, snapshotUrl: signed?.signedUrl ?? '' };
    }));
    setStoredPlans(plans); setSelectedUnitIds(plans.flatMap((plan) => plan.unitIds));
  };

  const load = async () => {
    if (isDemo) { setValues({ ...demoApplication.values }); setWorkflowDefaults({ ...demoApplication.values }); setManualFields([]); setLoading(false); return; }
    if (!supabase || !contractId) return; const client = supabase; setLoading(true); setError('');
    const [{ data: contract, error: contractError }, { data: stored, error: documentError }] = await Promise.all([
      supabase.from('lease_contract').select('lease_contract_id, contract_start_date, contract_end_date, tenant:tenant_master(tenant_name), contract_units:lease_contract_unit(monthly_rent_amount, monthly_common_charge_amount, deposit_amount, security_deposit_amount, key_money_amount, unit:unit_master(unit_id, unit_code, property_id, floor_label, property:property_master(property_name, address)))').eq('lease_contract_id', contractId).maybeSingle(),
      supabase.from('lease_contract_document').select('lease_contract_document_id, field_values, workflow_defaults, manually_edited_fields, desknets_application_id, pdf_file_path, pdf_generated_at').eq('lease_contract_id', contractId).maybeSingle(),
    ]);
    if (contractError || documentError || !contract) { setError(`契約書データを読み込めませんでした: ${(contractError ?? documentError)?.message ?? '対象契約がありません。'}`); setLoading(false); return; }
    const units = ((contract as any).contract_units ?? []).map((item: any) => item.unit).filter(Boolean);
    const unit = (contract as any).contract_units?.[0];
    const rentalDefaults: Values = { ...emptyValues(), propertyName: unit?.unit?.property?.property_name ?? '', propertyAddress: unit?.unit?.property?.address ?? '', unitNames: units.map((item: any) => item.unit_code).join('、'), tenantName: (contract as any).tenant?.tenant_name ?? '', contractStartDate: contract.contract_start_date ?? '', contractEndDate: contract.contract_end_date ?? '', monthlyRentAmount: unit?.monthly_rent_amount?.toString() ?? '', monthlyCommonChargeAmount: unit?.monthly_common_charge_amount?.toString() ?? '', depositAmount: unit?.deposit_amount?.toString() ?? '', securityDepositAmount: unit?.security_deposit_amount?.toString() ?? '', keyMoneyAmount: unit?.key_money_amount?.toString() ?? '' };
    const existing = stored as StoredDocument | null;
    setValues(existing ? { ...rentalDefaults, ...existing.field_values } : rentalDefaults); setWorkflowDefaults(existing?.workflow_defaults ?? emptyValues()); setManualFields(existing?.manually_edited_fields ?? []); setDocument(existing);
    if (existing) await loadStoredPlans(existing.lease_contract_document_id); else { setStoredPlans([]); setSelectedUnitIds([]); }

    const { data: revisionRows, error: revisionError } = await supabase.from('floor_plan_revision').select('floor_plan_revision_id, preview_file_path, floor_plan:floor_plan_id(property_id, floor_label)').eq('is_current', true);
    if (revisionError) setError(`現行平面図を読み込めませんでした: ${revisionError.message}`);
    const relevantRevisions = (revisionRows ?? []).filter((row: any) => units.some((contractUnit: any) => contractUnit.property_id === row.floor_plan?.property_id && contractUnit.floor_label === row.floor_plan?.floor_label));
    const revisionIds = relevantRevisions.map((row: any) => row.floor_plan_revision_id);
    const { data: featureRows, error: featureError } = revisionIds.length ? await supabase.from('floor_plan_map_features').select('floor_plan_revision_id, unit_id, unit_code, geometry_geojson').in('floor_plan_revision_id', revisionIds) : { data: [], error: null };
    if (featureError) setError(`対象区画の図形を読み込めませんでした: ${featureError.message}`);
    const features = new Map((featureRows ?? []).map((row: any) => [`${row.floor_plan_revision_id}|${row.unit_id}`, row]));
    const candidates = await Promise.all(units.flatMap((contractUnit: any) => relevantRevisions.filter((revision: any) => revision.floor_plan?.property_id === contractUnit.property_id && revision.floor_plan?.floor_label === contractUnit.floor_label).map(async (revision: any) => {
      const feature: any = features.get(`${revision.floor_plan_revision_id}|${contractUnit.unit_id}`); if (!feature?.geometry_geojson) return null;
      const { data: signed } = await client.storage.from('floor-plans').createSignedUrl(revision.preview_file_path, 3600);
      return { unitId: contractUnit.unit_id, unitCode: contractUnit.unit_code, floorLabel: contractUnit.floor_label, revisionId: revision.floor_plan_revision_id, previewPath: revision.preview_file_path, previewUrl: signed?.signedUrl ?? '', geometry: feature.geometry_geojson as Geometry };
    })));
    setPlanCandidates(candidates.filter(Boolean) as PlanCandidate[]); setPlansDirty(false); setLoading(false);
  };

  const save = async (nextValues = values, nextDefaults = workflowDefaults, nextManualFields = manualFields, application?: WorkflowApplication): Promise<StoredDocument | null> => {
    if (isDemo) { setNotice('デモでは対象区画図の保存は行いません。'); return null; }
    if (!supabase) return null; setSaving(true); setError('');
    const payload: Record<string, unknown> = { lease_contract_id: contractId, document_type: 'ordinary_lease', field_values: nextValues, workflow_defaults: nextDefaults, manually_edited_fields: nextManualFields, desknets_application_id: application?.applicationId ?? document?.desknets_application_id ?? null };
    if (application) { payload.desknets_retrieved_at = new Date().toISOString(); payload.desknets_source_payload = application.source; }
    const { data, error: saveError } = await supabase.from('lease_contract_document').upsert(payload, { onConflict: 'lease_contract_id' }).select('lease_contract_document_id, field_values, workflow_defaults, manually_edited_fields, desknets_application_id, pdf_file_path, pdf_generated_at').single();
    setSaving(false); if (saveError) { setError(`保存できませんでした: ${saveError.message}`); return null; } setDocument(data as StoredDocument); return data as StoredDocument;
  };

  const renderPlanSnapshot = async (candidates: PlanCandidate[]) => {
    if (!supabase || !candidates[0]) throw new Error('対象区画図を作成できません。');
    const { data, error: downloadError } = await supabase.storage.from('floor-plans').download(candidates[0].previewPath);
    if (downloadError || !data) throw new Error(`平面図を取得できませんでした: ${downloadError?.message ?? ''}`);
    const image = await imageFromBlob(data); const originalWidth = image.naturalWidth || 1200; const originalHeight = image.naturalHeight || 900;
    const scale = Math.min(1, 1600 / originalWidth); const width = Math.round(originalWidth * scale); const height = Math.round(originalHeight * scale); const header = 58;
    const canvas = window.document.createElement('canvas'); canvas.width = width; canvas.height = height + header; const context = canvas.getContext('2d'); if (!context) throw new Error('図面用キャンバスを作成できませんでした。');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#17233a'; context.font = 'bold 22px sans-serif'; context.fillText(`別紙：対象区画図（${candidates[0].floorLabel}）`, 20, 35); context.drawImage(image, 0, header, width, height);
    candidates.forEach((candidate) => { context.beginPath(); candidate.geometry.coordinates.forEach((polygon) => polygon.forEach((ring) => ring.forEach(([x, y], index) => { const px = x * width; const py = header + y * height; if (index === 0) context.moveTo(px, py); else context.lineTo(px, py); }))); context.closePath(); context.fillStyle = 'rgba(222, 59, 52, .30)'; context.strokeStyle = '#c4221e'; context.lineWidth = Math.max(3, width / 350); context.fill(); context.stroke(); const point = candidate.geometry.coordinates[0]?.[0]?.[0]; if (point) { context.fillStyle = '#951713'; context.font = `bold ${Math.max(16, width / 50)}px sans-serif`; context.fillText(candidate.unitCode, point[0] * width + 8, header + point[1] * height + 24); } });
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('対象区画図PNGを作成できませんでした。')), 'image/png'));
  };

  const savePlans = async (storedDocument: StoredDocument) => {
    if (!supabase || !plansDirty) return true;
    const client = supabase;
    const selected = planCandidates.filter((candidate) => selectedUnitIds.includes(candidate.unitId));
    const groups = [...selected.reduce((map, candidate) => { const group = map.get(candidate.revisionId) ?? []; group.push(candidate); map.set(candidate.revisionId, group); return map; }, new Map<string, PlanCandidate[]>()).entries()];
    try {
      const rows = await Promise.all(groups.map(async ([revisionId, candidates]) => { const snapshot = await renderPlanSnapshot(candidates); const path = `${contractId}/plan-snapshots/${revisionId}.png`; const { error: uploadError } = await client.storage.from('contract-documents').upload(path, snapshot, { contentType: 'image/png', upsert: true }); if (uploadError) throw new Error(`対象区画図を保存できませんでした: ${uploadError.message}`); return { lease_contract_document_id: storedDocument.lease_contract_document_id, floor_plan_revision_id: revisionId, target_unit_ids: candidates.map((candidate) => candidate.unitId), snapshot_file_path: path }; }));
      const { error: deleteError } = await client.from('lease_contract_document_plan').delete().eq('lease_contract_document_id', storedDocument.lease_contract_document_id); if (deleteError) throw deleteError;
      if (rows.length) { const { error: insertError } = await client.from('lease_contract_document_plan').insert(rows); if (insertError) throw insertError; }
      await loadStoredPlans(storedDocument.lease_contract_document_id); setPlansDirty(false); return true;
    } catch (planError: any) { setError(planError.message ?? `対象区画図を保存できませんでした: ${planError}`); return false; }
  };

  const saveAll = async () => { const stored = await save(); if (!stored) return false; if (!await savePlans(stored)) return false; setNotice('契約書データと対象区画図を保存しました。'); return true; };
  const loadApplications = async () => { if (isDemo) { setApplications([demoApplication]); setNotice('デモ用の最終承認済み申請を取得しました。'); return; } if (!supabase) return; setError(''); const { data, error: functionError } = await supabase.functions.invoke('desknets-workflow-applications'); if (functionError || data?.error) { setError(data?.error ?? `デスクネッツ申請を取得できませんでした: ${functionError?.message ?? ''}`); return; } setApplications(data.applications ?? []); setNotice(`${data.applications?.length ?? 0} 件の最終承認済み申請を取得しました。`); };
  const applyApplication = async (application: WorkflowApplication) => { const nextDefaults = { ...workflowDefaults, ...application.values }; const nextValues = { ...values }; Object.entries(application.values).forEach(([key, value]) => { if (!manualFields.includes(key)) nextValues[key] = value; }); setValues(nextValues); setWorkflowDefaults(nextDefaults); await save(nextValues, nextDefaults, manualFields, application); };
  const update = (key: string, value: string) => { setValues((current) => ({ ...current, [key]: value })); setManualFields((current) => current.includes(key) ? current : [...current, key]); };
  const resetField = (key: string) => { setValues((current) => ({ ...current, [key]: workflowDefaults[key] ?? '' })); setManualFields((current) => current.filter((item) => item !== key)); };
  const toggleUnit = (unitId: string, checked: boolean) => { setSelectedUnitIds((current) => checked ? [...new Set([...current, unitId])] : current.filter((id) => id !== unitId)); setPlansDirty(true); };
  const generate = async () => { if (isDemo) { setNotice('デモでは印刷画面を開きます。'); window.print(); return; } if (!selectedUnitIds.length) { setError('PDF生成前に、対象区画を1件以上選択して保存してください。'); return; } if (!await saveAll() || !supabase) return; setSaving(true); setError(''); const { data, error: functionError } = await supabase.functions.invoke('generate-contract-pdf', { body: { leaseContractId: contractId } }); setSaving(false); if (functionError || data?.error) { setError(data?.error ?? `PDFを生成できませんでした: ${functionError?.message ?? ''}`); return; } setNotice('対象区画図を含むPDFを生成・保存しました。'); await load(); };
  const download = async () => { if (!supabase || !document?.pdf_file_path) return; const { data, error: signedUrlError } = await supabase.storage.from('contract-documents').createSignedUrl(document.pdf_file_path, 60); if (signedUrlError || !data?.signedUrl) { setError(`PDFを開けませんでした: ${signedUrlError?.message ?? ''}`); return; } window.open(data.signedUrl, '_blank', 'noopener,noreferrer'); };

  if (loading) return <section className="contract-document-page"><p>契約書データを読み込み中です…</p></section>;
  return <section className="contract-document-page"><header className="document-heading"><div><p className="section-kicker">{isDemo ? 'DEMO / ORDINARY LEASE' : 'ORDINARY LEASE'}</p><h2>普通賃貸借契約書</h2><p>契約情報と対象区画図を保存し、別紙付きPDFを生成します。</p></div><div><Link className="secondary-button" to="/contracts">契約一覧へ戻る</Link><button className="primary-button" onClick={() => void generate()} disabled={saving}>{isDemo ? 'PDF出力を確認' : 'PDFを生成・保存'}</button></div></header>
    {error && <div className="document-message error">{error}</div>}{notice && <div className="document-message">{notice}</div>}
    <div className="document-workspace"><div className="document-editor"><section className="document-panel"><header><div><h3>デスクネッツ申請</h3><p>最終承認済みの申請のみを取得します。</p></div><button className="secondary-button" onClick={() => void loadApplications()} disabled={saving}>申請を取得</button></header>{applications.length > 0 && <div className="application-list">{applications.map((application) => <button key={application.applicationId} onClick={() => void applyApplication(application)}><strong>{application.title}</strong><span>承認日: {application.approvedAt ? new Date(application.approvedAt).toLocaleDateString('ja-JP') : '未設定'} / ID: {application.applicationId}</span></button>)}</div>}{selectedApplication && <p className="selected-application">転記元: {selectedApplication.title}</p>}</section>
      <section className="document-panel"><header><div><h3>契約情報</h3><p>変更した項目は再取得時も保持されます。</p></div><button className="secondary-button" onClick={() => void saveAll()} disabled={saving}>入力内容を保存</button></header><div className="document-form">{fields.map((field) => <label key={field.key}>{field.label}{field.required && <b>必須</b>}<div><input type={field.type ?? 'text'} value={values[field.key] ?? ''} onChange={(event) => update(field.key, event.target.value)} />{manualFields.includes(field.key) && <button type="button" title="デスクネッツの取得値へ戻す" onClick={() => resetField(field.key)}>取得値に戻す</button>}</div></label>)}</div></section>
      {!isDemo && <section className="document-panel plan-selection"><header><div><h3>対象区画</h3><p>契約済み区画のみ選択できます。保存時に現行平面図を別紙用PNGとして固定します。</p></div></header>{candidateGroups.length ? <div className="plan-groups">{candidateGroups.map(([revisionId, candidates]) => <div className="plan-group" key={revisionId}><div className="plan-group-heading"><strong>{candidates[0].floorLabel}</strong><span>選択した区画を赤枠で強調</span></div><div className="plan-candidates">{candidates.map((candidate) => <label key={candidate.unitId}><input type="checkbox" checked={selectedUnitIds.includes(candidate.unitId)} onChange={(event) => toggleUnit(candidate.unitId, event.target.checked)} /><span>{candidate.unitCode}</span></label>)}</div>{candidates[0].previewUrl && <div className="plan-preview"><img src={candidates[0].previewUrl} alt={`${candidates[0].floorLabel} 平面図`} /><svg viewBox="0 0 1 1" preserveAspectRatio="none">{candidates.filter((candidate) => selectedUnitIds.includes(candidate.unitId)).map((candidate) => <path key={candidate.unitId} d={candidate.geometry.coordinates.flatMap((polygon) => polygon.map((ring) => `M ${ring.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`)).join(' ')} />)}</svg></div>}</div>)}</div> : <p className="plan-empty">契約済み区画に、現行平面図と区画形状の両方が登録されていません。リーシング図面で登録後に選択してください。</p>}</section>}
      {storedPlans.length > 0 && <section className="document-panel saved-plan-list"><header><div><h3>保存済み対象区画図</h3><p>PDFは下記の固定スナップショットを使用します。</p></div></header>{storedPlans.map((plan) => <div key={plan.revisionId}><strong>{plan.floorLabel}：{plan.unitIds.length} 区画</strong>{plan.snapshotUrl && <img src={plan.snapshotUrl} alt={`${plan.floorLabel} の保存済み対象区画図`} />}</div>)}</section>}
      {document?.pdf_file_path && <section className="document-panel generated-file"><div><strong>最新PDFを保存済み</strong><span>{document.pdf_generated_at ? new Date(document.pdf_generated_at).toLocaleString('ja-JP') : ''}</span></div><button className="primary-button" onClick={() => void download()}>PDFを開く</button></section>}</div>
      <aside className="contract-preview"><div className="paper"><h1>建物賃貸借契約書</h1><p>以下の条件により、貸主と賃借人は建物賃貸借契約を締結する。</p><dl>{fields.map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{field.type === 'number' ? formatYen(values[field.key]) : values[field.key] || '未設定'}</dd></div>)}</dl><section><h3>第1条（使用目的）</h3><p>賃借人は、上記貸室を契約で定める用途以外に使用してはならない。</p><h3>第2条（賃料）</h3><p>賃借人は、毎月定められた期日までに賃料その他の負担金を支払う。</p><h3>第3条（原状回復）</h3><p>契約終了時の原状回復は、別途合意した条件に従う。</p></section><div className="seal-row"><div>貸主</div><div>賃借人</div></div></div><p className="template-note">PDF生成時は、選択済み対象区画図を契約書末尾の別紙ページに追加します。</p></aside></div></section>;
}
