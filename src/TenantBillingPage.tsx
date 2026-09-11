import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BillingCodePage } from './BillingCodePage';
import { BillingStatementPage } from './BillingStatementPage';
import { PropertyBillingSettings } from './PropertyBillingSettings';
import { supabase } from './lib/supabase';
import { fiscalYearOf, TenantBillingControls, type BillingPeriod, type BillingProperty } from './TenantBillingControls';
import './TenantBillingPage.css';

const billingMenus = ['テナントコード一覧', '入金明細', '請求明細', '請求書作成', '検針データ', '請求設定'];

export function TenantBillingPage({ canEdit, canManageSettings }: { canEdit: boolean; canManageSettings: boolean }) {
  const navigate = useNavigate();
  const now = useMemo(() => new Date(), []);
  const [properties, setProperties] = useState<BillingProperty[]>([]);
  const [propertyId, setPropertyId] = useState('');
  const [period, setPeriod] = useState<BillingPeriod>(() => ({ fiscalYear: fiscalYearOf(now), month: now.getMonth() + 1 }));
  const [activeMenu, setActiveMenu] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    let cancelled = false;
    void client.from('asset_master').select('asset_id, asset_name, short_name').eq('is_tenant_billing_enabled', true).order('asset_code').then(({ data, error: loadError }) => {
      if (cancelled) return;
      if (loadError) setError(`物件を読み込めませんでした: ${loadError.message}`);
      const next = (data ?? []) as BillingProperty[];
      setProperties(next);
      setPropertyId((current) => current || next[0]?.asset_id || '');
    });
    return () => { cancelled = true; };
  }, []);

  return <section className="tenant-billing-page">
    <TenantBillingControls properties={properties} propertyId={propertyId} onPropertyChange={setPropertyId} period={period} onPeriodChange={setPeriod} onSettingsClick={canManageSettings ? () => navigate('/settings/tenant-billing') : undefined} />
    {error && <p className="tenant-billing-notice">{error}</p>}
    {!error && !properties.length && <p className="tenant-billing-notice">テナント請求対象の物件がありません。アセット設定で対象物件を有効にしてください。</p>}
    <section className="tenant-billing-tabs" aria-label="テナント請求メニュー">{billingMenus.map((label, index) => <button key={label} className={activeMenu === index ? 'active' : ''} onClick={() => setActiveMenu(index)}>{label}</button>)}</section>
    {activeMenu === 0
      ? <BillingCodePage canEdit={canEdit} propertyId={propertyId} period={period} />
      : activeMenu === 1 || activeMenu === 2
        ? <BillingStatementPage kind={activeMenu === 1 ? 'payment' : 'invoice'} propertyId={propertyId} propertyName={properties.find((item) => item.asset_id === propertyId)?.short_name || properties.find((item) => item.asset_id === propertyId)?.asset_name || ''} period={period} />
      : activeMenu === 5
        ? <PropertyBillingSettings propertyId={propertyId} properties={properties} canEdit={canEdit} />
        : <section className="tenant-billing-workspace"><p className="section-kicker">{billingMenus[activeMenu]}</p><h3>{billingMenus[activeMenu]}</h3><p>この領域に{billingMenus[activeMenu]}の機能を追加していきます。</p></section>}
  </section>;
}
