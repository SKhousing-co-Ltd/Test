import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';

// 契約区画の公共料金（明細項目ごとの単価・分類ごとの基本料）を設定する欄です。
//   単価 … 検針設定で固定単価の小分類に紐づく明細項目ごとに設定します（変動単価の小分類は検針データで単価を計算します）。
//          請求設定で単価を「分類で共通」にした分類は、明細項目ではなく分類の単価を1つ設定します。
//          請求月によって単価が変わる契約は、毎年繰り返す開始月・終了月と単価を登録します。
//   基本料 … 検針設定で基本料を請求する分類（電気・水道・ガス）ごとに設定します。
// 未設定の単価は、請求設定の明細項目の既定単価で計算します。

type TaxMode = 'exclusive' | 'inclusive';
type CategoryId = 'electric' | 'water' | 'gas';
// 単価の行です。明細項目ごとの単価と、分類で共通の単価のどちらかです。
type PriceTarget = { key: string; label: string; sub: string; category?: CategoryId; lineItemId?: string; fallback: { unitPrice: number; taxMode: TaxMode } | null };
type LineItemRow = { asset_billing_line_item_id: string; line_item_name: string; display_name: string; billing_content: string | null; default_unit_price: number | null; default_tax_mode: TaxMode };
type PricePeriod = { startMonth: string; endMonth: string; price: string };
type PriceDraft = { unitPrice: string; taxMode: TaxMode; periods: PricePeriod[] };
type BasicDraft = { amount: string; taxMode: TaxMode };

const categoryNames: Record<CategoryId, string> = { electric: '電気', water: '水道', gas: 'ガス' };
const emptyPrice = (taxMode: TaxMode): PriceDraft => ({ unitPrice: '', taxMode, periods: [] });
const isNumber = (value: string) => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
const isMonth = (value: string) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 12;
const monthIsInPeriod = (month: number, startMonth: number, endMonth: number) => startMonth <= endMonth
  ? startMonth <= month && month <= endMonth
  : month >= startMonth || month <= endMonth;

