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
type SavedGroup = { billing_code_allocation_group_id: string; tenant_id: string | null; allocation_mode: 'contract' | 'line_item'; members: { code: { issue_code: string } | null }[] | null };
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
  const [tenantId, setTenantId] = useState('');
  const [mode, setMode] = useState<"contract" | "line_item">("contract");
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [savedGroups, setSavedGroups] = useState<SavedGroup[]>([]);
  const [editingGroupId, setEditingGroupId] = useState('');
  useEffect(() => {
    const load = async () => {
      if (!supabase || !propertyId) {
        setLoading(false);
        return;
      }
      setLoading(true);
      const [codeResult, unitResult, groupResult] = await Promise.all([
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
        supabase.from('billing_code_allocation_group').select('billing_code_allocation_group_id, tenant_id, allocation_mode, members:billing_code_allocation_group_member(code:billing_code(issue_code))').eq('asset_id', propertyId),
      ]);
      if (codeResult.error || unitResult.error)
        setNotice(
          `複数コードの候補を読み込めませんでした: ${codeResult.error?.message ?? unitResult.error?.message}`,
        );
      setCodes((codeResult.data ?? []) as Code[]);
      setUnits((unitResult.data ?? []) as unknown as Unit[]);
      setSavedGroups((groupResult.data ?? []) as unknown as SavedGroup[]);
      setLoading(false);
    };
    void load();
  }, [propertyId]);
  const tenantCodes = codes.filter((code) =>
    selected.includes(code.billing_code_id),
  );
  const codeGroups = new Map<string, Code[]>();
  for (const code of codes) if (code.tenant_id) codeGroups.set(code.tenant_id, [...(codeGroups.get(code.tenant_id) ?? []), code]);
  useEffect(() => { const group = codeGroups.get(tenantId) ?? []; setSelected(group.map((code) => code.billing_code_id)); setAssignments({}); }, [tenantId, codes]);
  const sameTenant =
    new Set(tenantCodes.map((code) => code.tenant_id).filter(Boolean)).size <=
    1;
  const selectedTenantId = tenantCodes[0]?.tenant_id ?? null;
  const targets =
    mode === "contract"
      ? units.flatMap((unit) => (unit.allocations ?? []).filter((allocation) => { const contract = firstOf(allocation.contract); return contract?.tenant_id === selectedTenantId && contract.contract_status === "active"; }).map((allocation) => ({ id: allocation.lease_contract_unit_id, label: `${unit.unit_name || unit.unit_code}（契約）` })))
      : lineItems.map((item) => ({
          id: item.asset_billing_line_item_id,
          label: item.line_item_name,
        }));
  const save = async () => {
    if (!supabase || selected.length < 2 || !sameTenant) return;
    setNotice("");
    if (editingGroupId) { const { error: deleteError } = await supabase.from('billing_code_allocation_group').delete().eq('billing_code_allocation_group_id', editingGroupId); if (deleteError) { setNotice(`設定を更新できませんでした: ${deleteError.message}`); return; } }
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
    setNotice(editingGroupId ? "複数テナントコードの設定を更新しました。" : "複数テナントコードの設定を保存しました。");
    setSavedGroups((current) => [...current.filter((item) => item.billing_code_allocation_group_id !== editingGroupId), { billing_code_allocation_group_id: group.billing_code_allocation_group_id, tenant_id: tenantId, allocation_mode: mode, members: tenantCodes.map((code) => ({ code: { issue_code: code.issue_code } })) }]); setEditingGroupId('');
  };
  const deleteGroup = async (id: string) => { if (!supabase) return; const { error } = await supabase.from('billing_code_allocation_group').delete().eq('billing_code_allocation_group_id', id); if (error) { setNotice(`設定を削除できませんでした: ${error.message}`); return; } setSavedGroups((current) => current.filter((group) => group.billing_code_allocation_group_id !== id)); if (editingGroupId === id) setEditingGroupId(''); };
  return (
    <section className="property-billing-items">
      <div className="property-billing-items-heading">
        <h4>複数テナントコード</h4>
        <p>
          同一テナントに紐づく複数コードを選び、契約または請求する明細項目だけを請求先コードへ割り振ります。
        </p>
      </div>
      {notice && <p className="property-billing-settings-notice">{notice}</p>}
      {savedGroups.length > 0 && <div className="property-billing-settings-table-wrap"><table><thead><tr><th>テナントコード</th><th>請求の分け方</th><th /></tr></thead><tbody>{savedGroups.map((group) => <tr key={group.billing_code_allocation_group_id}><td>{(group.members ?? []).map((member) => member.code?.issue_code).filter(Boolean).join(' / ')}</td><td>{group.allocation_mode === 'contract' ? '契約から分ける' : '明細項目ごとに分ける'}</td><td><button type="button" className="text-button" onClick={() => { setEditingGroupId(group.billing_code_allocation_group_id); setTenantId(group.tenant_id ?? ''); setMode(group.allocation_mode); }}>編集</button><button type="button" className="tenant-billing-delete" onClick={() => void deleteGroup(group.billing_code_allocation_group_id)}>削除</button></td></tr>)}</tbody></table></div>}
      <div className="allocation-layout">
        <div>
          <h5>1. テナントを選択</h5>
          {loading ? (
            <p>読み込み中…</p>
          ) : (
            <><select value={tenantId} onChange={(event) => setTenantId(event.target.value)}><option value="">選択してください</option>{[...codeGroups.entries()].filter(([, group]) => group.length > 1).map(([id, group]) => <option key={id} value={id}>{group[0].recipient_name}（{group.map((code) => code.issue_code).join(' / ')}）</option>)}</select>{tenantCodes.map((code) => <p className="allocation-code" key={code.billing_code_id}><strong>{code.issue_code}</strong><span>{code.recipient_name}</span></p>)}</>
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
            <p>複数のテナントコードを持つテナントを選択してください。</p>
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
            {editingGroupId ? '設定を更新' : '設定を保存'}
          </button>
        </div>
      </div>
    </section>
  );
}
