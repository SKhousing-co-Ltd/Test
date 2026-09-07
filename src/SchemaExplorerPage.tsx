import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './lib/supabase';
import './SchemaExplorerPage.css';

type Area = 'マスタ' | '物件/契約' | '駐車場' | '財務/調達' | '連携/取込/履歴' | 'その他' | '外部';
type Column = { name: string; type: string; nullable: boolean; default: string | null; comment: string | null };
type UniqueConstraint = { name: string; columns: string[] };
type SchemaTable = { id: string; schema: string; name: string; external: boolean; comment: string | null; columns: Column[]; primary_key: string[]; unique_constraints: UniqueConstraint[] };
type Relationship = { id: string; name: string; source: string; target: string; source_columns: string[]; target_columns: string[]; on_update: string; on_delete: string };
type SchemaGraph = { tables: SchemaTable[]; relationships: Relationship[] };
type GraphNode = SchemaTable & { area: Area; degree: number };
type GraphLink = Relationship & { source: string | GraphNode; target: string | GraphNode };

const ForceGraph3D = lazy(() => import('react-force-graph-3d'));

const AREA_COLORS: Record<Area, string> = {
  'マスタ': '#38a169', '物件/契約': '#3182ce', '駐車場': '#d69e2e', '財務/調達': '#805ad5', '連携/取込/履歴': '#dd6b20', 'その他': '#718096', '外部': '#e53e3e',
};
const AREAS = Object.keys(AREA_COLORS) as Area[];

function classify(table: SchemaTable): Area {
  if (table.external) return '外部';
  const name = table.name.toLowerCase();
  if (/(parking|parkings|bicycle|signage)/.test(name)) return '駐車場';
  if (/(property|asset|lease|contract|tenant|unit|floor|client)/.test(name)) return '物件/契約';
  if (/(financial|budget|actual|procure|vendor|invoice|payment|account)/.test(name)) return '財務/調達';
  if (/(import|sync|history|audit|change_request|inbox|snapshot|log)/.test(name)) return '連携/取込/履歴';
  if (/(master|profiles|employee|department|type|category|classification)/.test(name)) return 'マスタ';
  return 'その他';
}

function supportsWebGl() {
  try { const canvas = document.createElement('canvas'); return Boolean(canvas.getContext('webgl') || canvas.getContext('experimental-webgl')); } catch { return false; }
}

function asGraph(value: unknown): SchemaGraph | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SchemaGraph>;
  return Array.isArray(candidate.tables) && Array.isArray(candidate.relationships) ? candidate as SchemaGraph : null;
}

function nodeId(value: string | GraphNode) {
  return typeof value === 'string' ? value : value.id;
}

