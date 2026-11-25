import { useEffect, useState, type DragEvent, type FormEvent } from "react";
import { supabase } from "./lib/supabase";
import "./TenantBillingSettingsPage.css";

type ChargeType = {
  billing_charge_type_id: string;
  charge_type_name: string;
  sort_order: number;
  is_active: boolean;
  utility_kind: "" | "electricity" | "water" | "gas" | null;
  is_fixed_charge: boolean;
  revenue_account_code: string | null;
  revenue_subaccount_code: string | null;
};
const defaultChargeTypes: ChargeType[] = [
  ["rent", "賃料"],
  ["common-charge", "共益費"],
  ["parking", "駐車料"],
  ["electricity", "電気代"],
  ["water", "水道代"],
  ["gas", "ガス代"],
  ["other", "その他"],
].map(([id, name], index) => ({
  billing_charge_type_id: id,
  charge_type_name: name,
  sort_order: index + 1,
  is_active: true,
  utility_kind: "",
  is_fixed_charge: ["賃料", "共益費", "駐車料"].includes(name),
  revenue_account_code: name === "その他" ? null : "4100",
  revenue_subaccount_code: name === "その他" ? null : "1",
}));
const localTypesKey = "tenant-billing-charge-types";
const utilityLabels: Record<string, string> = {
  electricity: "電気代",
  water: "水道代",
  gas: "ガス代",
};
const stored = <T,>(key: string, fallback: T): T => {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
};
const renumber = <T,>(items: T[]) =>
  items.map((item, index) => ({ ...item, sort_order: index + 1 }));
const move = (items: ChargeType[], sourceId: string, targetId: string) => {
  const sourceIndex = items.findIndex(
    (item) => item.billing_charge_type_id === sourceId,
  );
  const targetIndex = items.findIndex(
    (item) => item.billing_charge_type_id === targetId,
  );
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex)
    return items;
  const next = [...items];
  const [source] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, source);
  return renumber(next);
};