export function ContractUtilityPricesSection({ leaseContractUnitId, propertyId, canEdit }: { leaseContractUnitId: string; propertyId: string; canEdit: boolean }) {
  const [targets, setTargets] = useState<PriceTarget[]>([]);
  const [basicCategories, setBasicCategories] = useState<CategoryId[]>([]);
  const [prices, setPrices] = useState<Record<string, PriceDraft>>({});
  const [basics, setBasics] = useState<Partial<Record<CategoryId, BasicDraft>>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!leaseContractUnitId || !propertyId) return;
    let cancelled = false;
    const load = async () => {
      if (!supabase) { setError('Supabaseの接続設定が見つかりません。'); return; }
      setLoading(true); setError(''); setMessage(''); setDirty(false);
      const [subItemResult, lineItemResult, settingResult, priceResult, basicResult, priceSettingResult, categoryPriceResult] = await Promise.all([
        supabase.from('asset_meter_sub_item').select('category, asset_billing_line_item_id, price_mode, sub_item_kind').eq('asset_id', propertyId),
        supabase.from('asset_billing_line_item').select('asset_billing_line_item_id, line_item_name, display_name, billing_content, default_unit_price, default_tax_mode, sort_order').eq('asset_id', propertyId).eq('is_active', true).order('sort_order'),
        supabase.from('asset_meter_category_setting').select('category, is_billable, is_basic_billable').eq('asset_id', propertyId),
        supabase.from('lease_contract_unit_utility_price').select('asset_billing_line_item_id, unit_price, tax_mode, billing_month_prices').eq('lease_contract_unit_id', leaseContractUnitId),
        supabase.from('lease_contract_unit_basic_charge').select('category, amount, tax_mode').eq('lease_contract_unit_id', leaseContractUnitId),
        supabase.from('asset_utility_price_setting').select('category, price_scope, default_unit_price, default_tax_mode').eq('asset_id', propertyId),
        supabase.from('lease_contract_unit_category_price').select('category, unit_price, tax_mode, billing_month_prices').eq('lease_contract_unit_id', leaseContractUnitId),
      ]);
      if (cancelled) return;
      const failed = [subItemResult, lineItemResult, settingResult, priceResult, basicResult, priceSettingResult, categoryPriceResult].find((result) => result.error);
      if (failed?.error) { setError(`公共料金の単価を読み込めませんでした: ${failed.error.message}`); setLoading(false); return; }
      // 単価を持たせるのは、固定単価の小分類に紐づく明細項目です。分類で共通にした分類は、分類で1行にします。
      const priceSettings = (priceSettingResult.data ?? []) as Array<{ category: CategoryId; price_scope: string; default_unit_price: number | null; default_tax_mode: TaxMode }>;
      // 設定が無い分類は「分類で共通」です。
      const sharedCategories = new Set((['electric', 'water', 'gas'] as CategoryId[]).filter((category) => priceSettings.find((row) => row.category === category)?.price_scope !== 'line_item'));
      const fixedSubItems = ((subItemResult.data ?? []) as Array<{ category: CategoryId; asset_billing_line_item_id: string | null; price_mode: string; sub_item_kind: string }>)
        .filter((row) => row.sub_item_kind !== 'basic' && row.price_mode === 'fixed');
      const fixedLineItemIds = new Set(fixedSubItems.filter((row) => row.asset_billing_line_item_id && !sharedCategories.has(row.category)).map((row) => row.asset_billing_line_item_id as string));
      const lineItemRows = (lineItemResult.data ?? []) as LineItemRow[];
      const items = lineItemRows.filter((item) => fixedLineItemIds.has(item.asset_billing_line_item_id));
      const sharedTargets: PriceTarget[] = (['electric', 'water', 'gas'] as CategoryId[])
        .filter((category) => sharedCategories.has(category) && fixedSubItems.some((row) => row.category === category))
        .map((category) => {
          const setting = priceSettings.find((row) => row.category === category);
          const names = [...new Set(fixedSubItems.filter((row) => row.category === category).map((row) => lineItemRows.find((item) => item.asset_billing_line_item_id === row.asset_billing_line_item_id)?.billing_content || lineItemRows.find((item) => item.asset_billing_line_item_id === row.asset_billing_line_item_id)?.display_name).filter(Boolean))];
          return { key: `category:${category}`, label: `${categoryNames[category]}単価`, sub: `分類で共通${names.length ? `（${names.join('・')}）` : ''}`, category, fallback: setting?.default_unit_price == null ? null : { unitPrice: Number(setting.default_unit_price), taxMode: setting.default_tax_mode } };
        });
      const itemTargets: PriceTarget[] = items.map((item) => ({ key: item.asset_billing_line_item_id, label: item.billing_content || item.display_name, sub: item.display_name, lineItemId: item.asset_billing_line_item_id, fallback: item.default_unit_price === null ? null : { unitPrice: Number(item.default_unit_price), taxMode: item.default_tax_mode } }));
      const savedCategoryPrices = (categoryPriceResult.data ?? []) as Array<{ category: CategoryId; unit_price: number; tax_mode: TaxMode; billing_month_prices: Array<{ start_month: number; end_month: number; unit_price: number }> | null }>;
      const settings = (settingResult.data ?? []) as Array<{ category: CategoryId; is_billable: boolean; is_basic_billable: boolean }>;
      const categories = (['electric', 'water', 'gas'] as CategoryId[]).filter((category) => settings.some((row) => row.category === category && row.is_basic_billable && (category === 'electric' || row.is_billable)));
      const savedPrices = (priceResult.data ?? []) as Array<{ asset_billing_line_item_id: string; unit_price: number; tax_mode: TaxMode; billing_month_prices: Array<{ start_month: number; end_month: number; unit_price: number }> | null }>;
      const savedBasics = (basicResult.data ?? []) as Array<{ category: CategoryId; amount: number; tax_mode: TaxMode }>;
      const allTargets = [...sharedTargets, ...itemTargets];
      setTargets(allTargets);
      setBasicCategories(categories);
      setPrices(Object.fromEntries(allTargets.map((target) => {
        const saved = target.category ? savedCategoryPrices.find((row) => row.category === target.category) : savedPrices.find((row) => row.asset_billing_line_item_id === target.lineItemId);
        return [target.key, saved
          ? { unitPrice: String(saved.unit_price), taxMode: saved.tax_mode, periods: (saved.billing_month_prices ?? []).map((period) => ({ startMonth: String(period.start_month), endMonth: String(period.end_month), price: String(period.unit_price) })).sort((a, b) => Number(a.startMonth) - Number(b.startMonth)) }
          : emptyPrice(target.fallback?.taxMode ?? 'exclusive')];
      })));
      setBasics(Object.fromEntries(categories.map((category) => {
        const saved = savedBasics.find((row) => row.category === category);
        return [category, saved ? { amount: String(saved.amount), taxMode: saved.tax_mode } : { amount: '', taxMode: 'exclusive' as TaxMode }];
      })));
      setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [leaseContractUnitId, propertyId]);

  const updatePrice = (lineItemId: string, patch: Partial<PriceDraft>) => { setPrices((current) => ({ ...current, [lineItemId]: { ...current[lineItemId], ...patch } })); setDirty(true); setMessage(''); };
  const updateBasic = (category: CategoryId, patch: Partial<BasicDraft>) => { setBasics((current) => ({ ...current, [category]: { ...(current[category] ?? { amount: '', taxMode: 'exclusive' }), ...patch } })); setDirty(true); setMessage(''); };

  const save = async () => {
    if (!supabase || !canEdit) return;
    const problems: string[] = [];
    const draftRows = targets.flatMap((target) => {
      const draft = prices[target.key];
      if (!draft || draft.unitPrice.trim() === '') {
        if (draft?.periods.length) problems.push(`${target.label}：期間別単価があるときは通常単価も入力してください`);
        return [];
      }
      if (!isNumber(draft.unitPrice)) { problems.push(`${target.label}：単価は0以上の数値で入力してください`); return []; }
      const periods = draft.periods.map((period) => ({ start_month: Number(period.startMonth), end_month: Number(period.endMonth), unit_price: Number(period.price) }));
      for (const [index, period] of draft.periods.entries()) {
        if (!isMonth(period.startMonth) || !isMonth(period.endMonth)) problems.push(`${target.label}：期間${index + 1}の請求月は1～12で入力してください`);
        if (!isNumber(period.price)) problems.push(`${target.label}：期間${index + 1}の単価は0以上の数値で入力してください`);
      }
      for (let left = 0; left < draft.periods.length; left += 1) {
        for (let right = left + 1; right < draft.periods.length; right += 1) {
          const a = draft.periods[left]; const b = draft.periods[right];
          if (isMonth(a.startMonth) && isMonth(a.endMonth) && isMonth(b.startMonth) && isMonth(b.endMonth)
            && Array.from({ length: 12 }, (_, month) => month + 1).some((month) => monthIsInPeriod(month, Number(a.startMonth), Number(a.endMonth)) && monthIsInPeriod(month, Number(b.startMonth), Number(b.endMonth)))) problems.push(`${target.label}：期間が重複しています`);
        }
      }
      return [{ target, row: { unit_price: Number(draft.unitPrice), tax_mode: draft.taxMode, billing_month_prices: periods } }];
    });
    const priceRows = draftRows.filter(({ target }) => target.lineItemId).map(({ target, row }) => ({ asset_billing_line_item_id: target.lineItemId, ...row }));
    const categoryPriceRows = draftRows.filter(({ target }) => target.category).map(({ target, row }) => ({ category: target.category, ...row }));
    const basicRows = basicCategories.flatMap((category) => {
      const draft = basics[category];
      if (!draft || draft.amount.trim() === '') return [];
      if (!isNumber(draft.amount)) { problems.push(`${categoryNames[category]}の基本料は0以上の数値で入力してください`); return []; }
      return [{ category, amount: Number(draft.amount), tax_mode: draft.taxMode }];
    });
    if (problems.length) { setError(problems.join('／')); return; }
    setSaving(true); setError('');
    const { error: saveError } = await supabase.rpc('save_lease_contract_unit_utility_terms', { p_lease_contract_unit_id: leaseContractUnitId, p_prices: priceRows, p_category_prices: categoryPriceRows, p_basic_charges: basicRows });
    setSaving(false);
    if (saveError) { setError(`公共料金の単価を保存できませんでした: ${saveError.message}`); return; }
    setDirty(false); setMessage('保存しました。');
  };

  const disabled = !canEdit || saving;

  return <>
    <div className="contract-information-section-heading"><div><h3>公共料金</h3></div></div>
    {error && <p className="contract-information-notice">{error}</p>}
    {loading && <p className="contract-information-empty">読み込み中…</p>}
    {!loading && !targets.length && !basicCategories.length && <p className="contract-information-empty">この物件には、契約で単価を持つ明細項目（固定単価の小分類に紐づく明細項目）や請求する基本料がありません。</p>}
    {!loading && (targets.length > 0 || basicCategories.length > 0) && <div className="contract-information-table-wrap">
      <table className="contract-information-table utility-price-table">
        <thead><tr><th>項目</th><th>単価・金額</th><th>税区分</th><th>請求月による単価</th></tr></thead>
        <tbody>
          {basicCategories.map((category) => {
            const draft = basics[category] ?? { amount: '', taxMode: 'exclusive' as TaxMode };
            return <tr key={category}>
              <td><strong>{categoryNames[category]}基本料</strong></td>
              <td><input type="number" step="1" min="0" value={draft.amount} disabled={disabled} placeholder="—" aria-label={`${categoryNames[category]}基本料`} onChange={(event) => updateBasic(category, { amount: event.target.value })} /> 円／月</td>
              <td><select value={draft.taxMode} disabled={disabled} aria-label={`${categoryNames[category]}基本料の税区分`} onChange={(event) => updateBasic(category, { taxMode: event.target.value as TaxMode })}><option value="exclusive">税抜</option><option value="inclusive">税込</option></select></td>
              <td><span className="billing-terms-preview">途中入退去は検針期間の入居日数で日割り</span></td>
            </tr>;
          })}
          {targets.map((target) => {
            const draft = prices[target.key] ?? emptyPrice(target.fallback?.taxMode ?? 'exclusive');
            return <tr key={target.key}>
              <td><strong>{target.label}</strong></td>
              <td><input type="number" step="0.0001" min="0" value={draft.unitPrice} disabled={disabled} placeholder="—" aria-label={`${target.label}の単価`} onChange={(event) => updatePrice(target.key, { unitPrice: event.target.value })} /> 円</td>
              <td><select value={draft.taxMode} disabled={disabled} aria-label={`${target.label}の税区分`} onChange={(event) => updatePrice(target.key, { taxMode: event.target.value as TaxMode })}><option value="exclusive">税抜</option><option value="inclusive">税込</option></select></td>
              <td>
                <div className="utility-monthly-prices">
                  {draft.periods.map((row, index) => <span key={index} className="utility-monthly-price">
                    <input type="number" min="1" max="12" step="1" value={row.startMonth} disabled={disabled} placeholder="開始月" aria-label="請求月始" onChange={(event) => updatePrice(target.key, { periods: draft.periods.map((period, i) => i === index ? { ...period, startMonth: event.target.value } : period) })} />月
                    <span>～</span>
                    <input type="number" min="1" max="12" step="1" value={row.endMonth} disabled={disabled} placeholder="終了月" aria-label="請求月終" onChange={(event) => updatePrice(target.key, { periods: draft.periods.map((period, i) => i === index ? { ...period, endMonth: event.target.value } : period) })} />月
                    <input type="number" step="0.0001" min="0" value={row.price} disabled={disabled} aria-label={`${row.startMonth || '開始月'}から${row.endMonth || '終了月'}の単価`} onChange={(event) => updatePrice(target.key, { periods: draft.periods.map((period, i) => i === index ? { ...period, price: event.target.value } : period) })} />円
                    <button type="button" className="text-button" disabled={disabled} onClick={() => updatePrice(target.key, { periods: draft.periods.filter((_, i) => i !== index) })}>削除</button>
                  </span>)}
                  <button type="button" className="text-button" disabled={disabled} onClick={() => updatePrice(target.key, { periods: [...draft.periods, { startMonth: '', endMonth: '', price: draft.unitPrice }] })}>期間別単価を追加</button>
                </div>
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>}
    {!loading && (targets.length > 0 || basicCategories.length > 0) && canEdit && <div className="utility-price-actions">
      {message && <span className="billing-terms-preview">{message}</span>}
      <button type="button" className="primary-button" disabled={saving || !dirty} onClick={() => void save()}>{saving ? '保存中…' : '公共料金を保存'}</button>
    </div>}
  </>;
}
