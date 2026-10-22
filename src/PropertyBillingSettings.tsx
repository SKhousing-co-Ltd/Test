import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "./lib/supabase";
import type { BillingPeriod, BillingProperty } from "./TenantBillingControls";
import { BillingCodeAllocationSettings } from "./BillingCodeAllocationSettings";
import { InvoiceSplitSettings } from "./InvoiceSplitSettings";
import { MeterReadingPage } from "./MeterReadingPage";
import "./PropertyBillingSettings.css";

type ChargeType = { billing_charge_type_id: string; charge_type_name: string; utility_kind?: string | null };
type PeriodRule = "manual" | "meter_reading" | "custom_pattern";
type Day = "first" | "last" | "meter" | `day_${number}`;
type LineItem = {
  asset_billing_line_item_id: string;
  line_item_name: string;
  display_name: string;
  billing_charge_type_id: string;
  billing_kind: "fixed" | "variable";
  period_rule_type: PeriodRule;
  billing_period_pattern_id: string | null;
  sort_order: number;
  show_unit_price_in_rent_roll: boolean;
  // 既定単価・税区分です。契約区画に単価が無いテナント（新規のテナントなど）に使います。
  default_unit_price: number | null;
  default_tax_mode: "exclusive" | "inclusive";
};
type Pattern = {
  billing_period_pattern_id: string;
  pattern_name: string;
  start_month_offset: number;
  start_day_type: Day;
  start_meter_day_offset: number;
  end_month_offset: number;
  end_day_type: Day;
  end_meter_day_offset: number;
  sort_order: number;
};
const monthLabel = (n: number) =>
  ({ "-2": "前々月", "-1": "前月", "0": "当月", "1": "翌月", "2": "翌々月" })[
    String(n)
  ] ?? "当月";
const dayLabel = (day: Day, offset: number) =>
  day === "first" || day === "day_1"
    ? "1日"
    : day === "last"
      ? "末日"
      : day === "meter"
        ? `検針日${offset ? "翌日" : "当日"}`
        : `${day.replace("day_", "")}日`;