export function TenantBillingSettingsPage() {
  const [chargeTypes, setChargeTypes] = useState<ChargeType[]>([]);
  const [chargeTypeName, setChargeTypeName] = useState("");
  const [utilityKind, setUtilityKind] =
    useState<ChargeType["utility_kind"]>("");
  const [draggingTypeId, setDraggingTypeId] = useState("");
  const [isDatabaseAvailable, setIsDatabaseAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [savingTypeId, setSavingTypeId] = useState("");
  const saveLocal = (types: ChargeType[]) => {
    localStorage.setItem(localTypesKey, JSON.stringify(types));
    setChargeTypes(types);
  };

  useEffect(() => {
    const load = async () => {
      if (supabase) {
        const result = await supabase
          .from("billing_charge_type")
          .select(
            "billing_charge_type_id, charge_type_name, sort_order, is_active, utility_kind, is_fixed_charge, revenue_account_code, revenue_subaccount_code",
          )
          .order("sort_order");
        if (!result.error) {
          setChargeTypes((result.data ?? []) as ChargeType[]);
          setIsDatabaseAvailable(true);
          setLoading(false);
          return;
        }
      }
      saveLocal(stored(localTypesKey, defaultChargeTypes));
      setLoading(false);
    };
    void load();
  }, []);

  const addChargeType = async (event: FormEvent) => {
    event.preventDefault();
    const name = chargeTypeName.trim();
    if (!name) return;
    if (chargeTypes.some((type) => type.charge_type_name === name)) {
      setNotice("同じ請求種別が登録されています。");
      return;
    }
    if (isDatabaseAvailable && supabase) {
      const { data, error } = await supabase
        .from("billing_charge_type")
        .insert({
          charge_type_name: name,
          sort_order: chargeTypes.length + 1,
          utility_kind: utilityKind || null,
          is_fixed_charge: false,
          revenue_account_code: name === "その他" ? null : "4100",
          revenue_subaccount_code: name === "その他" ? null : "1",
        })
        .select(
          "billing_charge_type_id, charge_type_name, sort_order, is_active, utility_kind, is_fixed_charge, revenue_account_code, revenue_subaccount_code",
        )
        .single();
      if (error) {
        setNotice(`請求種別を登録できませんでした: ${error.message}`);
        return;
      }
      setChargeTypes((current) => [...current, data as ChargeType]);
    } else
      saveLocal([
        ...chargeTypes,
        {
          billing_charge_type_id: crypto.randomUUID(),
          charge_type_name: name,
          sort_order: chargeTypes.length + 1,
          is_active: true,
          utility_kind: utilityKind,
          is_fixed_charge: false,
          revenue_account_code: name === "その他" ? null : "4100",
          revenue_subaccount_code: name === "その他" ? null : "1",
        },
      ]);
    setChargeTypeName("");
    setUtilityKind("");
    setNotice("請求種別を登録しました。");
  };
  const saveOrder = async (next: ChargeType[]) => {
    setChargeTypes(next);
    const client = supabase;
    if (!isDatabaseAvailable || !client) {
      saveLocal(next);
      return;
    }
    const results = await Promise.all(
      next.map((type) =>
        client
          .from("billing_charge_type")
          .update({ sort_order: type.sort_order })
          .eq("billing_charge_type_id", type.billing_charge_type_id),
      ),
    );
    if (results.some((result) => result.error))
      setNotice("請求種別の並び順を保存できませんでした。");
  };
  const saveRevenueSetting = async (type: ChargeType) => {
    if (!isDatabaseAvailable || !supabase) { saveLocal(chargeTypes); setNotice("会計設定をローカルに保存しました。"); return; }
    if (type.charge_type_name !== "その他" && !/^\d+$/.test(type.revenue_account_code ?? "")) { setNotice("売上科目コードは数字で入力してください。"); return; }
    if (type.revenue_subaccount_code && !/^\d+$/.test(type.revenue_subaccount_code)) { setNotice("補助科目コードは数字で入力してください。"); return; }
    setSavingTypeId(type.billing_charge_type_id);
    const { error } = await supabase.from("billing_charge_type").update({ is_fixed_charge: type.is_fixed_charge, revenue_account_code: type.charge_type_name === "その他" ? null : type.revenue_account_code, revenue_subaccount_code: type.charge_type_name === "その他" ? null : type.revenue_subaccount_code || null }).eq("billing_charge_type_id", type.billing_charge_type_id);
    setSavingTypeId("");
    setNotice(error ? `会計設定を保存できませんでした: ${error.message}` : `${type.charge_type_name}の会計設定を保存しました。`);
  };
  const updateRevenueDraft = (id: string, patch: Partial<ChargeType>) => setChargeTypes((current) => current.map((type) => type.billing_charge_type_id === id ? { ...type, ...patch } : type));
  const deleteChargeType = async (type: ChargeType) => {
    if (isDatabaseAvailable && supabase) {
      const { error } = await supabase
        .from("billing_charge_type")
        .delete()
        .eq("billing_charge_type_id", type.billing_charge_type_id);
      if (error) {
        setNotice(`請求種別を削除できませんでした: ${error.message}`);
        return;
      }
    }
    const next = renumber(
      chargeTypes.filter(
        (item) => item.billing_charge_type_id !== type.billing_charge_type_id,
      ),
    );
    if (isDatabaseAvailable) setChargeTypes(next);
    else saveLocal(next);
    setNotice("請求種別を削除しました。");
  };

  return (
    <section className="tenant-billing-settings">
      <section className="page-heading">
        <div>
          <p className="section-kicker">SETTINGS</p>
          <h2>テナント請求設定</h2>
          <p>
            テナント請求で共通利用する請求種別を管理します。明細項目は各物件の「請求設定」で登録します。
          </p>
        </div>
      </section>
      {!isDatabaseAvailable && !loading && (
        <p className="tenant-billing-settings-notice">
          現在はローカル表示用の仮データです。データベース移行後は組織共通の設定として保存されます。
        </p>
      )}
      {notice && <p className="tenant-billing-settings-message">{notice}</p>}
      <div className="tenant-billing-settings-grid">
        <section className="tenant-billing-settings-panel">
          <header>
            <div>
              <h3>請求種別</h3>
              <p>
                賃料・共益費・電気代など、請求する内容の大まかな分類です。左端をドラッグして順番を変更できます。
              </p>
            </div>
          </header>
          <form
            onSubmit={addChargeType}
            className="tenant-billing-settings-form"
          >
            <label>
              請求種別名
              <input
                value={chargeTypeName}
                onChange={(event) => setChargeTypeName(event.target.value)}
                placeholder="例：電気代"
              />
            </label>
            <label>
              公共料金設定
              <select
                value={utilityKind ?? ""}
                onChange={(event) =>
                  setUtilityKind(
                    event.target.value as ChargeType["utility_kind"],
                  )
                }
              >
                <option value="">設定しない</option>
                <option value="electricity">電気代</option>
                <option value="water">水道代</option>
                <option value="gas">ガス代</option>
              </select>
            </label>
            <button className="primary-button" type="submit">
              登録
            </button>
          </form>
          <div className="tenant-billing-settings-table-wrap">
            <table className="tenant-billing-settings-table">
              <thead>
                <tr>
                  <th />
                  <th>請求種別</th>
                  <th>公共料金設定</th>
                  <th>固定費</th>
                  <th>売上科目</th>
                  <th>補助科目</th>
                  <th>状態</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={8}>読み込み中…</td>
                  </tr>
                ) : (
                  chargeTypes.map((type) => (
                    <tr
                      key={type.billing_charge_type_id}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (draggingTypeId)
                          void saveOrder(
                            move(
                              chargeTypes,
                              draggingTypeId,
                              type.billing_charge_type_id,
                            ),
                          );
                        setDraggingTypeId("");
                      }}
                    >
                      <td>
                        <button
                          type="button"
                          className="drag-handle"
                          draggable
                          onDragStart={() =>
                            setDraggingTypeId(type.billing_charge_type_id)
                          }
                          onDragEnd={() => setDraggingTypeId("")}
                          aria-label={`${type.charge_type_name}をドラッグして並び替え`}
                          title="ドラッグして並び替え"
                        >
                          ⠿
                        </button>
                      </td>
                      <td>
                        <strong>{type.charge_type_name}</strong>
                      </td>
                      <td>{utilityLabels[type.utility_kind ?? ""] ?? "—"}</td>
                      <td><input type="checkbox" aria-label={`${type.charge_type_name}を固定費に設定`} checked={type.is_fixed_charge} onChange={(event) => updateRevenueDraft(type.billing_charge_type_id, { is_fixed_charge: event.target.checked })} /></td>
                      <td>{type.charge_type_name === "その他" ? "各管理表で設定" : <input className="tenant-billing-account-input" aria-label={`${type.charge_type_name}の売上科目`} inputMode="numeric" value={type.revenue_account_code ?? ""} onChange={(event) => updateRevenueDraft(type.billing_charge_type_id, { revenue_account_code: event.target.value })} />}</td>
                      <td>{type.charge_type_name === "その他" ? "—" : <input className="tenant-billing-account-input" aria-label={`${type.charge_type_name}の売上補助科目`} inputMode="numeric" value={type.revenue_subaccount_code ?? ""} onChange={(event) => updateRevenueDraft(type.billing_charge_type_id, { revenue_subaccount_code: event.target.value })} />}</td>
                      <td>
                        <span>{type.is_active ? "有効" : "無効"}</span>
                      </td>
                      <td>
                        <button type="button" className="tenant-billing-save" disabled={savingTypeId === type.billing_charge_type_id} onClick={() => void saveRevenueSetting(type)}>保存</button>
                        <button
                          type="button"
                          className="tenant-billing-delete"
                          onClick={() => void deleteChargeType(type)}
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </section>
  );
}