export function SchemaExplorerPage() {
  const [graph, setGraph] = useState<SchemaGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [areas, setAreas] = useState<Set<Area>>(() => new Set(AREAS));
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [selectedRelationshipId, setSelectedRelationshipId] = useState<string | null>(null);
  const [webGl, setWebGl] = useState(true);
  const [graphSize, setGraphSize] = useState({ width: 0, height: 560 });
  const graphRef = useRef<{ cameraPosition: (position?: { x?: number; y?: number; z?: number }, lookAt?: { x?: number; y?: number; z?: number }, ms?: number) => void } | null>(null);
  const graphContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => setWebGl(supportsWebGl()), []);
  useEffect(() => {
    const element = graphContainerRef.current;
    if (!element) return;
    const updateSize = () => setGraphSize({ width: Math.floor(element.clientWidth), height: Math.floor(element.clientHeight) });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [graph]);
  const load = async () => {
    if (!supabase) { setError('Supabase の接続設定がありません。'); return; }
    setLoading(true); setError(''); setSelectedTableId(null); setSelectedRelationshipId(null);
    const { data, error: rpcError } = await supabase.rpc('get_schema_explorer_graph');
    setLoading(false);
    if (rpcError) { setError(`スキーマを取得できませんでした: ${rpcError.message}`); return; }
    const next = asGraph(data);
    if (!next) { setError('スキーマ取得結果の形式が不正です。'); return; }
    setGraph(next);
  };

  const decorated = useMemo(() => {
    if (!graph) return { nodes: [] as GraphNode[], links: [] as GraphLink[] };
    const degree = new Map<string, number>();
    graph.relationships.forEach((edge) => { degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1); degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1); });
    const search = query.trim().toLowerCase();
    const nodes = graph.tables.map((table) => ({ ...table, area: classify(table), degree: degree.get(table.id) ?? 0 }))
      .filter((table) => areas.has(table.area) && (!search || `${table.name} ${table.comment ?? ''}`.toLowerCase().includes(search)));
    const visibleIds = new Set(nodes.map((node) => node.id));
    return { nodes, links: graph.relationships.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map((edge) => ({ ...edge })) };
  }, [areas, graph, query]);
  const selectedTable = graph?.tables.find((table) => table.id === selectedTableId) ?? null;
  const selectedRelationship = graph?.relationships.find((edge) => edge.id === selectedRelationshipId) ?? null;
  const focus = (id: string) => {
    const node = decorated.nodes.find((item) => item.id === id) as (GraphNode & { x?: number; y?: number; z?: number }) | undefined;
    if (node && graphRef.current && Number.isFinite(node.x)) graphRef.current.cameraPosition({ x: node.x! * 1.35, y: node.y! * 1.35, z: (node.z ?? 0) * 1.35 + 320 }, node, 700);
  };
  const relatedIds = useMemo(() => new Set(selectedTableId ? graph?.relationships.filter((edge) => edge.source === selectedTableId || edge.target === selectedTableId).flatMap((edge) => [edge.source, edge.target]) : []), [graph, selectedTableId]);
  const toggleArea = (area: Area) => setAreas((current) => { const next = new Set(current); next.has(area) ? next.delete(area) : next.add(area); return next; });
  const selectTable = (id: string) => { setSelectedTableId(id || null); setSelectedRelationshipId(null); if (id) focus(id); };

  return <section className="schema-explorer">
    <header className="page-header schema-explorer-header"><div><p className="eyebrow">ADMINISTRATION / DATABASE METADATA</p><h2>3Dスキーマ探索</h2><p>テーブル定義と外部キー関係のみを表示します。業務データや認証情報は取得しません。</p></div><button className="primary-button" onClick={() => void load()} disabled={loading}>{loading ? '読み込み中…' : graph ? 'スキーマを再取得' : 'スキーマを読み込む'}</button></header>
    {error && <p className="schema-explorer-message error">{error}</p>}
    {!graph && !loading && !error && <section className="panel schema-explorer-empty"><h3>まだスキーマは読み込まれていません</h3><p>「スキーマを読み込む」を選択すると、現在接続しているDBのメタデータを取得します。</p></section>}
    {graph && <section className="schema-explorer-workspace">
      <div className="schema-explorer-controls"><input aria-label="テーブルを検索" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="テーブル名・コメントを検索" /><select aria-label="テーブル詳細を開く" value={selectedTableId ?? ''} onChange={(event) => selectTable(event.target.value)} style={{ border: '1px solid #d5e0eb', borderRadius: 6, padding: '8px 10px', font: 'inherit', fontSize: 12, minWidth: 190 }}><option value="">テーブル詳細を選択…</option>{decorated.nodes.map((node) => <option key={node.id} value={node.id}>{node.id}</option>)}</select><button className="secondary-button" onClick={() => graphRef.current?.cameraPosition({ x: 0, y: 0, z: 400 }, { x: 0, y: 0, z: 0 }, 500)}>カメラをリセット</button><span>{decorated.nodes.length} テーブル / {decorated.links.length} 関係</span></div>
      <div className="schema-explorer-legend">{AREAS.map((area) => <button key={area} className={areas.has(area) ? 'active' : ''} onClick={() => toggleArea(area)}><i style={{ background: AREA_COLORS[area] }} />{area}</button>)}</div>
      <div className="schema-explorer-body"><div className="schema-explorer-graph" ref={graphContainerRef} style={{ minWidth: 0, overflow: 'hidden' }}>{webGl ? <Suspense fallback={<div className="schema-explorer-loading">3Dグラフを読み込んでいます…</div>}>{graphSize.width > 0 && <ForceGraph3D ref={graphRef as never} width={graphSize.width} height={graphSize.height} graphData={decorated} backgroundColor="#f8fafc" nodeId="id" linkSource="source" linkTarget="target" nodeLabel={(node: object) => { const value = node as GraphNode; return `${value.id}<br>${value.columns.length} columns / ${value.degree} links`; }} nodeColor={(node: object) => { const value = node as GraphNode; return selectedTableId && value.id !== selectedTableId && !relatedIds.has(value.id) ? '#cbd5e0' : AREA_COLORS[value.area]; }} nodeOpacity={0.94} nodeVal={(node: object) => 3 + Math.min((node as GraphNode).degree * 0.65, 10)} linkColor={(link: object) => { const value = link as GraphLink; const sourceId = nodeId(value.source); const targetId = nodeId(value.target); return selectedRelationshipId && value.id !== selectedRelationshipId ? 'rgba(148,163,184,.14)' : selectedTableId && sourceId !== selectedTableId && targetId !== selectedTableId ? 'rgba(148,163,184,.14)' : selectedRelationshipId === value.id ? '#be185d' : selectedTableId ? '#2563eb' : '#64748b'; }} linkWidth={(link: object) => { const value = link as GraphLink; const sourceId = nodeId(value.source); const targetId = nodeId(value.target); return selectedRelationshipId === value.id ? 2.8 : selectedTableId && (sourceId === selectedTableId || targetId === selectedTableId) ? 1.8 : 0.7; }} linkOpacity={0.68} linkDirectionalArrowLength={3} linkDirectionalArrowRelPos={1} linkDirectionalArrowColor={() => '#2563eb'} onNodeClick={(node: object) => { const value = node as GraphNode; selectTable(value.id); }} onLinkClick={(link: object) => { const value = link as GraphLink; setSelectedRelationshipId(value.id); setSelectedTableId(null); }} />}</Suspense> : <RelationshipList nodes={decorated.nodes} links={decorated.links} onTable={selectTable} onRelationship={setSelectedRelationshipId} />}</div>
        <aside className="schema-explorer-detail"><Detail table={selectedTable} relationship={selectedRelationship} onFocus={focus} /></aside></div>
    </section>}
  </section>;
}

