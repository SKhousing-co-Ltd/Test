import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { supabase } from './lib/supabase';
import './approval-inventory.css';

type Review = 'unreviewed' | 'confirmed' | 'not_needed' | 'on_hold';
type Link = { kind: string; tenant?: string; property?: string; unit?: string; floor?: string; start?: string; end?: string; snapshot?: string; scope?: string };
type Row = { appsuite_record_id: string; app_id: string; data_id: string; ringi_number: string | null; workflow_type: string | null; approval_status: string | null; property_name: string | null; tenant_name: string | null; source_updated_at: string | null; is_present: boolean; review_status: Review; reviewed_at: string | null; reviewer: string | null; links: Link[] };
const labels: Record<Review, string> = { unreviewed: '未確認', confirmed: '確認済み', not_needed: '紐づけ不要', on_hold: '保留' };
const date = (value: string | null) => value ? new Date(value).toLocaleString('ja-JP') : '—';
const appsuiteUrl = (row: Row) => `https://sk-housing.dn-cloud.com/cgi-bin/dneo/appsuite.cgi?cmd=cdbbrowse&app_id=${encodeURIComponent(row.app_id)}#view_id=2&id=${encodeURIComponent(row.data_id)}`;
function openAppsuite(event: MouseEvent<HTMLAnchorElement>, url: string) {
  event.preventDefault();
  const popup = window.open(url, 'desknets-workflow', 'popup,width=1280,height=900,resizable=yes,scrollbars=yes');
  if (!popup) window.open(url, '_blank', 'noopener,noreferrer');
}

