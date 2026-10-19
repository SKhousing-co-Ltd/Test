import { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import { ChangeRequestWorkbenchPage } from "./ChangeRequestWorkbenchPage";
import type { AccountRole } from "./lib/contract-capabilities";

type QueueItem = {
  appsuite_record_id: string;
  app_id: string;
  data_id: string;
  ringi_number: string | null;
  workflow_type: string | null;
  property_name: string | null;
  tenant_name: string | null;
  approved_at: string | null;
  workflow_completed_at: string | null;
  match_status: string;
  active_contract_count: number;
};
type Candidate = {
  lease_contract_id: string;
  tenant_name: string;
  property_name: string;
  lease_contract_unit_id: string;
  unit_id: string;
  unit_code: string;
  floor_label: string | null;
  rentable_area_sqm?: number | null;
  contract_start_date: string | null;
  contract_end_date: string | null;
};
const applicationType = (item: QueueItem) =>
  (item.ringi_number ?? item.data_id).split("-")[1] ?? "その他";
type Contract = {
  lease_contract_id: string;
  updated_at: string | null;
  workflow_type: string | null;
  contract_type: string | null;
  contract_start_date: string | null;
  contract_end_date: string | null;
  contract_content_reviewed_at: string | null;
  contract_document_completed_at: string | null;
  btob_registered_at: string | null;
  workflow_progress?: { rent_roll_status: "reflected" | "skipped" | null; rent_roll_completed_at: string | null } | null;
  workflow_skips?: Array<{ stage_no: number; reason: string; skipped_at: string }> | null;
  tenant: { tenant_name: string } | null;
  contract_units: Array<{
    unit: { unit_code: string; unit_name: string | null; asset: { asset_name: string } | null } | null;
  }> | null;
};
const isNewContractWorkflow = (item: QueueItem) =>
  ["新規契約稟議", "入居稟議", "定期借家まき直し稟議"].includes(item.workflow_type ?? "");
const currentStage = (contract: Contract) => {
  const skipped = new Set((contract.workflow_skips ?? []).map((row) => row.stage_no));
  if (contract.workflow_progress?.rent_roll_status) return 6;
  if (!contract.contract_content_reviewed_at && !skipped.has(2)) return 2;
  if (!contract.contract_document_completed_at && !skipped.has(3)) return 3;
  if (!contract.btob_registered_at && !skipped.has(4)) return 4;
  return 5;
};
const renderStageCell = (contract: Contract, stage: number) => {
  const skipped = contract.workflow_skips?.some((row) => row.stage_no === stage) ?? false;
  const completed = stage === 1
    ? true
    : stage === 2
      ? !!contract.contract_content_reviewed_at
      : stage === 3
        ? !!contract.contract_document_completed_at
        : stage === 4
          ? !!contract.btob_registered_at
          : contract.workflow_progress?.rent_roll_status === "reflected";
  const current = !completed && !skipped && currentStage(contract) === stage;
  const label = skipped ? "スキップ済" : completed ? (stage === 1 ? "承認済・データ作成済" : "完了") : current ? ["", "", "内容確認中", "契約書作成中", "BtoB対応待ち", "自動反映待ち"][stage] : "未着手";
  const detail = skipped
    ? "理由を記録済"
    : stage === 1
      ? "AppSuite"
      : stage === 2
        ? "総務経理"
        : stage === 3
          ? "作成担当"
          : stage === 4
            ? "BtoB登録"
            : "契約情報の登録後";
  return <div className={`workflow-stage-cell ${skipped ? "skipped" : completed ? "done" : current ? "current" : "pending"}`}>
    <strong><i />{label}</strong><small>{detail}</small>
  </div>;
};

let selectedAppSuiteAppId = "65";
const appsuiteRecordUrl = (dataId: string) =>
  `https://sk-housing.dn-cloud.com/cgi-bin/dneo/appsuite.cgi?cmd=cdbbrowse&app_id=${encodeURIComponent(selectedAppSuiteAppId)}#view_id=2&id=${encodeURIComponent(dataId)}`;
const formatDate = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" }).format(
        new Date(value),
      )
    : "未設定";
const formatDateTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("ja-JP", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "未完了";
const statusLabel: Record<string, string> = {
  not_reflected: "未反映",
  waiting_completion: "確認待ち",
  ambiguous: "候補複数",
  ready_to_process: "処理可能",
};
const chunkIds = (ids: string[], size = 100) =>
  Array.from({ length: Math.ceil(ids.length / size) }, (_, index) =>
    ids.slice(index * size, (index + 1) * size),
  );
export function ContractWorkflowPage({
  canComplete,
  role,
}: {
  canComplete: boolean;
  role: AccountRole;
}) {
  const [view, setView] = useState<"progress" | "applications">("progress");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [query, setQuery] = useState("");
  const [progressQuery, setProgressQuery] = useState("");
  const [progressTypeFilter, setProgressTypeFilter] = useState("all");
  const [progressStageFilter, setProgressStageFilter] = useState("all");
  const [applicationTypeFilter, setApplicationTypeFilter] = useState("all");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [selectedItem, setSelectedItem] = useState<QueueItem | null>(null);
  const [linking, setLinking] = useState<QueueItem | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedContractId, setSelectedContractId] = useState("");
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isQueueOpen, setIsQueueOpen] = useState(true);
  const [isProgressOpen, setIsProgressOpen] = useState(true);
  const [isCompletedOpen, setIsCompletedOpen] = useState(false);
  const load = async () => {
    if (!supabase) return;
    const client = supabase;
    setLoading(true);
    const [queue, workflowLinks] = await Promise.all([
      client.rpc("list_contract_workflow_queue"),
      client
        .from("workflow_contract_link")
        .select("lease_contract_id, appsuite_record_id, updated_at")
        .order("updated_at", { ascending: false }),
    ]);
    if (queue.error)
      setError(`AppSuiteキューを読み込めませんでした: ${queue.error.message}`);
    else setItems((queue.data ?? []) as QueueItem[]);
    if (workflowLinks.error)
      setError(`契約業務フローの対象を読み込めませんでした: ${workflowLinks.error.message}`);
    else {
      const appSuiteIds = Array.from(new Set((workflowLinks.data ?? []).map((row) => row.appsuite_record_id)));
      const appSuiteResults = await Promise.all(chunkIds(appSuiteIds).map((idChunk) =>
        client.from("appsuite_record").select("appsuite_record_id, workflow_completed_at, workflow_type").in("appsuite_record_id", idChunk),
      ));
      const appSuiteError = appSuiteResults.find((result) => result.error)?.error;
      if (appSuiteError) setError(`AppSuite連携情報を読み込めませんでした: ${appSuiteError.message}`);
      const completedAppSuiteIds = new Set(appSuiteResults.flatMap((result) => result.data ?? []).filter((record) => !!record.workflow_completed_at).map((record) => record.appsuite_record_id));
      const completedLinks = (workflowLinks.data ?? []).filter((link) => completedAppSuiteIds.has(link.appsuite_record_id));
      const ids = Array.from(new Set(completedLinks.map((row) => row.lease_contract_id)));
      const workflowTypes = new Map<string, string>();
      const workflowTypeByAppSuiteId = new Map(appSuiteResults.flatMap((result) => result.data ?? []).map((record) => [record.appsuite_record_id, record.workflow_type]));
      for (const link of completedLinks) {
        const workflowType = workflowTypeByAppSuiteId.get(link.appsuite_record_id);
        if (!workflowTypes.has(link.lease_contract_id) && workflowType)
          workflowTypes.set(link.lease_contract_id, workflowType);
      }
      const idChunks = chunkIds(ids);
      const [contractResults, progressResults, skipResults] = await Promise.all([
        Promise.all(idChunks.map((idChunk) =>
          client.from("lease_contract").select("lease_contract_id, updated_at, contract_type, contract_start_date, contract_end_date, contract_content_reviewed_at, contract_document_completed_at, btob_registered_at, tenant:tenant_master(tenant_name), contract_units:lease_contract_unit!inner(unit:unit_master!inner(unit_code, unit_name, asset:asset_master(asset_name)))").in("lease_contract_id", idChunk).order("updated_at", { ascending: false }),
        )),
        Promise.all(idChunks.map((idChunk) =>
          client.from("contract_workflow_progress").select("lease_contract_id, rent_roll_status, rent_roll_completed_at").in("lease_contract_id", idChunk),
        )),
        Promise.all(idChunks.map((idChunk) =>
          client.from("contract_workflow_stage_skip").select("lease_contract_id, stage_no, reason, skipped_at").in("lease_contract_id", idChunk),
        )),
      ]);
      const contractError = contractResults.find((result) => result.error)?.error;
      const progressError = progressResults.find((result) => result.error)?.error;
      const skipError = skipResults.find((result) => result.error)?.error;
      if (contractError || progressError || skipError) setError(`契約業務フローを読み込めませんでした: ${contractError?.message ?? progressError?.message ?? skipError?.message}`);
      const rows = contractResults.flatMap((result) => (result.data ?? []) as unknown as Contract[]);
      const progress = new Map(progressResults.flatMap((result) => result.data ?? []).map((row) => [row.lease_contract_id, row]));
      const skips = new Map<string, Array<{ stage_no: number; reason: string; skipped_at: string }>>();
      for (const row of skipResults.flatMap((result) => result.data ?? [])) skips.set(row.lease_contract_id, [...(skips.get(row.lease_contract_id) ?? []), row]);
      setContracts(rows.map((row) => ({ ...row, workflow_type: workflowTypes.get(row.lease_contract_id) ?? null, workflow_progress: progress.get(row.lease_contract_id) ?? null, workflow_skips: skips.get(row.lease_contract_id) ?? [] })));
    }
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (
      !candidates.some(
        (candidate) =>
          candidate.rentable_area_sqm != null &&
          !candidate.unit_code.includes("㎡"),
      )
    )
      return;
    setCandidates((current) =>
      current.map((candidate) =>
        candidate.unit_code.includes("㎡") ||
        candidate.rentable_area_sqm == null
          ? candidate
          : {
              ...candidate,
              unit_code: `${candidate.unit_code} / ${Number(candidate.rentable_area_sqm).toLocaleString("ja-JP")}㎡`,
            },
      ),
    );
  }, [candidates]);
  useEffect(() => {
    const openAppSuiteWindow = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest(
        'a[href*="sk-housing.dn-cloud.com"]',
      ) as HTMLAnchorElement | null;
      if (!anchor) return;
      event.preventDefault();
      const popup = window.open(
        anchor.href,
        "desknets-workflow",
        "popup,width=1280,height=900,resizable=yes,scrollbars=yes",
      );
      if (!popup) window.open(anchor.href, "_blank", "noopener,noreferrer");
    };
    document.addEventListener("click", openAppSuiteWindow);

  return () => document.removeEventListener("click", openAppSuiteWindow);
  }, []);
  const filteredQueue = useMemo(() => {
    const value = query.trim().toLocaleLowerCase("ja-JP");
    const relevant = items.filter(isNewContractWorkflow);
    const byType =
      applicationTypeFilter === "all"
        ? relevant
        : relevant.filter(
            (item) => applicationType(item) === applicationTypeFilter,
          );
    return value
      ? byType.filter((item) =>
          [
            item.ringi_number,
            item.data_id,
            item.property_name,
            item.tenant_name,
          ].some((field) => field?.toLocaleLowerCase("ja-JP").includes(value)),
        )
      : byType;
  }, [applicationTypeFilter, items, query]);
  const applicationTypes = useMemo(
    () =>
      Array.from(new Set(items.filter(isNewContractWorkflow).map(applicationType))).sort(),
    [items],
  );
  const activeContracts = useMemo(
    () => contracts.filter((contract) => !contract.workflow_progress?.rent_roll_status),
    [contracts],
  );
  const filteredContracts = useMemo(() => {
    const value = progressQuery.trim().toLocaleLowerCase("ja-JP");
    return activeContracts.filter((contract) => {
      const matchesText = !value || [
        contract.contract_units?.[0]?.unit?.asset?.asset_name,
        contract.contract_units?.map((unit) => unit.unit?.unit_code).join(" "),
        contract.tenant?.tenant_name,
        contract.contract_type,
        contract.workflow_type,
      ].some((field) => field?.toLocaleLowerCase("ja-JP").includes(value));
      const stage = currentStage(contract);
      const matchesType = progressTypeFilter === "all" || (contract.workflow_type ?? contract.contract_type ?? "不明") === progressTypeFilter;
      return matchesText && matchesType && (progressStageFilter === "all" || stage === Number(progressStageFilter));
    });
  }, [activeContracts, progressQuery, progressStageFilter, progressTypeFilter]);
  const contractTypes = useMemo(
    () => Array.from(new Set(activeContracts.map((contract) => contract.workflow_type ?? contract.contract_type ?? "不明"))).sort(),
    [activeContracts],
  );
  const completedContracts = useMemo(
    () => contracts.filter((contract) => !!contract.workflow_progress?.rent_roll_status),
    [contracts],
  );
  const monthCompletedCount = completedContracts.filter((contract) => {
    const completedAt = contract.workflow_progress?.rent_roll_completed_at;
    if (!completedAt) return false;
    const date = new Date(completedAt);
    const now = new Date();
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  }).length;
  const activeStageCount = new Set(activeContracts.map(currentStage)).size;
  const btobWaitingCount = activeContracts.filter((contract) => currentStage(contract) === 4).length;
  const filteredCandidates = useMemo(() => {
    const value = candidateQuery.trim().toLocaleLowerCase("ja-JP");
    if (!value) return candidates;
    return candidates.filter((candidate) =>
      [
        candidate.tenant_name,
        candidate.property_name,
        candidate.unit_code,
        candidate.floor_label,
      ].some((field) => field?.toLocaleLowerCase("ja-JP").includes(value)),
    );
  }, [candidateQuery, candidates]);
  const selectItem = async (item: QueueItem) => {
    selectedAppSuiteAppId = item.app_id;
    setSelectedItem(item);
    setNotice("");
    setError("");
    if (!supabase || !isNewContractWorkflow(item)) return;
    setLinking(item);
    setCandidateQuery("");
    setCandidates([]);
    setSelectedContractId("");
    setSelectedUnitIds([]);
    const result = await supabase.rpc("list_workflow_contract_candidates", {
      p_appsuite_record_id: item.appsuite_record_id,
    });
    if (result.error)
      setError(`契約候補を取得できませんでした: ${result.error.message}`);
    else {
      const next = (result.data ?? []) as Candidate[];
      const unitIds = [...new Set(next.map((candidate) => candidate.unit_id))];
      const units = unitIds.length
        ? await supabase
            .from("unit_master")
            .select("unit_id, rentable_area_sqm")
            .in("unit_id", unitIds)
        : { data: [], error: null };
      const areas = new Map(
        (units.data ?? []).map((unit) => [
          unit.unit_id,
          unit.rentable_area_sqm,
        ]),
      );
      setCandidates(
        next.map((candidate) => ({
          ...candidate,
          rentable_area_sqm: areas.get(candidate.unit_id) ?? null,
        })),
      );
      if (next[0]) setSelectedContractId(next[0].lease_contract_id);
    }
  };
  const beginLink = async (item: QueueItem) => {
    if (!supabase) return;
    if (!isNewContractWorkflow(item)) {
      setSelectedItem(item);
      setView("applications");
      setNotice("変更・解約の確認画面に切り替えました。");
      return;
    }
    selectItem(item);
    setLinking(item);
    setCandidates([]);
    setSelectedContractId("");
    setSelectedUnitIds([]);
    const result = await supabase.rpc("list_workflow_contract_candidates", {
      p_appsuite_record_id: item.appsuite_record_id,
    });
    if (result.error)
      setError(`契約候補を取得できませんでした: ${result.error.message}`);
    else {
      const next = (result.data ?? []) as Candidate[];
      const unitIds = [...new Set(next.map((candidate) => candidate.unit_id))];
      const units = unitIds.length
        ? await supabase
            .from("unit_master")
            .select("unit_id, rentable_area_sqm")
            .in("unit_id", unitIds)
        : { data: [], error: null };
      const areas = new Map(
        (units.data ?? []).map((unit) => [
          unit.unit_id,
          unit.rentable_area_sqm,
        ]),
      );
      const enriched = next.map((candidate) => ({
        ...candidate,
        rentable_area_sqm: areas.get(candidate.unit_id) ?? null,
      }));
      setCandidates(enriched);
      if (enriched[0]) setSelectedContractId(enriched[0].lease_contract_id);
    }
  };
  const completeQueue = async (item: QueueItem) => {
    if (!supabase) return;
    setSavingId(item.appsuite_record_id);
    setError("");
    const result = await supabase.rpc("complete_contract_workflow", {
      p_appsuite_record_id: item.appsuite_record_id,
    });
    setSavingId(null);
    if (result.error) setError(result.error.message);
    else {
      setNotice("AppSuiteワークフローを完了しました。");
      await load();
    }
  };
  const withdrawQueue = async (item: QueueItem) => {
    if (!supabase) return;
    const reason = window.prompt(`「${item.ringi_number ?? item.data_id}」を取下げとして契約業務フローから除外します。取消を確認した理由を入力してください。`);
    if (!reason?.trim()) return;
    if (!window.confirm('この稟議を取下げ扱いにします。未紐づけの稟議だけが対象です。実行しますか？')) return;
    setSavingId(item.appsuite_record_id); setError('');
    const result = await supabase.rpc('withdraw_contract_workflow', { p_appsuite_record_id: item.appsuite_record_id, p_reason: reason.trim() });
    setSavingId(null);
    if (result.error) setError(`稟議を取下げにできませんでした: ${result.error.message}`);
    else { setNotice('稟議を取下げ扱いにし、契約業務フローから除外しました。'); setSelectedItem(null); setLinking(null); await load(); }
  };
  const linkAndComplete = async () => {
    if (!supabase || !linking || !selectedContractId) return;
    setSavingId(linking.appsuite_record_id);
    setError("");
    const result = await supabase.rpc("link_and_complete_contract_workflow", {
      p_appsuite_record_id: linking.appsuite_record_id,
      p_lease_contract_id: selectedContractId,
      p_lease_contract_unit_ids: selectedUnitIds,
      p_effective_date: null,
    });
    setSavingId(null);
    if (result.error)
      setError(`契約の紐付けに失敗しました: ${result.error.message}`);
    else {
      setNotice("契約を紐付けてAppSuiteワークフローを完了しました。");
      setLinking(null);
      await load();
    }
  };
  const runContractAction = async (
    id: string,
    rpc: string,
    params: Record<string, unknown>,
    message: string,
  ) => {
    if (!supabase) return;
    setSavingId(id);
    setError("");
    const result = await supabase.rpc(rpc, params);
    setSavingId(null);
    if (result.error)
      setError(`${message}に失敗しました: ${result.error.message}`);
    else {
      setNotice(`${message}しました。`);
      await load();
    }
  };
  const requestChange = async (id: string) => {
    const summary = window.prompt("修正内容・理由を入力してください。");
    if (!summary?.trim()) return;
    await runContractAction(
      id,
      "request_contract_workflow_change",
      {
        p_lease_contract_id: id,
        p_title: "契約業務フローの修正依頼",
        p_summary: summary.trim(),
        p_proposed_payload: { summary: summary.trim() },
      },
      "修正依頼を登録",
    );
  };
  const skipStage = async (contract: Contract, stage: number) => {
    const reason = window.prompt(`${stage}工程目をスキップする理由を入力してください。`);
    if (!reason?.trim()) return;
    await runContractAction(contract.lease_contract_id, "skip_contract_workflow_stage", {
      p_lease_contract_id: contract.lease_contract_id,
      p_stage_no: stage,
      p_reason: reason.trim(),
    }, "工程をスキップ");
  };

  const appSuiteSection = <>
      {selectedItem && (
        <section className="contract-workflow-detail">
          <header>
            <div>
              <p className="section-kicker">SELECTED APPLICATION</p>
              <h3>{selectedItem.ringi_number ?? selectedItem.data_id}</h3>
              <p>
                {selectedItem.tenant_name ?? "テナント未設定"} ／{" "}
                {selectedItem.property_name ?? "物件未設定"}
              </p>
            </div>
            <div className="contract-workflow-detail-actions">
              <a
                className="secondary-button"
                href={appsuiteRecordUrl(selectedItem.data_id)}
                target="_blank"
                rel="noreferrer"
              >
                AppSuiteで原文を確認 ↗
              </a>
              <button
                className="text-button"
                onClick={() => {
                  setSelectedItem(null);
                  setLinking(null);
                }}
              >
                閉じる
              </button>
            </div>
          </header>
          <div className="contract-workflow-checklist">
            <div>
              <strong>確認する内容</strong>
              <span>テナント・物件・区画・契約開始日・契約条件</span>
            </div>
            <div>
              <strong>照合状態</strong>
              <span className={`workflow-status ${selectedItem.match_status}`}>
                {statusLabel[selectedItem.match_status] ??
                  selectedItem.match_status}
              </span>
            </div>
            <div>
              <strong>AppSuite処理</strong>
              <span>
                {selectedItem.workflow_completed_at
                  ? `完了 ${formatDateTime(selectedItem.workflow_completed_at)}`
                  : "未完了"}
              </span>
            </div>
            <div>
              <strong>次の操作</strong>
              <span>
                {selectedItem.match_status === "ambiguous"
                  ? "契約候補を比較して正しい区画を選択"
                  : "契約を紐付けて完了"}
              </span>
            </div>
          </div>
        </section>
      )}
      {linking && (
        <section className="contract-workflow-link-panel">
          <header>
            <div>
              <strong>既存契約との紐付け</strong>
              <small>
                {linking.ringi_number ?? linking.data_id}{" "}
                の候補を確認してください
              </small>
            </div>
            <button className="text-button" onClick={() => setLinking(null)}>
              閉じる
            </button>
          </header>
          {!candidates.length ? (
            <p>
              一致する契約候補がありません。物件・テナント・区画を確認し、対応依頼として扱ってください。
            </p>
          ) : (
            <>
              <label className="contract-workflow-search">
                契約候補を検索
                <input
                  value={candidateQuery}
                  onChange={(event) => setCandidateQuery(event.target.value)}
                  placeholder="契約先・物件・階数・区画"
                />
              </label>
              <label className="workflow-field">
                契約候補
                <select
                  value={selectedContractId}
                  onChange={(event) => {
                    setSelectedContractId(event.target.value);
                    setSelectedUnitIds([]);
                  }}
                >
                  {Array.from(
                    new Map(
                      filteredCandidates.map((candidate) => [
                        candidate.lease_contract_id,
                        candidate,
                      ]),
                    ).values(),
                  ).map((candidate) => (
                    <option
                      key={candidate.lease_contract_id}
                      value={candidate.lease_contract_id}
                    >
                      {candidate.tenant_name} ／ {candidate.property_name} ／{" "}
                      {formatDate(candidate.contract_start_date)}〜
                    </option>
                  ))}
                </select>
              </label>
              <div className="contract-workflow-unit-options">
                {filteredCandidates
                  .filter(
                    (candidate) =>
                      candidate.lease_contract_id === selectedContractId,
                  )
                  .map((candidate) => (
                    <label key={candidate.lease_contract_unit_id}>
                      <input
                        type="checkbox"
                        checked={selectedUnitIds.includes(
                          candidate.lease_contract_unit_id,
                        )}
                        onChange={(event) =>
                          setSelectedUnitIds((ids) =>
                            event.target.checked
                              ? [...ids, candidate.lease_contract_unit_id]
                              : ids.filter(
                                  (id) =>
                                    id !== candidate.lease_contract_unit_id,
                                ),
                          )
                        }
                      />{" "}
                      {candidate.floor_label ?? ""} / {candidate.unit_code}
                    </label>
                  ))}
              </div>
              <button
                className="primary-button"
                disabled={!!savingId}
                onClick={() => void linkAndComplete()}
              >
                この契約・区画で紐付けて完了
              </button>
            </>
          )}
        </section>
      )}
      <section className="contract-workflow-panel">
        <header className="contract-workflow-panel-heading">
          <div>
            <h3>① AppSuite決裁キュー</h3>
            <p>
              申請原文を確認してから契約情報へ進めます。過去案件も表示されます。
            </p>
          </div>
          <div className="contract-workflow-panel-heading-actions">
            <span>{filteredQueue.length}件</span>
            <button
              className="secondary-button workflow-toggle-button"
              onClick={() => setIsQueueOpen((open) => !open)}
              aria-expanded={isQueueOpen}
            >
              {isQueueOpen ? "折り畳む" : "展開する"}
            </button>
          </div>
        </header>
        {isQueueOpen && (
          <>
            <div className="contract-workflow-toolbar">
              <label className="contract-workflow-search">
                申請番号・テナント・物件を検索
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="例：稟議番号、会社名、物件名"
                />
              </label>
              <label className="contract-workflow-search">
                申請タイプ
                <select
                  value={applicationTypeFilter}
                  onChange={(event) =>
                    setApplicationTypeFilter(event.target.value)
                  }
                >
                  <option value="all">すべて</option>
                  {applicationTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="table-wrap">
              <table className="contract-workflow-table">
                <thead>
                  <tr>
                    <th>申請</th>
                    <th>テナント・物件</th>
                    <th>承認日</th>
                    <th>照合状態</th>
                    <th>処理</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr>
                      <td colSpan={5}>読み込み中…</td>
                    </tr>
                  )}
                  {!loading &&
                    filteredQueue.map((item) => (
                      <tr
                        key={item.appsuite_record_id}
                        className={
                          selectedItem?.appsuite_record_id ===
                          item.appsuite_record_id
                            ? "selected"
                            : ""
                        }
                      >
                        <td>
                          <button
                            className="workflow-row-link"
                            onClick={() => selectItem(item)}
                          >
                            {item.ringi_number ?? item.data_id}
                          </button>
                          <small>{item.workflow_type ?? "契約申請"}</small>
                        </td>
                        <td>
                          <strong>
                            {item.tenant_name ?? "テナント未設定"}
                          </strong>
                          <small>{item.property_name ?? "物件未設定"}</small>
                        </td>
                        <td>{formatDateTime(item.approved_at)}</td>
                        <td>
                          <span
                            className={`workflow-status ${item.match_status}`}
                          >
                            {statusLabel[item.match_status] ??
                              item.match_status}
                          </span>
                          {item.match_status === "ambiguous" && (
                            <small>{item.active_contract_count}件の候補</small>
                          )}
                        </td>
                        <td>
                          <button
                            className="secondary-button workflow-complete-button"
                            onClick={() => selectItem(item)}
                          >
                            内容を確認
                          </button>
                          {canComplete && !item.workflow_completed_at && (
                            <button
                              className="primary-button workflow-complete-button"
                              disabled={!!savingId}
                              onClick={() => void beginLink(item)}
                            >
                              契約を紐付けて完了
                            </button>
                          )}
                          {canComplete && (
                            <button className="text-button workflow-withdraw-button" disabled={!!savingId} onClick={() => void withdrawQueue(item)}>取下げとして除外</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  {!loading && !filteredQueue.length && (
                    <tr>
                      <td colSpan={5} className="contract-workflow-empty">
                        該当する申請はありません。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      </>;
  return (
    <section className="contract-workflow-page">
      <section className="contract-workflow-hero">
        <div>
          <p className="section-kicker">CONTRACT OPERATIONS</p>
          <h2>契約業務フロー</h2>
          <p>申請から契約登録、BtoB対応、レントロール反映までの進捗を確認します。</p>
        </div>
        <div className="contract-workflow-head-actions">
          <button className="secondary-button" onClick={() => void load()}>↻ 更新</button>
          <button className="primary-button" onClick={() => setView("applications")}>申請処理を確認 →</button>
        </div>
      </section>
      <section className="contract-workflow-metrics" aria-label="契約業務の集計">
        <div className="metric blue"><span>進行中の案件</span><strong>{activeContracts.length}<small>件</small></strong></div>
        <div className="metric amber"><span>進行中の工程</span><strong>{activeStageCount}<small>工程</small></strong></div>
        <div className="metric"><span>BtoB対応待ち</span><strong>{btobWaitingCount}<small>件</small></strong></div>
        <div className="metric green"><span>今月の完了</span><strong>{monthCompletedCount}<small>件</small></strong></div>
      </section>
      <nav className="contract-workflow-views" aria-label="契約業務フローの表示">
        <button className={view === "progress" ? "active" : ""} onClick={() => setView("progress")}>契約後進捗 <span className="workflow-tab-count">{activeContracts.length}</span></button>
        <button className={view === "applications" ? "active" : ""} onClick={() => setView("applications")}>申請処理 <span className="workflow-tab-count">{filteredQueue.length + items.filter((item) => !isNewContractWorkflow(item)).length}</span></button>
      </nav>
      {error && <p className="contract-workflow-message error">{error}</p>}
      {notice && <p className="contract-workflow-message">{notice}</p>}
      {view === "applications" ? <>{appSuiteSection}<ChangeRequestWorkbenchPage role={role} /></> : <>
      <section className="contract-workflow-panel">
        <header className="contract-workflow-panel-heading">
          <div>
            <h3>契約後進捗</h3>
            <p>現在の工程と完了状況を案件ごとに表示します。工程をスキップすると理由が記録されます。</p>
          </div>
          <div className="contract-workflow-panel-heading-actions">
            <span>{filteredContracts.length}件</span>
            <button
              className="secondary-button workflow-toggle-button"
              onClick={() => setIsProgressOpen((open) => !open)}
              aria-expanded={isProgressOpen}
            >
              {isProgressOpen ? "折り畳む" : "展開する"}
            </button>
          </div>
        </header>
        {isProgressOpen && (
          <>
            <div className="contract-workflow-progress-toolbar">
              <label className="contract-workflow-search">
                案件を検索
                <input value={progressQuery} onChange={(event) => setProgressQuery(event.target.value)} placeholder="物件名・区画・テナント名" />
              </label>
              <label className="contract-workflow-search">
                業務種別
                <select value={progressTypeFilter} onChange={(event) => setProgressTypeFilter(event.target.value)}>
                  <option value="all">すべての業務</option>
                  {contractTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label className="contract-workflow-search">
                進捗
                <select value={progressStageFilter} onChange={(event) => setProgressStageFilter(event.target.value)}>
                  <option value="all">すべて</option>
                  <option value="2">契約内容確認</option>
                  <option value="3">契約書作成</option>
                  <option value="4">BtoB対応</option>
                  <option value="5">レントロール反映</option>
                </select>
              </label>
            </div>
            <div className="table-wrap">
              <table className="contract-workflow-table">
                <thead>
                  <tr>
                    <th>案件</th>
                    <th>① 承認・データ作成</th>
                    <th>② 内容確認</th>
                    <th>③ 契約書作成</th>
                    <th>④ BtoB対応</th>
                    <th>⑤ レントロール</th>
                    <th>詳細</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredContracts.map((contract) => (
                    <tr key={contract.lease_contract_id}>
                      <td>
                        <span className={`workflow-type-mark ${(contract.workflow_type ?? "").includes("解約") ? "cancel" : (contract.workflow_type ?? "").includes("変更") ? "change" : "new"}`}>{contract.workflow_type ?? contract.contract_type ?? "契約"}</span>
                        <strong>{contract.contract_units?.[0]?.unit?.asset?.asset_name ?? "物件未設定"}</strong>
                        <small>
                          {(contract.contract_units ?? [])
                            .map((unit) => unit.unit?.unit_code)
                            .filter(Boolean)
                            .join(", ") || "区画未設定"}　・　{contract.tenant?.tenant_name ?? "テナント未設定"}
                        </small>
                        <span className="workflow-row-progress">{currentStage(contract)}/5 工程目 ・ 更新 {formatDateTime(contract.updated_at)}</span>
                      </td>
                      <td>{renderStageCell(contract, 1)}</td>
                      <td>{renderStageCell(contract, 2)}</td>
                      <td>{renderStageCell(contract, 3)}</td>
                      <td>{renderStageCell(contract, 4)}</td>
                      <td>{renderStageCell(contract, 5)}</td>
                      <td>
                        {canComplete && (
                          <div className="workflow-action-group">
                            {currentStage(contract) === 2 && <button
                              className="secondary-button workflow-complete-button"
                              disabled={!!savingId}
                              onClick={() =>
                                void runContractAction(
                                  contract.lease_contract_id,
                                  "complete_contract_content_review",
                                  {
                                    p_lease_contract_id:
                                      contract.lease_contract_id,
                                  },
                                  "契約内容確認を完了",
                                )
                              }
                            >
                              確認完了
                            </button>}
                            {currentStage(contract) === 3 && <button
                              className="secondary-button workflow-complete-button"
                              disabled={!!savingId}
                              onClick={() =>
                                void runContractAction(
                                  contract.lease_contract_id,
                                  "complete_contract_document_workflow",
                                  {
                                    p_lease_contract_id:
                                      contract.lease_contract_id,
                                  },
                                  "契約書作成を完了",
                                )
                              }
                            >契約書完了</button>}
                            {currentStage(contract) === 4 && <button
                              className="secondary-button workflow-complete-button"
                              disabled={!!savingId}
                              onClick={() =>
                                void runContractAction(
                                  contract.lease_contract_id,
                                  "set_contract_btob_registration",
                                  {
                                    p_lease_contract_id:
                                      contract.lease_contract_id,
                                    p_registered: true,
                                  },
                                  "BtoB登録",
                                )
                              }
                            >BtoB対応完了</button>}
                            {currentStage(contract) >= 2 && currentStage(contract) <= 5 && <button className="text-button" disabled={!!savingId} onClick={() => void skipStage(contract, currentStage(contract))}>工程をスキップ</button>}
                            <button className="text-button" disabled={!!savingId} onClick={() => void requestChange(contract.lease_contract_id)}>修正依頼</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <section className="contract-workflow-panel">
        <header className="contract-workflow-panel-heading">
          <div><h3>完了案件</h3><p>レントロール反映済・スキップ済の案件を確認できます。</p></div>
          <div className="contract-workflow-panel-heading-actions">
            <span>{completedContracts.length}件</span>
            <button className="secondary-button workflow-toggle-button" onClick={() => setIsCompletedOpen((open) => !open)} aria-expanded={isCompletedOpen}>{isCompletedOpen ? "折り畳む" : "展開する"}</button>
          </div>
        </header>
        {isCompletedOpen && <>
        <div className="table-wrap">
          <table className="contract-workflow-table">
            <thead><tr><th>物件・区画・テナント</th><th>契約種別</th><th>状態</th><th>完了日時</th></tr></thead>
            <tbody>
              {completedContracts.map((contract) => <tr key={contract.lease_contract_id}>
                <td><strong>{contract.contract_units?.[0]?.unit?.asset?.asset_name ?? "物件未設定"}</strong><small>{(contract.contract_units ?? []).map((unit) => unit.unit?.unit_code).filter(Boolean).join(", ") || "区画未設定"}　/　{contract.tenant?.tenant_name ?? "テナント未設定"}</small></td>
                <td>{contract.contract_type ?? "—"}</td>
                <td><span className="workflow-check complete">{contract.workflow_progress?.rent_roll_status === "reflected" ? "反映済" : "スキップ済"}</span></td>
                <td>{formatDateTime(contract.workflow_progress?.rent_roll_completed_at ?? null)}</td>
              </tr>)}
              {!completedContracts.length && <tr><td colSpan={4} className="contract-workflow-empty">完了案件はありません。</td></tr>}
            </tbody>
          </table>
        </div>
        </>}
      </section>
      </>}
    </section>
  );
}