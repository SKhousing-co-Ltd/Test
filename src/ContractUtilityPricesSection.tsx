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
type PriceTarget = { key: string; label: string; sub: string; category?: CategoryId; lineItemId?: string; fallbackCategory?: CategoryId; fallback: { unitPrice: number; taxMode: TaxMode } | null };
type LineItemRow = { asset_billing_line_item_id: string; line_item_name: string; display_name: string; billing_content: string | null; default_unit_price: number | null; default_tax_mode: TaxMode };
type PricePeriod = { startMonth: string; endMonth: string; price: string };
type PriceDraft = { unitPrice: string; taxMode: TaxMode; periods: PricePeriod[] };
type BasicDraft = { amount: string; taxMode: TaxMode };
type MeterTerm = { asset_meter_sub_item_id: string; price_mode: 'fixed' | 'amount' | 'master_meter'; tax_mode: TaxMode; show_unit_price_on_invoice: boolean; show_usage_on_invoice: boolean };
type MeterTermDraft = MeterTerm & { label: string; category: CategoryId; lineItemId: string | null; calculationMode: 'meter' | 'fixed' | 'allocated_amount' };

const categoryNames: Record<CategoryId, string> = { electric: '電気', water: '水道', gas: 'ガス' };
const emptyPrice = (taxMode: TaxMode): PriceDraft => ({ unitPrice: '', taxMode, periods: [] });
const isNumber = (value: string) => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
const isMonth = (value: string) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 12;
const monthIsInPeriod = (month: number, startMonth: number, endMonth: number) => startMonth <= endMonth
  ? startMonth <= month && month <= endMonth
  : month >= startMonth || month <= endMonth;

