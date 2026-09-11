import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from './lib/supabase';
import type { BillingProperty } from './TenantBillingControls';
import './PropertyBillingSettings.css';

type ChargeType = { billing_charge_type_id: string; charge_type_name: string };
type PeriodRule = 'manual' | 'meter_reading' | 'custom_pattern';
type LineItem = { asset_billing_line_item_id: string; line_item_name: string; display_name: string; billing_charge_type_id: string; billing_kind: 'fixed' | 'variable'; period_rule_type: PeriodRule; billing_period_pattern_id: string | null; sort_order: number };
type Pattern = { billing_period_pattern_id: string; pattern_name: string; start_month_offset: number; start_day_type: 'first' | 'last'; end_month_offset: number; end_day_type: 'first' | 'last'; sort_order: number };
const typesKey = 'tenant-billing-charge-types';
const itemsKey = (propertyId: string) => `tenant-billing-property-line-items:${propertyId}`;
const patternsKey = (propertyId: string) => `tenant-billing-period-patterns:${propertyId}`;
const stored = <T,>(key: string, fallback: T): T => { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const monthLabel = (offset: number) => offset === -1 ? '前月' : offset === 1 ? '翌月' : '当月';
const dayLabel = (value: 'first' | 'last') => value === 'first' ? '1日' : '末日';

export function PropertyBillingSettings({ propertyId, properties, canEdit }: { propertyId: string; properties: BillingProperty[]; canEdit: boolean }) {
  const [activeTab, setActiveTab] = useState<'items' | 'patterns'>('items');
  const [chargeTypes, setChargeTypes] = useState<ChargeType[]>([]);
  const [items, setItems] = useState<LineItem[]>([]);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [databaseReady, setDatabaseReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [lineItemName, setLineItemName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [chargeTypeId, setChargeTypeId] = useState('');
  const [billingKind, setBillingKind] = useState<'fixed' | 'variable'>('fixed');
  const [periodRule, setPeriodRule] = useState<PeriodRule>('manual');
  const [periodPatternId, setPeriodPatternId] = useState('');
  const [patternName, setPatternName] = useState('');
  const [startMonth, setStartMonth] = useState(0);
  const [startDay, setStartDay] = useState<'first' | 'last'>('first');
  const [endMonth, setEndMonth] = useState(0);
  const [endDay, setEndDay] = useState<'first' | 'last'>('last');
  const property = properties.find((item) => item.asset_id === propertyId);
  const setLocalData = (nextItems: LineItem[], nextPatterns: Pattern[]) => { localStorage.setItem(itemsKey(propertyId), JSON.stringify(nextItems)); localStorage.setItem(patternsKey(propertyId), JSON.stringify(nextPatterns)); setItems(nextItems); setPatterns(nextPatterns); };

  useEffect(() => { const load = async () => {
    if (!propertyId) { setItems([]); setPatterns([]); setLoading(false); return; }
    setLoading(true); setNotice('');
    if (supabase) {
      const [typeResult, itemResult, patternResult] = await Promise.all([
        supabase.from('billing_charge_type').select('billing_charge_type_id, charge_type_name').eq('is_active', true).order('sort_order'),
        supabase.from('asset_billing_line_item').select('asset_billing_line_item_id, line_item_name, display_name, billing_charge_type_id, billing_kind, period_rule_type, billing_period_pattern_id, sort_order').eq('asset_id', propertyId).eq('is_active', true).order('sort_order'),
        supabase.from('asset_billing_period_pattern').select('billing_period_pattern_id, pattern_name, start_month_offset, start_day_type, end_month_offset, end_day_type, sort_order').eq('asset_id', propertyId).order('sort_order'),
      ]);
      if (!typeResult.error && !itemResult.error && !patternResult.error) { const types = (typeResult.data ?? []) as ChargeType[]; setChargeTypes(types); setItems((itemResult.data ?? []) as LineItem[]); setPatterns((patternResult.data ?? []) as Pattern[]); setChargeTypeId(types[0]?.billing_charge_type_id ?? ''); setDatabaseReady(true); setLoading(false); return; }
    }
    const types = stored(typesKey, [] as ChargeType[]); setChargeTypes(types); setChargeTypeId(types[0]?.billing_charge_type_id ?? ''); setLocalData(stored(itemsKey(propertyId), [] as LineItem[]), stored(patternsKey(propertyId), [] as Pattern[])); setDatabaseReady(false); setLoading(false);
  }; void load(); }, [propertyId]);

  const addItem = async (event: FormEvent) => {
    event.preventDefault(); const name = lineItemName.trim(); const shownName = displayName.trim(); if (!name || !shownName || !chargeTypeId || !propertyId) return;
    if (items.some((item) => item.line_item_name === name)) { setNotice('同じ項目が登録されています。'); return; }
    const draft = { line_item_name: name, display_name: shownName, billing_charge_type_id: chargeTypeId, billing_kind: billingKind, period_rule_type: billingKind === 'fixed' ? 'manual' as PeriodRule : periodRule, billing_period_pattern_id: billingKind === 'variable' && periodRule === 'custom_pattern' ? periodPatternId || patterns[0]?.billing_period_pattern_id || null : null, sort_order: items.length + 1 };
    if (databaseReady && supabase) { const { data, error } = await supabase.from('asset_billing_line_item').insert({ asset_id: propertyId, ...draft }).select('asset_billing_line_item_id, line_item_name, display_name, billing_charge_type_id, billing_kind, period_rule_type, billing_period_pattern_id, sort_order').single(); if (error) { setNotice(`明細項目を登録できませんでした: ${error.message}`); return; } setItems((current) => [...current, data as LineItem]); }
    else setLocalData([...items, { asset_billing_line_item_id: crypto.randomUUID(), ...draft }], patterns);
    setLineItemName(''); setDisplayName(''); setPeriodRule('manual'); setPeriodPatternId(''); setNotice('明細項目を登録しました。');
  };
  const deleteItem = async (item: LineItem) => { if (databaseReady && supabase) { const { error } = await supabase.from('asset_billing_line_item').delete().eq('asset_billing_line_item_id', item.asset_billing_line_item_id); if (error) { setNotice(`明細項目を削除できませんでした: ${error.message}`); return; } } const next = items.filter((current) => current.asset_billing_line_item_id !== item.asset_billing_line_item_id).map((current, index) => ({ ...current, sort_order: index + 1 })); if (databaseReady) setItems(next); else setLocalData(next, patterns); setNotice('明細項目を削除しました。'); };
  const addPattern = async (event: FormEvent) => { event.preventDefault(); const name = patternName.trim(); if (!name || !propertyId) return; const draft = { pattern_name: name, start_month_offset: startMonth, start_day_type: startDay, end_month_offset: endMonth, end_day_type: endDay, sort_order: patterns.length + 1 }; if (databaseReady && supabase) { const { data, error } = await supabase.from('asset_billing_period_pattern').insert({ asset_id: propertyId, ...draft }).select('billing_period_pattern_id, pattern_name, start_month_offset, start_day_type, end_month_offset, end_day_type, sort_order').single(); if (error) { setNotice(`請求期間パターンを登録できませんでした: ${error.message}`); return; } setPatterns((current) => [...current, data as Pattern]); } else setLocalData(items, [...patterns, { billing_period_pattern_id: crypto.randomUUID(), ...draft }]); setPatternName(''); setNotice('請求期間パターンを登録しました。'); };
  const typeName = (typeId: string) => chargeTypes.find((type) => type.billing_charge_type_id === typeId)?.charge_type_name ?? '未設定';
  const patternDescription = (pattern: Pattern) => `YYYY/MM/DD～YYYY/MM/DD分（${monthLabel(pattern.start_month_offset)}${dayLabel(pattern.start_day_type)} ～ ${monthLabel(pattern.end_month_offset)}${dayLabel(pattern.end_day_type)}）`;

  return <section className="property-billing-settings"><header><div><h3>請求設定</h3><p>{property ? `${property.short_name || property.asset_name}の明細項目と請求期間パターンを設定します。` : '物件を選択してください。'}</p></div></header>{!databaseReady && !loading && <p className="property-billing-settings-notice">現在はローカル表示用の仮設定です。データベース移行後は物件ごとの設定として保存されます。</p>}{notice && <p className="property-billing-settings-notice error">{notice}</p>}
    <div className="property-billing-tabs"><button type="button" className={activeTab === 'items' ? 'active' : ''} onClick={() => setActiveTab('items')}>明細項目</button><button type="button" className={activeTab === 'patterns' ? 'active' : ''} onClick={() => setActiveTab('patterns')}>請求期間の任意パターン</button></div>
    {activeTab === 'items' ? <section className="property-billing-items"><div className="property-billing-items-heading"><h4>明細項目</h4><p>この物件で請求する項目を登録します。固定費の請求期間は契約情報から取得します。</p></div><form onSubmit={addItem} className="property-billing-item-form"><label>項目<input value={lineItemName} onChange={(event) => setLineItemName(event.target.value)} placeholder="例：電気代（基本料）" /></label><label>明細表示名<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="例：電気代" /></label><label>請求種別<select value={chargeTypeId} onChange={(event) => setChargeTypeId(event.target.value)}>{chargeTypes.map((type) => <option key={type.billing_charge_type_id} value={type.billing_charge_type_id}>{type.charge_type_name}</option>)}</select></label><label>請求区分<select value={billingKind} onChange={(event) => setBillingKind(event.target.value as 'fixed' | 'variable')}><option value="fixed">固定費</option><option value="variable">変動費</option></select></label><label>請求期間<select disabled={billingKind === 'fixed'} value={billingKind === 'fixed' ? 'contract' : periodRule} onChange={(event) => setPeriodRule(event.target.value as PeriodRule)}><option value="contract">契約情報から設定</option><option value="manual">手入力</option><option value="meter_reading">検針データから設定</option><option value="custom_pattern">任意のパターンから設定</option></select>{billingKind === 'variable' && periodRule === 'meter_reading' && <small>前月検針日 ～ 今月検針日</small>}{billingKind === 'variable' && periodRule === 'custom_pattern' && <select value={periodPatternId} onChange={(event) => setPeriodPatternId(event.target.value)}><option value="">パターンを選択</option>{patterns.map((pattern) => <option key={pattern.billing_period_pattern_id} value={pattern.billing_period_pattern_id}>{pattern.pattern_name}</option>)}</select>}</label><button type="submit" className="primary-button" disabled={!canEdit || !chargeTypes.length}>登録</button></form><div className="property-billing-settings-table-wrap"><table><thead><tr><th>項目</th><th>明細表示名</th><th>請求種別</th><th>請求区分</th><th>請求期間</th><th /></tr></thead><tbody>{loading ? <tr><td colSpan={6}>読み込み中…</td></tr> : items.length ? items.map((item) => <tr key={item.asset_billing_line_item_id}><td><strong>{item.line_item_name}</strong></td><td>{item.display_name}</td><td>{typeName(item.billing_charge_type_id)}</td><td><span>{item.billing_kind === 'fixed' ? '固定費' : '変動費'}</span></td><td>{item.billing_kind === 'fixed' ? '契約情報から設定' : item.period_rule_type === 'manual' ? '手入力' : item.period_rule_type === 'meter_reading' ? '検針データから設定' : `任意パターン：${patterns.find((pattern) => pattern.billing_period_pattern_id === item.billing_period_pattern_id)?.pattern_name ?? '未設定'}`}</td><td><button type="button" className="tenant-billing-delete" disabled={!canEdit} onClick={() => void deleteItem(item)}>削除</button></td></tr>) : <tr><td colSpan={6}>明細項目はまだ登録されていません。</td></tr>}</tbody></table></div></section> : <section className="property-period-patterns"><div><h4>請求期間の任意パターン</h4><p>任意パターン用に、請求書へ表示する期間を物件ごとに登録します。</p></div><form onSubmit={addPattern}><label>パターン名<input value={patternName} onChange={(event) => setPatternName(event.target.value)} placeholder="例：前月分" /></label><label>開始<select value={startMonth} onChange={(event) => setStartMonth(Number(event.target.value))}>{[-1, 0, 1].map((value) => <option key={value} value={value}>{monthLabel(value)}</option>)}</select><select value={startDay} onChange={(event) => setStartDay(event.target.value as 'first' | 'last')}><option value="first">1日</option><option value="last">末日</option></select></label><label>終了<select value={endMonth} onChange={(event) => setEndMonth(Number(event.target.value))}>{[-1, 0, 1].map((value) => <option key={value} value={value}>{monthLabel(value)}</option>)}</select><select value={endDay} onChange={(event) => setEndDay(event.target.value as 'first' | 'last')}><option value="first">1日</option><option value="last">末日</option></select></label><button type="submit" className="primary-button" disabled={!canEdit}>登録</button></form>{patterns.length > 0 && <div className="property-period-pattern-list">{patterns.map((pattern) => <span key={pattern.billing_period_pattern_id}><strong>{pattern.pattern_name}</strong>{patternDescription(pattern)}</span>)}</div>}</section>}
  </section>;
}
