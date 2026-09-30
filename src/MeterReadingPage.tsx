import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import {
  billedAmounts, calculateSubItem,
  floorLabel, priceModeLabel, roundingModeLabel, splitName, sumModeLabel, taxModeLabel, toExclusive,
  subItemDefaults, variablePriceMethodLabel, variableUnitPrice,
  type BuildingConfig, type Category, type CategoryId, type ContractRow, type LineItem, type MeterShare,
  type PriceMode, type RoundingMode, type SubItem, type SumMode, type TaxMode, type TenantConfig,
  type SurchargePurchase, type VariablePriceInput, type VariablePriceMethod,
} from './utils/meterReading';
import { computeMonth, confirmMeterReading, loadConfirmedAmounts, loadMeterReading, newId, releaseMeterReading, saveMeterReading, type ConfirmedAmount, type MeterReadingSnapshot } from './utils/meterReadingStore';
import {
  addDays, monthFirst, ORIGIN_DATE, reassignUnit, slashDate, unitAt,
  type AllocatedSegment, type AssetMeter, type MeterBreak, type Occupancy, type UnitOption,
} from './utils/meterAllocation';
import { periodRange } from './utils/billingDates';
import { supabase } from './lib/supabase';
import type { BillingPeriod } from './TenantBillingControls';
import './MeterReadingPage.css';

// 検針データの画面です。
// 分類（電気・水道・ガス）の中に小分類のタブを持ち、小分類ごとに
// 「使用量の入力」と「メーターの割り当て」を切り替えます。
// 設定と検針値は画面上で編集し、「保存」でまとめてSupabaseへ書き込みます。