function RelationshipList({ nodes, links, onTable, onRelationship }: { nodes: GraphNode[]; links: GraphLink[]; onTable: (id: string) => void; onRelationship: (id: string) => void }) {
  return <div className="schema-explorer-fallback"><p>この環境では WebGL を利用できないため、関係一覧を表示しています。</p><div className="schema-explorer-table-list">{nodes.map((node) => <button key={node.id} onClick={() => onTable(node.id)}><i style={{ background: AREA_COLORS[node.area] }} />{node.id}</button>)}</div><ul>{links.map((edge) => <li key={edge.id}><button onClick={() => onRelationship(edge.id)}>{edge.source} → {edge.target}</button><small>{edge.source_columns.join(', ')} → {edge.target_columns.join(', ')}</small></li>)}</ul></div>;
}

function Detail({ table, relationship, onFocus }: { table: SchemaTable | null; relationship: Relationship | null; onFocus: (id: string) => void }) {
  if (relationship) return <><p className="eyebrow">FOREIGN KEY</p><h3>{relationship.name}</h3><dl><dt>参照元</dt><dd><button onClick={() => onFocus(relationship.source)}>{relationship.source}</button> ({relationship.source_columns.join(', ')})</dd><dt>参照先</dt><dd><button onClick={() => onFocus(relationship.target)}>{relationship.target}</button> ({relationship.target_columns.join(', ')})</dd><dt>更新規則</dt><dd>{relationship.on_update}</dd><dt>削除規則</dt><dd>{relationship.on_delete}</dd></dl></>;
  if (!table) return <div className="schema-explorer-detail-empty"><h3>ノードまたは関係を選択</h3><p>選択したテーブルの列・キー、または外部キーの参照関係を表示します。</p></div>;
  return <><p className="eyebrow">{table.external ? 'EXTERNAL NODE' : table.schema.toUpperCase()}</p><h3>{table.name}</h3>{table.comment && <p className="schema-explorer-comment">{table.comment}</p>}{table.external ? <p>auth.users の内部定義は表示しません。</p> : <><dl><dt>主キー</dt><dd>{table.primary_key.length ? table.primary_key.join(', ') : 'なし'}</dd><dt>一意制約</dt><dd>{table.unique_constraints.length ? table.unique_constraints.map((key) => `${key.name} (${key.columns.join(', ')})`).join('\n') : 'なし'}</dd></dl><h4>列定義 ({table.columns.length})</h4><div className="schema-explorer-columns">{table.columns.map((column) => <div key={column.name}><strong>{column.name}</strong><span>{column.type}{column.nullable ? ' / NULL' : ' / NOT NULL'}</span>{column.default && <small>DEFAULT {column.default}</small>}{column.comment && <small>{column.comment}</small>}</div>)}</div></>}</>;
}
