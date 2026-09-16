import { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import type { BillingPeriod } from "./TenantBillingControls";

type ChargeType =
  | "meeting_room"
  | "electricity"
  | "electricity_increment"
  | "water"
  | "gas"
  | "fluorescent_light"
  | "other";
type ChargeFlag = { charge_type: ChargeType; is_enabled: boolean };
type BillingAssignment = {
  billing_code_id: string;
  lease_contract_unit_id: string;
  charge_type: "rent" | "common_charge";
  effective_from: string;
  effective_to: string | null;
};
type ContractCodeAllocation = { lease_contract_unit_id: string; billing_code_id: string };
type BillingCode = {
  billing_code_id: string;
  tenant_id: string | null;
  issue_code: string;
  recipient_name: string;
  invoice_display_name: string | null;
  invoice_subject: string | null;
  notes: string | null;
  is_active: boolean;
  is_primary: boolean;
  match_status: "matched" | "unmatched" | "review_required";
  flags: ChargeFlag[] | null;
  assignments: BillingAssignment[] | null;
};
type Tenant = {
  tenant_id: string;
  tenant_name: string;
  external_tenant_code: string | null;
};
type Term = {
  effective_from: string;
  effective_to: string | null;
  monthly_rent_amount: number | null;
  monthly_common_charge_amount: number | null;
};
type Allocation = {
  lease_contract_unit_id: string;
  lease_start_date: string | null;
  lease_end_date: string | null;
  monthly_rent_amount: number | null;
  monthly_common_charge_amount: number | null;
  terms: Term[] | null;
  contract:
    | {
        contract_status: string;
        contract_start_date: string | null;
        contract_end_date: string | null;
        tenant: Tenant | Tenant[] | null;
      }
    | {
        contract_status: string;
        contract_start_date: string | null;
        contract_end_date: string | null;
        tenant: Tenant | Tenant[] | null;
      }[]
    | null;
};
type Unit = {
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  floor_label: string | null;
  unit_type: string;
  allocations: Allocation[] | null;
};
type Amounts = {
  occupied: boolean;
  rent: number;
  commonCharge: number;
  parking: number;
  storage: number;
};
type AssignmentSource = {
  leaseContractUnitId: string;
  unitLabel: string;
  chargeType: "rent" | "common_charge";
  label: string;
};
type VisibleChargeType = {
  billing_charge_type_id: string;
  charge_type_name: string;
};

const currency = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
});
const flagColumns: Array<{ type: ChargeType; label: string }> = [
  { type: "meeting_room", label: "会議室利用料" },
  { type: "electricity", label: "電気代" },
  { type: "electricity_increment", label: "電気増額分" },
  { type: "water", label: "水道代" },
  { type: "gas", label: "ガス代" },
  { type: "fluorescent_light", label: "蛍光灯代" },
  { type: "other", label: "その他" },
];
const firstOf = <T,>(value: T | T[] | null | undefined): T | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
const amount = (value: number | null | undefined) => Number(value ?? 0);
const isCurrent = (allocation: Allocation, referenceDate: string) => {
  const contract = firstOf(allocation.contract);
  return Boolean(
    contract?.contract_status === "active" &&
    (!contract.contract_start_date ||
      contract.contract_start_date <= referenceDate) &&
    (!contract.contract_end_date ||
      contract.contract_end_date >= referenceDate) &&
    (!allocation.lease_start_date ||
      allocation.lease_start_date <= referenceDate) &&
    (!allocation.lease_end_date || allocation.lease_end_date >= referenceDate),
  );
};
const currentTerm = (allocation: Allocation, referenceDate: string) =>
  (allocation.terms ?? [])
    .filter(
      (term) =>
        term.effective_from <= referenceDate &&
        (!term.effective_to || term.effective_to >= referenceDate),
    )
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ??
  null;