const yen = new Intl.NumberFormat('ja-JP');
const amount = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
// 使用量は、小分類で決めた小数点以下の桁数で表示します。
const usageFormats = new Map<number, Intl.NumberFormat>();
const formatUsage = (value: number, digits: number) => {
  if (!usageFormats.has(digits)) usageFormats.set(digits, new Intl.NumberFormat('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  return usageFormats.get(digits)!.format(value);
};

// 使用量・金額の入力欄です。入力中以外はカンマ区切りで見せ、Enter で同じ表の下の行の入力欄へ移ります。
function NumberInput({ value, digits, group, onChange }: { value: number; digits: number; group: string; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const moveNext = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const inputs = [...document.querySelectorAll<HTMLInputElement>(`input[data-nav-input="${group}"]`)];
    const next = inputs[inputs.indexOf(event.currentTarget) + (event.shiftKey ? -1 : 1)];
    if (next) { next.focus(); next.select(); }
  };
  return <input
    data-nav-input={group} inputMode={digits ? 'decimal' : 'numeric'} className="meter-number-input"
    value={draft ?? formatUsage(value, digits)}
    onFocus={(event) => { setDraft(value ? String(value) : ''); const target = event.currentTarget; requestAnimationFrame(() => target.select()); }}
    onBlur={() => setDraft(null)}
    onKeyDown={moveNext}
    onChange={(event) => {
      // 全角数字やカンマ付きで入力されても数値として受け取ります。
      const text = event.target.value.replace(/[０-９．]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
      setDraft(text);
      const parsed = Number(text.replace(/,/g, ''));
      if (Number.isFinite(parsed)) onChange(parsed);
    }}
  />;
}
// 単価計算タブの入力欄です。未入力（空欄）を扱え、空欄のときは placeholder に自動で求めた値を出せます。
function OptionalNumberInput({ value, digits, placeholder, disabled, onChange }: { value: number | null; digits: number; placeholder?: string; disabled?: boolean; onChange: (value: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = value === null ? '' : new Intl.NumberFormat('ja-JP', { maximumFractionDigits: digits }).format(value);
  return <input
    inputMode={digits ? 'decimal' : 'numeric'} className="meter-number-input"
    value={draft ?? shown} placeholder={placeholder} disabled={disabled}
    onFocus={(event) => { setDraft(value === null ? '' : String(value)); const target = event.currentTarget; requestAnimationFrame(() => target.select()); }}
    onBlur={() => setDraft(null)}
    onChange={(event) => {
      const text = event.target.value.replace(/[０-９．]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
      setDraft(text);
      const trimmed = text.replace(/,/g, '').trim();
      if (!trimmed) { onChange(null); return; }
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) onChange(parsed);
    }}
  />;
}
const variablePriceMethods: VariablePriceMethod[] = ['manual', 'billed'];
const sumModes: SumMode[] = ['aggregate', 'perMeter'];
const roundingModes: RoundingMode[] = ['floor', 'ceil', 'round'];
const taxModes: TaxMode[] = ['exclusive', 'inclusive'];
const priceModes: PriceMode[] = ['fixed', 'variable'];
const unitLabel = (unit: UnitOption | undefined) => unit ? [unit.floor, unit.name || unit.code].filter(Boolean).join(' ') : '';
const shortDate = (value: string) => slashDate(value).replace(/^\d{4}\//, '');
const utilityKindOf: Record<CategoryId, string> = { electric: 'electricity', water: 'water', gas: 'gas' };
const patternMark = (index: number) => '①②③④⑤⑥⑦⑧⑨⑩'.charAt(index) || String(index + 1);
// 物件を読み込むまでの空の状態です。分類は読み込み時にDBの設定で置き換えます。
const emptyBuilding: BuildingConfig = { categories: [], subItems: [], surcharges: [], taxRate: 0.1 };
type PeriodPattern = { billing_period_pattern_id: string; pattern_name: string; start_month_offset: number; start_day_type: string; start_meter_day_offset: number; end_month_offset: number; end_day_type: string; end_meter_day_offset: number };

export function MeterReadingPage({ propertyId, period }: { propertyId: string; propertyName: string; period: BillingPeriod }) {
  const [building, setBuildingState] = useState<BuildingConfig>(emptyBuilding);
  const [tenants, setTenantsState] = useState<TenantConfig[]>([]);
  const [meters, setMetersState] = useState<AssetMeter[]>([]);
  // 物件の区画と、日ごとの入居状況です（読み込み時に決まり、画面では編集しません）。
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [occupancy, setOccupancy] = useState<Occupancy>(new Map());
  // 読み込んだ時点の内容です。保存時に「消えた行」を見つけるために使います。
  const [baseline, setBaseline] = useState<MeterReadingSnapshot | null>(null);
  const [status, setStatus] = useState<'draft' | 'confirmed'>('draft');
  // 確定済みの月は、そのとき保存した金額を表示します。
  const [confirmedAmounts, setConfirmedAmounts] = useState<ConfirmedAmount[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<string>('summary');
  const [subTab, setSubTab] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<'input' | 'assign' | 'price'>('input');
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [periodPatterns, setPeriodPatterns] = useState<PeriodPattern[]>([]);
  const [notice, setNotice] = useState('');
  // 検針日は月ごとの検針データに持たせ、前回検針日は前月の行から読みます。
  const [meterDate, setMeterDateState] = useState('');
  const [previousMeterDate, setPreviousMeterDate] = useState('');

  const calendarYear = period.fiscalYear + (period.month <= 3 ? 1 : 0);

  // 編集はすべてここを通し、未保存かどうかを覚えておきます。
  const setBuilding: typeof setBuildingState = (value) => { setBuildingState(value); setDirty(true); };
  const setTenants: typeof setTenantsState = (value) => { setTenantsState(value); setDirty(true); };
  const setMeters: typeof setMetersState = (value) => { setMetersState(value); setDirty(true); };
  const setMeterDate = (value: string) => { setMeterDateState(value); setDirty(true); };

  // 物件と対象月の検針データを読み込みます。
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!supabase || !propertyId) { setBaseline(null); setBuildingState(emptyBuilding); setTenantsState([]); setMetersState([]); setUnits([]); setOccupancy(new Map()); return; }
      setLoading(true);
      try {
        const snapshot = await loadMeterReading(supabase, propertyId, calendarYear, period.month);
        if (cancelled) return;
        setBaseline(snapshot);
        setBuildingState(snapshot.building);
        setTenantsState(snapshot.tenants);
        setMetersState(snapshot.meters);
        setUnits(snapshot.units);
        setOccupancy(snapshot.occupancy);
        setMeterDateState(snapshot.meterDate);
        setPreviousMeterDate(snapshot.previousMeterDate);
        setStatus(snapshot.status);
        // 初めて出てきたテナントなど、まだ保存していない契約行があれば未保存として保存を促します。
        const persistedIds = new Set(snapshot.persistedContractIds);
        setDirty(snapshot.status === 'draft' && snapshot.tenants.some((tenant) => tenant.rows.some((row) => !persistedIds.has(row.id))));
        setNotice('');
        const confirmed = snapshot.status === 'confirmed' ? await loadConfirmedAmounts(supabase, propertyId, calendarYear, period.month) : [];
        if (cancelled) return;
        setConfirmedAmounts(confirmed);
      } catch (error) {
        if (!cancelled) setNotice(error instanceof Error ? error.message : '検針データを読み込めませんでした');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [propertyId, calendarYear, period.month]);

  // 確定すると、そのときの使用量・単価・丸めごと金額を残し、画面は編集できなくなります。
  const confirm = async () => {
    if (!supabase || !propertyId || !baseline || dirty) return;
    setConfirming(true);
    try {
      const names = new Map(lineItems.map((row) => [row.id, row.name]));
      await confirmMeterReading(supabase, propertyId, calendarYear, period.month, { ...baseline, building, tenants, meters, meterDate, previousMeterDate, status: 'confirmed' }, results, names);
      setStatus('confirmed');
      setConfirmedAmounts(await loadConfirmedAmounts(supabase, propertyId, calendarYear, period.month));
      setNotice('この月の金額を確定しました。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '確定できませんでした');
    } finally {
      setConfirming(false);
    }
  };

  const release = async () => {
    if (!supabase || !propertyId) return;
    setConfirming(true);
    try {
      await releaseMeterReading(supabase, propertyId, calendarYear, period.month);
      setStatus('draft');
      setConfirmedAmounts([]);
      setNotice('確定を解除しました。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '確定を解除できませんでした');
    } finally {
      setConfirming(false);
    }
  };

  const save = async () => {
    if (!supabase || !propertyId || !baseline) return;
    setSaving(true);
    try {
      const snapshot: MeterReadingSnapshot = {
        ...baseline, building, tenants, meters, meterDate, previousMeterDate, status,
        persistedContractIds: tenants.flatMap((tenant) => tenant.rows.map((row) => row.id)),
        savedContracts: { ...baseline.savedContracts, ...Object.fromEntries(tenants.map((tenant) => [tenant.id, tenant.rows])) },
      };
      await saveMeterReading(supabase, propertyId, calendarYear, period.month, snapshot, baseline);
      setBaseline(snapshot);
      setDirty(false);
      setNotice('保存しました。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存できませんでした');
    } finally {
      setSaving(false);
    }
  };

  // 請求明細の項目は請求設定から読み込み、請求種別に公共料金が設定されているものだけを対象にします。
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!supabase || !propertyId) { setLineItems([]); setPeriodPatterns([]); return; }
      const patternResult = await supabase
        .from('asset_billing_period_pattern')
        .select('billing_period_pattern_id, pattern_name, start_month_offset, start_day_type, start_meter_day_offset, end_month_offset, end_day_type, end_meter_day_offset')
        .eq('asset_id', propertyId).order('sort_order');
      if (!cancelled) setPeriodPatterns((patternResult.data ?? []) as PeriodPattern[]);
      const { data, error } = await supabase
        .from('asset_billing_line_item')
        .select('asset_billing_line_item_id, line_item_name, display_name, charge:billing_charge_type!inner(charge_type_name, utility_kind)')
        .eq('asset_id', propertyId).eq('is_active', true).not('charge.utility_kind', 'is', null)
        .order('sort_order');
      if (cancelled) return;
      if (error) { setNotice(`請求明細の項目を読み込めませんでした: ${error.message}`); setLineItems([]); return; }
      const rows = (data ?? []) as unknown as Array<{ asset_billing_line_item_id: string; line_item_name: string; display_name: string | null; charge: { charge_type_name: string; utility_kind: string | null } | Array<{ charge_type_name: string; utility_kind: string | null }> | null }>;
      setNotice('');
      setLineItems(rows.map((row) => {
        const charge = Array.isArray(row.charge) ? row.charge[0] : row.charge;
        return { id: row.asset_billing_line_item_id, name: row.display_name || row.line_item_name, utilityKind: charge?.utility_kind ?? null, chargeTypeName: charge?.charge_type_name ?? '' };
      }));
    };
    void load();
    return () => { cancelled = true; };
  }, [propertyId]);

  // メーターを区間ごとに区画の入居テナントへ振り分け、基本料を日割りして計算します。
  // 増額分は、仕入の請求金額を入れた月は増額分タブで算出した単価で計算します。
  const calculated = useMemo(() => computeMonth({ building, tenants, meters, meterDate, previousMeterDate, occupancy, savedContracts: baseline?.savedContracts, invoiceSplitTenantIds: baseline?.invoiceSplitTenantIds }, calendarYear, period.month),
    [building, meters, tenants, meterDate, previousMeterDate, occupancy, baseline, calendarYear, period.month]);
  const results = calculated.results;
  const readingPeriodText = `${slashDate(calculated.period.start)}～${slashDate(calculated.period.end)}`;
  const billingFirst = monthFirst(calendarYear, period.month);
  // 中間検針の区切りで一覧に居ないテナント（期間中に退去・入居したテナント）が出てきたら、一覧に加えます。
  useEffect(() => {
    if (calculated.tenants.length > tenants.length) setTenants(calculated.tenants);
  }, [calculated.tenants, tenants.length]);
  const allocationByMeter = new Map(calculated.allocations.map((row) => [row.meter.id, row]));
  // 区間ごとの MeterShare から、元のメーターと区間を引けるようにします。
  const segmentOfShare = (share: MeterShare): { meter: AssetMeter; segment: AllocatedSegment; index: number } | null => {
    const allocation = allocationByMeter.get(share.meterId ?? share.id);
    if (!allocation) return null;
    const index = share.id.includes('#') ? Number(share.id.split('#')[1]) : 0;
    return { meter: allocation.meter, segment: allocation.segments[index], index };
  };
  const unitById = new Map(units.map((row) => [row.id, row]));
  const blockingProblems = calculated.allocations.filter((row) => row.problems.length);
  // 確定額は契約行を参照するため、まだ保存していない契約行（初めて出てきたテナントなど）があるうちは確定できません。
  const persisted = new Set(baseline?.persistedContractIds ?? []);
  const unsavedRows = tenants.some((tenant) => tenant.rows.some((row) => !persisted.has(row.id)));
  const grandTotal = results.reduce((sum, result) => sum + result.total, 0);
  const grandExpected = results.reduce((sum, result) => sum + result.tenant.expected, 0);
  // 元表との突き合わせ列は、期待値を持つサンプルデータのときだけ出します。
  const showExpected = results.some((result) => result.tenant.expected);
  // 確定済みの月は、計算し直した金額ではなく確定時に保存した金額を請求へ渡します。
  const confirmedByTenant = new Map<string, Map<string, number>>();
  for (const row of confirmedAmounts) {
    if (!row.lineItemId) continue;
    const own = confirmedByTenant.get(row.tenantId) ?? new Map<string, number>();
    own.set(row.lineItemId, (own.get(row.lineItemId) ?? 0) + row.amount);
    confirmedByTenant.set(row.tenantId, own);
  }
  const lineItemAmounts = (tenantId: string) => status === 'confirmed'
    ? confirmedByTenant.get(tenantId) ?? new Map<string, number>()
    : results.find((result) => result.tenant.id === tenantId)?.byLineItem ?? new Map<string, number>();
  const visibleCategories = building.categories.filter((category) => category.billable);
  const customSubItems = building.subItems.filter((row) => row.kind === 'custom');
  const billableSurcharges = building.surcharges.filter((row) => row.billable);
  // 設定値は「残す桁数」ですが、選ぶときはどの桁を処理するかで示します。
  // 例：小数第1位まで残す＝小数第2位以下を処理する。
  const digitOptions = [0, 1, 2, 3].map((digits) => <option key={digits} value={digits}>{`小数第${digits + 1}位以下`}</option>);
  const displayDigitOptions = [0, 1, 2, 3].map((digits) => <option key={digits} value={digits}>{digits ? `小数第${digits}位まで` : '整数'}</option>);
  const roundingOptions = roundingModes.map((row) => <option key={row} value={row}>{roundingModeLabel[row]}</option>);
  const lineItemsFor = (categoryId: CategoryId) => lineItems.filter((row) => row.utilityKind === utilityKindOf[categoryId]);
  // 分類ごとの色分けです。電気は黄、水道は青、ガスは赤にします。
  const categoryClass = (id: CategoryId) => `meter-cat-${id}`;
  const rowLabel = (tenant: TenantConfig, index: number) => tenant.rows.length > 1 ? `${tenant.name}（${splitName(tenant.rows[index], index)}）` : tenant.name;
  // 使用量の入力は、メーターの並び順（検針表と同じ順）でテナントの行ごとにまとめます。
  // 中間検針のあるメーターは、区間ごとに請求先のテナントの行へ並べます。
  // 区画が未割当のメーター・空室の区間は、階ごとに「未割当」「空室」として並べます（請求しません）。
  // 階数とテナント使用料合計は、続けて並ぶ行をまとめて1つの欄にします。
  const usageTable = (target: SubItem, targetCategory: Category) => {
    const groups: Array<{ key: string; tenantId: string; rowIndex: number; vacancy: '' | 'vacant' | 'unassigned'; meters: MeterShare[] }> = [];
    for (const share of calculated.shares.filter((row) => row.subItemId === target.id)) {
      const assigned = tenants.some((tenant) => tenant.id === share.tenantId && tenant.rows[share.rowIndex]);
      const vacancy = assigned ? '' : segmentOfShare(share)?.segment.unitId ? 'vacant' : 'unassigned';
      const key = assigned ? `${share.tenantId}:${share.rowIndex}` : `${vacancy}:${share.label}`;
      const found = groups.find((group) => group.key === key);
      if (found) found.meters.push(share);
      else groups.push({ key, tenantId: assigned ? share.tenantId : '', rowIndex: assigned ? share.rowIndex : 0, vacancy, meters: [share] });
    }
    const rows = groups.map((group) => {
      const tenant = tenants.find((item) => item.id === group.tenantId);
      const row = tenant?.rows[group.rowIndex];
      const result = tenant && row ? calculateSubItem(target, targetCategory, row, tenant.id, group.rowIndex, calculated.shares, building.taxRate) : null;
      // 単価は、メーターの割り当てで上書きした単価、契約行の単価、小分類の既定単価の順で決めます。
      // 変動単価は、単価計算タブで決めたその月の単価を全メーター共通で出します。
      const priceOf = (meter: MeterShare) => !row ? null
        : target.priceMode === 'variable' ? variableUnitPrice(target, building.taxRate)
          : meter.unitPrice ?? row.unitPrices[target.id] ?? target.defaultUnitPrice ?? 0;
      // 使用料は、メーターごとに計算する行はメーターの行ごとに、まとめて計算する行は分割した行の合計を1つの欄に出します。
      // どちらも請求に使う計算結果（使用量の丸め・金額の丸めを通したもの）をそのまま出します。
      const perMeter = row?.sumMode[targetCategory.id] === 'perMeter';
      // 区間に分かれたメーターは、メーターごとの使用料をグループ内の最初の区間の行にだけ出します。
      const amountOf = (meter: MeterShare) => group.meters.find((item) => (item.meterId ?? item.id) === (meter.meterId ?? meter.id)) !== meter ? null
        : result?.groups.find((value) => value.key === (meter.meterId ?? meter.id))?.amount ?? null;
      return {
        ...group, result, priceOf, amountOf, perMeter,
        floor: [...new Set(group.meters.map((item) => item.label).filter(Boolean))].join('・'),
        name: tenant ? rowLabel(tenant, group.rowIndex) : '',
        floorSpan: 0, tenantSpan: 0, tenantTotal: null as number | null,
      };
    });
    rows.forEach((row, index) => {
      if (index === 0 || rows[index - 1].floor !== row.floor) {
        let end = index;
        while (end < rows.length && rows[end].floor === row.floor) end += 1;
        row.floorSpan = rows.slice(index, end).reduce((sum, item) => sum + item.meters.length, 0);
      }
      if (index === 0 || !row.tenantId || rows[index - 1].tenantId !== row.tenantId) {
        let end = index + 1;
        while (row.tenantId && end < rows.length && rows[end].tenantId === row.tenantId) end += 1;
        const run = rows.slice(index, end);
        row.tenantSpan = run.reduce((sum, item) => sum + item.meters.length, 0);
        row.tenantTotal = row.tenantId ? run.reduce((sum, item) => sum + (item.result?.amount ?? 0), 0) : null;
      }
    });
    return rows;
  };

  const updateMeter = (id: string, patch: Partial<AssetMeter>) => setMeters((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const updateCategory = (id: string, patch: Partial<Category>) => setBuilding((current) => ({ ...current, categories: current.categories.map((row) => row.id === id ? { ...row, ...patch } : row) }));
  const updateSubItem = (id: string, patch: Partial<SubItem>) => setBuilding((current) => ({ ...current, subItems: current.subItems.map((row) => row.id === id ? { ...row, ...patch } : row) }));
  const updateMonthly = (target: SubItem, patch: Partial<VariablePriceInput>) => updateSubItem(target.id, { monthly: { ...target.monthly, ...patch } });
  const updateRow = (tenantId: string, index: number, patch: Partial<ContractRow>) => setTenants((current) => current.map((tenant) => tenant.id === tenantId
    ? { ...tenant, rows: tenant.rows.map((row, position) => position === index ? { ...row, ...patch } : row) } : tenant));
  const updateTenant = (id: string, patch: Partial<TenantConfig>) => setTenants((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const setSplitCount = (tenant: TenantConfig, count: number) => {
    const next = Math.max(1, Math.min(9, count));
    // 行を減らしたときは、消えた行の区画は1行目で計算します（どの行にも無い区画は1行目の扱いのため）。
    const rows = Array.from({ length: next }, (_, index) => tenant.rows[index] ?? { ...tenant.rows[0], id: newId(), invoiceNo: index + 1, fixedCharges: {}, splitLabel: '', unitIds: [] });
    updateTenant(tenant.id, { rows });
  };
  // 分割行の区画です。1つの区画は1つの行にだけ持たせます。
  const toggleRowUnit = (tenant: TenantConfig, index: number, unitId: string, checked: boolean) => updateTenant(tenant.id, {
    rows: tenant.rows.map((row, position) => ({
      ...row,
      unitIds: position === index
        ? checked ? [...new Set([...row.unitIds, unitId])] : row.unitIds.filter((id) => id !== unitId)
        : checked ? row.unitIds.filter((id) => id !== unitId) : row.unitIds,
    })),
  });
  // テナントが検針期間の前後に借りている貸室です（分割行の区画の選択肢）。
  const tenantUnits = (tenantId: string) => {
    const found = new Set<string>();
    for (const day of occupancy.values()) for (const [unitId, occupant] of day) if (occupant.tenantId === tenantId) found.add(unitId);
    return units.filter((row) => found.has(row.id));
  };
  const addSubItem = (categoryId: CategoryId) => {
    const id = newId();
    setBuilding((current) => ({ ...current, subItems: [...current.subItems, { id, categoryId, name: '新しい小分類', kind: 'custom', lineItemId: '', priceMode: 'fixed', defaultUnitPrice: null, periodPatternId: '', taxMode: 'exclusive', taxRoundingMode: 'floor', usageRoundingDigits: 1, usageDisplayDigits: 1, usageRoundingMode: 'round', ...subItemDefaults() }] }));
    setTenants((current) => current.map((tenant) => ({ ...tenant, rows: tenant.rows.map((row) => ({ ...row, billable: { ...row.billable, [id]: true }, unitPrices: { ...row.unitPrices, [id]: null } })) })));
  };
  // 小分類を消すと、保存したときに配下のメーターと過去月の検針値もまとめて消えます。
  const removeSubItem = (id: string) => {
    const target = building.subItems.find((row) => row.id === id);
    const own = meters.filter((row) => row.subItemId === id).length;
    if (!window.confirm(`小分類「${target?.name ?? ''}」を削除します。保存すると、この小分類のメーター${own}件と、過去の月を含むすべての検針値も消えます。よろしいですか。`)) return;
    setBuilding((current) => ({ ...current, subItems: current.subItems.filter((row) => row.id !== id) }));
    setMeters((current) => current.filter((row) => row.subItemId !== id));
  };
  const addMeter = (subItemId: string) => setMeters((current) => [...current, {
    id: newId(), subItemId, code: '', label: '', assignments: [], usage: 0,
    previousReading: null, currentReading: null, previousReadingManual: false, exchange: null, breaks: [],
  }]);
  // 区画を選び直すと、対象月の1日からその区画にします（それより前の月は元の区画のまま）。
  const assignUnit = (meter: AssetMeter, unitId: string) => {
    const unit = unitById.get(unitId);
    // 保存済みの区画が無いメーター（新しく追加した・未割当だった）は、選び直しても履歴を分けず当初からその区画にします。
    const saved = baseline?.meters.find((row) => row.id === meter.id)?.assignments ?? [];
    const assignments = saved.length ? reassignUnit(meter.assignments, unitId, billingFirst, newId)
      : unitId ? [{ id: meter.assignments[0]?.id ?? newId(), unitId, from: ORIGIN_DATE, to: null }] : [];
    updateMeter(meter.id, { assignments, ...(unit && !meter.label ? { label: floorLabel(unit.floor) } : {}) });
  };
  const updateBreak = (meter: AssetMeter, index: number, patch: Partial<MeterBreak>) => updateMeter(meter.id, { breaks: meter.breaks.map((row, position) => position === index ? { ...row, ...patch } : row) });
  const addBreak = (meter: AssetMeter, date = '') => updateMeter(meter.id, { breaks: [...meter.breaks, { date, reading: null, usage: null }] });
  const removeBreak = (meter: AssetMeter, index: number) => updateMeter(meter.id, { breaks: meter.breaks.filter((_, position) => position !== index) });
  const removeMeter = (id: string) => {
    const target = meters.find((row) => row.id === id);
    if (!window.confirm(`メーター「${target?.code || '番号なし'}」を削除します。保存すると、過去の月を含むこのメーターの検針値も消えます。よろしいですか。`)) return;
    setMeters((current) => current.filter((row) => row.id !== id));
  };

  // 区画の入居テナントです（請求月の1日時点）。
  const occupantName = (unitId: string, date = billingFirst) => unitId ? occupancy.get(date)?.get(unitId)?.tenantName ?? '' : '';

  const category = visibleCategories.find((row) => row.id === tab);
  const categorySubItems = category ? building.subItems.filter((row) => row.categoryId === category.id && (row.kind !== 'basic' || category.fixedBillable)) : [];
  const categorySurcharges = category ? billableSurcharges.filter((row) => row.categoryId === category.id) : [];
  // 分類を開いたときは最初の小分類を出します。選んでいた小分類が消えた場合も最初に戻します。
  const storedSubTab = category ? subTab[category.id] : undefined;
  const currentSubTab = storedSubTab && (storedSubTab === 'surcharge' ? categorySurcharges.length > 0 : categorySubItems.some((row) => row.id === storedSubTab))
    ? storedSubTab : categorySubItems[0]?.id ?? (categorySurcharges.length ? 'surcharge' : '');
  const subItem = categorySubItems.find((row) => row.id === currentSubTab);
  // 選んでいる小分類の請求期間です。小分類の設定で選んだ請求期間パターンから、検針日をもとに求めます。
  // 増額分タブでは、増額分で選んだ既定の請求期間を出します。
  const tabPatternId = subItem ? subItem.periodPatternId : currentSubTab === 'surcharge' ? categorySurcharges[0]?.periodPatternId ?? '' : null;
  const subItemPattern = tabPatternId ? periodPatterns.find((row) => row.billing_period_pattern_id === tabPatternId) : undefined;
  const subItemRange = subItemPattern ? periodRange(calendarYear, period.month, subItemPattern, { current: meterDate, previous: previousMeterDate }) : null;
  const updatePurchase = (id: string, patch: Partial<SurchargePurchase>) => setBuilding((current) => ({ ...current, surcharges: current.surcharges.map((row) => row.id === id ? { ...row, purchase: { ...row.purchase, ...patch } } : row) }));
  // 単価計算タブは変動単価の小分類だけにあるため、ほかの小分類では使用量の入力に戻します。
  const currentMode = mode === 'price' && subItem?.priceMode !== 'variable' ? 'input' : mode;

  return <section className="meter-page">
    <header className="meter-page-heading">
      <div><p className="section-kicker">METER</p><h2>検針データ</h2></div>
      <div className="meter-date-fields">
        <label className="meter-date"><span>検針日</span><input type="date" value={meterDate} onChange={(event) => setMeterDate(event.target.value)} /></label>
        <span className="meter-date-previous">前回検針日<b>{previousMeterDate ? previousMeterDate.replace(/-/g, '/') : '前月の検針データなし'}</b></span>
        <span className="meter-date-previous">検針期間<b>{readingPeriodText}</b></span>
        {status === 'draft'
          ? <>
            <button type="button" className="meter-save" disabled={!dirty || saving || loading || !baseline} onClick={() => void save()}>{saving ? '保存中…' : dirty ? '保存' : '保存済み'}</button>
            <button type="button" className="meter-confirm" disabled={dirty || confirming || loading || !baseline || !tenants.length || blockingProblems.length > 0 || unsavedRows} title={blockingProblems.length ? '検針値の入力に不備があるため確定できません' : unsavedRows ? 'まだ保存していないテナントの設定があります。保存してから確定してください' : undefined} onClick={() => void confirm()}>{confirming ? '確定中…' : '確定'}</button>
          </>
          : <>
            <span className="meter-confirmed-mark">確定済み</span>
            <button type="button" className="meter-release" disabled={confirming || loading} onClick={() => void release()}>確定を解除</button>
          </>}
      </div>
    </header>

    {notice && <p className="tenant-billing-notice">{notice}</p>}
    {loading && <p className="tenant-billing-notice">検針データを読み込んでいます…</p>}
    {!loading && baseline && !tenants.length && <p className="tenant-billing-notice">対象月に契約中のテナントがありません。</p>}

    {status === 'confirmed' && <p className="tenant-billing-notice">この月は確定済みです。編集するには確定を解除してください。</p>}
    {status === 'draft' && blockingProblems.length > 0 && <div className="tenant-billing-notice meter-problem-list">
      <b>検針値の入力に不備があるため確定できません。</b>
      <ul>{blockingProblems.map((row) => <li key={row.meter.id}>{building.subItems.find((item) => item.id === row.meter.subItemId)?.name ?? ''}　メーター「{row.meter.code || '番号なし'}」：{row.problems.join('／')}</li>)}</ul>
    </div>}

    <nav className="meter-tabs">
      <button type="button" className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>集計</button>
      {visibleCategories.map((row) => <button key={row.id} type="button" className={tab === row.id ? 'active' : ''} onClick={() => setTab(row.id)}>{row.name}</button>)}
      <button type="button" className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>設定</button>
    </nav>

    <fieldset className="meter-lock" disabled={status === 'confirmed'}>
    {tab === 'summary' && <div className="meter-panel">
      {billableSurcharges.length > 0 && <div className="meter-month-rates">
        {billableSurcharges.map((row) => {
          const price = calculated.building.surcharges.find((item) => item.id === row.id)?.unitPrice ?? 0;
          const parent = building.categories.find((item) => item.id === row.categoryId);
          return <label key={row.id}>
            {row.name}の単価
            <b>{price}</b>
            <span>円／{parent?.unit ?? ''}（税抜）{row.purchase.amountInclusive === null ? `　${parent?.name ?? ''}タブの「増額分」で仕入を入力すると算出します` : '　増額分タブで算出'}</span>
          </label>;
        })}
      </div>}
      <div className="meter-table-wrap">
        <table className="meter-table">
          <thead><tr><th className="meter-col-name">テナント</th>{visibleCategories.map((row) => <th key={row.id}>{row.name}</th>)}{billableSurcharges.map((row) => <th key={row.id}>{row.name}</th>)}<th>請求合計</th>{showExpected ? <><th>元表</th><th>差</th></> : null}</tr></thead>
          <tbody>{results.flatMap((result) => [
            <tr key={result.tenant.id}>
              <td className="meter-col-name"><strong>{result.tenant.name}</strong>{result.tenant.splitEnabled ? <small>{result.tenant.rows.length} 分割</small> : null}</td>
              {visibleCategories.map((row) => <td key={row.id} className="numeric">{yen.format(result.rows.reduce((sum, item) => sum + (item.categories.find((value) => value.category.id === row.id)?.amount ?? 0), 0))}</td>)}
              {billableSurcharges.map((row) => <td key={row.id} className="numeric">{yen.format(result.rows.reduce((sum, item) => sum + (item.surcharges.find((value) => value.surcharge.id === row.id)?.amount ?? 0), 0))}</td>)}
              <td className="numeric meter-total">{yen.format(result.total)}</td>
              {showExpected ? <>
                <td className="numeric meter-muted">{yen.format(result.tenant.expected)}</td>
                <td className={result.difference === 0 ? 'numeric meter-ok' : 'numeric meter-warn'}>{result.difference === 0 ? '一致' : yen.format(result.difference)}</td>
              </> : null}
            </tr>,
            ...(result.tenant.splitEnabled ? result.rows.map((row) => <tr key={`${result.tenant.id}-${row.index}`} className="meter-split-row">
              <td className="meter-col-name">{splitName(row.row, row.index)}{result.tenant.invoiceSplitByUnit ? <small>請求書 {row.row.invoiceNo}</small> : null}</td>
              {visibleCategories.map((item) => <td key={item.id} className="numeric">{yen.format(row.categories.find((value) => value.category.id === item.id)?.amount ?? 0)}</td>)}
              {billableSurcharges.map((item) => <td key={item.id} className="numeric">{yen.format(row.surcharges.find((value) => value.surcharge.id === item.id)?.amount ?? 0)}</td>)}
              <td className="numeric">{yen.format(row.total)}</td>
              {showExpected ? <><td /><td /></> : null}
            </tr>) : []),
          ])}</tbody>
          <tfoot><tr>
            <td className="meter-col-name">合計</td>
            {visibleCategories.map((row) => <td key={row.id} className="numeric">{yen.format(results.reduce((sum, result) => sum + result.rows.reduce((value, item) => value + (item.categories.find((target) => target.category.id === row.id)?.amount ?? 0), 0), 0))}</td>)}
            {billableSurcharges.map((row) => <td key={row.id} className="numeric">{yen.format(results.reduce((sum, result) => sum + result.rows.reduce((value, item) => value + (item.surcharges.find((target) => target.surcharge.id === row.id)?.amount ?? 0), 0), 0))}</td>)}
            <td className="numeric meter-total">{yen.format(grandTotal)}</td>
            {showExpected ? <>
              <td className="numeric meter-muted">{yen.format(grandExpected)}</td>
              <td className={grandTotal === grandExpected ? 'numeric meter-ok' : 'numeric meter-warn'}>{grandTotal === grandExpected ? '一致' : yen.format(grandTotal - grandExpected)}</td>
            </> : null}
          </tr></tfoot>
        </table>
      </div>

      <div className="meter-settings-block">
        <div className="meter-settings-heading"><h4>請求明細の項目別</h4><p>小分類に紐づけた明細項目ごとの金額です。この単位で請求書作成へ渡します。{status === 'confirmed' ? 'この月は確定済みのため、確定したときの金額を表示しています。' : ''}</p></div>
        <div className="meter-table-wrap">
          <table className="meter-table">
            <thead><tr><th className="meter-col-name">テナント</th>{lineItems.length ? lineItems.map((row) => <th key={row.id}>{row.name}</th>) : <th>明細項目が未登録です</th>}</tr></thead>
            <tbody>{results.map((result) => {
              const amounts = lineItemAmounts(result.tenant.id);
              return <tr key={result.tenant.id}>
                <td className="meter-col-name">{result.tenant.name}</td>
                {lineItems.length ? lineItems.map((row) => <td key={row.id} className="numeric">{amounts.get(row.id) ? yen.format(amounts.get(row.id) ?? 0) : <span className="meter-muted">—</span>}</td>) : <td className="meter-muted">請求設定で公共料金の明細項目を登録してください。</td>}
              </tr>;
            })}</tbody>
          </table>
        </div>
      </div>
    </div>}

    {category && <div className="meter-panel">
      <div className="meter-panel-bar">
        <nav className="meter-subtabs">
          {categorySubItems.map((row) => <button key={row.id} type="button" className={currentSubTab === row.id ? 'active' : ''} onClick={() => setSubTab({ ...subTab, [category.id]: row.id })}>{row.name}</button>)}
          {categorySurcharges.length > 0 && <button type="button" className={currentSubTab === 'surcharge' ? 'active' : ''} onClick={() => setSubTab({ ...subTab, [category.id]: 'surcharge' })}>増額分</button>}
          {tabPatternId !== null && <span className="meter-subtab-period">
            <b>請求期間</b>
            {!subItemPattern ? <span className="meter-muted">未設定（設定タブで選んでください）</span>
              : subItemRange?.start && subItemRange.end ? `${subItemRange.start}～${subItemRange.end}`
                : <span className="meter-muted">検針日と前回検針日（前月の検針データ）が揃うと表示します</span>}
          </span>}
        </nav>
        {subItem && subItem.kind === 'custom' && <div className="meter-switch">
          <button type="button" className={currentMode === 'input' ? 'active' : ''} onClick={() => setMode('input')}>使用量の入力</button>
          {subItem.priceMode === 'variable' && <button type="button" className={currentMode === 'price' ? 'active' : ''} onClick={() => setMode('price')}>単価計算</button>}
          <button type="button" className={currentMode === 'assign' ? 'active' : ''} onClick={() => setMode('assign')}>メーターの割り当て</button>
        </div>}
      </div>

      {subItem && subItem.kind === 'custom' && currentMode === 'price' && (() => {
        const billed = billedAmounts(subItem.monthly, building.taxRate);
        const inclusiveOnly = subItem.taxMode === 'inclusive';
        const price = variableUnitPrice(subItem, building.taxRate);
        const yenText = (value: number | null) => value === null ? '' : yen.format(value);
        return <div className="meter-price-calc">
          <div className="meter-settings-heading"><h4>{subItem.name}の単価計算</h4><p>この月の単価を決めます。決めた単価は、この小分類の全メーターに使います。</p></div>
          <div className="meter-price-method">
            {variablePriceMethods.map((value) => <label key={value} className="meter-check">
              <input type="radio" name={`price-method-${subItem.id}`} checked={subItem.variablePriceMethod === value} onChange={() => updateSubItem(subItem.id, { variablePriceMethod: value })} />{variablePriceMethodLabel[value]}
            </label>)}
          </div>
          {subItem.variablePriceMethod === 'manual'
            ? <div className="meter-price-grid">
              <span>単価</span>
              <span><OptionalNumberInput value={subItem.monthly.unitPrice} digits={4} placeholder="未入力" onChange={(unitPrice) => updateMonthly(subItem, { unitPrice })} /><span className="meter-unit">円／{category.unit}（{taxModeLabel[subItem.taxMode]}）</span></span>
            </div>
            : <div className="meter-price-grid">
              <span>税込請求額</span>
              <span><OptionalNumberInput value={subItem.monthly.billedInclusive} digits={0} disabled={!inclusiveOnly && billed.exclusiveEntered} placeholder="—" onChange={(billedInclusive) => updateMonthly(subItem, { billedInclusive })} /><span className="meter-unit">円</span></span>
              {!inclusiveOnly && <>
                <span>消費税</span>
                <span><OptionalNumberInput value={subItem.monthly.billedTax} digits={0} disabled={billed.exclusiveEntered} placeholder={billed.exclusiveEntered ? '—' : yenText(billed.tax) || '—'} onChange={(billedTax) => updateMonthly(subItem, { billedTax })} /><span className="meter-unit">円{!billed.exclusiveEntered && subItem.monthly.billedTax === null && billed.tax !== null ? '（税込から10%割り戻し）' : ''}</span></span>
                <span>税抜請求額</span>
                <span><OptionalNumberInput value={subItem.monthly.billedExclusive} digits={0} placeholder={yenText(billed.exclusive) || '—'} onChange={(billedExclusive) => updateMonthly(subItem, { billedExclusive })} /><span className="meter-unit">円{billed.exclusiveEntered ? '（手入力。消すと税込・消費税から計算します）' : billed.exclusive !== null ? '（税込−消費税）' : ''}</span></span>
              </>}
              <span>使用量</span>
              <span><OptionalNumberInput value={subItem.monthly.billedUsage} digits={3} placeholder="—" onChange={(billedUsage) => updateMonthly(subItem, { billedUsage })} /><span className="meter-unit">{category.unit}</span></span>
              <span>単価</span>
              <span className="meter-price-result">
                <b>{price === null ? '—' : `${price} 円／${category.unit}`}</b>
                <small>{inclusiveOnly ? '税込請求額' : '税抜請求額'} ÷ 使用量</small>
                <select value={subItem.unitPriceRoundingDigits} onChange={(event) => updateSubItem(subItem.id, { unitPriceRoundingDigits: Number(event.target.value) })}>{digitOptions}</select>
                <select value={subItem.unitPriceRoundingMode} onChange={(event) => updateSubItem(subItem.id, { unitPriceRoundingMode: event.target.value as RoundingMode })}>{roundingOptions}</select>
              </span>
            </div>}
          {inclusiveOnly && price !== null && <p className="meter-hint">税込単価のため、使用料の計算では税抜単価 {toExclusive(price, subItem, building.taxRate)} 円（税抜換算の丸め：{roundingModeLabel[subItem.taxRoundingMode]}）を使います。</p>}
        </div>;
      })()}

      {currentSubTab === 'surcharge' && categorySurcharges.map((surcharge) => {
        const calc = calculated.calculations.get(surcharge.id);
        const unitPrice = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 4 });
        const unit = category.unit;
        return <div key={surcharge.id} className="meter-price-calc">
          <div className="meter-settings-heading"><h4>{surcharge.name}</h4><p>仕入（電力会社などからの請求）と、テナントからの回収額の差から増額分の単価を求めます。算出した税抜単価を、各テナントの{surcharge.name}に使います。</p></div>
          <h5 className="meter-price-section">仕入</h5>
          <div className="meter-price-grid">
            <span>期間</span>
            <span className="meter-price-period">
              <input type="date" value={surcharge.purchase.periodStart} onChange={(event) => updatePurchase(surcharge.id, { periodStart: event.target.value })} />～
              <input type="date" value={surcharge.purchase.periodEnd} onChange={(event) => updatePurchase(surcharge.id, { periodEnd: event.target.value })} />
            </span>
            <span>請求金額（税込）</span>
            <span><OptionalNumberInput value={surcharge.purchase.amountInclusive} digits={0} placeholder="—" onChange={(amountInclusive) => updatePurchase(surcharge.id, { amountInclusive })} /><span className="meter-unit">円</span></span>
            <span>使用量</span>
            <span><OptionalNumberInput value={surcharge.purchase.usage} digits={3} placeholder="—" onChange={(usage) => updatePurchase(surcharge.id, { usage })} /><span className="meter-unit">{unit}</span></span>
          </div>
          <h5 className="meter-price-section">回収</h5>
          <div className="meter-price-grid">
            <span>使用量計</span><span className="numeric">{amount.format(calc?.recoveredUsage ?? 0)} {unit}</span>
            <span>{category.name}計</span><span className="numeric">{yen.format(calc?.recoveredAmount ?? 0)} 円<small className="meter-price-note">（税抜）</small></span>
            <span>税込{category.name}代</span><span className="numeric">{yen.format(calc?.recoveredInclusive ?? 0)} 円<small className="meter-price-note">（{category.name}計×1.1、四捨五入）</small></span>
          </div>
          <h5 className="meter-price-section">増額分</h5>
          <div className="meter-price-grid">
            <span>差額</span><span className="numeric">{calc?.difference === null || calc?.difference === undefined ? '—' : `${yen.format(calc.difference)} 円`}<small className="meter-price-note">（税込仕入額−税込回収額{calc && calc.difference !== null && calc.difference < 0 ? '。マイナスのため増額分は0円' : ''}）</small></span>
            <span>税込単価</span><span className="numeric">{calc?.inclusiveUnitPrice === null || calc?.inclusiveUnitPrice === undefined ? '—' : `${unitPrice.format(calc.inclusiveUnitPrice)} 円／${unit}`}<small className="meter-price-note">（差額÷使用量計）</small></span>
            <span>税抜単価</span><span className="meter-price-result"><b>{calc?.exclusiveUnitPrice === null || calc?.exclusiveUnitPrice === undefined ? '—' : `${calc.exclusiveUnitPrice.toFixed(2)} 円／${unit}`}</b><small>税込単価÷1.1、小数第3位以下切り上げ</small></span>
          </div>
          {surcharge.purchase.amountInclusive !== null && !calc?.recoveredUsage && <p className="meter-hint">使用量計が0のため、単価を算出できません。{category.name}の使用量を入力してください。</p>}
        </div>;
      })}

      {subItem && subItem.kind === 'basic' && (() => {
        // 請求額は計算結果（検針期間の途中で入居・退去したテナントは日割り）をそのまま出します。
        const billedOf = (tenantId: string, index: number) => results.find((result) => result.tenant.id === tenantId)?.rows[index]
          ?.categories.find((item) => item.category.id === category.id)?.subItems.find((item) => item.subItem.id === subItem.id)?.amount ?? 0;
        return <div className="meter-table-wrap">
          <table className="meter-table">
            <thead><tr><th className="meter-col-name">テナント</th><th>{subItem.name}（円／月）</th><th>入居日数<small>検針期間 {readingPeriodText}</small></th><th>請求額</th></tr></thead>
            <tbody>{tenants.flatMap((tenant) => tenant.rows.map((row, index) => {
              const ratio = calculated.ratios.get(row.id);
              const partial = ratio && ratio.days < ratio.totalDays;
              return <tr key={row.id}>
                <td className="meter-col-name">{rowLabel(tenant, index)}</td>
                <td>{row.billable[subItem.id]
                  ? <NumberInput group="basic" value={row.fixedCharges[subItem.id] ?? 0} digits={0} onChange={(value) => updateRow(tenant.id, index, { fixedCharges: { ...row.fixedCharges, [subItem.id]: value } })} />
                  : <span className="meter-muted">請求しない</span>}</td>
                <td className={partial ? 'numeric meter-warn' : 'numeric meter-muted'}>{ratio ? `${ratio.days}／${ratio.totalDays}日${partial ? '（日割り）' : ''}` : '—'}</td>
                <td className="numeric">{row.billable[subItem.id] ? yen.format(billedOf(tenant.id, index)) : ''}</td>
              </tr>;
            }))}</tbody>
            <tfoot><tr>
              <td className="meter-col-name">合計</td>
              <td className="numeric">{yen.format(tenants.reduce((sum, tenant) => sum + tenant.rows.reduce((value, row) => value + (row.billable[subItem.id] ? row.fixedCharges[subItem.id] ?? 0 : 0), 0), 0))}</td>
              <td />
              <td className="numeric meter-total">{yen.format(tenants.reduce((sum, tenant) => sum + tenant.rows.reduce((value, row, index) => value + (row.billable[subItem.id] ? billedOf(tenant.id, index) : 0), 0), 0))}</td>
            </tr></tfoot>
          </table>
          <p className="meter-hint">検針期間の途中で入居・退去したテナントは、入居日数で日割りします（小数点以下はテナントの「小数点」の設定で処理します）。</p>
        </div>;
      })()}

      {subItem && subItem.kind === 'custom' && currentMode === 'input' && (() => {
        const unit = category.unit;
        const usageRows = usageTable(subItem, category);
        const allShares = usageRows.flatMap((group) => group.meters);
        const totalUsageAll = allShares.reduce((sum, item) => sum + item.usage, 0);
        const vacantUsage = usageRows.filter((group) => group.vacancy).reduce((sum, group) => sum + group.meters.reduce((value, item) => value + item.usage, 0), 0);
        const totalAmount = usageRows.reduce((sum, group) => sum + (group.result?.amount ?? 0), 0);
        const totalGroupUsage = usageRows.reduce((sum, group) => sum + (group.result?.usage ?? 0), 0);
        const subMeters = meters.filter((row) => row.subItemId === subItem.id);
        const detailMeters = subMeters.filter((row) => row.breaks.length);
        const changed = calculated.allocations.filter((row) => row.meter.subItemId === subItem.id && row.warnings.length);
        const usageText = (value: number) => `${formatUsage(value, subItem.usageDisplayDigits)} ${unit}`;
        const payer = (segment: AllocatedSegment) => segment.tenantName || (segment.unitId ? '空室（請求しません）' : '区画が未割当（請求しません）');
        return <>
        <div className="meter-table-wrap">
        <table className="meter-table meter-input-table">
          <colgroup><col className="meter-input-col-floor" /><col className="meter-input-col-tenant" /><col className="meter-input-col-price" /><col className="meter-input-col-code" /><col className="meter-input-col-usage" /><col className="meter-input-col-sum" /><col className="meter-input-col-amount" /><col className="meter-input-col-amount" /></colgroup>
          <thead><tr><th>階数</th><th>テナント名</th><th>単価</th><th>メーター番号</th><th>使用量</th><th>使用合計</th><th>使用料</th><th>テナント使用料合計</th></tr></thead>
          <tbody>{usageRows.map((group) => group.meters.map((item, position) => {
            const info = segmentOfShare(item);
            const meter = info?.meter;
            // 中間検針のあるメーターは、使用量を下の欄で入力します。
            const split = Boolean(meter && allocationByMeter.get(meter.id)!.segments.length > 1);
            return <tr key={item.id} className={position > 0 ? undefined : group.floorSpan ? 'meter-input-floor-first' : 'meter-input-first'}>
              {position === 0 && group.floorSpan > 0 && <td rowSpan={group.floorSpan} className="meter-input-floor">{group.floor || '—'}</td>}
              {position === 0 && <td rowSpan={group.meters.length} className="meter-col-name">{group.name ? <strong>{group.name}</strong> : <span className="meter-muted">{group.vacancy === 'vacant' ? '空室' : '区画が未割当'}</span>}</td>}
              <td className="numeric">{group.priceOf(item) === null ? '' : `${group.priceOf(item)} 円`}</td>
              <td className="meter-input-code">{item.code}</td>
              <td>{split || !meter
                ? <span className="numeric">{usageText(item.usage)}{split && info ? <small className="meter-segment-period">{shortDate(info.segment.from)}～{shortDate(info.segment.to)}</small> : null}</span>
                : <><NumberInput group="usage" value={meter.usage} digits={subItem.usageDisplayDigits} onChange={(usage) => updateMeter(meter.id, { usage })} /><span className="meter-unit">{unit}</span></>}</td>
              {position === 0 && <td rowSpan={group.meters.length} className="numeric">{group.result ? `${formatUsage(group.result.usage, subItem.usageRoundingDigits)} ${unit}` : ''}</td>}
              {group.perMeter
                ? <td className="numeric">{group.amountOf(item) === null ? '' : `${yen.format(group.amountOf(item) ?? 0)} 円`}</td>
                : position === 0 && <td rowSpan={group.meters.length} className="numeric">{group.result ? `${yen.format(group.result.amount)} 円` : ''}</td>}
              {position === 0 && group.tenantSpan > 0 && <td rowSpan={group.tenantSpan} className="numeric meter-total">{group.tenantTotal === null ? '' : `${yen.format(group.tenantTotal)} 円`}</td>}
            </tr>;
          }))}</tbody>
          <tfoot>
            <tr>
              <td colSpan={4} className="meter-input-total-label">合計</td>
              <td className="numeric">{usageText(totalUsageAll)}</td>
              <td className="numeric">{formatUsage(totalGroupUsage, subItem.usageRoundingDigits)} {unit}</td>
              <td className="numeric">{yen.format(totalAmount)} 円</td>
              <td className="numeric meter-total">{yen.format(totalAmount)} 円</td>
            </tr>
            {vacantUsage !== 0 && <tr className="meter-vacant-row">
              <td colSpan={4} className="meter-input-total-label">うち空室・区画未割当（請求しません）</td>
              <td className="numeric">{usageText(vacantUsage)}</td>
              <td colSpan={3} className="meter-muted">テナントへの請求分 {usageText(totalUsageAll - vacantUsage)}</td>
            </tr>}
          </tfoot>
        </table>
        </div>

        {changed.length > 0 && <div className="meter-hint meter-change-list">
          {changed.map((row) => <p key={row.meter.id}>メーター「{row.meter.code || '番号なし'}」：{row.warnings.join('／')}
            {row.warnings.some((text) => text.includes('中間検針')) && <button type="button" className="text-button" onClick={() => addBreak(row.meter)}>中間検針を入力</button>}
          </p>)}
        </div>}

        <div className="meter-break-panel">
          <div className="meter-settings-heading">
            <h4>中間検針</h4>
            <p>月の途中で入退去があったメーターは、区切りの日までの使用量を入力します。区切りの日までを前の区間、翌日からを次の区間とし、各区間の入居テナントに請求します（入居者のいない区間は空室分として請求しません）。</p>
          </div>
          <div className="meter-break-actions">
            <select value="" onChange={(event) => { const target = subMeters.find((row) => row.id === event.target.value); if (target) addBreak(target); }}>
              <option value="">中間検針を追加するメーター…</option>
              {subMeters.map((row) => <option key={row.id} value={row.id}>{row.code || '番号なし'}　{unitLabel(unitById.get(unitAt(row, billingFirst)))}</option>)}
            </select>
          </div>
          {detailMeters.map((meter) => {
            const allocation = allocationByMeter.get(meter.id);
            const segments = allocation?.segments ?? [];
            return <div key={meter.id} className="meter-break-card">
              <div className="meter-break-head">
                <b>{meter.code || '番号なし'}</b>
                <span>{unitLabel(unitById.get(unitAt(meter, billingFirst))) || '区画が未割当'}</span>
                <span className="meter-muted">検針期間 {readingPeriodText}</span>
              </div>
              <table className="meter-table meter-break-table">
                <tbody>
                  <tr>
                    <th>使用量（全体）</th>
                    <td><NumberInput group="break" value={meter.usage} digits={subItem.usageDisplayDigits} onChange={(usage) => updateMeter(meter.id, { usage })} /><span className="meter-unit">{unit}</span></td>
                    <td colSpan={2} />
                  </tr>
                  {meter.breaks.map((row, index) => <tr key={index}>
                    <th>中間検針 {index + 1}</th>
                    <td className="meter-break-exchange">
                      <label>区切りの日<input type="date" value={row.date} min={calculated.period.start} max={addDays(calculated.period.end, -1)} onChange={(event) => updateBreak(meter, index, { date: event.target.value })} /></label>
                      <label>区切りまでの使用量<OptionalNumberInput value={row.usage} digits={3} placeholder="—" onChange={(value) => updateBreak(meter, index, { usage: value })} /></label>
                    </td>
                    <td className="meter-muted">{row.date ? `${slashDate(row.date)}までの入居：${occupantName(unitAt(meter, row.date), row.date) || '空室'}` : '退去日など、前の区間の最後の日を入れます'}</td>
                    <td><button type="button" className="meter-delete" onClick={() => removeBreak(meter, index)}>削除</button></td>
                  </tr>)}
                </tbody>
              </table>
              {segments.length > 1 && <table className="meter-table meter-segment-table">
                <thead><tr><th>区間</th><th>区画</th><th>請求先</th><th>使用量</th></tr></thead>
                <tbody>{segments.map((segment, index) => <tr key={index} className={segment.tenantId ? undefined : 'meter-vacant-row'}>
                  <td>{slashDate(segment.from)}～{slashDate(segment.to)}</td>
                  <td>{unitLabel(unitById.get(segment.unitId)) || '—'}</td>
                  <td>{payer(segment)}</td>
                  <td className="numeric">{usageText(segment.usage)}</td>
                </tr>)}</tbody>
                <tfoot><tr>
                  <td colSpan={3}>合計（空室分 {usageText(segments.filter((segment) => !segment.tenantId).reduce((sum, segment) => sum + segment.usage, 0))}）</td>
                  <td className="numeric">{usageText(segments.reduce((sum, segment) => sum + segment.usage, 0))}</td>
                </tr></tfoot>
              </table>}
              {allocation && allocation.problems.length > 0 && <p className="meter-hint meter-problem">{allocation.problems.join('／')}</p>}
            </div>;
          })}
        </div>
        </>;
      })()}

      {subItem && subItem.kind === 'custom' && currentMode === 'assign' && <div className="meter-assign">
        <div className="meter-settings-heading"><h4>{subItem.name}のメーター割り当て</h4><p>メーター番号と設置階を入力し、メーターを付けている区画を選びます。請求先は、請求月ごとにレントロールからその区画の入居テナントを求めて決めます。区画を選び直すと、この月（{slashDate(billingFirst)}）から新しい区画になり、前の月は元の区画のまま残ります。</p><button type="button" className="text-button" onClick={() => addMeter(subItem.id)}>メーターを追加</button></div>
        <div className="meter-table-wrap">
          <table className="meter-table meter-assign-table">
            <thead><tr><th>メーター番号</th><th>階数</th><th>区画</th><th>入居テナント（{slashDate(billingFirst)}時点）</th><th>単価の上書き</th><th /></tr></thead>
            <tbody>{meters.filter((row) => row.subItemId === subItem.id).map((row) => {
              const unitId = unitAt(row, billingFirst);
              const later = row.assignments.filter((item) => item.from > billingFirst);
              return <tr key={row.id}>
                <td><input value={row.code} placeholder="メーター番号" onChange={(event) => updateMeter(row.id, { code: event.target.value })} /></td>
                <td><input className="meter-floor-input" value={row.label} placeholder="2F" onChange={(event) => updateMeter(row.id, { label: floorLabel(event.target.value) })} /></td>
                <td>
                  <select className="meter-assign-tenant" value={unitId} onChange={(event) => assignUnit(row, event.target.value)}>
                    <option value="">未割当</option>
                    {units.map((item) => <option key={item.id} value={item.id}>{unitLabel(item)}</option>)}
                  </select>
                  {later.length > 0 && <small className="meter-warn meter-assign-since">{later.map((item) => `${slashDate(item.from)}から${unitLabel(unitById.get(item.unitId))}`).join('、')}（選び直すと置き換わります）</small>}
                </td>
                <td>{unitId ? occupantName(unitId) || <span className="meter-muted">空室</span> : <span className="meter-muted">—</span>}</td>
                <td><input type="number" step="0.01" className="meter-narrow" value={row.unitPrice ?? ''} placeholder="契約単価" onChange={(event) => updateMeter(row.id, { unitPrice: event.target.value ? Number(event.target.value) : undefined })} /></td>
                <td><button type="button" className="meter-delete" onClick={() => removeMeter(row.id)}>削除</button></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      </div>}
    </div>}

    {tab === 'settings' && <div className="meter-panel meter-settings-panel">
      <section className="meter-settings-block">
        {building.categories.map((row) => <div key={row.id} className={`meter-category-config ${categoryClass(row.id)}${row.billable ? '' : ' meter-disabled'}`}>
          <div className="meter-category-head">
            <h5>{row.name}</h5>
            <label>使用量の単位<input className="meter-narrow" value={row.unit} onChange={(event) => updateCategory(row.id, { unit: event.target.value })} /></label>
            <label className="meter-check"><input type="checkbox" checked={row.billable} onChange={(event) => updateCategory(row.id, { billable: event.target.checked })} />請求する</label>
            <label className="meter-check"><input type="checkbox" checked={row.fixedBillable} onChange={(event) => updateCategory(row.id, { fixedBillable: event.target.checked })} />基本料を請求する</label>
            {building.surcharges.filter((item) => item.categoryId === row.id).map((item) => <label key={item.id} className="meter-check">
              <input type="checkbox" checked={item.billable} onChange={(event) => setBuilding({ ...building, surcharges: building.surcharges.map((target) => target.id === item.id ? { ...target, billable: event.target.checked } : target) })} />{item.name}を請求する
            </label>)}
            <button type="button" className="text-button" onClick={() => addSubItem(row.id)}>小分類を追加</button>
          </div>
          <table className="meter-table meter-settings-table meter-subitem-table">
            <colgroup><col style={{ width: 132 }} /><col style={{ width: 260 }} /><col style={{ width: 104 }} /><col style={{ width: 88 }} /><col style={{ width: 96 }} /><col style={{ width: 88 }} /><col style={{ width: 132 }} /><col style={{ width: 264 }} /><col style={{ width: 128 }} /><col style={{ width: 150 }} /><col style={{ width: 56 }} /></colgroup>
            <thead><tr><th>小分類</th><th>請求明細の項目</th><th>単価計算方法</th><th>既定単価</th><th>請求書に<br />単価を表示</th><th>税区分</th><th>税抜換算の丸め<small>小数点以下</small></th><th>使用量の丸め</th><th>入力使用量の表示桁数</th><th>既定の請求期間</th><th /></tr></thead>
            <tbody>{building.subItems.filter((item) => item.categoryId === row.id && (item.kind !== 'basic' || row.fixedBillable)).map((item) => <tr key={item.id}>
              <td>{item.kind === 'basic' ? <span className="meter-fixed-name">{item.name}</span> : <input value={item.name} onChange={(event) => updateSubItem(item.id, { name: event.target.value })} />}</td>
              <td><select value={item.lineItemId} onChange={(event) => updateSubItem(item.id, { lineItemId: event.target.value })}><option value="">未設定</option>{lineItemsFor(row.id).map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}</select></td>
              <td>{item.kind === 'custom' ? <select value={item.priceMode} onChange={(event) => updateSubItem(item.id, { priceMode: event.target.value as PriceMode })}>{priceModes.map((value) => <option key={value} value={value}>{priceModeLabel[value]}</option>)}</select> : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' && item.priceMode === 'fixed' ? <input type="number" step="0.01" className="meter-narrow" value={item.defaultUnitPrice ?? ''} placeholder="—" onChange={(event) => updateSubItem(item.id, { defaultUnitPrice: event.target.value ? Number(event.target.value) : null })} /> : <span className="meter-muted">—</span>}</td>
              <td className="meter-center">{item.kind === 'custom' ? <input type="checkbox" checked={item.showUnitPriceOnInvoice} aria-label={`${item.name}の単価を請求書に表示`} onChange={(event) => updateSubItem(item.id, { showUnitPriceOnInvoice: event.target.checked })} /> : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' ? <select value={item.taxMode} onChange={(event) => updateSubItem(item.id, { taxMode: event.target.value as TaxMode })}>{taxModes.map((value) => <option key={value} value={value}>{taxModeLabel[value]}</option>)}</select> : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' && item.taxMode === 'inclusive'
                ? <select value={item.taxRoundingMode} onChange={(event) => updateSubItem(item.id, { taxRoundingMode: event.target.value as RoundingMode })}>{roundingOptions}</select>
                : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' ? <span className="meter-settings-pair">
                <select value={item.usageRoundingDigits} onChange={(event) => updateSubItem(item.id, { usageRoundingDigits: Number(event.target.value) })}>{digitOptions}</select>
                <select value={item.usageRoundingMode} onChange={(event) => updateSubItem(item.id, { usageRoundingMode: event.target.value as RoundingMode })}>{roundingOptions}</select>
              </span> : <span className="meter-muted">—</span>}</td>
              <td>{item.kind === 'custom' ? <select value={item.usageDisplayDigits} onChange={(event) => updateSubItem(item.id, { usageDisplayDigits: Number(event.target.value) })}>{displayDigitOptions}</select> : <span className="meter-muted">—</span>}</td>
              {/* 基本料も、請求書の明細項目１に出す請求期間を選べます。 */}
              <td><select value={item.periodPatternId} aria-label={`${item.name}の既定の請求期間`} onChange={(event) => updateSubItem(item.id, { periodPatternId: event.target.value })}><option value="">未設定</option>{periodPatterns.map((pattern, index) => <option key={pattern.billing_period_pattern_id} value={pattern.billing_period_pattern_id}>{patternMark(index)} {pattern.pattern_name}</option>)}</select></td>
              <td>{item.kind === 'custom' && <button type="button" className="meter-delete" onClick={() => removeSubItem(item.id)}>削除</button>}</td>
            </tr>)}
            {building.surcharges.filter((item) => item.categoryId === row.id && item.billable).map((item) => <tr key={item.id} className="meter-surcharge-row">
              <td><span className="meter-fixed-name">{item.name}</span></td>
              <td><select value={item.lineItemId} onChange={(event) => setBuilding({ ...building, surcharges: building.surcharges.map((target) => target.id === item.id ? { ...target, lineItemId: event.target.value } : target) })}><option value="">未設定</option>{lineItemsFor(item.categoryId).map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}</select></td>
              <td className="meter-muted">—</td><td className="meter-muted">—</td><td className="meter-muted">—</td><td className="meter-muted">—</td><td className="meter-muted">—</td><td className="meter-muted">—</td><td className="meter-muted">—</td>
              <td><select value={item.periodPatternId} onChange={(event) => setBuilding({ ...building, surcharges: building.surcharges.map((target) => target.id === item.id ? { ...target, periodPatternId: event.target.value } : target) })}><option value="">未設定</option>{periodPatterns.map((pattern, index) => <option key={pattern.billing_period_pattern_id} value={pattern.billing_period_pattern_id}>{patternMark(index)} {pattern.pattern_name}</option>)}</select></td>
              <td />
            </tr>)}</tbody>
          </table>
        </div>)}
      </section>

      <section className="meter-settings-block">
        <h4>テナント一覧</h4>
        <div className="meter-table-wrap">
          <table className="meter-table meter-settings-table meter-contract-table">
            <thead>
              <tr>
                <th className="meter-col-name" rowSpan={2}>テナント</th>
                {visibleCategories.map((item) => {
                  const customs = building.subItems.filter((value) => value.categoryId === item.id && value.kind === 'custom');
                  const priceColumns = customs.filter((value) => value.priceMode === 'fixed').length;
                  return <th key={item.id} colSpan={(item.fixedBillable ? 3 : 2) + (customs.length === 1 ? priceColumns : customs.length + priceColumns)} className={`meter-contract-group ${categoryClass(item.id)}`}>{item.name}</th>;
                })}
                <th rowSpan={2}>小数点</th>
                <th rowSpan={2}>備考</th>
                <th rowSpan={2}>データ分割設定</th>
                {tenants.some((item) => item.splitEnabled) && <th rowSpan={2}>分割行の区画</th>}
                {tenants.some((item) => item.invoiceSplitByUnit) && <th rowSpan={2}>請求書</th>}
              </tr>
              <tr>{visibleCategories.flatMap((item) => [
                <th key={`${item.id}-billable`} className={`meter-contract-group ${categoryClass(item.id)}`}>請求</th>,
                ...(item.fixedBillable ? [<th key={`${item.id}-basic`} className={categoryClass(item.id)}>基本料</th>] : []),
...(() => {
                  const customs = building.subItems.filter((value) => value.categoryId === item.id && value.kind === 'custom');
                  if (customs.length === 1) return customs[0].priceMode === 'fixed' ? [<th key={`${customs[0].id}-p`} className={categoryClass(item.id)}>単価</th>] : [];
                  return customs.flatMap((value) => [
                    <th key={`${value.id}-b`} className={categoryClass(item.id)}>{value.name}</th>,
                    ...(value.priceMode === 'fixed' ? [<th key={`${value.id}-p`} className={categoryClass(item.id)}>単価</th>] : []),
                  ]);
                })(),
                <th key={`${item.id}-sum`} className={categoryClass(item.id)}>計算方法</th>,
              ])}</tr>
            </thead>
            <tbody>{tenants.flatMap((tenant) => tenant.rows.map((row, index) => <tr key={row.id} className={`${index === 0 ? 'meter-contract-first' : 'meter-contract-sub'}${tenant.splitEnabled ? ' meter-contract-split' : ''}`}>
              <td className="meter-col-name">{index === 0 ? <strong>{tenant.name}</strong> : <span className="meter-contract-continued">{tenant.name}</span>}{tenant.splitEnabled ? <input className="meter-split-label" value={row.splitLabel} placeholder={`分割 ${index + 1} の識別名（3F など）`} onChange={(event) => updateRow(tenant.id, index, { splitLabel: event.target.value })} /> : null}</td>
              {visibleCategories.flatMap((item) => {
                const basic = building.subItems.find((value) => value.categoryId === item.id && value.kind === 'basic');
                const customs = building.subItems.filter((value) => value.categoryId === item.id && value.kind === 'custom');
                const enabled = row.categoryBillable[item.id] !== false;
                return [
                  <td key={`${item.id}-billable`} className={`meter-contract-group ${categoryClass(item.id)}`}>
                    <input type="checkbox" checked={enabled} onChange={(event) => updateRow(tenant.id, index, { categoryBillable: { ...row.categoryBillable, [item.id]: event.target.checked } })} />
                  </td>,
                  ...(item.fixedBillable && basic ? [<td key={`${item.id}-basic`} className={categoryClass(item.id)}>
                    <input type="checkbox" checked={row.billable[basic.id] ?? false} disabled={!enabled} onChange={(event) => updateRow(tenant.id, index, { billable: { ...row.billable, [basic.id]: event.target.checked } })} />
                  </td>] : []),
                  ...customs.flatMap((value) => {
                    const price = <td key={`${value.id}-p`} className={categoryClass(item.id)}><input type="number" step="0.01" className="meter-narrow" value={row.unitPrices[value.id] ?? ''} placeholder="既定" disabled={!enabled || (customs.length > 1 && !row.billable[value.id])} onChange={(event) => updateRow(tenant.id, index, { unitPrices: { ...row.unitPrices, [value.id]: event.target.value === '' ? null : Number(event.target.value) } })} /></td>;
                    if (customs.length === 1) return value.priceMode === 'fixed' ? [price] : [];
                    return [
                      <td key={`${value.id}-b`} className={categoryClass(item.id)}><input type="checkbox" checked={row.billable[value.id] ?? false} disabled={!enabled} onChange={(event) => updateRow(tenant.id, index, { billable: { ...row.billable, [value.id]: event.target.checked } })} /></td>,
                      ...(value.priceMode === 'fixed' ? [price] : []),
                    ];
                  }),
                  <td key={`${item.id}-sum`} className={categoryClass(item.id)}>
                    <select value={row.sumMode[item.id] ?? 'aggregate'} disabled={!enabled} onChange={(event) => updateRow(tenant.id, index, { sumMode: { ...row.sumMode, [item.id]: event.target.value as SumMode } })}>{sumModes.map((value) => <option key={value} value={value}>{sumModeLabel[value]}</option>)}</select>
                  </td>,
                ];
              })}
              <td><select value={row.amountRoundingMode} onChange={(event) => updateRow(tenant.id, index, { amountRoundingMode: event.target.value as RoundingMode })}>{roundingOptions}</select></td>
              <td><input className="meter-note-input" value={row.note} placeholder="—" onChange={(event) => updateRow(tenant.id, index, { note: event.target.value })} /></td>
              <td className="meter-split-cell">{index === 0 ? <span className="meter-settings-pair">
                <label className="meter-check"><input type="checkbox" checked={tenant.splitEnabled} onChange={(event) => { updateTenant(tenant.id, { splitEnabled: event.target.checked }); if (!event.target.checked) setSplitCount(tenant, 1); else if (tenant.rows.length < 2) setSplitCount(tenant, 2); }} />分割する</label>
                {tenant.splitEnabled && <input type="number" min="1" max="9" className="meter-narrow" value={tenant.rows.length} onChange={(event) => setSplitCount(tenant, Number(event.target.value))} />}
              </span> : null}</td>
              {tenants.some((item) => item.splitEnabled) && <td className="meter-row-units">{tenant.splitEnabled
                ? tenantUnits(tenant.id).map((unit) => <label key={unit.id} className="meter-check"><input type="checkbox" checked={row.unitIds.includes(unit.id)} onChange={(event) => toggleRowUnit(tenant, index, unit.id, event.target.checked)} />{unitLabel(unit)}</label>)
                : <span className="meter-muted">—</span>}</td>}
              {tenants.some((item) => item.invoiceSplitByUnit) && <td>{tenant.invoiceSplitByUnit
                ? <select value={row.invoiceNo} onChange={(event) => updateRow(tenant.id, index, { invoiceNo: Number(event.target.value) })}>{[1, 2, 3].map((no) => <option key={no} value={no}>請求書 {no}</option>)}</select>
                : <span className="meter-muted">—</span>}</td>}
            </tr>))}</tbody>
          </table>
        </div>
        <p className="meter-hint">請求書は、請求設定の請求書分割設定で区画ごとに分けているテナントだけ選べます。分割したテナントは、各行で計算する区画を選びます（どの行にも選んでいない区画のメーターは1行目で計算します）。</p>
      </section>
    </div>}
    </fieldset>
  </section>;
}
