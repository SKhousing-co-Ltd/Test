import { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";

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
  contract_start_date: string | null;
  contract_end_date: string | null;
  contract_content_reviewed_at: string | null;
  contract_document_completed_at: string | null;
  btob_registered_at: string | null;
  tenant: { tenant_name: string } | null;
  contract_units: Array<{
    unit: { unit_code: string; unit_name: string | null } | null;
  }> | null;
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
const isNewContractWorkflow = (item: QueueItem) =>
  ["新規契約稟議", "入居稟議", "定期借家まき直し稟議"].includes(
    item.workflow_type ?? "",
  );

export function ContractWorkflowPage({
  canComplete,
}: {
  canComplete: boolean;
}) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [query, setQuery] = useState("");
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
  const load = async () => {
    if (!supabase) return;
    setLoading(true);
    const [queue, contractRows] = await Promise.all([
      supabase.rpc("list_contract_workflow_queue"),
      supabase
        .from("lease_contract")
        .select(
          "lease_contract_id, contract_start_date, contract_end_date, contract_content_reviewed_at, contract_document_completed_at, btob_registered_at, tenant:tenant_master(tenant_name), contract_units:lease_contract_unit!inner(unit:unit_master!inner(unit_code, unit_name))",
        )
        .order("updated_at", { ascending: false }),
    ]);
    if (queue.error)
      setError(`AppSuiteキューを読み込めませんでした: ${queue.error.message}`);
    else setItems((queue.data ?? []) as QueueItem[]);
    if (contractRows.error)
      setError(`契約状況を読み込めませんでした: ${contractRows.error.message}`);
    else setContracts((contractRows.data ?? []) as unknown as Contract[]);
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
      Array.from(
        new Set(items.filter(isNewContractWorkflow).map(applicationType)),
      ).sort(),
    [items],
  );
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
    selectItem(item);
    if (!isNewContractWorkflow(item)) {
      setNotice(
        "この案件は既存契約の変更・解約系ワークフローです。契約候補の紐付けではなく、対応依頼で内容を確認してください。",
      );
      return;
    }
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
  return (
    <section className="contract-workflow-page">
      <section className="contract-workflow-hero">
        <div>
          <p className="section-kicker">CONTRACT WORKFLOW</p>
          <h2>契約業務フロー</h2>
          <p>
            決裁済みの申請を確認し、契約情報・契約書・BtoB登録を順番に完了します。
          </p>
        </div>
        <a className="secondary-button" href="/appsuite-sync">
          AppSuite同期を確認
        </a>
      </section>
      <ol className="contract-workflow-steps">
        <li className="done">
          <b>1</b>
          <span>AppSuite承認</span>
        </li>
        <li>
          <b>2</b>
          <span>契約内容確認</span>
        </li>
        <li>
          <b>3</b>
          <span>契約書作成</span>
        </li>
        <li>
          <b>4</b>
          <span>BtoB登録</span>
        </li>
        <li>
          <b>5</b>
          <span>レントロール反映</span>
        </li>
      </ol>
      {error && <p className="contract-workflow-message error">{error}</p>}
      {notice && <p className="contract-workflow-message">{notice}</p>}
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
      <section className="contract-workflow-panel">
        <header className="contract-workflow-panel-heading">
          <div>
            <h3>② 契約単位の進捗</h3>
            <p>
              契約内容確認・契約書作成・BtoB登録がすべて完了すると、レントロール側で反映判定されます。
            </p>
          </div>
          <div className="contract-workflow-panel-heading-actions">
            <span>{contracts.length}件</span>
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
            <div className="table-wrap">
              <table className="contract-workflow-table">
                <thead>
                  <tr>
                    <th>テナント・区画</th>
                    <th>内容確認</th>
                    <th>契約書</th>
                    <th>BtoB</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((contract) => (
                    <tr key={contract.lease_contract_id}>
                      <td>
                        <strong>
                          {contract.tenant?.tenant_name ?? "未設定"}
                        </strong>
                        <small>
                          {(contract.contract_units ?? [])
                            .map((unit) => unit.unit?.unit_code)
                            .filter(Boolean)
                            .join(", ") || "区画未設定"}
                        </small>
                      </td>
                      <td>
                        <span
                          className={
                            contract.contract_content_reviewed_at
                              ? "workflow-check complete"
                              : "workflow-check"
                          }
                        >
                          {contract.contract_content_reviewed_at
                            ? `完了 ${formatDateTime(contract.contract_content_reviewed_at)}`
                            : "未完了"}
                        </span>
                      </td>
                      <td>
                        <span
                          className={
                            contract.contract_document_completed_at
                              ? "workflow-check complete"
                              : "workflow-check"
                          }
                        >
                          {contract.contract_document_completed_at
                            ? `完了 ${formatDateTime(contract.contract_document_completed_at)}`
                            : "未完了"}
                        </span>
                      </td>
                      <td>
                        <span
                          className={
                            contract.btob_registered_at
                              ? "workflow-check complete"
                              : "workflow-check"
                          }
                        >
                          {contract.btob_registered_at ? "登録済" : "未登録"}
                        </span>
                      </td>
                      <td>
                        {canComplete && (
                          <div className="workflow-action-group">
                            <button
                              className="secondary-button workflow-complete-button"
                              disabled={
                                !!savingId ||
                                !!contract.contract_content_reviewed_at
                              }
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
                            </button>
                            <button
                              className="secondary-button workflow-complete-button"
                              disabled={
                                !!savingId ||
                                !!contract.contract_document_completed_at
                              }
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
                            >
                              契約書完了
                            </button>
                            <button
                              className="secondary-button workflow-complete-button"
                              disabled={
                                !!savingId || !!contract.btob_registered_at
                              }
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
                            >
                              登録済
                            </button>
                            <button
                              className="text-button"
                              disabled={!!savingId}
                              onClick={() =>
                                void requestChange(contract.lease_contract_id)
                              }
                            >
                              修正依頼
                            </button>
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
    </section>
  );
}
