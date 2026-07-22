import { useEffect, useRef, useState, type PointerEvent } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { supabase } from './lib/supabase';
import './leasing-map.css';
import { centerFor, fileKind, pathFor, scopeKey, toMultiPolygon, type GeoJSONMultiPolygon, type Point } from './lib/leasing-map';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export type FloorPlanSummary = { floorPlanId: string | null; propertyId: string; propertyName: string; floorLabel: string };
export type FloorPlanRevision = { id: string; floorPlanId: string; revisionNo: number; previewPath: string; originalPath: string; fileType: string; pdfPage: number | null; createdAt: string };
export type MapFeature = { unitId: string; unitCode: string; unitName: string; areaSqm: number | null; geometry: GeoJSONMultiPolygon; displayStatus: DisplayStatus };
export type PlanChangeSet = { id: string; type: string; note: string | null; createdAt: string };
type DisplayStatus = 'occupied' | 'vacant' | 'applied' | 'unavailable';
type Unit = { unit_id: string; unit_code: string; unit_name: string | null; rentable_area_sqm: number | null };
type Property = { property_id: string; property_name: string };

const statusLabel: Record<DisplayStatus, string> = { occupied: '契約中', applied: '申込中', vacant: '空室', unavailable: '募集停止' };
const statusColor: Record<DisplayStatus, string> = { occupied: '#2f7fc5', applied: '#e6982e', vacant: '#42a877', unavailable: '#8b96a8' };


