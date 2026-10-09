import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';

// 契約区画の公共料金（明細項目ごとの単価・分類ごとの基本料）を設定する欄です。
//   単価 … 検針設定で固定単価の小分類に紐づく明細項目ごとに設定します（変動単価の小分類は検針データで単価を計算します）。
//          検針月によって単価が変わる契約は、例外の月だけ別単価を登録します。
//   基本料 … 検針設定で基本料を請求する分類（電気・水道・ガス）ごとに設定します。
// 未設定の単価は、請求設定の明細項目の既定単価で計算します。

type TaxMode = 'exclusive' | 'inclusive';
type CategoryId = 'electric' | 'water' | 'gas';
type LineItemRow = { asset_billing_line_item_id: string; line_item_name: string; display_name: string; billing_content: string | null; default_unit_price: number | null; default_tax_mode: TaxMode };
type PriceDraft = { unitPrice: string; taxMode: TaxMode; monthly: Array<{ month: number; price: string }> };
type BasicDraft = { amount: string; taxMode: TaxMode };

const categoryNames: Record<CategoryId, string> = { electric: '電気', water: '水道', gas: 'ガス' };
const taxModeNames: Record<TaxMode, string> = { exclusive: '税抜', inclusive: '税込' };
const emptyPrice = (taxMode: TaxMode): PriceDraft => ({ unitPrice: '', taxMode, monthly: [] });
const isNumber = (value: string) => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;

