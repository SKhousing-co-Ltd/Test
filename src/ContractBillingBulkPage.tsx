import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import './ParkingFeeCleanupPage.css';
import './ContractBillingBulkPage.css';

// 請求条件（入金期日・請求期間・小数点以下の処理）と公共料金（電気基本料・各単価）を、
// テナント請求の対象ビルの全契約で一括設定するページです。
//   請求条件の入金期日・請求期間は契約が持つため、同じ契約の区画を並べたときは同じ値を保存します。
//   単価欄は、選択したビルの「分類で共通／小分類ごと」の設定に応じて動的に切り替えます。

type CategoryId = 'electric' | 'water' | 'gas';
type TaxMode = 'exclusive' | 'inclusive';
type Rounding = 'floor' | 'round' | 'ceil';
type Terms = { due_month_offset: number; due_day_of_month: number; due_holiday_adjustment: 'previous' | 'next'; period_month_offset: number; is_annual_billing: boolean; annual_billing_month: number | null; annual_start_offset: number | null };
type BillingMonthPrice = { start_month: number; end_month: number; unit_price: number };
type SavedPrice = { asset_billing_line_item_id: string; unit_price: number; tax_mode: TaxMode; billing_month_prices: BillingMonthPrice[] | null };
type SavedCategoryPrice = { category: CategoryId; unit_price: number; tax_mode: TaxMode; billing_month_prices: BillingMonthPrice[] | null };
type SavedBasic = { category: CategoryId; amount: number; tax_mode: TaxMode };
type UnitRecord = {
  lease_contract_unit_id: string; utility_amount_rounding_mode: Rounding;
  contract: (Terms & { lease_contract_id: string }) | Array<Terms & { lease_contract_id: string }> | null;
  prices: SavedPrice[] | null; categoryPrices: SavedCategoryPrice[] | null; basics: SavedBasic[] | null;
};
type PriceDefinition = {
  key: string;
  label: string;
  category: CategoryId;
  scope: 'category' | 'line_item';
  lineItemId: string | null;
};
// 画面で編集する値です。単価・基本料は文字列で持ち、空欄は未設定です。
type Draft = Terms & { rounding: Rounding; basic: string; prices: Record<string, string> };
type Row = {
  id: string; contractId: string; propertyId: string; property: string; tenant: string; unit: string;
  sharedCategories: CategoryId[];
  priceDefinitions: PriceDefinition[];
  saved: { prices: SavedPrice[]; categoryPrices: SavedCategoryPrice[]; basics: SavedBasic[] };
  original: Draft;
};
type Failure = { property: string; tenant: string; unit: string; message: string };

const categories: CategoryId[] = ['electric', 'water', 'gas'];
const categoryNames: Record<CategoryId, string> = { electric: '電気', water: '水道', gas: 'ガス' };
const today = new Date().toISOString().slice(0, 10);
const termKeys: Array<keyof Terms> = ['due_month_offset', 'due_day_of_month', 'due_holiday_adjustment', 'period_month_offset', 'is_annual_billing', 'annual_billing_month', 'annual_start_offset'];
const isAmount = (value: string) => value.trim() === '' || (Number.isFinite(Number(value)) && Number(value) >= 0);
// 一括反映の欄です。空欄の項目は反映しません。
type Bulk = { dueMonth: string; dueDay: string; holiday: string; period: string; rounding: string; basic: string; prices: Record<string, string> };
type BulkScalarKey = Exclude<keyof Bulk, 'prices'>;
const emptyBulk: Bulk = { dueMonth: '', dueDay: '', holiday: '', period: '', rounding: '', basic: '', prices: {} };

