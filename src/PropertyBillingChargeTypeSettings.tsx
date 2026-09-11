import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';

type ChargeType = { billing_charge_type_id: string; charge_type_name: string };
const localKey = (assetId: string) => `tenant-billing-enabled-charge-types:${assetId}`;

export function PropertyBillingChargeTypeSettings({ propertyId, canEdit }: { propertyId: string; canEdit: boolean }) {
  const [types, setTypes] = useState<ChargeType[]>([]); const [enabled, setEnabled] = useState<string[]>([]); const [databaseReady, setDatabaseReady] = useState(false);
  useEffect(() => { const load = async () => { if (!supabase || !propertyId) return; const [typesResult, settingResult] = await Promise.all([supabase.from('billing_charge_type').select('billing_charge_type_id, charge_type_name').eq('is_active', true).order('sort_order'), supabase.from('asset_billing_charge_type_setting').select('billing_charge_type_id').eq('asset_id', propertyId).eq('is_enabled', true)]); if (!typesResult.error && !settingResult.error) { setTypes((typesResult.data ?? []) as ChargeType[]); setEnabled((settingResult.data ?? []).map((row) => row.billing_charge_type_id)); setDatabaseReady(true); return; } const stored = localStorage.getItem(localKey(propertyId)); setTypes((typesResult.data ?? []) as ChargeType[]); setEnabled(stored ? JSON.parse(stored) : []); }; void load(); }, [propertyId]);
  const toggle = async (id: string, checked: boolean) => { const next = checked ? [...enabled, id] : enabled.filter((item) => item !== id); setEnabled(next); if (databaseReady && supabase) await supabase.from('asset_billing_charge_type_setting').upsert({ asset_id: propertyId, billing_charge_type_id: id, is_enabled: checked }, { onConflict: 'asset_id,billing_charge_type_id' }); else localStorage.setItem(localKey(propertyId), JSON.stringify(next)); };
  return <section className="property-billing-items"><div className="property-billing-items-heading"><h4>使用する請求種別</h4><p>オンにした請求種別だけが、テナントコード一覧・入金明細・請求明細・コード割当の候補に表示されます。</p></div><div className="property-charge-type-list">{types.map((type) => <label key={type.billing_charge_type_id}><input type="checkbox" disabled={!canEdit} checked={enabled.includes(type.billing_charge_type_id)} onChange={(event) => void toggle(type.billing_charge_type_id, event.target.checked)} />{type.charge_type_name}</label>)}</div></section>;
}
