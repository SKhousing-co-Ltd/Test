import { useEffect, useState, type DragEvent } from 'react';
import { supabase } from './lib/supabase';
import { loadSavedTenantOrder, moveBefore, orderTenants } from './utils/tenantOrder';

type RentRollRow = { tenant_id: string | null; tenant_name: string | null; unit_id: string | null; unit_code: string | null; unit_name: string | null; floor_label: string | null };
type TenantRow = { tenantId: string; name: string; floor: string; units: string[]; saved: boolean };

const today = () => new Date().toLocaleDateString('sv-SE');

// テナント請求の各画面で使うテナントの並び順を決めます。今日時点で契約中のテナントを並べ替えて保存します。
export function TenantOrderSettings({ propertyId, canEdit }: { propertyId: string; canEdit: boolean }) {
  const [rows, setRows] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!supabase || !propertyId) { setRows([]); setLoading(false); return; }
      setLoading(true); setNotice(''); setDirty(false);
      const [rentRoll, saved] = await Promise.all([
        supabase.rpc('rent_roll_list_with_terms_at_date', { p_property_id: propertyId, p_as_of_date: today() }),
        loadSavedTenantOrder(supabase, propertyId),
      ]);
      if (cancelled) return;
      if (rentRoll.error) { setNotice(`テナントを読み込めませんでした: ${rentRoll.error.message}`); setRows([]); setLoading(false); return; }
      const source = (rentRoll.data ?? []) as RentRollRow[];
      const savedIds = new Set(saved.map((row) => row.tenant_id));
      setRows(orderTenants(source, saved).map((tenantId) => {
        const own = source.filter((row) => row.tenant_id === tenantId);
        return {
          tenantId, name: own[0]?.tenant_name ?? '', floor: own[0]?.floor_label ?? '',
          units: [...new Set(own.map((row) => row.unit_name || row.unit_code || ''))].filter(Boolean), saved: savedIds.has(tenantId),
        };
      }));
      setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [propertyId]);

  // 行の左端のつまみをドラッグして並べ替えます。dropBefore は挿入線を引く位置（その番目の行の手前）です。
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropBefore, setDropBefore] = useState<number | null>(null);
  const endDrag = () => { setDragIndex(null); setDropBefore(null); };
  const dragOver = (event: DragEvent<HTMLTableRowElement>, index: number) => {
    if (dragIndex === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const box = event.currentTarget.getBoundingClientRect();
    setDropBefore(event.clientY < box.top + box.height / 2 ? index : index + 1);
  };
  const drop = (event: DragEvent<HTMLTableRowElement>) => {
    event.preventDefault();
    if (dragIndex !== null && dropBefore !== null && dropBefore !== dragIndex && dropBefore !== dragIndex + 1) {
      setRows((current) => moveBefore(current, dragIndex, dropBefore));
      setDirty(true);
    }
    endDrag();
  };

  const save = async () => {
    if (!supabase || !propertyId) return;
    setSaving(true); setNotice('');
    const { error } = await supabase.from('asset_billing_tenant_order').upsert(
      rows.map((row, index) => ({ asset_id: propertyId, tenant_id: row.tenantId, sort_order: index })),
      { onConflict: 'asset_id,tenant_id' },
    );
    if (error) { setSaving(false); setNotice(`テナント並び順を保存できませんでした: ${error.message}`); return; }
    // 退去したテナントの古い並び順は消します。残すと、過去の月を開いたときに今のテナントと順番がぶつかります。
    const { error: cleanupError } = await supabase.from('asset_billing_tenant_order').delete()
      .eq('asset_id', propertyId).not('tenant_id', 'in', `(${rows.map((row) => row.tenantId).join(',')})`);
    setSaving(false);
    if (cleanupError) { setNotice(`退去したテナントの並び順を消せませんでした: ${cleanupError.message}`); return; }
    setRows((current) => current.map((row) => ({ ...row, saved: true })));
    setDirty(false);
    setNotice('テナント並び順を保存しました。');
  };

  return <section className="property-period-patterns tenant-order-settings">
    <div>
      <h4>テナント並び順</h4>
      <p>入金明細・請求明細・請求書作成・検針データは、この順番でテナントを表示します。請求書番号もこの順で採番します。テナントコード一覧は発行コード順です。</p>
      <p>「未設定」のテナントは、保存するまでレントロールの階順の位置に表示します。同じ区画に入居しているテナントは、そのテナントのすぐ下に表示します。</p>
    </div>
    <div className="tenant-order-actions">
      {notice && <span className="tenant-order-notice">{notice}</span>}
      <button type="button" className="primary-button" disabled={!canEdit || saving || loading || !rows.length || (!dirty && rows.every((row) => row.saved))} onClick={() => void save()}>{saving ? '保存中…' : '並び順を保存'}</button>
    </div>
    <div className="property-billing-settings-table-wrap">
      <table>
        <thead><tr><th aria-label="並べ替え" /><th>階</th><th>テナント名</th><th>区画</th></tr></thead>
        <tbody>
          {loading && <tr><td colSpan={4}>読み込み中…</td></tr>}
          {!loading && !rows.length && <tr><td colSpan={4}>契約中のテナントがありません。</td></tr>}
          {!loading && rows.map((row, index) => <tr
            key={row.tenantId}
            className={[
              dragIndex === index ? 'tenant-order-dragging' : '',
              dropBefore === index ? 'tenant-order-drop-before' : '',
              dropBefore === index + 1 && index === rows.length - 1 ? 'tenant-order-drop-after' : '',
            ].filter(Boolean).join(' ') || undefined}
            onDragOver={(event) => dragOver(event, index)}
            onDrop={drop}
          >
            <td className="tenant-order-handle-cell">
              <span
                className="tenant-order-handle"
                draggable={canEdit}
                title={canEdit ? 'ドラッグして並べ替え' : undefined}
                aria-label={`${row.name}を並べ替え`}
                onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.tenantId); setDragIndex(index); }}
                onDragEnd={endDrag}
              >⋮⋮</span>
            </td>
            <td>{row.floor || '—'}</td>
            <td>{row.name}{!row.saved && <span className="tenant-order-unsaved">未設定</span>}</td>
            <td>{row.units.join('・') || '—'}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </section>;
}