const flagTypeFor = (name: string): ChargeType | null =>
  (({
    会議室利用料: "meeting_room",
    電気代: "electricity",
    電気増額分: "electricity_increment",
    水道代: "water",
    ガス代: "gas",
    蛍光灯代: "fluorescent_light",
    その他: "other",
  })[name] as ChargeType | undefined) ?? null;
const amountFor = (values: Amounts, name: string) =>
  name === "賃料"
    ? values.rent
    : name === "共益費"
      ? values.commonCharge
      : name === "駐車料"
        ? values.parking
        : name === "倉庫料"
          ? values.storage
          : 0;

export function BillingCodePage({
  canEdit,
  propertyId,
  period,
}: {
  canEdit: boolean;
  propertyId: string;
  period: BillingPeriod;
}) {
  const [codes, setCodes] = useState<BillingCode[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [assetCode, setAssetCode] = useState("");
  const [visibleChargeTypes, setVisibleChargeTypes] = useState<
    VisibleChargeType[]
  >([]);
  const [contractAllocations, setContractAllocations] = useState<ContractCodeAllocation[]>([]);
  const [selectedGroupKey, setSelectedGroupKey] = useState("");
  const [editingCode, setEditingCode] = useState<BillingCode | null>(null);
  const [editingTenantId, setEditingTenantId] = useState("");
  const [editingDisplayName, setEditingDisplayName] = useState("");
  const [editingSubject, setEditingSubject] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState("");
  const [error, setError] = useState("");
  const referenceDate = `${period.fiscalYear + (period.month <= 3 ? 1 : 0)}-${String(period.month).padStart(2, "0")}-01`;
  const load = async () => {
    if (!supabase || !propertyId) {
      setCodes([]);
      setUnits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    const [codeResult, unitResult, assetResult, settingResult, typeResult, contractAllocationResult] =
      await Promise.all([
        supabase
          .from("billing_code")
          .select(
            "billing_code_id, tenant_id, issue_code, recipient_name, invoice_display_name, invoice_subject, notes, is_active, is_primary, match_status, flags:billing_code_charge_flag(charge_type, is_enabled), assignments:billing_code_assignment(billing_code_id, lease_contract_unit_id, charge_type, effective_from, effective_to)",
          )
          .eq("property_id", propertyId)
          .order("issue_code"),
        supabase
          .from("unit_master")
          .select(
            `unit_id, unit_code, unit_name, floor_label, unit_type, allocations:lease_contract_unit(lease_contract_unit_id, lease_start_date, lease_end_date, monthly_rent_amount, monthly_common_charge_amount, terms:lease_contract_unit_term(effective_from, effective_to, monthly_rent_amount, monthly_common_charge_amount), contract:lease_contract(contract_status, contract_start_date, contract_end_date, tenant:tenant_master(tenant_id, tenant_name, external_tenant_code)))`,
          )
          .eq("property_id", propertyId)
          .eq("is_active", true),
        supabase
          .from("asset_master")
          .select("asset_code")
          .eq("asset_id", propertyId)
          .maybeSingle(),
        supabase
          .from("asset_billing_charge_type_setting")
          .select("billing_charge_type_id")
          .eq("asset_id", propertyId)
          .eq("is_enabled", true),
        supabase
          .from("billing_charge_type")
          .select("billing_charge_type_id, charge_type_name")
          .eq("is_active", true)
          .order("sort_order"),
        supabase.from('billing_code_contract_allocation').select('lease_contract_unit_id, billing_code_id'),
      ]);
    if (codeResult.error || unitResult.error)
      setError(
        `テナントコード一覧を読み込めませんでした: ${codeResult.error?.message ?? unitResult.error?.message}`,
      );
    setCodes((codeResult.data ?? []) as unknown as BillingCode[]);
    setUnits((unitResult.data ?? []) as unknown as Unit[]);
    setAssetCode(String(assetResult.data?.asset_code ?? ""));
    if (settingResult.error || typeResult.error)
      setError(
        `請求種別を読み込めませんでした: ${settingResult.error?.message ?? typeResult.error?.message}`,
      );
    const enabledIds = new Set(
      (settingResult.data ?? []).map((row) => row.billing_charge_type_id),
    );
    setVisibleChargeTypes(
      ((typeResult.data ?? []) as VisibleChargeType[]).filter((type) =>
        enabledIds.has(type.billing_charge_type_id),
      ),
    );
    setContractAllocations((contractAllocationResult.data ?? []) as ContractCodeAllocation[]);
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, [propertyId, referenceDate]);
  const isDepositCode = (code: BillingCode) =>
    Boolean(assetCode && code.issue_code === `${assetCode}00`);
  const tenantOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const unit of units)
      for (const allocation of unit.allocations ?? []) {
        const tenant = firstOf(firstOf(allocation.contract)?.tenant);
        if (tenant?.tenant_id) map.set(tenant.tenant_id, tenant.tenant_name);
      }
    return [...map.entries()].sort((left, right) =>
      left[1].localeCompare(right[1], "ja"),
    );
  }, [units]);
  const saveTenant = async () => {
    if (!supabase || !editingCode) return;
    const { error: saveError } = await supabase
      .from("billing_code")
      .update({
        tenant_id: editingTenantId || null,
        match_status: editingTenantId ? "matched" : "unmatched",
        invoice_display_name: editingDisplayName.trim() || null,
        invoice_subject: editingSubject.trim() || null,
      })
      .eq("billing_code_id", editingCode.billing_code_id);
    if (saveError) {
      setError(`テナント紐づけを保存できませんでした: ${saveError.message}`);
      return;
    }
    setEditingCode(null);
    void load();
  };
  const groupKeyOf = (code: BillingCode) =>
    code.recipient_name
      .normalize("NFKC")
      .replace(/[\s　]+/g, "")
      .toLocaleLowerCase("ja-JP");
  const codeGroups = useMemo(() => {
    const groups = new Map<string, BillingCode[]>();
    for (const code of codes) {
      const key = groupKeyOf(code);
      if (key) groups.set(key, [...(groups.get(key) ?? []), code]);
    }
    return groups;
  }, [codes]);
  const amountsByCode = useMemo(() => {
    const result = new Map<string, Amounts>();
    const primaryByTenant = new Map<string, BillingCode>();
    const assignmentByItem = new Map<string, BillingCode>();
    const contractCodeByUnit = new Map(contractAllocations.map((item) => [item.lease_contract_unit_id, item.billing_code_id]));
    const activeTenantIds = new Set<string>();
    for (const code of codes) {
      result.set(code.billing_code_id, {
        occupied: false,
        rent: 0,
        commonCharge: 0,
        parking: 0,
        storage: 0,
      });
      if (code.tenant_id && code.is_primary && code.is_active)
        primaryByTenant.set(code.tenant_id, code);
      for (const assignment of code.assignments ?? [])
        if (
          assignment.effective_from <= referenceDate &&
          (!assignment.effective_to || assignment.effective_to >= referenceDate)
        )
          assignmentByItem.set(
            `${assignment.lease_contract_unit_id}:${assignment.charge_type}`,
            code,
          );
    }
    for (const unit of units)
      for (const allocation of unit.allocations ?? []) {
        const contract = firstOf(allocation.contract);
        const tenant = firstOf(contract?.tenant);
        if (!tenant?.tenant_id || !isCurrent(allocation, referenceDate))
          continue;
        activeTenantIds.add(tenant.tenant_id);
        const primary = primaryByTenant.get(tenant.tenant_id);
        if (!primary) continue;
        const term = currentTerm(allocation, referenceDate);
        const rent = amount(
          term?.monthly_rent_amount ?? allocation.monthly_rent_amount,
        );
        const common = amount(
          term?.monthly_common_charge_amount ??
            allocation.monthly_common_charge_amount,
        );
        const contractTarget = codes.find((code) => code.billing_code_id === contractCodeByUnit.get(allocation.lease_contract_unit_id));
        const rentTarget = contractTarget ??
          assignmentByItem.get(`${allocation.lease_contract_unit_id}:rent`) ??
          primary;
        const commonTarget = contractTarget ??
          assignmentByItem.get(
            `${allocation.lease_contract_unit_id}:common_charge`,
          ) ?? primary;
        const rentValues = result.get(rentTarget.billing_code_id)!;
        const commonValues = result.get(commonTarget.billing_code_id)!;
        if (unit.unit_type === "parking") {
          rentValues.parking += rent;
          commonValues.parking += common;
        } else if (unit.unit_type === "storage") {
          rentValues.storage += rent;
          commonValues.storage += common;
        } else {
          rentValues.rent += rent;
          commonValues.commonCharge += common;
        }
      }
    for (const code of codes)
      if (
        code.tenant_id &&
        activeTenantIds.has(code.tenant_id) &&
        code.is_active
      )
        result.get(code.billing_code_id)!.occupied = true;
    return result;
  }, [codes, units, contractAllocations, referenceDate]);
  const selectedCodes = selectedGroupKey
    ? (codeGroups.get(selectedGroupKey) ?? [])
    : [];
  const codeTotals = [...amountsByCode.values()].reduce(
    (sum, value) => ({
      rent: sum.rent + value.rent,
      commonCharge: sum.commonCharge + value.commonCharge,
      parking: sum.parking + value.parking,
      storage: sum.storage + value.storage,
    }),
    { rent: 0, commonCharge: 0, parking: 0, storage: 0 },
  );
  const assignmentSources = useMemo(() => {
    const tenantIds = new Set(
      selectedCodes.flatMap((code) => (code.tenant_id ? [code.tenant_id] : [])),
    );
    if (!tenantIds.size) return [];
    const rows: AssignmentSource[] = [];
    for (const unit of units)
      for (const allocation of unit.allocations ?? []) {
        const tenant = firstOf(firstOf(allocation.contract)?.tenant);
        if (
          !tenant?.tenant_id ||
          !tenantIds.has(tenant.tenant_id) ||
          !isCurrent(allocation, referenceDate)
        )
          continue;
        const label = [unit.floor_label, unit.unit_name ?? unit.unit_code]
          .filter(Boolean)
          .join(" / ");
        rows.push(
          {
            leaseContractUnitId: allocation.lease_contract_unit_id,
            unitLabel: label,
            chargeType: "rent",
            label: "賃料",
          },
          {
            leaseContractUnitId: allocation.lease_contract_unit_id,
            unitLabel: label,
            chargeType: "common_charge",
            label: "共益費",
          },
        );
      }
    return rows;
  }, [selectedCodes, units, referenceDate]);
  const assignedCodeId = (source: AssignmentSource) =>
    selectedCodes.find((code) =>
      (code.assignments ?? []).some(
        (assignment) =>
          assignment.lease_contract_unit_id === source.leaseContractUnitId &&
          assignment.charge_type === source.chargeType &&
          assignment.effective_from <= referenceDate &&
          (!assignment.effective_to ||
            assignment.effective_to >= referenceDate),
      ),
    )?.billing_code_id ??
    selectedCodes.find((code) => code.is_primary)?.billing_code_id ??
    "";
  const saveAssignment = async (
    source: AssignmentSource,
    nextCodeId: string,
  ) => {
    if (!supabase || !canEdit || !selectedGroupKey) return;
    const key = `${source.leaseContractUnitId}:${source.chargeType}`;
    setSavingKey(key);
    setError("");
    const selected = selectedCodes.find(
      (code) => code.billing_code_id === nextCodeId,
    );
    const previousDate = new Date(`${referenceDate}T00:00:00`);
    previousDate.setDate(previousDate.getDate() - 1);
    const closesOn = previousDate.toISOString().slice(0, 10);
    const targetCodes = selectedCodes.map((code) => code.billing_code_id);
    const { error: closeError } = await supabase
      .from("billing_code_assignment")
      .update({ effective_to: closesOn })
      .in("billing_code_id", targetCodes)
      .eq("lease_contract_unit_id", source.leaseContractUnitId)
      .eq("charge_type", source.chargeType)
      .lt("effective_from", referenceDate)
      .or(`effective_to.is.null,effective_to.gte.${referenceDate}`);
    if (closeError) {
      setError(`請求対象の割当を更新できませんでした: ${closeError.message}`);
      setSavingKey("");
      return;
    }
    const { error: removeError } = await supabase
      .from("billing_code_assignment")
      .delete()
      .in("billing_code_id", targetCodes)
      .eq("lease_contract_unit_id", source.leaseContractUnitId)
      .eq("charge_type", source.chargeType)
      .eq("effective_from", referenceDate);
    if (removeError) {
      setError(`請求対象の割当を更新できませんでした: ${removeError.message}`);
      setSavingKey("");
      return;
    }
    if (selected && !selected.is_primary) {
      const { error: insertError } = await supabase
        .from("billing_code_assignment")
        .insert({
          billing_code_id: selected.billing_code_id,
          lease_contract_unit_id: source.leaseContractUnitId,
          charge_type: source.chargeType,
          effective_from: referenceDate,
        });
      if (insertError) {
        setError(
          `請求対象の割当を保存できませんでした: ${insertError.message}`,
        );
        setSavingKey("");
        return;
      }
    }
    setSavingKey("");
    void load();
  };
  const toggleFlag = async (code: BillingCode, chargeType: ChargeType) => {
    if (!supabase || !canEdit) return;
    const flag = (code.flags ?? []).find(
      (item) => item.charge_type === chargeType,
    );
    const { error: saveError } = await supabase
      .from("billing_code_charge_flag")
      .upsert(
        {
          billing_code_id: code.billing_code_id,
          charge_type: chargeType,
          is_enabled: !flag?.is_enabled,
        },
        { onConflict: "billing_code_id,charge_type" },
      );
    if (saveError)
      setError(`請求対象フラグを保存できませんでした: ${saveError.message}`);
    else void load();
  };
  const setCodeActive = async (code: BillingCode, isActive: boolean) => {
    if (!supabase || !canEdit || isDepositCode(code)) return;
    setSavingKey(code.billing_code_id);
    const { error: saveError } = await supabase
      .from("billing_code")
      .update({ is_active: isActive })
      .eq("billing_code_id", code.billing_code_id);
    setSavingKey("");
    if (saveError)
      setError(
        `テナントコードの状態を更新できませんでした: ${saveError.message}`,
      );
    else void load();
  };

  return (
    <section className="billing-code-page">
      {error && <p className="billing-code-notice">{error}</p>}
      <div className="billing-code-panel">
        <div className="billing-code-table-wrap">
          <table className="billing-code-table">
            <thead>
              <tr>
                <th>入居状況</th>
                <th>テナントコード</th>
                <th>請求書表示名</th>
                <th>請求書表示件名</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td
                    colSpan={5}
                    className="billing-code-empty"
                  >
                    読み込み中…
                  </td>
                </tr>
              )}
              {!loading &&
                codes.map((code) => {
                  const values = amountsByCode.get(code.billing_code_id) ?? {
                    occupied: false,
                    rent: 0,
                    commonCharge: 0,
                    parking: 0,
                    storage: 0,
                  };
                  const deposit = isDepositCode(code);
                  const status = deposit
                    ? "—"
                    : !code.is_active
                      ? "解約済み"
                      : code.match_status !== "matched" || !code.tenant_id
                        ? "未照合"
                        : values.occupied
                          ? "入居中"
                          : "解約済み";
                  return (
                    <tr
                      key={code.billing_code_id}
                      onClick={() => {
                        if (!deposit) {
                          setEditingCode(code);
                          setEditingTenantId(code.tenant_id ?? "");
                          setEditingDisplayName(code.invoice_display_name ?? "");
                          setEditingSubject(code.invoice_subject ?? "");
                        }
                      }}
                    >
                      <td>
                        <span
                          className={`billing-code-status ${status === "入居中" ? "occupied" : "terminated"}`}
                        >
                          {status}
                        </span>
                      </td>
                      <td>
                        <strong>{code.issue_code}</strong>
                      </td>
                      <td>{code.invoice_display_name || code.recipient_name}</td>
                      <td>{code.invoice_subject ?? "—"}</td>
                      <td className="billing-code-actions">
                        {!deposit && (
                          <button
                            type="button"
                            className="text-button danger"
                            disabled={
                              !canEdit || savingKey === code.billing_code_id
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              void setCodeActive(code, !code.is_active);
                            }}
                          >
                            {code.is_active ? "解約済みにする" : "有効に戻す"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              {!loading && codes.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="billing-code-empty"
                  >
                    この物件のテナントコードは未登録です。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {selectedGroupKey && (
        <section className="billing-allocation-panel">
          <header>
            <div>
              <p className="section-kicker">BILLING ALLOCATION</p>
              <h3>請求対象の割当</h3>
              <p>
                契約区画ごとの賃料・共益費を、どのテナントコードで請求するか設定します。主コードを選択すると主コードへ全額を割り当てます。
              </p>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setSelectedGroupKey("")}
            >
              閉じる
            </button>
          </header>
          <div className="billing-allocation-codes">
            {selectedCodes.map((code) => (
              <span key={code.billing_code_id}>
                {code.issue_code}
                {code.is_primary ? "（主コード）" : ""}
              </span>
            ))}
          </div>
          <div className="billing-allocation-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>契約区画</th>
                  <th>請求項目</th>
                  <th>請求先テナントコード</th>
                </tr>
              </thead>
              <tbody>
                {assignmentSources.map((source) => (
                  <tr
                    key={`${source.leaseContractUnitId}:${source.chargeType}`}
                  >
                    <td>{source.unitLabel}</td>
                    <td>{source.label}</td>
                    <td>
                      <select
                        disabled={
                          !canEdit ||
                          savingKey ===
                            `${source.leaseContractUnitId}:${source.chargeType}`
                        }
                        value={assignedCodeId(source)}
                        onChange={(event) =>
                          void saveAssignment(source, event.target.value)
                        }
                      >
                        {selectedCodes
                          .filter((code) => code.is_active)
                          .map((code) => (
                            <option
                              key={code.billing_code_id}
                              value={code.billing_code_id}
                            >
                              {code.issue_code}
                              {code.is_primary ? "（主コード）" : ""}
                            </option>
                          ))}
                      </select>
                    </td>
                  </tr>
                ))}
                {!assignmentSources.length && (
                  <tr>
                    <td colSpan={3} className="billing-code-empty">
                      この基準月に有効な契約区画がありません。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {editingCode && (
        <div
          className="billing-code-modal-backdrop"
          onClick={() => setEditingCode(null)}
        >
          <section
            className="billing-code-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <h3>テナントコードを編集</h3>
              <button type="button" onClick={() => setEditingCode(null)}>
                ×
              </button>
            </header>
            <p>
              <strong>{editingCode.issue_code}</strong>　
              {editingCode.recipient_name}
            </p>
            <label>
              紐づけるテナント
              <select
                value={editingTenantId}
                onChange={(event) => setEditingTenantId(event.target.value)}
              >
                <option value="">未紐づけ</option>
                {tenantOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>請求書表示名<input value={editingDisplayName} onChange={(event) => setEditingDisplayName(event.target.value)} /></label>
            <label>請求書表示件名<input value={editingSubject} onChange={(event) => setEditingSubject(event.target.value)} /></label>
            <footer>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setEditingCode(null)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void saveTenant()}
              >
                保存
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}

function Amount({ value }: { value: number }) {
  return <td className="numeric">{value ? currency.format(value) : "–"}</td>;
}