// 契約区画の公共料金（単価・分類共通の単価・基本料）の保存済みの内容を読み直します。
async function loadSavedTerms(client: NonNullable<typeof supabase>, leaseContractUnitId: string): Promise<Row['saved'] | { error: string }> {
  const [prices, categoryPrices, basics] = await Promise.all([
    client.from('lease_contract_unit_utility_price').select('asset_billing_line_item_id, unit_price, tax_mode, billing_month_prices').eq('lease_contract_unit_id', leaseContractUnitId),
    client.from('lease_contract_unit_category_price').select('category, unit_price, tax_mode, billing_month_prices').eq('lease_contract_unit_id', leaseContractUnitId),
    client.from('lease_contract_unit_basic_charge').select('category, amount, tax_mode').eq('lease_contract_unit_id', leaseContractUnitId),
  ]);
  const failed = prices.error ?? categoryPrices.error ?? basics.error;
  if (failed) return { error: `保存済みの内容を読み込めませんでした: ${failed.message}` };
  return { prices: (prices.data ?? []) as SavedPrice[], categoryPrices: (categoryPrices.data ?? []) as SavedCategoryPrice[], basics: (basics.data ?? []) as SavedBasic[] };
}

export function ContractBillingBulkPage({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [propertyFilter, setPropertyFilter] = useState('');
  const [bulk, setBulk] = useState<Bulk>(emptyBulk);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ success: number; failures: Failure[] } | null>(null);

  const load = useCallback(async () => {
    if (!supabase || !canEdit) return;
    const client = supabase;
    setLoading(true); setError('');
    const { data: assetData, error: assetError } = await client.from('asset_master').select('asset_id, asset_name').eq('is_tenant_billing_enabled', true).order('asset_code');
    if (assetError) { setError(`ビルを読み込めませんでした: ${assetError.message}`); setLoading(false); return; }
    const assets = (assetData ?? []) as Array<{ asset_id: string; asset_name: string }>;
    const assetIds = assets.map((asset) => asset.asset_id);
    const [listResults, settingResult, subItemResult, lineItemResult] = await Promise.all([
      Promise.all(assets.map((asset) => client.rpc('rent_roll_list_with_terms_at_date', { p_property_id: asset.asset_id, p_as_of_date: today }))),
      assetIds.length ? client.from('asset_utility_price_setting').select('asset_id, category, price_scope').in('asset_id', assetIds) : Promise.resolve({ data: [], error: null }),
      assetIds.length ? client.from('asset_meter_sub_item').select('asset_id, category, sub_item_name, sub_item_kind, asset_billing_line_item_id, price_mode, sort_order').in('asset_id', assetIds).order('sort_order') : Promise.resolve({ data: [], error: null }),
      assetIds.length ? client.from('asset_billing_line_item').select('asset_id, asset_billing_line_item_id, line_item_name, display_name').in('asset_id', assetIds).eq('is_active', true) : Promise.resolve({ data: [], error: null }),
    ]);
    const listError = listResults.find((item) => item.error)?.error ?? settingResult.error ?? subItemResult.error ?? lineItemResult.error;
    if (listError) { setError(`契約を読み込めませんでした: ${listError.message}`); setLoading(false); return; }
    // 設定が無い分類は「分類で共通」です。
    const lineItemScoped = new Set(((settingResult.data ?? []) as Array<{ asset_id: string; category: CategoryId; price_scope: string }>).filter((row) => row.price_scope === 'line_item').map((row) => `${row.asset_id}:${row.category}`));
    const lineItems = (lineItemResult.data ?? []) as Array<{ asset_id: string; asset_billing_line_item_id: string; line_item_name: string; display_name: string | null }>;
    const subItems = (subItemResult.data ?? []) as Array<{ asset_id: string; category: CategoryId; sub_item_name: string; sub_item_kind: string; asset_billing_line_item_id: string | null; price_mode: string; sort_order: number }>;
    const priceDefinitionsByAsset = new Map<string, PriceDefinition[]>();
    for (const asset of assets) {
      const definitions: PriceDefinition[] = [];
      for (const category of categories) {
        if (!lineItemScoped.has(`${asset.asset_id}:${category}`)) {
          definitions.push({ key: `category:${category}`, label: `${categoryNames[category]}単価`, category, scope: 'category', lineItemId: null });
          continue;
        }
        const seen = new Set<string>();
        for (const subItem of subItems.filter((item) => item.asset_id === asset.asset_id && item.category === category && item.sub_item_kind === 'custom' && item.price_mode === 'fixed' && item.asset_billing_line_item_id)) {
          const lineItemId = subItem.asset_billing_line_item_id as string;
          if (seen.has(lineItemId)) continue;
          const lineItem = lineItems.find((item) => item.asset_billing_line_item_id === lineItemId);
          if (!lineItem) continue;
          seen.add(lineItemId);
          definitions.push({ key: `line:${lineItemId}`, label: `${subItem.sub_item_name}単価`, category, scope: 'line_item', lineItemId });
        }
      }
      priceDefinitionsByAsset.set(asset.asset_id, definitions);
    }
    type ListRow = { lease_contract_unit_id: string | null; unit_code: string; unit_name: string | null; tenant_name: string | null; contract_status: string | null };
    const listed = assets.flatMap((asset, index) => ((listResults[index].data ?? []) as ListRow[])
      .filter((row) => row.lease_contract_unit_id && row.tenant_name)
      .map((row) => ({ asset, row })));
    const ids = listed.map(({ row }) => row.lease_contract_unit_id as string);
    const records = new Map<string, UnitRecord>();
    // URLが長くなりすぎないよう、区画は分けて読み込みます。
    for (let start = 0; start < ids.length; start += 100) {
      const { data, error: unitError } = await client.from('lease_contract_unit')
        .select('lease_contract_unit_id, utility_amount_rounding_mode, contract:lease_contract!inner(lease_contract_id, due_month_offset, due_day_of_month, due_holiday_adjustment, period_month_offset, is_annual_billing, annual_billing_month, annual_start_offset), prices:lease_contract_unit_utility_price(asset_billing_line_item_id, unit_price, tax_mode, billing_month_prices), categoryPrices:lease_contract_unit_category_price(category, unit_price, tax_mode, billing_month_prices), basics:lease_contract_unit_basic_charge(category, amount, tax_mode)')
        .in('lease_contract_unit_id', ids.slice(start, start + 100));
      if (unitError) { setError(`契約の請求条件を読み込めませんでした: ${unitError.message}`); setLoading(false); return; }
      for (const record of (data ?? []) as unknown as UnitRecord[]) records.set(record.lease_contract_unit_id, record);
    }
    const next: Row[] = [];
    for (const { asset, row } of listed) {
      const record = records.get(row.lease_contract_unit_id as string);
      const contract = record && (Array.isArray(record.contract) ? record.contract[0] : record.contract);
      if (!record || !contract) continue;
      const categoryPrices = record.categoryPrices ?? [];
      const basics = record.basics ?? [];
      const basic = basics.find((item) => item.category === 'electric');
      const terms = Object.fromEntries(termKeys.map((key) => [key, contract[key]])) as Terms;
      const priceDefinitions = priceDefinitionsByAsset.get(asset.asset_id) ?? [];
      const priceValues = Object.fromEntries(priceDefinitions.map((definition) => {
        const savedPrice = definition.scope === 'category'
          ? categoryPrices.find((item) => item.category === definition.category)
          : (record.prices ?? []).find((item) => item.asset_billing_line_item_id === definition.lineItemId);
        return [definition.key, savedPrice ? String(savedPrice.unit_price) : ''];
      }));
      next.push({
        id: record.lease_contract_unit_id, contractId: contract.lease_contract_id, propertyId: asset.asset_id, property: asset.asset_name,
        tenant: row.tenant_name ?? '', unit: row.unit_name || row.unit_code,
        sharedCategories: categories.filter((category) => !lineItemScoped.has(`${asset.asset_id}:${category}`)),
        priceDefinitions,
        saved: { prices: record.prices ?? [], categoryPrices, basics },
        original: { ...terms, rounding: record.utility_amount_rounding_mode ?? 'floor', basic: basic ? String(basic.amount) : '', prices: priceValues },
      });
    }
    setRows(next);
    setDrafts(Object.fromEntries(next.map((row) => [row.id, row.original])));
    setSelected(new Set());
    setLoading(false);
  }, [canEdit]);
  useEffect(() => { void load(); }, [load]);

  const properties = useMemo(() => [...new Map(rows.map((row) => [row.propertyId, row.property])).entries()], [rows]);
  const visible = propertyFilter ? rows.filter((row) => row.propertyId === propertyFilter) : [];
  const activePriceDefinitions = visible[0]?.priceDefinitions ?? [];
  const selectedRows = visible.filter((row) => selected.has(row.id));
  const termsChanged = (row: Row) => termKeys.some((key) => drafts[row.id]?.[key] !== row.original[key]);
  const pricesChanged = (row: Row) => drafts[row.id]?.basic !== row.original.basic || row.priceDefinitions.some((definition) => drafts[row.id]?.prices[definition.key] !== row.original.prices[definition.key]);
  const roundingChanged = (row: Row) => drafts[row.id]?.rounding !== row.original.rounding;
  const changedRows = rows.filter((row) => termsChanged(row) || pricesChanged(row) || roundingChanged(row));

  // 入金期日・請求期間は契約が持つため、同じ契約の区画にも同じ値を入れます。
  const updateDraft = (row: Row, patch: Partial<Draft>) => setDrafts((current) => {
    const termPatch = Object.fromEntries(Object.entries(patch).filter(([key]) => (termKeys as string[]).includes(key)));
    const next = { ...current, [row.id]: { ...current[row.id], ...patch } };
    if (Object.keys(termPatch).length) for (const other of rows) if (other.contractId === row.contractId && other.id !== row.id) next[other.id] = { ...next[other.id], ...termPatch };
    return next;
  });
  const updatePrice = (row: Row, key: string, value: string) => setDrafts((current) => ({
    ...current,
    [row.id]: { ...current[row.id], prices: { ...current[row.id].prices, [key]: value } },
  }));
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const applyBulk = () => {
    if (!isAmount(bulk.basic) || Object.values(bulk.prices).some((value) => !isAmount(value))) { setError('一括反映する金額・単価は0以上の数値で入力してください。'); return; }
    const patch: Partial<Draft> = {};
    if (bulk.dueMonth) patch.due_month_offset = Number(bulk.dueMonth);
    if (bulk.dueDay) patch.due_day_of_month = Number(bulk.dueDay);
    if (bulk.holiday) patch.due_holiday_adjustment = bulk.holiday as Terms['due_holiday_adjustment'];
    if (bulk.period) patch.period_month_offset = Number(bulk.period);
    if (bulk.rounding) patch.rounding = bulk.rounding as Rounding;
    if (bulk.basic.trim()) patch.basic = bulk.basic.trim();
    const bulkPrices = Object.fromEntries(Object.entries(bulk.prices).filter(([, value]) => value.trim()));
    if (!Object.keys(patch).length && !Object.keys(bulkPrices).length) { setError('反映する項目を入力してください。'); return; }
    for (const row of selectedRows) {
      // 年払いの契約は請求期間を変えません。単価は選択したビルに表示されている項目だけを反映します。
      const rowPatch: Partial<Draft> = { ...patch };
      if (drafts[row.id]?.is_annual_billing) delete rowPatch.period_month_offset;
      updateDraft(row, rowPatch);
      if (Object.keys(bulkPrices).length) setDrafts((current) => ({
        ...current,
        [row.id]: { ...current[row.id], prices: { ...current[row.id].prices, ...bulkPrices } },
      }));
    }
    setError('');
  };

  const save = async () => {
    if (!supabase || !changedRows.length) return;
    const invalid = changedRows.find((row) => !isAmount(drafts[row.id].basic) || row.priceDefinitions.some((definition) => !isAmount(drafts[row.id].prices[definition.key] ?? '')));
    if (invalid) { setError(`${invalid.property} / ${invalid.tenant} / ${invalid.unit} の金額・単価は0以上の数値で入力してください。`); return; }
    if (!window.confirm(`${changedRows.length}件の区画の変更を保存します。よろしいですか？`)) return;
    setProcessing(true); setError(''); setResult(null);
    let success = 0; const failures: Failure[] = [];
    const savedContracts = new Set<string>();
    // 区画ごとに、請求条件・小数点以下の処理・公共料金をそれぞれ保存します。一部だけ失敗したときは、保存できた項目も結果に出します。
    for (const row of changedRows) {
      const draft = drafts[row.id];
      const saved: string[] = []; const errors: string[] = [];
      if (termsChanged(row) && !savedContracts.has(row.contractId)) {
        const { error: termsError } = await supabase.rpc('update_lease_contract_billing_terms', {
          p_lease_contract_id: row.contractId, p_due_month_offset: draft.due_month_offset, p_due_day_of_month: draft.due_day_of_month,
          p_due_holiday_adjustment: draft.due_holiday_adjustment, p_period_month_offset: draft.period_month_offset,
          p_is_annual_billing: draft.is_annual_billing, p_annual_billing_month: draft.annual_billing_month, p_annual_start_offset: draft.annual_start_offset,
        });
        if (termsError) errors.push(`請求条件：${termsError.message}`); else { saved.push('請求条件'); savedContracts.add(row.contractId); }
      }
      if (roundingChanged(row)) {
        const { error: roundingError } = await supabase.rpc('update_lease_contract_unit_amount_rounding', { p_lease_contract_unit_id: row.id, p_amount_rounding_mode: draft.rounding });
        if (roundingError) errors.push(`小数点以下の処理：${roundingError.message}`); else saved.push('小数点以下の処理');
      }
      if (pricesChanged(row)) {
        // 保存は置き換えのため、この画面で扱わない単価・基本料は保存直前の最新の内容をそのまま渡します（画面を開いた後に契約情報で入れた変更も消さないため）。
        const latest = await loadSavedTerms(supabase, row.id);
        if ('error' in latest) errors.push(`公共料金：${latest.error}`);
        else {
          const categoryPrices = categories.flatMap((category) => {
            const kept = latest.categoryPrices.find((item) => item.category === category);
            if (!row.sharedCategories.includes(category)) return kept ? [kept] : [];
            const value = (draft.prices[`category:${category}`] ?? '').trim();
            if (!value) return [];
            return [{ category, unit_price: Number(value), tax_mode: kept?.tax_mode ?? 'exclusive', billing_month_prices: kept?.billing_month_prices ?? [] }];
          });
          const lineItemPrices = latest.prices.flatMap((item) => {
            const definition = row.priceDefinitions.find((candidate) => candidate.scope === 'line_item' && candidate.lineItemId === item.asset_billing_line_item_id);
            const value = definition ? (draft.prices[definition.key] ?? '').trim() : '';
            if (!definition) return [item];
            return value ? [{ ...item, unit_price: Number(value) }] : [];
          });
          for (const definition of row.priceDefinitions.filter((candidate) => candidate.scope === 'line_item' && candidate.lineItemId)) {
            const value = (draft.prices[definition.key] ?? '').trim();
            if (!value || lineItemPrices.some((item) => item.asset_billing_line_item_id === definition.lineItemId)) continue;
            lineItemPrices.push({ asset_billing_line_item_id: definition.lineItemId as string, unit_price: Number(value), tax_mode: 'exclusive', billing_month_prices: [] });
          }
          const keptBasic = latest.basics.find((item) => item.category === 'electric');
          const basics = [
            ...latest.basics.filter((item) => item.category !== 'electric'),
            ...(draft.basic.trim() ? [{ category: 'electric' as CategoryId, amount: Number(draft.basic), tax_mode: keptBasic?.tax_mode ?? 'exclusive' }] : []),
          ];
          const { error: priceError } = await supabase.rpc('save_lease_contract_unit_utility_terms', {
            p_lease_contract_unit_id: row.id, p_prices: lineItemPrices.map((item) => ({ ...item, billing_month_prices: item.billing_month_prices ?? [] })),
            p_category_prices: categoryPrices, p_basic_charges: basics,
          });
          if (priceError) errors.push(`公共料金：${priceError.message}`); else saved.push('公共料金');
        }
      }
      if (errors.length) failures.push({ property: row.property, tenant: row.tenant, unit: row.unit, message: `${errors.join('／')}${saved.length ? `（${saved.join('・')}は保存済み）` : ''}` });
      else success += 1;
    }
    setProcessing(false); setResult({ success, failures }); await load();
  };

  if (!canEdit) return <section className="parking-fee-cleanup"><div className="panel parking-fee-cleanup-empty"><h2>請求条件一括設定</h2><p>このページは総務経理部の担当者と管理者だけが利用できます。</p></div></section>;
  const settingsDisabled = !propertyFilter || processing;
  const bulkSelect = (key: BulkScalarKey, label: string, options: Array<[string, string]>) => <label>{label}<select value={bulk[key]} disabled={settingsDisabled} onChange={(event) => setBulk((current) => ({ ...current, [key]: event.target.value }))}><option value="">変更しない</option>{options.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>;
  const bulkInput = (key: BulkScalarKey, label: string) => <label>{label}<input type="number" min="0" step="0.0001" value={bulk[key]} placeholder="変更しない" disabled={settingsDisabled} onChange={(event) => setBulk((current) => ({ ...current, [key]: event.target.value }))} /></label>;
  const bulkPriceInput = (definition: PriceDefinition) => <label key={definition.key}>{definition.label}<input type="number" min="0" step="0.0001" value={bulk.prices[definition.key] ?? ''} placeholder="変更しない" onChange={(event) => setBulk((current) => ({ ...current, prices: { ...current.prices, [definition.key]: event.target.value } }))} /></label>;
  const dayOptions: Array<[string, string]> = [...Array.from({ length: 31 }, (_, i) => [String(i + 1), `${i + 1}日`] as [string, string]), ['0', '末日']];
  const selectable = visible;
  return <section className="parking-fee-cleanup contract-billing-bulk">
    <header className="page-header"><div><p className="eyebrow">BILLING TERMS</p><h2>請求条件一括設定</h2><p>テナント請求の対象ビルの契約について、請求条件と公共料金をまとめて設定します。</p></div><button className="secondary-button" onClick={() => void load()} disabled={loading || processing}>再読み込み</button></header>
    <section className="panel parking-fee-cleanup-panel">
      <div className="parking-fee-cleanup-tools">
        <label>ビル<span className="required-mark">必須</span><select value={propertyFilter} required onChange={(event) => { setPropertyFilter(event.target.value); setSelected(new Set()); setBulk(emptyBulk); setResult(null); }}><option value="">ビルを選択してください</option>{properties.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        {bulkSelect('dueMonth', '入金期日（月）', [['0', '当月'], ['1', '翌月']])}
        {bulkSelect('dueDay', '入金期日（日）', dayOptions)}
        {bulkSelect('holiday', '土日祝の場合', [['previous', '前日'], ['next', '翌日']])}
        {bulkSelect('period', '請求期間', [['-1', '前月分'], ['0', '当月分'], ['1', '翌月分']])}
        {bulkSelect('rounding', '小数点以下の処理', [['floor', '切り捨て'], ['round', '四捨五入'], ['ceil', '切り上げ']])}
        {bulkInput('basic', '電気基本料')}
        {activePriceDefinitions.map(bulkPriceInput)}
        <div className="contract-billing-bulk-actions">
          <button className="secondary-button" onClick={applyBulk} disabled={!selectedRows.length || processing}>選択した{selectedRows.length}件へ反映</button>
          <button className="primary-button" onClick={() => void save()} disabled={!changedRows.length || processing}>{processing ? '保存中…' : `変更した${changedRows.length}件を保存`}</button>
        </div>
      </div>
      {error ? <p className="parking-fee-cleanup-message error">{error}</p> : null}
      {result ? <section className="parking-fee-cleanup-result"><strong>成功：{result.success}件　失敗：{result.failures.length}件</strong>{result.failures.length ? <ul>{result.failures.map((failure, index) => <li key={index}>{failure.property} / {failure.tenant} / {failure.unit}：{failure.message}</li>)}</ul> : null}</section> : null}
      <div className="table-scroll"><table className="parking-fee-cleanup-table">
        <thead><tr>
          <th><input type="checkbox" aria-label="表示中の契約をすべて選択" checked={selectable.length > 0 && selectable.every((row) => selected.has(row.id))} onChange={(event) => setSelected((current) => { const next = new Set(current); selectable.forEach((row) => { if (event.target.checked) next.add(row.id); else next.delete(row.id); }); return next; })} /></th>
          <th>ビル</th><th>テナント</th><th>区画</th><th>入金期日</th><th>請求期間</th><th>小数点以下の処理</th><th>電気基本料</th>{activePriceDefinitions.map((definition) => <th key={definition.key}>{definition.label}</th>)}
        </tr></thead>
        <tbody>{loading ? <tr><td colSpan={8 + activePriceDefinitions.length} className="parking-fee-cleanup-empty">読み込み中です…</td></tr> : visible.length ? visible.map((row) => {
          const draft = drafts[row.id] ?? row.original;
          const changed = termsChanged(row) || pricesChanged(row) || roundingChanged(row);
          return <tr key={row.id} className={changed ? 'changed' : undefined}>
            <td><input type="checkbox" checked={selected.has(row.id)} disabled={processing} onChange={() => toggle(row.id)} /></td>
            <td>{row.property}</td><td>{row.tenant}</td><td>{row.unit}</td>
            <td><select aria-label="入金期日の月" value={draft.due_month_offset} disabled={processing} onChange={(event) => updateDraft(row, { due_month_offset: Number(event.target.value) })}><option value={0}>当月</option><option value={1}>翌月</option></select>
              <select aria-label="入金期日の日" value={draft.due_day_of_month} disabled={processing} onChange={(event) => updateDraft(row, { due_day_of_month: Number(event.target.value) })}>{dayOptions.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>
              <select aria-label="土日祝の場合" value={draft.due_holiday_adjustment} disabled={processing} onChange={(event) => updateDraft(row, { due_holiday_adjustment: event.target.value as Terms['due_holiday_adjustment'] })}><option value="previous">前日</option><option value="next">翌日</option></select></td>
            <td>{draft.is_annual_billing ? '年払い' : <select aria-label="請求期間" value={draft.period_month_offset} disabled={processing} onChange={(event) => updateDraft(row, { period_month_offset: Number(event.target.value) })}><option value={-1}>前月分</option><option value={0}>当月分</option><option value={1}>翌月分</option></select>}</td>
            <td><select aria-label="小数点以下の処理" value={draft.rounding} disabled={processing} onChange={(event) => updateDraft(row, { rounding: event.target.value as Rounding })}><option value="floor">切り捨て</option><option value="round">四捨五入</option><option value="ceil">切り上げ</option></select></td>
            <td><input type="number" min="0" step="1" value={draft.basic} placeholder="—" disabled={processing} aria-label="電気基本料" onChange={(event) => updateDraft(row, { basic: event.target.value })} /></td>
            {activePriceDefinitions.map((definition) => <td key={definition.key}><input type="number" min="0" step="0.0001" value={draft.prices[definition.key] ?? ''} placeholder="—" disabled={processing} aria-label={definition.label} onChange={(event) => updatePrice(row, definition.key, event.target.value)} /></td>)}
          </tr>;
        }) : <tr><td colSpan={8 + activePriceDefinitions.length} className="parking-fee-cleanup-empty">{propertyFilter ? '選択したビルに対象契約がありません。' : 'ビルを選択してください。'}</td></tr>}</tbody>
      </table></div>
    </section>
  </section>;
}
