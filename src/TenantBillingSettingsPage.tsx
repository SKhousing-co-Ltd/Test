import { useEffect, useState, type DragEvent, type FormEvent } from 'react';
import { supabase } from './lib/supabase';
import './TenantBillingSettingsPage.css';

type ChargeType = { billing_charge_type_id: string; charge_type_name: string; sort_order: number; is_active: boolean };
const defaultChargeTypes: ChargeType[] = [['rent', '賃料'], ['common-charge', '共益費'], ['parking', '駐車料'], ['electricity', '電気代'], ['water', '水道代'], ['gas', 'ガス代'], ['other', 'その他']].map(([id, name], index) => ({ billing_charge_type_id: id, charge_type_name: name, sort_order: index + 1, is_active: true }));
const localTypesKey = 'tenant-billing-charge-types';
const stored = <T,>(key: string, fallback: T): T => { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const renumber = <T,>(items: T[]) => items.map((item, index) => ({ ...item, sort_order: index + 1 }));
const move = (items: ChargeType[], sourceId: string, targetId: string) => { const sourceIndex = items.findIndex((item) => item.billing_charge_type_id === sourceId); const targetIndex = items.findIndex((item) => item.billing_charge_type_id === targetId); if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items; const next = [...items]; const [source] = next.splice(sourceIndex, 1); next.splice(targetIndex, 0, source); return renumber(next); };

export function TenantBillingSettingsPage() {
  const [chargeTypes, setChargeTypes] = useState<ChargeType[]>([]);
  const [chargeTypeName, setChargeTypeName] = useState('');
  const [draggingTypeId, setDraggingTypeId] = useState('');
  const [isDatabaseAvailable, setIsDatabaseAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const saveLocal = (types: ChargeType[]) => { localStorage.setItem(localTypesKey, JSON.stringify(types)); setChargeTypes(types); };

  useEffect(() => { const load = async () => {
    if (supabase) { const result = await supabase.from('billing_charge_type').select('billing_charge_type_id, charge_type_name, sort_order, is_active').order('sort_order'); if (!result.error) { setChargeTypes((result.data ?? []) as ChargeType[]); setIsDatabaseAvailable(true); setLoading(false); return; } }
    saveLocal(stored(localTypesKey, defaultChargeTypes)); setLoading(false);
  }; void load(); }, []);

  const addChargeType = async (event: FormEvent) => { event.preventDefault(); const name = chargeTypeName.trim(); if (!name) return; if (chargeTypes.some((type) => type.charge_type_name === name)) { setNotice('同じ請求種別が登録されています。'); return; }
    if (isDatabaseAvailable && supabase) { const { data, error } = await supabase.from('billing_charge_type').insert({ charge_type_name: name, sort_order: chargeTypes.length + 1 }).select('billing_charge_type_id, charge_type_name, sort_order, is_active').single(); if (error) { setNotice(`請求種別を登録できませんでした: ${error.message}`); return; } setChargeTypes((current) => [...current, data as ChargeType]); }
    else saveLocal([...chargeTypes, { billing_charge_type_id: crypto.randomUUID(), charge_type_name: name, sort_order: chargeTypes.length + 1, is_active: true }]);
    setChargeTypeName(''); setNotice('請求種別を登録しました。');
  };
  const saveOrder = async (next: ChargeType[]) => { setChargeTypes(next); const client = supabase; if (!isDatabaseAvailable || !client) { saveLocal(next); return; } const results = await Promise.all(next.map((type) => client.from('billing_charge_type').update({ sort_order: type.sort_order }).eq('billing_charge_type_id', type.billing_charge_type_id))); if (results.some((result) => result.error)) setNotice('請求種別の並び順を保存できませんでした。'); };
  const deleteChargeType = async (type: ChargeType) => { if (isDatabaseAvailable && supabase) { const { error } = await supabase.from('billing_charge_type').delete().eq('billing_charge_type_id', type.billing_charge_type_id); if (error) { setNotice(`請求種別を削除できませんでした: ${error.message}`); return; } } const next = renumber(chargeTypes.filter((item) => item.billing_charge_type_id !== type.billing_charge_type_id)); if (isDatabaseAvailable) setChargeTypes(next); else saveLocal(next); setNotice('請求種別を削除しました。'); };

  return <section className="tenant-billing-settings"><section className="page-heading"><div><p className="section-kicker">SETTINGS</p><h2>テナント請求設定</h2><p>テナント請求で共通利用する請求種別を管理します。明細項目は各物件の「請求設定」で登録します。</p></div></section>{!isDatabaseAvailable && !loading && <p className="tenant-billing-settings-notice">現在はローカル表示用の仮データです。データベース移行後は組織共通の設定として保存されます。</p>}{notice && <p className="tenant-billing-settings-message">{notice}</p>}<div className="tenant-billing-settings-grid">
    <section className="tenant-billing-settings-panel"><header><div><h3>請求種別</h3><p>賃料・共益費・電気代など、請求する内容の大まかな分類です。左端をドラッグして順番を変更できます。</p></div></header><form onSubmit={addChargeType} className="tenant-billing-settings-form"><label>請求種別名<input value={chargeTypeName} onChange={(event) => setChargeTypeName(event.target.value)} placeholder="例：電気代" /></label><button className="primary-button" type="submit">登録</button></form><div className="tenant-billing-settings-table-wrap"><table className="tenant-billing-settings-table"><thead><tr><th /><th>請求種別</th><th>状態</th><th /></tr></thead><tbody>{loading ? <tr><td colSpan={4}>読み込み中…</td></tr> : chargeTypes.map((type) => <tr key={type.billing_charge_type_id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (draggingTypeId) void saveOrder(move(chargeTypes, draggingTypeId, type.billing_charge_type_id)); setDraggingTypeId(''); }}><td><button type="button" className="drag-handle" draggable onDragStart={() => setDraggingTypeId(type.billing_charge_type_id)} onDragEnd={() => setDraggingTypeId('')} aria-label={`${type.charge_type_name}をドラッグして並び替え`} title="ドラッグして並び替え">⠿</button></td><td><strong>{type.charge_type_name}</strong></td><td><span>{type.is_active ? '有効' : '無効'}</span></td><td><button type="button" className="tenant-billing-delete" onClick={() => void deleteChargeType(type)}>削除</button></td></tr>)}</tbody></table></div></section>
  </div></section>;
}