export function ApprovalInventoryPage() {
  const [rows, setRows] = useState<Row[]>([]); const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState(''); const [linkFilter, setLinkFilter] = useState('all'); const [reviewFilter, setReviewFilter] = useState('all'); const [typeFilter, setTypeFilter] = useState('all'); const [approvalFilter, setApprovalFilter] = useState('all');
  const [sort, setSort] = useState('source_updated_at'); const [ascending, setAscending] = useState(true); const [page, setPage] = useState(1); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  async function load() {
    if (!supabase) { setError('Supabase の接続情報がありません。'); setLoading(false); return; }
    setLoading(true); setError(''); const all: Row[] = [];
    for (let offset = 0; ; offset += 500) {
      const result = await supabase.rpc('list_approval_inventory').range(offset, offset + 499);
      if (result.error) { setError(result.error.message); setLoading(false); return; }
      const batch = (result.data ?? []) as Row[];
      all.push(...batch.filter(row => !/^(SK-SHU-|SK-BU-|SK-TE-)/i.test((row.ringi_number ?? '').trim()) && !['取消し', '取り消し', '下書き'].includes((row.approval_status ?? '').trim())));
      if (batch.length < 500) break;
    }
    setRows(all); setLoading(false);
  }
  useEffect(() => { void load(); }, []);
  const types = useMemo(() => [...new Set(rows.map(r => r.workflow_type).filter((v): v is string => !!v))].sort(), [rows]);
  const approvals = useMemo(() => [...new Set(rows.map(r => r.approval_status).filter((v): v is string => !!v))].sort(), [rows]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return rows.filter(r => (!term || [r.ringi_number,r.workflow_type,r.property_name,r.tenant_name,r.app_id,r.data_id].some(v => v?.toLowerCase().includes(term))) && (linkFilter === 'all' || (linkFilter === 'linked') === (r.links.length > 0)) && (reviewFilter === 'all' || r.review_status === reviewFilter) && (typeFilter === 'all' || r.workflow_type === typeFilter) && (approvalFilter === 'all' || r.approval_status === approvalFilter))
      .sort((a,b) => { const value = (r: Row) => sort === 'linked' ? (r.links.length ? '1' : '0') : String(r[sort as keyof Row] ?? ''); return value(a).localeCompare(value(b), 'ja', { numeric: true }) * (ascending ? 1 : -1) || a.appsuite_record_id.localeCompare(b.appsuite_record_id); });
  }, [rows,query,linkFilter,reviewFilter,typeFilter,approvalFilter,sort,ascending]);
  useEffect(() => { setPage(1); }, [query,linkFilter,reviewFilter,typeFilter,approvalFilter,sort,ascending]);
  const current = rows.find(r => r.appsuite_record_id === selected); const pages = Math.max(1, Math.ceil(filtered.length / 50));
  async function save(status: Review) {
    if (!current || !supabase) return; setSaving(true); setError('');
    const result = await supabase.rpc('save_approval_inventory_review', { p_record_id: current.appsuite_record_id, p_status: status });
    if (result.error) setError(result.error.message); else await load(); setSaving(false);
  }
  return <section className="inventory-page"><header className="page-heading"><div><h2>稟議の棚卸し</h2><p>取得済み稟議と契約の紐づけを確認します。契約や対応依頼は変更されません。</p></div><button onClick={() => void load()} disabled={loading}>更新</button></header>
    {error && <p className="notice">{error}</p>}
    <div className="inventory-filters"><input aria-label="検索" placeholder="稟議番号・物件・テナントなど" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="紐づけ状態" value={linkFilter} onChange={e => setLinkFilter(e.target.value)}><option value="all">紐づけ：すべて</option><option value="linked">紐づけ済み</option><option value="unlinked">未紐づけ</option></select><select aria-label="確認状況" value={reviewFilter} onChange={e => setReviewFilter(e.target.value)}><option value="all">確認状況：すべて</option>{Object.entries(labels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select><select aria-label="稟議種別" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}><option value="all">稟議種別：すべて</option>{types.map(v => <option key={v}>{v}</option>)}</select><select aria-label="決裁状況" value={approvalFilter} onChange={e => setApprovalFilter(e.target.value)}><option value="all">決裁状況：すべて</option>{approvals.map(v => <option key={v}>{v}</option>)}</select><select aria-label="並び順" value={sort} onChange={e => setSort(e.target.value)}><option value="source_updated_at">更新日時</option><option value="ringi_number">稟議番号</option><option value="workflow_type">稟議種別</option><option value="approval_status">決裁状況</option><option value="property_name">物件</option><option value="tenant_name">テナント</option><option value="linked">紐づけ状態</option><option value="review_status">確認状況</option></select><button onClick={() => setAscending(!ascending)}>{ascending ? '昇順 ↑' : '降順 ↓'}</button></div>
    <p>{loading ? '読み込み中…' : `${filtered.length.toLocaleString()}件 / 全 ${rows.length.toLocaleString()}件`}　※取得元で見つからなくなった稟議も含みます。</p>
    <div className="table-wrap inventory-table"><table><thead><tr><th>紐づけ</th><th>確認状況</th><th>稟議番号</th><th>種別</th><th>決裁状況</th><th>物件</th><th>テナント</th><th>更新日時</th><th /></tr></thead><tbody>{filtered.slice((page-1)*50,page*50).map(r => <tr key={r.appsuite_record_id}><td>{r.links.length ? `紐づけ済み (${r.links.length})` : '未紐づけ'}</td><td>{labels[r.review_status]}</td><td><a href={appsuiteUrl(r)} target="_blank" rel="noreferrer" onClick={event => openAppsuite(event, appsuiteUrl(r))}>{r.ringi_number || '原文を開く'} ↗</a>{!r.is_present && <small>取得元で未検出</small>}</td><td>{r.workflow_type || '—'}</td><td>{r.approval_status || '—'}</td><td>{r.property_name || '—'}</td><td>{r.tenant_name || '—'}</td><td>{date(r.source_updated_at)}</td><td><button onClick={() => setSelected(r.appsuite_record_id)}>確認</button></td></tr>)}</tbody></table></div>
    <div className="inventory-pagination"><button disabled={page <= 1} onClick={() => setPage(page-1)}>前へ</button><span>{page} / {pages}</span><button disabled={page >= pages} onClick={() => setPage(page+1)}>次へ</button></div>
    {current && <div className="modal-backdrop" onClick={() => setSelected(null)}><section className="modal inventory-detail" onClick={e => e.stopPropagation()}><header><h3>{current.ringi_number || '稟議番号なし'}</h3><button onClick={() => setSelected(null)}>閉じる</button></header><p>{current.workflow_type || '種別なし'} / {current.approval_status || '決裁状況なし'} / {current.property_name || '物件なし'} / {current.tenant_name || 'テナントなし'}</p><p><a href={appsuiteUrl(current)} target="_blank" rel="noreferrer" onClick={event => openAppsuite(event, appsuiteUrl(current))}>デスクネッツの原文を開く ↗</a></p><h4>紐づけ先（{current.links.length}件）</h4>{current.links.length ? <ul>{current.links.map((link,i) => <li key={i}>{[link.kind,link.property,link.tenant,link.floor,link.unit,link.start && `${link.start}〜${link.end || '継続中'}`,link.snapshot && `基準日 ${link.snapshot}`,link.scope].filter(Boolean).join(' / ')}</li>)}</ul> : <p>紐づけはありません。</p>}<h4>棚卸し状況：{labels[current.review_status]}</h4><p>確認者：{current.reviewer || '—'}　確認日時：{date(current.reviewed_at)}</p><div className="inventory-actions">{Object.entries(labels).map(([status,label]) => <button key={status} disabled={saving || status === current.review_status} onClick={() => void save(status as Review)}>{label}にする</button>)}</div></section></div>}
  </section>;
}
