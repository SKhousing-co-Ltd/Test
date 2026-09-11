export type BillingProperty = { asset_id: string; asset_name: string; short_name: string | null };
export type BillingPeriod = { fiscalYear: number; month: number };

export function fiscalYearOf(date: Date) {
  return date.getFullYear() - (date.getMonth() < 3 ? 1 : 0);
}

export function moveBillingPeriod(period: BillingPeriod, delta: number): BillingPeriod {
  const date = new Date(period.fiscalYear + (period.month <= 3 ? 1 : 0), period.month - 1 + delta, 1);
  return { fiscalYear: fiscalYearOf(date), month: date.getMonth() + 1 };
}

export function TenantBillingControls({ properties, propertyId, onPropertyChange, period, onPeriodChange, onSettingsClick }: {
  properties: BillingProperty[];
  propertyId: string;
  onPropertyChange: (propertyId: string) => void;
  period: BillingPeriod;
  onPeriodChange: (period: BillingPeriod) => void;
  onSettingsClick?: () => void;
}) {
  const currentFiscalYear = fiscalYearOf(new Date());
  const fiscalYears = Array.from({ length: 7 }, (_, index) => currentFiscalYear - 3 + index);
  return <section className="tenant-billing-controls" aria-label="請求対象の選択">
    <label className="tenant-billing-property"><span>物件</span><select value={propertyId} onChange={(event) => onPropertyChange(event.target.value)}><option value="">物件を選択</option>{properties.map((property) => <option key={property.asset_id} value={property.asset_id}>{property.short_name || property.asset_name}</option>)}</select></label>
    <label className="tenant-billing-year"><span>年</span><select value={period.fiscalYear} onChange={(event) => onPeriodChange({ ...period, fiscalYear: Number(event.target.value) })}>{fiscalYears.map((year) => <option value={year} key={year}>{year}年</option>)}</select></label>
    <div className="tenant-billing-month"><span>月</span><div><button aria-label="前月" onClick={() => onPeriodChange(moveBillingPeriod(period, -1))}>‹</button><strong>{period.month}月</strong><button aria-label="翌月" onClick={() => onPeriodChange(moveBillingPeriod(period, 1))}>›</button></div></div>
    {onSettingsClick && <button type="button" className="secondary-button tenant-billing-settings-link" onClick={onSettingsClick}>⚙ テナント請求設定</button>}
  </section>;
}