export function ContractUtilityPricesSection({ leaseContractUnitId, propertyId, canEdit }: { leaseContractUnitId: string; propertyId: string; canEdit: boolean }) {
  const [lineItems, setLineItems] = useState<LineItemRow[]>([]);
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
      const [subItemResult, lineItemResult, settingResult, priceResult, basicResult] = await Promise.all([
        supabase.from('asset_meter_sub_item').select('asset_billing_line_item_id, price_mode, sub_item_kind').eq('asset_id', propertyId),
        supabase.from('asset_billing_line_item').select('asset_billing_line_item_id, line_item_name, display_name, billing_content, default_unit_price, default_tax_mode, sort_order').eq('asset_id', propertyId).eq('is_active', true).order('sort_order'),
        supabase.from('asset_meter_category_setting').select('category, is_billable, is_basic_billable').eq('asset_id', propertyId),
        supabase.from('lease_contract_unit_utility_price').select('asset_billing_line_item_id, unit_price, tax_mode, monthly_unit_prices').eq('lease_contract_unit_id', leaseContractUnitId),
        supabase.from('lease_contract_unit_basic_charge').select('category, amount, tax_mode').eq('lease_contract_unit_id', leaseContractUnitId),
      ]);
      if (cancelled) return;
      const failed = [subItemResult, lineItemResult, settingResult, priceResult, basicResult].find((result) => result.error);
      if (failed?.error) { setError(`公共料金の単価を読み込めませんでした: ${failed.error.message}`); setLoading(false); return; }
      // 単価を持たせるのは、固定単価の小分類に紐づく明細項目です。
      const fixedLineItemIds = new Set(((subItemResult.data ?? []) as Array<{ asset_billing_line_item_id: string | null; price_mode: string; sub_item_kind: string }>)
        .filter((row) => row.sub_item_kind !== 'basic' && row.price_mode === 'fixed' && row.asset_billing_line_item_id).map((row) => row.asset_billing_line_item_id as string));
      const items = ((lineItemResult.data ?? []) as LineItemRow[]).filter((item) => fixedLineItemIds.has(item.asset_billing_line_item_id));
      const settings = (settingResult.data ?? []) as Array<{ category: CategoryId; is_billable: boolean; is_basic_billable: boolean }>;
      const categories = (['electric', 'water', 'gas'] as CategoryId[]).filter((category) => settings.some((row) => row.category === category && row.is_basic_billable && (category === 'electric' || row.is_billable)));
      const savedPrices = (priceResult.data ?? []) as Array<{ asset_billing_line_item_id: string; unit_price: number; tax_mode: TaxMode; monthly_unit_prices: Record<string, number> | null }>;
      const savedBasics = (basicResult.data ?? []) as Array<{ category: CategoryId; amount: number; tax_mode: TaxMode }>;
      setLineItems(items);
      setBasicCategories(categories);
      setPrices(Object.fromEntries(items.map((item) => {
        const saved = savedPrices.find((row) => row.asset_billing_line_item_id === item.asset_billing_line_item_id);
        return [item.asset_billing_line_item_id, saved
          ? { unitPrice: String(saved.unit_price), taxMode: saved.tax_mode, monthly: Object.entries(saved.monthly_unit_prices ?? {}).map(([month, price]) => ({ month: Number(month), price: String(price) })).sort((a, b) => a.month - b.month) }
          : emptyPrice(item.default_tax_mode)];
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
    const priceRows = lineItems.flatMap((item) => {
      const draft = prices[item.asset_billing_line_item_id];
      if (!draft || draft.unitPrice.trim() === '') {
        if (draft?.monthly.length) problems.push(`${item.display_name}：月別単価があるときは通常単価も入力してください`);
        return [];
      }
      if (!isNumber(draft.unitPrice)) { problems.push(`${item.display_name}：単価は0以上の数値で入力してください`); return []; }
      const monthly: Record<string, number> = {};
      for (const row of draft.monthly) {
        if (!isNumber(row.price)) { problems.push(`${item.display_name}：${row.month}月の単価は0以上の数値で入力してください`); continue; }
        if (String(row.month) in monthly) { problems.push(`${item.display_name}：${row.month}月が重複しています`); continue; }
        monthly[String(row.month)] = Number(row.price);
      }
      return [{ asset_billing_line_item_id: item.asset_billing_line_item_id, unit_price: Number(draft.unitPrice), tax_mode: draft.taxMode, monthly_unit_prices: monthly }];
    });
    const basicRows = basicCategories.flatMap((category) => {
      const draft = basics[category];
      if (!draft || draft.amount.trim() === '') return [];
      if (!isNumber(draft.amount)) { problems.push(`${categoryNames[category]}の基本料は0以上の数値で入力してください`); return []; }
      return [{ category, amount: Number(draft.amount), tax_mode: draft.taxMode }];
    });
    if (problems.length) { setError(problems.join('／')); return; }
    setSaving(true); setError('');
    const { error: saveError } = await supabase.rpc('save_lease_contract_unit_utility_terms', { p_lease_contract_unit_id: leaseContractUnitId, p_prices: priceRows, p_basic_charges: basicRows });
    setSaving(false);
    if (saveError) { setError(`公共料金の単価を保存できませんでした: ${saveError.message}`); return; }
    setDirty(false); setMessage('保存しました。');
  };

  const disabled = !canEdit || saving;
  const defaultLabel = (item: LineItemRow) => item.default_unit_price === null ? '既定単価なし' : `未入力なら既定単価 ${Number(item.default_unit_price).toLocaleString('ja-JP', { maximumFractionDigits: 4 })}円（${taxModeNames[item.default_tax_mode]}）`;

  return <>
    <div className="contract-information-section-heading"><div><h3>公共料金（単価・基本料）</h3><p>この区画の公共料金の単価と基本料を設定します。変動単価の小分類は検針データで単価を計算します。</p></div></div>
    {error && <p className="contract-information-notice">{error}</p>}
    {loading && <p className="contract-information-empty">読み込み中…</p>}
    {!loading && !lineItems.length && !basicCategories.length && <p className="contract-information-empty">この物件には、契約で単価を持つ明細項目（固定単価の小分類に紐づく明細項目）や請求する基本料がありません。</p>}
    {!loading && (lineItems.length > 0 || basicCategories.length > 0) && <div className="contract-information-table-wrap">
      <table className="contract-information-table utility-price-table">
        <thead><tr><th>項目</th><th>単価・金額</th><th>税区分</th><th>検針月による単価</th></tr></thead>
        <tbody>
          {lineItems.map((item) => {
            const draft = prices[item.asset_billing_line_item_id] ?? emptyPrice(item.default_tax_mode);
            return <tr key={item.asset_billing_line_item_id}>
              <td><strong>{item.billing_content || item.display_name}</strong><small className="billing-terms-preview">{item.display_name}</small></td>
              <td><input type="number" step="0.0001" min="0" value={draft.unitPrice} disabled={disabled} placeholder="—" aria-label={`${item.display_name}の単価`} onChange={(event) => updatePrice(item.asset_billing_line_item_id, { unitPrice: event.target.value })} /> 円<small className="billing-terms-preview">{defaultLabel(item)}</small></td>
              <td><select value={draft.taxMode} disabled={disabled} aria-label={`${item.display_name}の税区分`} onChange={(event) => updatePrice(item.asset_billing_line_item_id, { taxMode: event.target.value as TaxMode })}><option value="exclusive">税抜</option><option value="inclusive">税込</option></select></td>
              <td>
                <div className="utility-monthly-prices">
                  {draft.monthly.map((row, index) => <span key={index} className="utility-monthly-price">
                    <select value={row.month} disabled={disabled} aria-label="単価が変わる検針月" onChange={(event) => updatePrice(item.asset_billing_line_item_id, { monthly: draft.monthly.map((target, i) => i === index ? { ...target, month: Number(event.target.value) } : target) })}>
                      {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}月</option>)}
                    </select>
                    <input type="number" step="0.0001" min="0" value={row.price} disabled={disabled} aria-label={`${row.month}月の単価`} onChange={(event) => updatePrice(item.asset_billing_line_item_id, { monthly: draft.monthly.map((target, i) => i === index ? { ...target, price: event.target.value } : target) })} />円
                    <button type="button" className="text-button" disabled={disabled} onClick={() => updatePrice(item.asset_billing_line_item_id, { monthly: draft.monthly.filter((_, i) => i !== index) })}>削除</button>
                  </span>)}
                  <button type="button" className="text-button" disabled={disabled} onClick={() => updatePrice(item.asset_billing_line_item_id, { monthly: [...draft.monthly, { month: draft.monthly.length ? Math.min(12, draft.monthly[draft.monthly.length - 1].month + 1) : 7, price: draft.unitPrice }] })}>月別単価を追加</button>
                </div>
              </td>
            </tr>;
          })}
          {basicCategories.map((category) => {
            const draft = basics[category] ?? { amount: '', taxMode: 'exclusive' as TaxMode };
            return <tr key={category}>
              <td><strong>{categoryNames[category]}基本料</strong></td>
              <td><input type="number" step="1" min="0" value={draft.amount} disabled={disabled} placeholder="—" aria-label={`${categoryNames[category]}基本料`} onChange={(event) => updateBasic(category, { amount: event.target.value })} /> 円／月</td>
              <td><select value={draft.taxMode} disabled={disabled} aria-label={`${categoryNames[category]}基本料の税区分`} onChange={(event) => updateBasic(category, { taxMode: event.target.value as TaxMode })}><option value="exclusive">税抜</option><option value="inclusive">税込</option></select></td>
              <td><span className="billing-terms-preview">途中入退去は検針期間の入居日数で日割り</span></td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>}
    {!loading && (lineItems.length > 0 || basicCategories.length > 0) && canEdit && <div className="utility-price-actions">
      {message && <span className="billing-terms-preview">{message}</span>}
      <button type="button" className="primary-button" disabled={saving || !dirty} onClick={() => void save()}>{saving ? '保存中…' : '公共料金を保存'}</button>
    </div>}
  </>;
}