export function PropertyBillingSettings({
  propertyId,
  properties,
  period,
  canEdit,
}: {
  propertyId: string;
  properties: BillingProperty[];
  period: BillingPeriod;
  canEdit: boolean;
}) {
  const [tab, setTab] = useState<
    "items" | "meterSettings" | "patterns" | "allocations" | "invoiceSplits"
  >("items");
  const [types, setTypes] = useState<ChargeType[]>([]);
  const [items, setItems] = useState<LineItem[]>([]);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [db, setDb] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [typeId, setTypeId] = useState("");
  const [patternName, setPatternName] = useState("");
  const [startMonth, setStartMonth] = useState(0);
  const [startDay, setStartDay] = useState<Day>("day_1");
  const [startMeterOffset, setStartMeterOffset] = useState(0);
  const [endMonth, setEndMonth] = useState(0);
  const [endDay, setEndDay] = useState<Day>("last");
  const [endMeterOffset, setEndMeterOffset] = useState(0);
  const [editingItemId, setEditingItemId] = useState("");
  const [editingPatternId, setEditingPatternId] = useState("");
  const [draggingItemId, setDraggingItemId] = useState("");
  const [draggingPatternId, setDraggingPatternId] = useState("");
  const [dropItemId, setDropItemId] = useState("");
  const [dropPatternId, setDropPatternId] = useState("");
  const property = properties.find((p) => p.asset_id === propertyId);
  useEffect(() => {
    const load = async () => {
      if (!propertyId) {
        setLoading(false);
        return;
      }
      localStorage.removeItem(`tenant-billing-property-line-items:${propertyId}`);
      localStorage.removeItem(`tenant-billing-period-patterns:${propertyId}`);
      localStorage.removeItem(`tenant-billing-enabled-charge-types:${propertyId}`);
      localStorage.removeItem("tenant-billing-charge-types");
      setLoading(true);
      setNotice("");
      if (supabase) {
        const [typeResult, itemResult, patternResult] = await Promise.all([
          supabase
            .from("billing_charge_type")
            .select("billing_charge_type_id, charge_type_name, utility_kind")
            .eq("is_active", true)
            .order("sort_order"),
          supabase
            .from("asset_billing_line_item")
            .select(
              "asset_billing_line_item_id, line_item_name, display_name, billing_charge_type_id, billing_kind, period_rule_type, billing_period_pattern_id, sort_order, show_unit_price_in_rent_roll, default_unit_price, default_tax_mode",
            )
            .eq("asset_id", propertyId)
            .eq("is_active", true)
            .order("sort_order"),
          supabase
            .from("asset_billing_period_pattern")
            .select(
              "billing_period_pattern_id, pattern_name, start_month_offset, start_day_type, start_meter_day_offset, end_month_offset, end_day_type, end_meter_day_offset, sort_order",
            )
            .eq("asset_id", propertyId)
            .order("sort_order"),
        ]);
        if (!typeResult.error && !itemResult.error && !patternResult.error) {
          const availableTypes = (typeResult.data ?? []) as ChargeType[];
          setTypes(availableTypes);
          setItems((itemResult.data ?? []) as LineItem[]);
          setPatterns((patternResult.data ?? []) as Pattern[]);
          setTypeId(availableTypes[0]?.billing_charge_type_id ?? "");
          setDb(true);
          setLoading(false);
          return;
        }
      }
      setTypes([]);
      setItems([]);
      setPatterns([]);
      setTypeId("");
      setDb(false);
      setNotice("請求設定のデータを読み込めませんでした。データベース移行が未適用、または権限設定を確認してください。");
      setLoading(false);
    };
    void load();
  }, [propertyId]);
  const addItem = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !displayName.trim() || !typeId) return;
    const draft = {
      line_item_name: name.trim(),
      display_name: displayName.trim(),
      billing_charge_type_id: typeId,
      ...(editingItemId ? {} : { sort_order: items.length + 1 }),
    };
    if (db && supabase && editingItemId) {
      const { data, error } = await supabase.from("asset_billing_line_item").update(draft).eq("asset_billing_line_item_id", editingItemId).select("asset_billing_line_item_id, line_item_name, display_name, billing_charge_type_id, billing_kind, period_rule_type, billing_period_pattern_id, sort_order, show_unit_price_in_rent_roll, default_unit_price, default_tax_mode").single();
      if (error) { setNotice(`明細項目を更新できませんでした: ${error.message}`); return; }
      setItems(items.map((item) => item.asset_billing_line_item_id === editingItemId ? data as LineItem : item)); setEditingItemId("");
    } else if (db && supabase) {
      const { data, error } = await supabase
        .from("asset_billing_line_item")
        .insert({
          asset_id: propertyId,
          ...draft,
          billing_kind: types.find((type) => type.billing_charge_type_id === typeId)?.utility_kind ? "variable" : "fixed",
          period_rule_type: "manual",
          billing_period_pattern_id: null,
        })
        .select(
          "asset_billing_line_item_id, line_item_name, display_name, billing_charge_type_id, billing_kind, period_rule_type, billing_period_pattern_id, sort_order, show_unit_price_in_rent_roll, default_unit_price, default_tax_mode",
        )
        .single();
      if (error) {
        setNotice(`明細項目を登録できませんでした: ${error.message}`);
        return;
      }
      setItems([...items, data as LineItem]);
    } else { setNotice("データベースに接続できないため、明細項目を登録できません。"); return; }
    setName("");
    setDisplayName("");
    setNotice(editingItemId ? "明細項目を更新しました。" : "明細項目を登録しました。");
  };
  const removeItem = async (item: LineItem) => {
    if (db && supabase) {
      const { error } = await supabase
        .from("asset_billing_line_item")
        .delete()
        .eq("asset_billing_line_item_id", item.asset_billing_line_item_id);
      if (error) {
        setNotice(`明細項目を削除できませんでした: ${error.message}`);
        return;
      }
      setItems(
        items.filter(
          (x) =>
            x.asset_billing_line_item_id !== item.asset_billing_line_item_id,
        ),
      );
    } else setNotice("データベースに接続できないため、明細項目を削除できません。");
  };
  const reorder = <T extends { sort_order: number }>(rows: T[], fromId: string, toId: string, key: keyof T) => {
    const from = rows.findIndex((row) => row[key] === fromId); const to = rows.findIndex((row) => row[key] === toId);
    if (from < 0 || to < 0 || from === to) return rows;
    const next = [...rows]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); return next.map((row, index) => ({ ...row, sort_order: index + 1 }));
  };
  const saveItemOrder = async (next: LineItem[]) => { const client = supabase; if (!db || !client) { setNotice("データベースに接続できないため、並び順を保存できません。"); return; } setItems(next); const results = await Promise.all(next.map((row) => client.from("asset_billing_line_item").update({ sort_order: row.sort_order }).eq("asset_billing_line_item_id", row.asset_billing_line_item_id))); if (results.some((result) => result.error)) setNotice("明細項目の並び順を保存できませんでした。"); };
  const savePatternOrder = async (next: Pattern[]) => { const client = supabase; if (!db || !client) { setNotice("データベースに接続できないため、並び順を保存できません。"); return; } setPatterns(next); const results = await Promise.all(next.map((row) => client.from("asset_billing_period_pattern").update({ sort_order: row.sort_order }).eq("billing_period_pattern_id", row.billing_period_pattern_id))); if (results.some((result) => result.error)) setNotice("請求期間パターンの並び順を保存できませんでした。"); };
  const removePattern = async (pattern: Pattern) => { if (db && supabase) { const { error } = await supabase.from("asset_billing_period_pattern").delete().eq("billing_period_pattern_id", pattern.billing_period_pattern_id); if (error) { setNotice(`請求期間パターンを削除できませんでした: ${error.message}`); return; } setPatterns(patterns.filter((row) => row.billing_period_pattern_id !== pattern.billing_period_pattern_id)); } else setNotice("データベースに接続できないため、請求期間パターンを削除できません。"); };
  const addPattern = async (e: FormEvent) => {
    e.preventDefault();
    if (!patternName.trim()) return;
    const draft = {
      pattern_name: patternName.trim(),
      start_month_offset: startMonth,
      start_day_type: startDay,
      start_meter_day_offset: startMeterOffset,
      end_month_offset: endMonth,
      end_day_type: endDay,
      end_meter_day_offset: endMeterOffset,
      sort_order: patterns.length + 1,
    };
    if (db && supabase) {
      const { data, error } = await supabase
        .from("asset_billing_period_pattern")
        .insert({ asset_id: propertyId, ...draft })
        .select(
          "billing_period_pattern_id, pattern_name, start_month_offset, start_day_type, start_meter_day_offset, end_month_offset, end_day_type, end_meter_day_offset, sort_order",
        )
        .single();
      if (error) {
        setNotice(`請求期間パターンを登録できませんでした: ${error.message}`);
        return;
      }
      setPatterns([...patterns, data as Pattern]);
    } else { setNotice("データベースに接続できないため、請求期間パターンを登録できません。"); return; }
    setPatternName("");
    setNotice(editingPatternId ? "請求期間パターンを更新しました。" : "請求期間パターンを登録しました。");
  };
  const description = (p: Pattern) =>
    `${monthLabel(p.start_month_offset)} ${dayLabel(p.start_day_type, p.start_meter_day_offset)} ～ ${monthLabel(p.end_month_offset)} ${dayLabel(p.end_day_type, p.end_meter_day_offset)}`;
  return (
    <section className="property-billing-settings">
      <header>
        <div>
          <h3>請求設定</h3>
          <p>
            {property
              ? `${property.short_name || property.asset_name}の請求設定を管理します。`
              : "物件を選択してください。"}
          </p>
        </div>
      </header>
      {!db && !loading && (
        <p className="property-billing-settings-notice">
          現在はローカル表示用の仮設定です。データベース移行後は物件ごとの設定として保存されます。
        </p>
      )}
      {notice && (
        <p className="property-billing-settings-notice error">{notice}</p>
      )}
      <div className="property-billing-tabs">
        <button
          className={tab === "items" ? "active" : ""}
          onClick={() => setTab("items")}
        >
          明細項目
        </button>
        <button
          className={tab === "meterSettings" ? "active" : ""}
          onClick={() => setTab("meterSettings")}
        >
          検針設定
        </button>
        <button
          className={tab === "allocations" ? "active" : ""}
          onClick={() => setTab("allocations")}
        >
          複数テナントコード
        </button>
        <button
          className={tab === "invoiceSplits" ? "active" : ""}
          onClick={() => setTab("invoiceSplits")}
        >
          請求書分割設定
        </button>
      </div>
      {tab === "items" && (
        <section className="property-billing-items">
          <div className="property-billing-items-heading">
            <h4>明細項目</h4>
            <p>固定費の請求期間は契約情報から取得します。</p>
          </div>
          <form className="property-billing-item-form" onSubmit={addItem}>
            <label>
              項目
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              明細表示名
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>
            <label>
              請求種別
              <select
                value={typeId}
                onChange={(e) => setTypeId(e.target.value)}
              >
                <option value="">選択してください</option>
                {types.map((x) => (
                  <option
                    key={x.billing_charge_type_id}
                    value={x.billing_charge_type_id}
                  >
                    {x.charge_type_name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="primary-button"
              disabled={!canEdit || !types.length}
            >
              {editingItemId ? "更新" : "登録"}
            </button>
          </form>
          <div className="property-billing-settings-table-wrap">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>項目</th>
                  <th>明細表示名</th>
                  <th>請求種別</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.asset_billing_line_item_id} className={dropItemId === item.asset_billing_line_item_id ? "drop-target" : ""} onDragOver={(event) => { event.preventDefault(); setDropItemId(item.asset_billing_line_item_id); }} onDragLeave={() => setDropItemId("")} onDrop={(event) => { event.preventDefault(); if (draggingItemId) void saveItemOrder(reorder(items, draggingItemId, item.asset_billing_line_item_id, "asset_billing_line_item_id")); setDraggingItemId(""); setDropItemId(""); }}>
                    <td><button type="button" className="drag-handle" draggable={canEdit} onDragStart={() => setDraggingItemId(item.asset_billing_line_item_id)} onDragEnd={() => { setDraggingItemId(""); setDropItemId(""); }} aria-label={`${item.line_item_name}をドラッグして並び替え`}>⠿</button></td>
                    <td>
                      <strong>{item.line_item_name}</strong>
                    </td>
                    <td>{item.display_name}</td>
                    <td>
                      {types.find(
                        (x) =>
                          x.billing_charge_type_id ===
                          item.billing_charge_type_id,
                      )?.charge_type_name ?? "—"}
                    </td>
                    <td>
                      <button type="button" className="text-button" disabled={!canEdit} onClick={() => { setEditingItemId(item.asset_billing_line_item_id); setName(item.line_item_name); setDisplayName(item.display_name); setTypeId(item.billing_charge_type_id); }}>編集</button>
                      <button
                        className="tenant-billing-delete"
                        disabled={!canEdit}
                        onClick={() => void removeItem(item)}
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
                {!items.length && (
                  <tr>
                    <td colSpan={5}>明細項目は未登録です。</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {tab === "meterSettings" && (
        <MeterReadingPage
          propertyId={propertyId}
          propertyName={property?.short_name || property?.asset_name || ""}
          period={period}
          settingsOnly
        />
      )}
      {tab === "patterns" && (
        <section className="property-period-patterns">
          <div>
            <h4>請求期間パターン</h4>
            <p>
              請求書に表示する「YYYY/M/D～YYYY/M/D分」の期間を設定します。
            </p>
          </div>
          <form onSubmit={addPattern}>
            <label>
              パターン名
              <input
                value={patternName}
                onChange={(e) => setPatternName(e.target.value)}
                placeholder="例：前月分"
              />
            </label>
            <PeriodField
              label="開始日"
              month={startMonth}
              setMonth={setStartMonth}
              day={startDay}
              setDay={setStartDay}
              meterOffset={startMeterOffset}
              setMeterOffset={setStartMeterOffset}
            />
            <PeriodField
              label="終了日"
              month={endMonth}
              setMonth={setEndMonth}
              day={endDay}
              setDay={setEndDay}
              meterOffset={endMeterOffset}
              setMeterOffset={setEndMeterOffset}
            />
            <button className="primary-button" disabled={!canEdit}>
              {editingPatternId ? "更新" : "登録"}
            </button>
          </form>
          <div className="property-billing-settings-table-wrap">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>パターン名</th>
                  <th>請求期間</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {patterns.map((p) => (
                  <tr key={p.billing_period_pattern_id} className={dropPatternId === p.billing_period_pattern_id ? "drop-target" : ""} onDragOver={(event) => { event.preventDefault(); setDropPatternId(p.billing_period_pattern_id); }} onDragLeave={() => setDropPatternId("")} onDrop={(event) => { event.preventDefault(); if (draggingPatternId) void savePatternOrder(reorder(patterns, draggingPatternId, p.billing_period_pattern_id, "billing_period_pattern_id")); setDraggingPatternId(""); setDropPatternId(""); }}>
                    <td><button type="button" className="drag-handle" draggable={canEdit} onDragStart={() => setDraggingPatternId(p.billing_period_pattern_id)} onDragEnd={() => { setDraggingPatternId(""); setDropPatternId(""); }} aria-label={`${p.pattern_name}をドラッグして並び替え`}>⠿</button></td>
                    <td>
                      <strong>{p.pattern_name}</strong>
                    </td>
                    <td>{description(p)}</td>
                    <td><button type="button" className="text-button" disabled={!canEdit} onClick={() => { setEditingPatternId(p.billing_period_pattern_id); setPatternName(p.pattern_name); setStartMonth(p.start_month_offset); setStartDay(p.start_day_type); setStartMeterOffset(p.start_meter_day_offset); setEndMonth(p.end_month_offset); setEndDay(p.end_day_type); setEndMeterOffset(p.end_meter_day_offset); }}>編集</button><button type="button" className="tenant-billing-delete" disabled={!canEdit} onClick={() => void removePattern(p)}>削除</button></td>
                  </tr>
                ))}
                {!patterns.length && (
                  <tr>
                    <td colSpan={4}>請求期間パターンは未登録です。</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {tab === "allocations" && (
        <BillingCodeAllocationSettings
          propertyId={propertyId}
          lineItems={items}
          canEdit={canEdit}
        />
      )}
      {tab === "invoiceSplits" && (
        <InvoiceSplitSettings propertyId={propertyId} lineItems={items} canEdit={canEdit} />
      )}
    </section>
  );
}
function PeriodField({
  label,
  month,
  setMonth,
  day,
  setDay,
  meterOffset,
  setMeterOffset,
}: {
  label: string;
  month: number;
  setMonth: (n: number) => void;
  day: Day;
  setDay: (d: Day) => void;
  meterOffset: number;
  setMeterOffset: (n: number) => void;
}) {
  return (
    <label className="period-field-label">
      {label && <span>{label}</span>}
      <span className="period-field">
        <select
          value={month}
          onChange={(e) => setMonth(Number(e.target.value))}
        >
          {[-2, -1, 0, 1, 2].map((n) => (
            <option key={n} value={n}>
              {monthLabel(n)}
            </option>
          ))}
        </select>
        <select value={day} onChange={(e) => setDay(e.target.value as Day)}>
          {Array.from({ length: 30 }, (_, index) => index + 1).map((number) => <option key={number} value={`day_${number}`}>{number}日</option>)}
          <option value="last">末日</option>
          <option value="meter">検針日</option>
        </select>
        {day === "meter" && (
          <select
            value={meterOffset}
            onChange={(e) => setMeterOffset(Number(e.target.value))}
          >
            <option value={0}>当日</option>
            <option value={1}>翌日</option>
          </select>
        )}
      </span>
    </label>
  );
}
