import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";

type Code = {
  billing_code_id: string;
  tenant_id: string | null;
  issue_code: string;
  recipient_name: string;
  is_active: boolean;
};
type Item = {
  asset_billing_line_item_id: string;
  line_item_name: string;
  display_name: string;
};
type ContractUnit = {
  lease_contract_unit_id: string;
  lease_contract_id: string;
  unit: { unit_code: string; unit_name: string | null } | null;
  contract: { tenant_id: string; contract_status: string } | { tenant_id: string; contract_status: string }[] | null;
};
type Unit = { unit_code: string; unit_name: string | null; allocations: ContractUnit[] | null };
const firstOf = <T,>(value: T | T[] | null) => Array.isArray(value) ? value[0] ?? null : value;

export function BillingCodeAllocationSettings({
  propertyId,
  lineItems,
  canEdit,
}: {
  propertyId: string;
  lineItems: Item[];
  canEdit: boolean;
}) {
  const [codes, setCodes] = useState<Code[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<"contract" | "line_item">("contract");
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const load = async () => {
      if (!supabase || !propertyId) {
        setLoading(false);
        return;
      }
      setLoading(true);
      const [codeResult, unitResult] = await Promise.all([
        supabase
          .from("billing_code")
          .select(
            "billing_code_id, tenant_id, issue_code, recipient_name, is_active",
          )
          .eq("property_id", propertyId)
          .eq("is_active", true)
          .order("issue_code"),
        supabase
          .from("unit_master")
          .select(
            "unit_code, unit_name, allocations:lease_contract_unit(lease_contract_unit_id, lease_contract_id, contract:lease_contract(tenant_id, contract_status))",
          )
          .eq("property_id", propertyId)
          .eq("is_active", true),
      ]);
      if (codeResult.error || unitResult.error)
        setNotice(
          `複数コードの候補を読み込めませんでした: ${codeResult.error?.message ?? unitResult.error?.message}`,
        );
      setCodes((codeResult.data ?? []) as Code[]);
      setUnits((unitResult.data ?? []) as unknown as Unit[]);
      setLoading(false);
    };
    void load();
  }, [propertyId]);
  const tenantCodes = codes.filter((code) =>
    selected.includes(code.billing_code_id),
  );
  const sameTenant =
    new Set(tenantCodes.map((code) => code.tenant_id).filter(Boolean)).size <=
    1;
  const selectedTenantId = tenantCodes[0]?.tenant_id ?? null;
  const targets =
    mode === "contract"
      ? units.flatMap((unit) => (unit.allocations ?? []).filter((allocation) => { const contract = firstOf(allocation.contract); return contract?.tenant_id === selectedTenantId && contract.contract_status === "active"; }).map((allocation) => ({ id: allocation.lease_contract_unit_id, label: `${unit.unit_name || unit.unit_code}（契約）` })))
      : lineItems.map((item) => ({
          id: item.asset_billing_line_item_id,
          label: item.display_name || item.line_item_name,
        }));
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  const save = async () => {
    if (!supabase || selected.length < 2 || !sameTenant) return;
    setNotice("");
    const tenantId = tenantCodes[0]?.tenant_id ?? null;
    const { data: group, error } = await supabase
      .from("billing_code_allocation_group")
      .insert({
        asset_id: propertyId,
        tenant_id: tenantId,
        allocation_mode: mode,
      })
      .select("billing_code_allocation_group_id")
      .single();
    if (error || !group) {
      setNotice(`設定を保存できませんでした: ${error?.message ?? ""}`);
      return;
    }
    const memberError = await supabase
      .from("billing_code_allocation_group_member")
      .insert(
        selected.map((billing_code_id) => ({
          billing_code_allocation_group_id:
            group.billing_code_allocation_group_id,
          billing_code_id,
        })),
      );
    if (memberError.error) {
      setNotice(
        `コードの紐づけを保存できませんでした: ${memberError.error.message}`,
      );
      return;
    }
    if (mode === "line_item") {
      const rows = targets
        .filter((target) => assignments[target.id])
        .map((target) => ({
          billing_code_allocation_group_id:
            group.billing_code_allocation_group_id,
          asset_billing_line_item_id: target.id,
          billing_code_id: assignments[target.id],
          effective_from: new Date().toISOString().slice(0, 10),
        }));
      if (rows.length) {
        const result = await supabase
          .from("billing_code_line_item_allocation")
          .insert(rows);
        if (result.error) {
          setNotice(
            `明細項目の割当を保存できませんでした: ${result.error.message}`,
          );
          return;
        }
      }
    } else {
      const rows = targets
        .filter((target) => assignments[target.id])
        .map((target) => ({
          billing_code_allocation_group_id:
            group.billing_code_allocation_group_id,
          lease_contract_unit_id: target.id,
          billing_code_id: assignments[target.id],
          effective_from: new Date().toISOString().slice(0, 10),
        }));
      if (rows.length) {
        const result = await supabase
          .from("billing_code_contract_allocation")
          .insert(rows);
        if (result.error) {
          setNotice(
            `契約の割当を保存できませんでした: ${result.error.message}`,
          );
          return;
        }
      }
    }
    setNotice("複数テナントコードの設定を保存しました。");
  };
  return (
    <section className="property-billing-items">
      <div className="property-billing-items-heading">
        <h4>複数テナントコード</h4>
        <p>
          同一テナントのコードを複数選択し、そのテナントの契約または請求する明細項目だけを請求先コードへ割り振ります。
        </p>
      </div>
      {notice && <p className="property-billing-settings-notice">{notice}</p>}
      <div className="allocation-layout">
        <div>
          <h5>1. 紐づけるテナントコードを選択</h5>
          {loading ? (
            <p>読み込み中…</p>
          ) : (
            codes.map((code) => (
              <label className="allocation-code" key={code.billing_code_id}>
                <input
                  type="checkbox"
                  checked={selected.includes(code.billing_code_id)}
                  onChange={() => toggle(code.billing_code_id)}
                  disabled={!canEdit}
                />
                <strong>{code.issue_code}</strong>
                <span>{code.recipient_name}</span>
              </label>
            ))
          )}
        </div>
        <div>
          <h5>2. 請求の分け方</h5>
          <label>
            <input
              type="radio"
              checked={mode === "contract"}
              onChange={() => setMode("contract")}
            />{" "}
            契約から分ける
          </label>
          <label>
            <input
              type="radio"
              checked={mode === "line_item"}
              onChange={() => setMode("line_item")}
            />{" "}
            明細項目ごとに分ける
          </label>
          <h5>3. 割り当て</h5>
          {selected.length < 2 ? (
            <p>2つ以上のコードを選択してください。</p>
          ) : !sameTenant ? (
            <p>同一テナントに紐づくコードだけを選択してください。</p>
          ) : (
            <div className="allocation-targets">
              {targets.map((target) => (
                <label key={target.id}>
                  {target.label}
                  <select
                    value={assignments[target.id] ?? ""}
                    onChange={(e) =>
                      setAssignments({
                        ...assignments,
                        [target.id]: e.target.value,
                      })
                    }
                  >
                    <option value="">選択してください</option>
                    {tenantCodes.map((code) => (
                      <option
                        key={code.billing_code_id}
                        value={code.billing_code_id}
                      >
                        {code.issue_code}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {!targets.length && <p>{mode === "contract" ? "選択したテナントに有効な契約がありません。" : "請求対象の明細項目が未登録です。"}</p>}
            </div>
          )}
          <button
            className="primary-button"
            disabled={!canEdit || selected.length < 2 || !sameTenant}
            onClick={() => void save()}
          >
            設定を保存
          </button>
        </div>
      </div>
    </section>
  );
}