export function LeasingMapPage() {
  const [plans, setPlans] = useState<FloorPlanSummary[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [revisions, setRevisions] = useState<FloorPlanRevision[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [selectedRevisionId, setSelectedRevisionId] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [features, setFeatures] = useState<MapFeature[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [history, setHistory] = useState<PlanChangeSet[]>([]);
  const [selectedUnitId, setSelectedUnitId] = useState('');
  const [tool, setTool] = useState<'select' | 'polygon' | 'rectangle'>('select');
  const [draft, setDraft] = useState<Point[]>([]);
  const [rectStart, setRectStart] = useState<Point | null>(null);
  const [rectEnd, setRectEnd] = useState<Point | null>(null);
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [unitCreateOpen, setUnitCreateOpen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const stageRef = useRef<SVGSVGElement>(null);
  const selectedPlan = plans.find((plan) => scopeKey(plan) === selectedPlanId);
  const selectedRevision = revisions.find((revision) => revision.id === selectedRevisionId);
  const selectedFeature = features.find((feature) => feature.unitId === selectedUnitId);

  const loadPlans = async () => {
    if (!supabase) return;
    const { data: propertyData, error: propertyError } = await supabase.from('property_master').select('property_id, property_name').order('property_name');
    if (propertyError) setNotice(`物件を取得できません: ${propertyError.message}`); else setProperties((propertyData ?? []) as Property[]);
    const { data, error } = await supabase.from('unit_master').select('property_id, floor_label, property:property_master(property_name)').eq('is_active', true).not('floor_label', 'is', null).order('floor_label');
    if (error) return setNotice(`図面一覧を取得できません: ${error.message}`);
    const scopes = new Map<string, FloorPlanSummary>(); (data ?? []).forEach((row: any) => { const plan = { floorPlanId: null, propertyId: row.property_id, propertyName: row.property?.property_name ?? '物件', floorLabel: row.floor_label }; scopes.set(scopeKey(plan), plan); });
    const { data: existing } = await supabase.from('floor_plan').select('floor_plan_id, property_id, floor_label, property:property_master(property_name)');
    (existing ?? []).forEach((row: any) => { const key = `${row.property_id}|${row.floor_label}`; const plan = scopes.get(key); if (plan) plan.floorPlanId = row.floor_plan_id; else scopes.set(key, { floorPlanId: row.floor_plan_id, propertyId: row.property_id, propertyName: row.property?.property_name ?? '物件', floorLabel: row.floor_label }); });
    const next = [...scopes.values()]; setPlans(next); if (!selectedPlanId && next[0]) setSelectedPlanId(scopeKey(next[0]));
  };
  const loadRevisions = async (planId: string) => {
    if (!supabase || !planId) return;
    const { data, error } = await supabase.from('floor_plan_revision').select('floor_plan_revision_id, floor_plan_id, revision_no, preview_file_path, original_file_path, file_type, pdf_page_number, created_at').eq('floor_plan_id', planId).order('revision_no', { ascending: false });
    if (error) return setNotice(`図面版を取得できません: ${error.message}`);
    const next = (data ?? []).map((row: any) => ({ id: row.floor_plan_revision_id, floorPlanId: row.floor_plan_id, revisionNo: row.revision_no, previewPath: row.preview_file_path, originalPath: row.original_file_path, fileType: row.file_type, pdfPage: row.pdf_page_number, createdAt: row.created_at }));
    setRevisions(next); setSelectedRevisionId(next[0]?.id ?? '');
  };
  const loadRevisionData = async (revisionId: string) => {
    if (!supabase || !revisionId) return;
    const [{ data: mapData, error: mapError }, { data: historyData }] = await Promise.all([
      supabase.from('floor_plan_map_features').select('unit_id, unit_code, unit_name, rentable_area_sqm, geometry_geojson, display_status').eq('floor_plan_revision_id', revisionId),
      supabase.from('plan_change_set').select('plan_change_set_id, change_type, note, created_at').eq('floor_plan_revision_id', revisionId).order('created_at', { ascending: false }),
    ]);
    if (mapError) setNotice(`区画データを取得できません: ${mapError.message}`);
    setFeatures((mapData ?? []).map((row: any) => ({ unitId: row.unit_id, unitCode: row.unit_code, unitName: row.unit_name, areaSqm: row.rentable_area_sqm, geometry: row.geometry_geojson, displayStatus: row.display_status })));
    setHistory((historyData ?? []).map((row: any) => ({ id: row.plan_change_set_id, type: row.change_type, note: row.note, createdAt: row.created_at })));
    const revision = revisions.find((item) => item.id === revisionId);
    if (revision) { const { data } = await supabase.storage.from('floor-plans').createSignedUrl(revision.previewPath, 3600); setPreviewUrl(data?.signedUrl ?? ''); }
    const plan = plans.find((item) => scopeKey(item) === selectedPlanId);
    if (plan) { const { data } = await supabase.from('unit_master').select('unit_id, unit_code, unit_name, rentable_area_sqm').eq('property_id', plan.propertyId).eq('floor_label', plan.floorLabel).eq('is_active', true).order('unit_code'); setUnits((data ?? []) as Unit[]); }
  };
  useEffect(() => { void loadPlans(); }, []);
  useEffect(() => { const plan = plans.find((item) => scopeKey(item) === selectedPlanId); if (plan?.floorPlanId) void loadRevisions(plan.floorPlanId); else { setRevisions([]); setSelectedRevisionId(''); } }, [selectedPlanId, plans]);
  useEffect(() => { if (selectedRevisionId) void loadRevisionData(selectedRevisionId); else { setFeatures([]); setUnits([]); setPreviewUrl(''); } }, [selectedRevisionId, revisions.length]);

  const pointFromEvent = (event: PointerEvent<SVGSVGElement>): Point => { const rect = stageRef.current!.getBoundingClientRect(); return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))]; };
  const finishPolygon = async () => { if (draft.length < 3) return setNotice('多角形には3点以上が必要です。'); await saveGeometry(toMultiPolygon(draft)); setDraft([]); setTool('select'); };
  const saveGeometry = async (geometry: GeoJSONMultiPolygon) => {
    if (!supabase || !selectedRevisionId || !selectedUnitId) return setNotice('図面版と対象区画を選択してください。');
    const { error } = await supabase.rpc('save_unit_plan_geometry', { p_revision_id: selectedRevisionId, p_unit_id: selectedUnitId, p_geometry_geojson: geometry, p_note: null });
    if (error) return setNotice(`保存できません: ${error.message}`);
    setNotice('区画形状を保存しました。'); await loadRevisionData(selectedRevisionId);
  };
  const updateStatus = async (status: DisplayStatus) => { if (!supabase || !selectedUnitId) return; const { error } = await supabase.rpc('set_unit_leasing_status', { p_unit_id: selectedUnitId, p_status: status }); if (error) return setNotice(error.message); setNotice('リーシング状態を更新しました。'); await loadRevisionData(selectedRevisionId); };
  const createUnit = async (draft: { unitCode: string; unitName: string; areaSqm: number | null }) => {
    if (!supabase || !selectedPlan) return;
    const { data, error } = await supabase.rpc('create_map_unit', { p_property_id: selectedPlan.propertyId, p_floor_label: selectedPlan.floorLabel, p_unit_code: draft.unitCode, p_unit_name: draft.unitName || null, p_rentable_area_sqm: draft.areaSqm });
    if (error) return setNotice(`区画を登録できません: ${error.message}`);
    setUnitCreateOpen(false); setSelectedUnitId(data); setNotice('区画を追加しました。続けて「矩形」または「多角形」で枠を描いてください。'); await loadPlans(); await loadRevisionData(selectedRevisionId);
  };
  const onStagePointerDown = (event: PointerEvent<SVGSVGElement>) => { if (!selectedUnitId) return setNotice('右側の区画一覧から対象区画を選択してください。'); const point = pointFromEvent(event); if (tool === 'polygon') setDraft((items) => [...items, point]); if (tool === 'rectangle') { setRectStart(point); setRectEnd(point); event.currentTarget.setPointerCapture(event.pointerId); } };
  const onStagePointerMove = (event: PointerEvent<SVGSVGElement>) => { if (tool === 'rectangle' && rectStart) setRectEnd(pointFromEvent(event)); };
  const onStagePointerUp = async () => { if (tool !== 'rectangle' || !rectStart || !rectEnd) return; const [x1, y1] = rectStart; const [x2, y2] = rectEnd; setRectStart(null); setRectEnd(null); if (Math.abs(x1 - x2) < .01 || Math.abs(y1 - y2) < .01) return; await saveGeometry(toMultiPolygon([[x1, y1], [x2, y1], [x2, y2], [x1, y2]])); setTool('select'); };
  const upload = async (file: File, pdfPage: number, target: { propertyId: string; floorLabel: string }) => {
    if (!supabase) return; const type = fileKind(file); if (!type) return setNotice('PNG、JPEG、SVG、PDFのみ登録できます。');
    setUploading(true); setNotice('');
    try {
      let previewBlob: Blob = file;
      if (type === 'pdf') { const pdfDocument = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise; if (pdfPage < 1 || pdfPage > pdfDocument.numPages) throw new Error(`PDFは1〜${pdfDocument.numPages}ページから選択してください。`); const page = await pdfDocument.getPage(pdfPage); const viewport = page.getViewport({ scale: 2 }); const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise; previewBlob = await new Promise<Blob>((resolve) => canvas.toBlob((blob: Blob | null) => resolve(blob!), 'image/png')); }
      // Storageのobject keyには元ファイル名を使わない（日本語・記号を含む名前を安全に扱うため）。
      const scope = crypto.randomUUID(); const extension = type === 'jpeg' ? 'jpg' : type; const originalPath = `${scope}/original.${extension}`; const previewPath = `${scope}/preview.${type === 'pdf' ? 'png' : extension}`;
      const [{ error: originalError }, { error: previewError }] = await Promise.all([supabase.storage.from('floor-plans').upload(originalPath, file), supabase.storage.from('floor-plans').upload(previewPath, previewBlob, { contentType: type === 'pdf' ? 'image/png' : file.type })]);
      if (originalError || previewError) throw originalError ?? previewError;
      const { data, error } = await supabase.rpc('create_floor_plan_revision', { p_property_id: target.propertyId, p_building_wing_id: null, p_floor_label: target.floorLabel, p_original_file_path: originalPath, p_preview_file_path: previewPath, p_file_type: type, p_pdf_page_number: type === 'pdf' ? pdfPage : null });
      if (error) throw error; setNotice('図面の新しい版を登録しました。'); setUploadOpen(false); await loadPlans(); setSelectedPlanId(`${target.propertyId}|${target.floorLabel}`); setSelectedRevisionId(data);
    } catch (error: any) { setNotice(`図面を登録できません: ${error.message ?? error}`); } finally { setUploading(false); }
  };

  return <section className="leasing-page">
    <div className="leasing-heading"><div><p className="eyebrow">LEASING MAP</p><h2>リーシング図面</h2><p>図面と区画形状を分離して管理します。赤枠は画面上で動的に描画されます。</p></div><button className="primary-button" onClick={() => setUploadOpen(true)} disabled={!properties.length}>図面を登録</button></div>
    {notice && <div className="leasing-notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}
    {!plans.length ? <div className="empty-state"><strong>登録済みのフロアがありません</strong><p>先に既存の区画マスタへ物件とフロアを登録してください。</p></div> : <>
      <div className="leasing-toolbar"><label>物件・フロア<select value={selectedPlanId} onChange={(event) => setSelectedPlanId(event.target.value)}>{plans.map((plan) => <option value={scopeKey(plan)} key={scopeKey(plan)}>{plan.propertyName} / {plan.floorLabel}</option>)}</select></label><label>図面版<select value={selectedRevisionId} onChange={(event) => setSelectedRevisionId(event.target.value)}>{revisions.map((revision) => <option value={revision.id} key={revision.id}>v{revision.revisionNo}（{new Date(revision.createdAt).toLocaleDateString('ja-JP')}）</option>)}</select></label><span className="revision-meta">{selectedRevision?.fileType.toUpperCase()}{selectedRevision?.pdfPage ? ` / ${selectedRevision.pdfPage}ページ` : ''}</span></div>
      {selectedRevisionId ? <div className="leasing-workspace"><div className="map-panel"><div className="map-tools"><button className={tool === 'select' ? 'selected' : ''} onClick={() => { setTool('select'); setDraft([]); }}>選択</button><button className={tool === 'polygon' ? 'selected' : ''} onClick={() => { setTool('polygon'); setDraft([]); }}>多角形</button><button className={tool === 'rectangle' ? 'selected' : ''} onClick={() => setTool('rectangle')}>矩形</button>{tool === 'polygon' && <button className="map-save" onClick={() => void finishPolygon()}>多角形を確定</button>}<div className="zoom-controls" aria-label="表示倍率"><button onClick={() => setZoom((value) => Math.max(50, value - 25))} disabled={zoom <= 50} aria-label="縮小">−</button><button className="zoom-value" onClick={() => setZoom(100)} title="100%に戻す">{zoom}%</button><button onClick={() => setZoom((value) => Math.min(200, value + 25))} disabled={zoom >= 200} aria-label="拡大">＋</button></div><span>{selectedUnitId ? `編集対象: ${units.find((unit) => unit.unit_id === selectedUnitId)?.unit_code ?? ''}` : '編集対象の区画を選択'}</span></div><div className="map-stage"><div className="map-canvas" style={{ width: `${zoom}%` }}><img src={previewUrl} alt="フロア図面" /><svg ref={stageRef} viewBox="0 0 1 1" preserveAspectRatio="none" onPointerDown={onStagePointerDown} onPointerMove={onStagePointerMove} onPointerUp={() => void onStagePointerUp()}>{features.map((feature) => { const [x, y] = centerFor(feature.geometry); return <g key={feature.unitId} className={selectedUnitId === feature.unitId ? 'map-feature selected' : 'map-feature'} onClick={(event) => { event.stopPropagation(); setSelectedUnitId(feature.unitId); }}><path d={pathFor(feature.geometry)} style={{ fill: statusColor[feature.displayStatus], stroke: statusColor[feature.displayStatus] }} /><text x={x} y={y}>{feature.unitCode}</text></g>; })}{draft.length > 0 && <path className="draft-shape" d={pathFor(toMultiPolygon(draft))} />}{rectStart && rectEnd && <path className="draft-shape" d={pathFor(toMultiPolygon([[rectStart[0], rectStart[1]], [rectEnd[0], rectStart[1]], rectEnd, [rectStart[0], rectEnd[1]]]))} />}</svg></div></div><div className="map-legend">{(Object.keys(statusLabel) as DisplayStatus[]).map((status) => <span key={status}><i style={{ background: statusColor[status] }} />{statusLabel[status]}</span>)}</div></div>
        <aside className="map-sidebar"><section><div className="section-title-row"><h3>区画</h3><button className="add-unit-button" onClick={() => setUnitCreateOpen(true)}>＋ 区画を追加</button></div><div className="unit-list">{units.map((unit) => { const feature = features.find((item) => item.unitId === unit.unit_id); return <button className={selectedUnitId === unit.unit_id ? 'selected' : ''} onClick={() => setSelectedUnitId(unit.unit_id)} key={unit.unit_id}><strong>{unit.unit_code}</strong><span>{unit.rentable_area_sqm ? `${unit.rentable_area_sqm}㎡` : '面積未設定'} {feature ? statusLabel[feature.displayStatus] : '図形未登録'}</span></button>; })}</div></section>{selectedFeature && <section className="status-editor"><h3>{selectedFeature.unitCode} の状態</h3><div>{(['occupied', 'vacant', 'applied', 'unavailable'] as const).map((status) => <button onClick={() => void updateStatus(status)} className={selectedFeature.displayStatus === status ? 'selected' : ''} key={status}>{statusLabel[status]}</button>)}</div>{selectedFeature.displayStatus === 'occupied' && <p>有効な契約がある場合も「契約中」と表示されます。</p>}</section>}<section><h3>変更履歴</h3><ol className="history-list">{history.map((change) => <li key={change.id}><strong>{change.type}</strong><span>{new Date(change.createdAt).toLocaleString('ja-JP')}</span></li>)}</ol></section></aside></div> : <div className="empty-state"><strong>図面版がありません</strong><p>このフロアのベース図面を登録してください。</p></div>}
    </>}
    {uploadOpen && <UploadDialog plan={selectedPlan} properties={properties} busy={uploading} onClose={() => setUploadOpen(false)} onUpload={upload} />}
    {unitCreateOpen && selectedPlan && <CreateUnitDialog plan={selectedPlan} onClose={() => setUnitCreateOpen(false)} onCreate={createUnit} />}
  </section>;
}

function UploadDialog({ plan, properties, busy, onClose, onUpload }: { plan?: FloorPlanSummary; properties: Property[]; busy: boolean; onClose: () => void; onUpload: (file: File, page: number, target: { propertyId: string; floorLabel: string }) => Promise<void> }) { const [file, setFile] = useState<File | null>(null); const [page, setPage] = useState(1); const [propertyId, setPropertyId] = useState(plan?.propertyId ?? properties[0]?.property_id ?? ''); const [floorLabel, setFloorLabel] = useState(plan?.floorLabel ?? ''); return <div className="modal-backdrop"><form className="modal upload-dialog" onSubmit={(event) => { event.preventDefault(); if (file && propertyId && floorLabel.trim()) void onUpload(file, page, { propertyId, floorLabel: floorLabel.trim() }); }}><header><div><p className="eyebrow">FLOOR PLAN</p><h2>図面を登録</h2></div><button className="modal-close" type="button" onClick={onClose}>×</button></header><div className="modal-body"><div className="form-grid"><label>物件<select value={propertyId} onChange={(event) => setPropertyId(event.target.value)} required>{properties.map((property) => <option value={property.property_id} key={property.property_id}>{property.property_name}</option>)}</select></label><label>フロア<input value={floorLabel} onChange={(event) => setFloorLabel(event.target.value)} placeholder="例: 8F" required /></label></div><label>図面ファイル<input type="file" accept="image/png,image/jpeg,image/svg+xml,application/pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required /></label>{file?.type === 'application/pdf' && <label>編集対象ページ<input type="number" min="1" value={page} onChange={(event) => setPage(Number(event.target.value))} required /></label>}<p className="modal-hint">PDFは原本と、選択ページをPNGに変換したプレビューを保存します。画像・SVGは同じファイルをプレビューとして使用します。</p></div><footer><button className="secondary-button" type="button" onClick={onClose}>キャンセル</button><button className="primary-button" disabled={busy || !file || !propertyId || !floorLabel.trim()}>{busy ? '登録中…' : '登録する'}</button></footer></form></div>; }

function CreateUnitDialog({ plan, onClose, onCreate }: { plan: FloorPlanSummary; onClose: () => void; onCreate: (draft: { unitCode: string; unitName: string; areaSqm: number | null }) => Promise<void> }) { const [unitCode, setUnitCode] = useState(''); const [unitName, setUnitName] = useState(''); const [area, setArea] = useState(''); return <div className="modal-backdrop"><form className="modal upload-dialog" onSubmit={(event) => { event.preventDefault(); void onCreate({ unitCode: unitCode.trim(), unitName: unitName.trim(), areaSqm: area === '' ? null : Number(area) }); }}><header><div><p className="eyebrow">UNIT</p><h2>区画を追加</h2></div><button className="modal-close" type="button" onClick={onClose}>×</button></header><div className="modal-body"><p className="upload-target">{plan.propertyName} / {plan.floorLabel}</p><label>区画コード<input value={unitCode} onChange={(event) => setUnitCode(event.target.value)} placeholder="例: 401" required autoFocus /></label><label>区画名<input value={unitName} onChange={(event) => setUnitName(event.target.value)} placeholder="例: 401号室" /></label><label>賃貸可能面積（㎡）<input type="number" min="0" step="0.01" value={area} onChange={(event) => setArea(event.target.value)} placeholder="例: 45.50" /></label><p className="modal-hint">登録後、区画が自動選択されます。「矩形」または「多角形」を選んで図面上に枠を描いてください。</p></div><footer><button className="secondary-button" type="button" onClick={onClose}>キャンセル</button><button className="primary-button" disabled={!unitCode.trim()}>区画を追加</button></footer></form></div>; }
