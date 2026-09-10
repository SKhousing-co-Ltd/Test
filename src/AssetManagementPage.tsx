import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import './AssetManagementPage.css';

type Asset = {
  asset_id: string;
  asset_code: number;
  asset_name: string;
  short_name: string | null;
  is_rent_roll_visible: boolean;
  is_tenant_billing_enabled: boolean;
};

export function AssetManagementPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [originalAssets, setOriginalAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  const loadAssets = async () => {
    if (!supabase) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('asset_master')
      .select('asset_id, asset_code, asset_name, short_name, is_rent_roll_visible, is_tenant_billing_enabled')
      .order('asset_code');
    if (error) setNotice(`アセットを読み込めませんでした: ${error.message}`);
    else {
      const next = (data ?? []) as Asset[];
      setAssets(next);
      setOriginalAssets(next);
      setNotice('');
    }
    setLoading(false);
  };

  useEffect(() => { void loadAssets(); }, []);

  const changedAssets = useMemo(() => assets.filter((asset) => {
    const original = originalAssets.find((item) => item.asset_id === asset.asset_id);
    return original && (original.is_rent_roll_visible !== asset.is_rent_roll_visible || original.is_tenant_billing_enabled !== asset.is_tenant_billing_enabled);
  }), [assets, originalAssets]);

  const setFlag = (assetId: string, key: 'is_rent_roll_visible' | 'is_tenant_billing_enabled', value: boolean) => {
    setAssets((current) => current.map((asset) => asset.asset_id === assetId ? { ...asset, [key]: value } : asset));
  };

  const save = async () => {
    const client = supabase;
    if (!client || !changedAssets.length) return;
    setSaving(true);
    const results = await Promise.all(changedAssets.map((asset) => client
      .from('asset_master')
      .update({ is_rent_roll_visible: asset.is_rent_roll_visible, is_tenant_billing_enabled: asset.is_tenant_billing_enabled })
      .eq('asset_id', asset.asset_id)));
    const error = results.find((result) => result.error)?.error;
    if (error) setNotice(`保存できませんでした: ${error.message}`);
    else {
      setOriginalAssets(assets);
      setNotice(`${changedAssets.length}件のアセット設定を保存しました。`);
    }
    setSaving(false);
  };

  return <>
    <section className="page-heading"><div><p className="section-kicker">SETTINGS</p><h2>アセット管理</h2><p>アセットごとのレントロール表示とテナント請求対象を設定します。</p></div><button className="primary-button" disabled={saving || !changedAssets.length} onClick={() => void save()}>{saving ? '保存中…' : `${changedAssets.length ? `${changedAssets.length}件を` : ''}保存`}</button></section>
    <section className="asset-management-notes"><p><strong>レントロール表示</strong>を有効にしたアセットだけがレントロール画面に表示されます。</p><p><strong>テナント請求</strong>を有効にしたアセットだけが発行コード管理・今後のテナント請求の対象になります。</p></section>
    {notice && <p className="asset-management-notice">{notice}</p>}
    <section className="asset-management-panel"><div className="table-wrap"><table className="asset-management-table"><thead><tr><th>コード</th><th>アセット名</th><th>略称</th><th>レントロール表示</th><th>テナント請求</th></tr></thead><tbody>{loading && <tr><td colSpan={5} className="asset-management-empty">読み込み中…</td></tr>}{!loading && assets.map((asset) => <tr key={asset.asset_id}><td className="numeric"><strong>{asset.asset_code}</strong></td><td><strong>{asset.asset_name}</strong></td><td>{asset.short_name || '—'}</td><td><label className="asset-flag"><input type="checkbox" checked={asset.is_rent_roll_visible} onChange={(event) => setFlag(asset.asset_id, 'is_rent_roll_visible', event.target.checked)} /><span>{asset.is_rent_roll_visible ? '表示する' : '表示しない'}</span></label></td><td><label className="asset-flag"><input type="checkbox" checked={asset.is_tenant_billing_enabled} onChange={(event) => setFlag(asset.asset_id, 'is_tenant_billing_enabled', event.target.checked)} /><span>{asset.is_tenant_billing_enabled ? '請求対象' : '対象外'}</span></label></td></tr>)}{!loading && !assets.length && <tr><td colSpan={5} className="asset-management-empty">アセットが登録されていません。</td></tr>}</tbody></table></div></section>
  </>;
}