export function ContractUtilityPricesSection({ leaseContractUnitId, billingUnitId, fallbackLeaseContractUnitId, propertyId, canEdit }: { leaseContractUnitId?: string; billingUnitId?: string; fallbackLeaseContractUnitId?: string; propertyId: string; canEdit: boolean }) {
  const [targets, setTargets] = useState<PriceTarget[]>([]);
  const [basicCategories, setBasicCategories] = useState<CategoryId[]>([]);
  const [prices, setPrices] = useState<Record<string, PriceDraft>>({});
  const [basics, setBasics] = useState<Partial<Record<CategoryId, BasicDraft>>>({});
  const [meterTerms, setMeterTerms] = useState<MeterTermDraft[]>([]);
  const [sharedCategories, setSharedCategories] = useState<Set<CategoryId>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [priceDirty, setPriceDirty] = useState(false);
  const [meterTermDirty, setMeterTermDirty] = useState(false);

  useEffect(() => {
    const targetId = billingUnitId || leaseContractUnitId;
    if (!targetId || !propertyId) return;
    let cancelled = false;
    const load = async () => {
      if (!supabase) { setError('Supabaseの接続設定が見つかりません。'); return; }
      setLoading(true); setError(''); setMessage(''); setDirty(false); setPriceDirty(false); setMeterTermDirty(false);
      const [subItemResult, lineItemResult, settingResult, priceResult, basicResult, priceSettingResult, categoryPriceResult, fallbackPriceResult, fallbackBasicResult, fallbackCategoryPriceResult, meterTermResult] = await Promise.all([
        supabase.from('asset_meter_sub_item').select('asset_meter_sub_item_id, sub_item_name, category, asset_billing_line_item_id, price_mode, sub_item_kind, is_monthly_fixed, calculation_mode, default_unit_price, tax_mode, show_unit_price_on_invoice, show_usage_on_invoice').eq('asset_id', propertyId),
        supabase.from('asset_billing_line_item').select('asset_billing_line_item_id, line_item_name, display_name, billing_content, default_unit_price, default_tax_mode, sort_order').eq('asset_id', propertyId).eq('is_active', true).order('sort_order'),
        supabase.from('asset_meter_category_setting').select('category, is_billable, is_basic_billable').eq('asset_id', propertyId),
        supabase.from(billingUnitId ? 'lease_contract_billing_unit_utility_price' : 'lease_contract_unit_utility_price').select('asset_billing_line_item_id, unit_price, tax_mode, billing_month_prices').eq(billingUnitId ? 'lease_contract_billing_unit_id' : 'lease_contract_unit_id', targetId),
        supabase.from(billingUnitId ? 'lease_contract_billing_unit_basic_charge' : 'lease_contract_unit_basic_charge').select('category, amount, tax_mode').eq(billingUnitId ? 'lease_contract_billing_unit_id' : 'lease_contract_unit_id', targetId),
        supabase.from('asset_utility_price_setting').select('category, price_scope, default_unit_price, default_tax_mode').eq('asset_id', propertyId),
        supabase.from(billingUnitId ? 'lease_contract_billing_unit_category_price' : 'lease_contract_unit_category_price').select('category, unit_price, tax_mode, billing_month_prices').eq(billingUnitId ? 'lease_contract_billing_unit_id' : 'lease_contract_unit_id', targetId),
        fallbackLeaseContractUnitId ? supabase.from('lease_contract_unit_utility_price').select('asset_billing_line_item_id, unit_price, tax_mode, billing_month_prices').eq('lease_contract_unit_id', fallbackLeaseContractUnitId) : Promise.resolve({ data: [], error: null }),
        fallbackLeaseContractUnitId ? supabase.from('lease_contract_unit_basic_charge').select('category, amount, tax_mode').eq('lease_contract_unit_id', fallbackLeaseContractUnitId) : Promise.resolve({ data: [], error: null }),
        fallbackLeaseContractUnitId ? supabase.from('lease_contract_unit_category_price').select('category, unit_price, tax_mode, billing_month_prices').eq('lease_contract_unit_id', fallbackLeaseContractUnitId) : Promise.resolve({ data: [], error: null }),
        supabase.from(billingUnitId ? 'lease_contract_billing_unit_meter_term' : 'lease_contract_unit_meter_term').select('asset_meter_sub_item_id, price_mode, tax_mode, show_unit_price_on_invoice, show_usage_on_invoice').eq(billingUnitId ? 'lease_contract_billing_unit_id' : 'lease_contract_unit_id', targetId),
      ]);
      if (cancelled) return;
      const failed = [subItemResult, lineItemResult, settingResult, priceResult, basicResult, priceSettingResult, categoryPriceResult, fallbackPriceResult, fallbackBasicResult, fallbackCategoryPriceResult, meterTermResult].find((result) => result.error);
      if (failed?.error) { setError(`公共料金の単価を読み込めませんでした: ${failed.error.message}`); setLoading(false); return; }
      // 単価を持たせるのは、固定単価の小分類に紐づく明細項目です。分類で共通にした分類は、分類で1行にします。
      const priceSettings = (priceSettingResult.data ?? []) as Array<{ category: CategoryId; price_scope: string; default_unit_price: number | null; default_tax_mode: TaxMode }>;
      // 設定が無い分類は「分類で共通」です。
      const sharedCategories = new Set((['electric', 'water', 'gas'] as CategoryId[]).filter((category) => priceSettings.find((row) => row.category === category)?.price_scope !== 'line_item'));
      setSharedCategories(sharedCategories);
      const customSubItems = ((subItemResult.data ?? []) as Array<{ asset_meter_sub_item_id: string; sub_item_name: string; category: CategoryId; asset_billing_line_item_id: string | null; price_mode: MeterTerm['price_mode']; sub_item_kind: string; is_monthly_fixed: boolean; calculation_mode: MeterTermDraft['calculationMode']; default_unit_price: number | null; tax_mode: TaxMode; show_unit_price_on_invoice: boolean; show_usage_on_invoice: boolean }>)
        .filter((row) => row.sub_item_kind !== 'basic');
      const savedMeterTerms = (meterTermResult.data ?? []) as MeterTerm[];
      setMeterTerms(customSubItems.map((item) => ({
        asset_meter_sub_item_id: item.asset_meter_sub_item_id, label: item.sub_item_name, category: item.category, lineItemId: item.asset_billing_line_item_id, calculationMode: item.calculation_mode,
        price_mode: savedMeterTerms.find((row) => row.asset_meter_sub_item_id === item.asset_meter_sub_item_id)?.price_mode ?? item.price_mode,
        tax_mode: item.calculation_mode === 'meter' ? savedMeterTerms.find((row) => row.asset_meter_sub_item_id === item.asset_meter_sub_item_id)?.tax_mode ?? item.tax_mode : item.tax_mode,
        show_unit_price_on_invoice: savedMeterTerms.find((row) => row.asset_meter_sub_item_id === item.asset_meter_sub_item_id)?.show_unit_price_on_invoice ?? item.show_unit_price_on_invoice,
        show_usage_on_invoice: savedMeterTerms.find((row) => row.asset_meter_sub_item_id === item.asset_meter_sub_item_id)?.show_usage_on_invoice ?? item.show_usage_on_invoice,
      })));
      const fixedSubItems = customSubItems.filter((item) => item.calculation_mode === 'meter' && !item.is_monthly_fixed);
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
      const itemTargets: PriceTarget[] = items.map((item) => {
        const subItem = fixedSubItems.find((row) => row.asset_billing_line_item_id === item.asset_billing_line_item_id);
        const fallbackPrice = subItem?.default_unit_price ?? item.default_unit_price;
        return { key: item.asset_billing_line_item_id, label: item.billing_content || item.display_name, sub: item.display_name, lineItemId: item.asset_billing_line_item_id, fallbackCategory: subItem?.category, fallback: fallbackPrice === null || fallbackPrice === undefined ? null : { unitPrice: Number(fallbackPrice), taxMode: subItem?.tax_mode ?? item.default_tax_mode } };
      });
      const savedCategoryPrices = ((categoryPriceResult.data?.length ? categoryPriceResult.data : fallbackCategoryPriceResult.data) ?? []) as Array<{ category: CategoryId; unit_price: number; tax_mode: TaxMode; billing_month_prices: Array<{ start_month: number; end_month: number; unit_price: number }> | null }>;
      const settings = (settingResult.data ?? []) as Array<{ category: CategoryId; is_billable: boolean; is_basic_billable: boolean }>;
      const categories = (['electric', 'water', 'gas'] as CategoryId[]).filter((category) => settings.some((row) => row.category === category && row.is_basic_billable && (category === 'electric' || row.is_billable)));
      const savedPrices = ((priceResult.data?.length ? priceResult.data : fallbackPriceResult.data) ?? []) as Array<{ asset_billing_line_item_id: string; unit_price: number; tax_mode: TaxMode; billing_month_prices: Array<{ start_month: number; end_month: number; unit_price: number }> | null }>;
      const savedBasics = ((basicResult.data?.length ? basicResult.data : fallbackBasicResult.data) ?? []) as Array<{ category: CategoryId; amount: number; tax_mode: TaxMode }>;
      const allTargets = [...sharedTargets, ...itemTargets];
      setTargets(allTargets);
      setBasicCategories(categories);
      setPrices(Object.fromEntries(allTargets.map((target) => {
        const saved = target.category
          ? savedCategoryPrices.find((row) => row.category === target.category)
          : savedPrices.find((row) => row.asset_billing_line_item_id === target.lineItemId)
            ?? savedCategoryPrices.find((row) => row.category === target.fallbackCategory);
        return [target.key, saved
          ? { unitPrice: String(saved.unit_price), taxMode: saved.tax_mode, periods: (saved.billing_month_prices ?? []).map((period) => ({ startMonth: String(period.start_month), endMonth: String(period.end_month), price: String(period.unit_price) })).sort((a, b) => Number(a.startMonth) - Number(b.startMonth)) }
          : target.fallback
            ? { unitPrice: String(target.fallback.unitPrice), taxMode: target.fallback.taxMode, periods: [] }
            : emptyPrice('exclusive')];
      })));
      setBasics(Object.fromEntries(categories.map((category) => {
        const saved = savedBasics.find((row) => row.category === category);
        return [category, saved ? { amount: String(saved.amount), taxMode: saved.tax_mode } : { amount: '', taxMode: 'exclusive' as TaxMode }];
      })));
      setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [leaseContractUnitId, billingUnitId, fallbackLeaseContractUnitId, propertyId]);

  const updatePrice = (lineItemId: string, patch: Partial<PriceDraft>) => { setPrices((current) => ({ ...current, [lineItemId]: { ...current[lineItemId], ...patch } })); setDirty(true); setPriceDirty(true); setMessage(''); };
  const updateBasic = (category: CategoryId, patch: Partial<BasicDraft>) => { setBasics((current) => ({ ...current, [category]: { ...(current[category] ?? { amount: '', taxMode: 'exclusive' }), ...patch } })); setDirty(true); setPriceDirty(true); setMessage(''); };
  const updateMeterTerm = (id: string, patch: Partial<MeterTerm>) => { setMeterTerms((current) => current.map((row) => row.asset_meter_sub_item_id === id ? { ...row, ...patch } : row)); setDirty(true); setMeterTermDirty(true); setMessage(''); };

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
    if (priceDirty && problems.length) { setError(problems.join('／')); return; }
    setSaving(true); setError('');
    let saveError: { message: string } | null = null;
    if (priceDirty && billingUnitId) {
      const key = 'lease_contract_billing_unit_id';
      for (const table of ['lease_contract_billing_unit_utility_price', 'lease_contract_billing_unit_category_price', 'lease_contract_billing_unit_basic_charge']) {
        const result = await supabase.from(table).delete().eq(key, billingUnitId);
        if (result.error) { saveError = result.error; break; }
      }
      if (!saveError && priceRows.length) saveError = (await supabase.from('lease_contract_billing_unit_utility_price').insert(priceRows.map((row) => ({ ...row, [key]: billingUnitId })))).error;
      if (!saveError && categoryPriceRows.length) saveError = (await supabase.from('lease_contract_billing_unit_category_price').insert(categoryPriceRows.map((row) => ({ ...row, [key]: billingUnitId })))).error;
      if (!saveError && basicRows.length) saveError = (await supabase.from('lease_contract_billing_unit_basic_charge').insert(basicRows.map((row) => ({ ...row, [key]: billingUnitId })))).error;
    } else if (priceDirty) {
      saveError = (await supabase.rpc('save_lease_contract_unit_utility_terms', { p_lease_contract_unit_id: leaseContractUnitId, p_prices: priceRows, p_category_prices: categoryPriceRows, p_basic_charges: basicRows })).error;
    }
    if (!saveError && meterTermDirty) {
      const table = billingUnitId ? 'lease_contract_billing_unit_meter_term' : 'lease_contract_unit_meter_term';
      const key = billingUnitId ? 'lease_contract_billing_unit_id' : 'lease_contract_unit_id';
      saveError = (await supabase.from(table).upsert(meterTerms.map(({ label: _label, category: _category, lineItemId: _lineItemId, calculationMode: _calculationMode, ...term }) => ({ ...term, [key]: billingUnitId || leaseContractUnitId })), { onConflict: `${key},asset_meter_sub_item_id` })).error;
    }
    setSaving(false);
    if (saveError) { setError(`公共料金の単価を保存できませんでした: ${saveError.message}`); return; }
    setDirty(false); setPriceDirty(false); setMeterTermDirty(false); setMessage('保存しました。');
  };

  const disabled = !canEdit || saving;
  const categoryIds: CategoryId[] = ['electric', 'water', 'gas'];
  const priceInput = (target: PriceTarget) => {
    const draft = prices[target.key] ?? emptyPrice(target.fallback?.taxMode ?? 'exclusive');
    return <><input type="number" step="0.0001" min="0" value={draft.unitPrice} disabled={disabled} placeholder="—" aria-label={`${target.label}の単価`} onChange={(event) => updatePrice(target.key, { unitPrice: event.target.value })} /> 円</>;
  };
  const periodInput = (target: PriceTarget) => {
    const draft = prices[target.key] ?? emptyPrice(target.fallback?.taxMode ?? 'exclusive');
    return <div className="utility-monthly-prices">
      {draft.periods.map((row, index) => <span key={index} className="utility-monthly-price">
        <input type="number" min="1" max="12" step="1" value={row.startMonth} disabled={disabled} placeholder="開始月" aria-label="請求月始" onChange={(event) => updatePrice(target.key, { periods: draft.periods.map((period, i) => i === index ? { ...period, startMonth: event.target.value } : period) })} />月
        <span>～</span>
        <input type="number" min="1" max="12" step="1" value={row.endMonth} disabled={disabled} placeholder="終了月" aria-label="請求月終" onChange={(event) => updatePrice(target.key, { periods: draft.periods.map((period, i) => i === index ? { ...period, endMonth: event.target.value } : period) })} />月
        <input type="number" step="0.0001" min="0" value={row.price} disabled={disabled} aria-label={`${row.startMonth || '開始月'}から${row.endMonth || '終了月'}の単価`} onChange={(event) => updatePrice(target.key, { periods: draft.periods.map((period, i) => i === index ? { ...period, price: event.target.value } : period) })} />円
        <button type="button" className="text-button" disabled={disabled} onClick={() => updatePrice(target.key, { periods: draft.periods.filter((_, i) => i !== index) })}>削除</button>
      </span>)}
      <button type="button" className="text-button" disabled={disabled} onClick={() => updatePrice(target.key, { periods: [...draft.periods, { startMonth: '', endMonth: '', price: draft.unitPrice }] })}>期間別単価を追加</button>
    </div>;
  };
  const updateCategoryPriceMode = (category: CategoryId, priceMode: MeterTerm['price_mode']) => {
    setMeterTerms((current) => current.map((term) => term.category === category && term.calculationMode === 'meter' ? { ...term, price_mode: priceMode } : term));
    setDirty(true); setMeterTermDirty(true); setMessage('');
  };

  return <>
    <div className="contract-information-section-heading"><div><h3>{billingUnitId ? '請求区画の公共料金' : '公共料金'}</h3></div></div>
    {error && <p className="contract-information-notice">{error}</p>}
    {loading && <p className="contract-information-empty">読み込み中…</p>}
    {!loading && !targets.length && !basicCategories.length && !meterTerms.length && <p className="contract-information-empty">公共料金の設定項目がありません。</p>}
    {!loading && (targets.length > 0 || basicCategories.length > 0 || meterTerms.length > 0) && <div className="contract-information-table-wrap utility-category-list">
      {categoryIds.map((category) => {
        const terms = meterTerms.filter((term) => term.category === category);
        const hasBasic = basicCategories.includes(category);
        const shared = sharedCategories.has(category);
        const commonTarget = targets.find((target) => target.category === category);
        const modes = [...new Set(terms.filter((term) => term.calculationMode === 'meter').map((term) => term.price_mode))];
        const commonMode = modes.length === 1 ? modes[0] : '';
        if (!terms.length && !hasBasic && !commonTarget) return null;
        return <section className="utility-contract-group" key={category}>
          <h4>{categoryNames[category]}</h4>
          {shared && commonTarget && <div className="utility-category-common"><strong>共通単価</strong>
            <label>単価計算方法 <select value={commonMode} disabled={disabled} onChange={(event) => updateCategoryPriceMode(category, event.target.value as MeterTerm['price_mode'])}>
              {!commonMode && <option value="">小分類ごとに異なる</option>}<option value="fixed">固定</option><option value="amount">金額から計算</option><option value="master_meter">大元メーターから計算</option>
            </select></label>
            {modes.includes('fixed') && <label>{priceInput(commonTarget)}</label>}
            <label>税区分 <select value={prices[commonTarget.key]?.taxMode ?? 'exclusive'} disabled={disabled} onChange={(event) => updatePrice(commonTarget.key, { taxMode: event.target.value as TaxMode })}><option value="exclusive">税抜</option><option value="inclusive">税込</option></select></label>
            {modes.includes('fixed') && periodInput(commonTarget)}
          </div>}
          <table className="contract-information-table utility-price-table"><thead><tr><th>小分類</th><th>計算方法</th><th>単価・金額</th><th>税区分</th><th>請求書の単価</th><th>請求書の使用量・単位</th><th>請求月による単価</th></tr></thead><tbody>
            {hasBasic && (() => { const draft = basics[category] ?? { amount: '', taxMode: 'exclusive' as TaxMode }; return <tr key="basic"><td><strong>基本料</strong></td><td>定額</td><td><input type="number" step="1" min="0" value={draft.amount} disabled={disabled} placeholder="—" aria-label={`${categoryNames[category]}基本料`} onChange={(event) => updateBasic(category, { amount: event.target.value })} /> 円／月</td><td><select value={draft.taxMode} disabled={disabled} aria-label={`${categoryNames[category]}基本料の税区分`} onChange={(event) => updateBasic(category, { taxMode: event.target.value as TaxMode })}><option value="exclusive">税抜</option><option value="inclusive">税込</option></select></td><td>—</td><td>—</td><td>途中入退去は日割り</td></tr>; })()}
            {terms.map((term) => {
              const target = !shared && term.lineItemId ? targets.find((item) => item.lineItemId === term.lineItemId) : undefined;
              const firstForTarget = target && terms.find((item) => item.lineItemId === term.lineItemId && item.calculationMode === 'meter' && item.price_mode === 'fixed')?.asset_meter_sub_item_id === term.asset_meter_sub_item_id;
              const priceEditable = term.calculationMode === 'meter' && term.price_mode === 'fixed';
              const calculationLabel = term.calculationMode === 'allocated_amount' ? '請求額から計算' : term.calculationMode === 'fixed' ? '毎月定額' : '検針データから計算';
              return <tr key={term.asset_meter_sub_item_id}>
                <td><strong>{term.label}</strong></td>
                <td>{calculationLabel}{!shared && term.calculationMode === 'meter' && <select value={term.price_mode} disabled={disabled} aria-label={`${term.label}の単価計算方法`} onChange={(event) => updateMeterTerm(term.asset_meter_sub_item_id, { price_mode: event.target.value as MeterTerm['price_mode'] })}><option value="fixed">固定</option><option value="amount">金額から計算</option><option value="master_meter">大元メーターから計算</option></select>}</td>
                <td>{target && firstForTarget && priceEditable ? priceInput(target) : '—'}</td>
                <td>{term.calculationMode === 'meter' ? <select value={term.tax_mode} disabled={disabled} aria-label={`${term.label}の税区分`} onChange={(event) => { updateMeterTerm(term.asset_meter_sub_item_id, { tax_mode: event.target.value as TaxMode }); if (target) updatePrice(target.key, { taxMode: event.target.value as TaxMode }); }}><option value="exclusive">税抜</option><option value="inclusive">税込</option></select> : <span>{term.tax_mode === 'inclusive' ? '税込' : '税抜'}（検針設定）</span>}</td>
                <td><input type="checkbox" checked={term.show_unit_price_on_invoice} disabled={disabled || term.calculationMode === 'allocated_amount'} aria-label={`${term.label}の請求書単価表示`} onChange={(event) => updateMeterTerm(term.asset_meter_sub_item_id, { show_unit_price_on_invoice: event.target.checked })} /></td>
                <td><input type="checkbox" checked={term.show_usage_on_invoice} disabled={disabled || term.calculationMode === 'allocated_amount'} aria-label={`${term.label}の請求書使用量表示`} onChange={(event) => updateMeterTerm(term.asset_meter_sub_item_id, { show_usage_on_invoice: event.target.checked })} /></td>
                <td>{target && firstForTarget && priceEditable ? periodInput(target) : '—'}</td>
              </tr>;
            })}
          </tbody></table>
        </section>;
      })}
    </div>}    {!loading && (targets.length > 0 || basicCategories.length > 0 || meterTerms.length > 0) && canEdit && <div className="utility-price-actions">
      {message && <span className="billing-terms-preview">{message}</span>}
      <button type="button" className="primary-button" disabled={saving || !dirty} onClick={() => void save()}>{saving ? '保存中…' : '公共料金を保存'}</button>
    </div>}
  </>;
}
