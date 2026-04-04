import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { BuildRecord, BuildStats, BuildTarget, BuildComparison, CacheAnalysis } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { showToast } from "../components/Toast";
import { confirmDanger } from "../components/ConfirmDialog";
import { SkeletonRow } from "../components/Skeleton";

interface BuildsPageProps {
  onNavigate?: (target: string) => void;
  onAskAi?: (tag: string, error: string, logTail: string) => void;
}

type FilterTab = "all" | "in_progress" | "success" | "failed";

function relativeTime(ts: string): string {
  const now = Date.now();
  const diff = now - new Date(ts).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(secs: number | undefined): string {
  if (secs === undefined || secs === null) return "--";
  if (secs < 1) return "< 1s";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function statusIcon(status: BuildRecord["status"]): string {
  switch (status) {
    case "in_progress": return "\u25f7"; // spinner-like
    case "success": return "\u2713";
    case "failed": return "\u2717";
    case "cancelled": return "\u25cb";
    default: return "\u2022";
  }
}

function statusColor(status: BuildRecord["status"]): string {
  switch (status) {
    case "in_progress": return "#58a6ff";
    case "success": return "#3fb950";
    case "failed": return "#f85149";
    case "cancelled": return "#8b949e";
    default: return "#8b949e";
  }
}

function sourceLabel(source: BuildRecord["source"]): string {
  switch (source) {
    case "manual": return "Manual";
    case "file_watch": return "File Watch";
    case "scheduled": return "Scheduled";
    case "webhook": return "Webhook";
    case "url": return "URL";
    case "external": return "External";
    default: return source;
  }
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function BuildsPage(props: BuildsPageProps) {
  const [builds, setBuilds] = createSignal<BuildRecord[]>([]);
  const [stats, setStats] = createSignal<BuildStats | null>(null);
  const [filter, setFilter] = createSignal<FilterTab>("all");
  const [selectedBuild, setSelectedBuild] = createSignal<string | null>(null);
  const [buildDetail, setBuildDetail] = createSignal<BuildRecord | null>(null);
  const [buildLogs, setBuildLogs] = createSignal<string>("");
  const [logsLoading, setLogsLoading] = createSignal(false);
  const [showUrlDialog, setShowUrlDialog] = createSignal(false);
  const [urlInput, setUrlInput] = createSignal("");
  const [urlTag, setUrlTag] = createSignal("");
  const [urlBuilding, setUrlBuilding] = createSignal(false);
  const [buildTargets, setBuildTargets] = createSignal<BuildTarget[]>([]);
  const [buildingTargets, setBuildingTargets] = createSignal<Set<string>>(new Set());
  const [buildingAll, setBuildingAll] = createSignal(false);
  const [analyticsOpen, setAnalyticsOpen] = createSignal(false);

  // Compare mode state
  const [compareMode, setCompareMode] = createSignal(false);
  const [compareSelected, setCompareSelected] = createSignal<string[]>([]);
  const [comparison, setComparison] = createSignal<BuildComparison | null>(null);
  const [compareLoading, setCompareLoading] = createSignal(false);
  const [compareLogs, setCompareLogs] = createSignal<{ log1: string; log2: string } | null>(null);
  const [compareLogsLoading, setCompareLogsLoading] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);

  const refresh = async () => {
    try {
      const [buildsResult, statsResult, targetsResult] = await Promise.all([
        invoke("list_builds") as Promise<BuildRecord[]>,
        invoke("get_build_stats") as Promise<BuildStats>,
        invoke("list_build_targets") as Promise<BuildTarget[]>,
      ]);
      setBuilds(buildsResult || []);
      setStats(statsResult || null);
      setBuildTargets(targetsResult || []);
    } catch {
      // ignore
    }
    setLoaded(true);
  };

  useRefresh(refresh);
  onMount(refresh);

  const filtered = () => {
    const f = filter();
    if (f === "all") return builds();
    return builds().filter((b) => b.status === f);
  };

  const selectBuild = async (id: string) => {
    if (compareMode()) return;
    setSelectedBuild(id);
    setLogsLoading(true);
    setBuildLogs("");
    try {
      const [detail, logs] = await Promise.all([
        invoke("get_build", { id }) as Promise<BuildRecord>,
        invoke("get_build_logs", { id }) as Promise<string>,
      ]);
      setBuildDetail(detail);
      setBuildLogs(logs || "");
    } catch (e) {
      showToast(`Failed to load build: ${e}`, "error");
    } finally {
      setLogsLoading(false);
    }
  };

  const deleteBuild = async (id: string, e?: MouseEvent) => {
    e?.stopPropagation();
    if (!await confirmDanger("Delete Build", "Delete this build record and its logs?")) return;
    try {
      await invoke("delete_build", { id });
      showToast("Build deleted", "success");
      if (selectedBuild() === id) {
        setSelectedBuild(null);
        setBuildDetail(null);
      }
      await refresh();
    } catch (err) {
      showToast(`Failed to delete build: ${err}`, "error");
    }
  };

  const rebuild = async (_record: BuildRecord) => {
    if (props.onNavigate) {
      props.onNavigate("images");
    }
  };

  const submitUrlBuild = async () => {
    const url = urlInput().trim();
    if (!url) { showToast("URL is required", "error"); return; }
    setUrlBuilding(true);
    try {
      await invoke("build_from_url", {
        sourceUrl: url,
        tag: urlTag().trim() || null,
      });
      showToast("Build started from URL", "success");
      setShowUrlDialog(false);
      setUrlInput("");
      setUrlTag("");
      await refresh();
    } catch (err) {
      showToast(`Build from URL failed: ${err}`, "error");
    } finally {
      setUrlBuilding(false);
    }
  };

  const cacheColor = (analysis: CacheAnalysis): string => {
    if (analysis.total_steps === 0) return "#8b949e";
    const rate = analysis.cached_steps / analysis.total_steps;
    if (rate >= 0.7) return "#3fb950";
    if (rate >= 0.3) return "#d29922";
    return "#f85149";
  };

  const successRate = () => {
    const s = stats();
    if (!s || s.total_builds === 0) return "--";
    return Math.round((s.success_count / s.total_builds) * 100) + "%";
  };

  // -- Compare functions --
  const toggleCompareSelect = (id: string, e: MouseEvent) => {
    e.stopPropagation();
    const current = compareSelected();
    if (current.includes(id)) {
      setCompareSelected(current.filter((x) => x !== id));
    } else if (current.length < 2) {
      setCompareSelected([...current, id]);
    }
  };

  const runComparison = async () => {
    const sel = compareSelected();
    if (sel.length !== 2) return;
    setCompareLoading(true);
    setCompareLogs(null);
    try {
      const result = await invoke("compare_builds", { id1: sel[0], id2: sel[1] }) as BuildComparison;
      setComparison(result);
    } catch (e) {
      showToast(`Comparison failed: ${e}`, "error");
    } finally {
      setCompareLoading(false);
    }
  };

  const loadCompareLogs = async () => {
    const comp = comparison();
    if (!comp) return;
    setCompareLogsLoading(true);
    try {
      const [log1, log2] = await Promise.all([
        invoke("get_build_logs", { id: comp.build1.id }) as Promise<string>,
        invoke("get_build_logs", { id: comp.build2.id }) as Promise<string>,
      ]);
      setCompareLogs({ log1: log1 || "", log2: log2 || "" });
    } catch (e) {
      showToast(`Failed to load logs: ${e}`, "error");
    } finally {
      setCompareLogsLoading(false);
    }
  };

  const closeComparison = () => {
    setComparison(null);
    setCompareLogs(null);
  };

  const exitCompareMode = () => {
    setCompareMode(false);
    setCompareSelected([]);
    setComparison(null);
    setCompareLogs(null);
  };

  // -- AI debugging --
  const askAiAboutBuild = () => {
    const detail = buildDetail();
    const logs = buildLogs();
    if (!detail || !props.onAskAi) return;

    const logLines = logs.split("\n");
    const tail = logLines.slice(-50).join("\n");
    props.onAskAi(detail.tag || "(untagged)", detail.error || "Unknown error", tail);
  };

  // -- Analytics Section --
  const renderAnalytics = () => {
    const s = stats();
    if (!s) return null;

    const maxPerDay = Math.max(...(s.builds_per_day || []).map((d) => d.count), 1);
    const maxMostBuilt = Math.max(...(s.most_built || []).map((m) => m.count), 1);

    return (
      <div style={{ "margin-bottom": "16px" }}>
        <button
          onClick={() => setAnalyticsOpen(!analyticsOpen())}
          style={{
            display: "flex",
            "align-items": "center",
            gap: "8px",
            background: "none",
            border: "none",
            color: "#8b949e",
            cursor: "pointer",
            padding: "0",
            "font-weight": "500",
            "font-size": "13px",
            "margin-bottom": analyticsOpen() ? "12px" : "0",
          }}
        >
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            style={{ transform: analyticsOpen() ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
          >
            <path d="m9 18 6-6-6-6"/>
          </svg>
          Analytics
        </button>

        <Show when={analyticsOpen()}>
          <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "16px" }}>
            {/* Builds per day */}
            <div>
              <div style={{ color: "#8b949e", "font-size": "12px", "margin-bottom": "10px", "font-weight": "500" }}>
                Builds per Day (Last 7 Days)
              </div>
              <Show when={(s.builds_per_day || []).length > 0} fallback={
                <div style={{ color: "#484f58", "font-size": "13px" }}>No data</div>
              }>
                <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                  <For each={s.builds_per_day || []}>
                    {(day) => (
                      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                        <span style={{ color: "#8b949e", "font-size": "11px", "min-width": "36px", "text-align": "right" }}>
                          {formatShortDate(day.date)}
                        </span>
                        <div style={{
                          flex: "1",
                          height: "16px",
                          background: "#161b22",
                          "border-radius": "3px",
                          overflow: "hidden",
                        }}>
                          <div style={{
                            width: `${maxPerDay > 0 ? (day.count / maxPerDay) * 100 : 0}%`,
                            height: "100%",
                            background: day.count > 0 ? "#58a6ff" : "transparent",
                            "border-radius": "3px",
                            "min-width": day.count > 0 ? "2px" : "0",
                            transition: "width 0.3s",
                          }} />
                        </div>
                        <span style={{ color: "#e6edf3", "font-size": "12px", "min-width": "20px" }}>
                          {day.count}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            {/* Most built images + avg duration */}
            <div>
              <div style={{ color: "#8b949e", "font-size": "12px", "margin-bottom": "10px", "font-weight": "500" }}>
                Most Built Images
              </div>
              <Show when={(s.most_built || []).length > 0} fallback={
                <div style={{ color: "#484f58", "font-size": "13px" }}>No data</div>
              }>
                <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                  <For each={(s.most_built || []).slice(0, 5)}>
                    {(item, idx) => (
                      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                        <span style={{ color: "#484f58", "font-size": "11px", "min-width": "16px", "text-align": "right" }}>
                          {idx() + 1}.
                        </span>
                        <div style={{
                          flex: "1",
                          height: "16px",
                          background: "#161b22",
                          "border-radius": "3px",
                          overflow: "hidden",
                          position: "relative",
                        }}>
                          <div style={{
                            width: `${(item.count / maxMostBuilt) * 100}%`,
                            height: "100%",
                            background: "#3fb950",
                            "border-radius": "3px",
                            "min-width": "2px",
                          }} />
                          <span style={{
                            position: "absolute",
                            left: "6px",
                            top: "0",
                            "line-height": "16px",
                            "font-size": "11px",
                            color: "#e6edf3",
                            "white-space": "nowrap",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "max-width": "calc(100% - 12px)",
                          }}>
                            {item.tag}
                          </span>
                        </div>
                        <span style={{ color: "#8b949e", "font-size": "12px", "min-width": "24px", "text-align": "right" }}>
                          {item.count}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={(s.avg_duration_by_tag || []).length > 0}>
                <div style={{ color: "#8b949e", "font-size": "12px", "margin-bottom": "8px", "margin-top": "16px", "font-weight": "500" }}>
                  Avg Build Time by Image
                </div>
                <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                  <For each={s.avg_duration_by_tag || []}>
                    {(item) => (
                      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "font-size": "12px" }}>
                        <span style={{ color: "#e6edf3", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "max-width": "180px" }}>
                          {item.tag}
                        </span>
                        <span style={{ color: "#8b949e", "font-family": "monospace" }}>
                          {formatDuration(item.avg_secs)}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    );
  };

  // -- Comparison Modal --
  const renderComparisonModal = () => {
    const comp = comparison();
    if (!comp) return null;

    const b1 = comp.build1;
    const b2 = comp.build2;

    return (
      <div style={{
        position: "fixed",
        inset: "0",
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        "z-index": "1000",
      }} onClick={closeComparison}>
        <div
          style={{
            background: "#161b22",
            border: "1px solid #30363d",
            "border-radius": "12px",
            padding: "24px",
            "max-width": "900px",
            width: "90%",
            "max-height": "80vh",
            "overflow-y": "auto",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "20px" }}>
            <h2 style={{ margin: "0", "font-size": "18px" }}>Build Comparison</h2>
            <button class="btn btn-ghost" onClick={closeComparison} style={{ "font-size": "18px", padding: "4px 8px" }}>
              {"\u00d7"}
            </button>
          </div>

          {/* Side by side overview */}
          <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "16px", "margin-bottom": "20px" }}>
            <For each={[b1, b2]}>
              {(b) => (
                <div style={{
                  background: "#0d1117",
                  border: "1px solid #21262d",
                  "border-radius": "8px",
                  padding: "14px",
                }}>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "10px" }}>
                    <span style={{ color: statusColor(b.status), "font-weight": "bold", "font-size": "16px" }}>
                      {statusIcon(b.status)}
                    </span>
                    <span style={{ "font-weight": "600", "font-size": "14px" }}>{b.tag || "(untagged)"}</span>
                  </div>
                  <div style={{ "font-size": "12px", color: "#8b949e", display: "flex", "flex-direction": "column", gap: "4px" }}>
                    <div>Status: <span style={{ color: statusColor(b.status) }}>{b.status.replace("_", " ")}</span></div>
                    <div>Duration: <span style={{ color: "#e6edf3" }}>{formatDuration(b.duration_secs)}</span></div>
                    <div>Started: <span style={{ color: "#e6edf3" }}>{relativeTime(b.started_at)}</span></div>
                    <div>Source: <span style={{ color: "#e6edf3" }}>{sourceLabel(b.source)}</span></div>
                    <div>Dockerfile: <span style={{ color: "#e6edf3" }}>{b.dockerfile}</span></div>
                  </div>
                </div>
              )}
            </For>
          </div>

          {/* Dockerfile diff */}
          <Show when={comp.dockerfile_changed}>
            <div style={{
              background: "rgba(210, 153, 34, 0.1)",
              border: "1px solid rgba(210, 153, 34, 0.3)",
              "border-radius": "6px",
              padding: "10px 14px",
              "margin-bottom": "16px",
              "font-size": "13px",
              color: "#d29922",
            }}>
              Dockerfile path changed: <span style={{ color: "#e6edf3" }}>{b1.dockerfile}</span> {"\u2192"} <span style={{ color: "#e6edf3" }}>{b2.dockerfile}</span>
            </div>
          </Show>

          {/* Build args diff */}
          <Show when={comp.args_diff.length > 0}>
            <div style={{ "margin-bottom": "16px" }}>
              <div style={{ "font-weight": "600", "font-size": "14px", "margin-bottom": "10px" }}>Build Args Changes</div>
              <div style={{
                background: "#0d1117",
                border: "1px solid #21262d",
                "border-radius": "6px",
                overflow: "hidden",
              }}>
                <For each={comp.args_diff}>
                  {(diff) => (
                    <div style={{
                      padding: "8px 14px",
                      "border-bottom": "1px solid #21262d",
                      "font-size": "13px",
                      "font-family": "monospace",
                    }}>
                      <span style={{ color: "#58a6ff" }}>{diff.key}</span>
                      <Show when={diff.value1 === null}>
                        <span style={{ color: "#3fb950", "margin-left": "8px" }}>+ {diff.value2}</span>
                      </Show>
                      <Show when={diff.value2 === null}>
                        <span style={{ color: "#f85149", "margin-left": "8px" }}>- {diff.value1}</span>
                      </Show>
                      <Show when={diff.value1 !== null && diff.value2 !== null}>
                        <span style={{ color: "#f85149", "margin-left": "8px" }}>{diff.value1}</span>
                        <span style={{ color: "#8b949e", margin: "0 6px" }}>{"\u2192"}</span>
                        <span style={{ color: "#3fb950" }}>{diff.value2}</span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Show when={comp.args_diff.length === 0}>
            <div style={{ color: "#8b949e", "font-size": "13px", "margin-bottom": "16px" }}>No build args differences.</div>
          </Show>

          {/* Logs */}
          <Show when={!compareLogs()}>
            <button
              class="btn btn-ghost"
              onClick={loadCompareLogs}
              disabled={compareLogsLoading()}
              style={{ "font-size": "13px" }}
            >
              {compareLogsLoading() ? "Loading logs..." : "View Both Logs"}
            </button>
          </Show>
          <Show when={compareLogs()}>
            {(logs) => (
              <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "12px", "margin-top": "8px" }}>
                <div>
                  <div style={{ "font-size": "12px", color: "#8b949e", "margin-bottom": "6px" }}>Build 1 Log ({b1.tag || b1.id.slice(0, 8)})</div>
                  <pre style={{
                    background: "#0d1117",
                    border: "1px solid #21262d",
                    "border-radius": "6px",
                    padding: "10px",
                    "font-family": "monospace",
                    "font-size": "11px",
                    "line-height": "1.4",
                    "max-height": "250px",
                    "overflow-y": "auto",
                    "overflow-x": "auto",
                    color: "#e6edf3",
                    margin: "0",
                    "white-space": "pre-wrap",
                    "word-break": "break-word",
                  }}>{logs().log1 || "No logs"}</pre>
                </div>
                <div>
                  <div style={{ "font-size": "12px", color: "#8b949e", "margin-bottom": "6px" }}>Build 2 Log ({b2.tag || b2.id.slice(0, 8)})</div>
                  <pre style={{
                    background: "#0d1117",
                    border: "1px solid #21262d",
                    "border-radius": "6px",
                    padding: "10px",
                    "font-family": "monospace",
                    "font-size": "11px",
                    "line-height": "1.4",
                    "max-height": "250px",
                    "overflow-y": "auto",
                    "overflow-x": "auto",
                    color: "#e6edf3",
                    margin: "0",
                    "white-space": "pre-wrap",
                    "word-break": "break-word",
                  }}>{logs().log2 || "No logs"}</pre>
                </div>
              </div>
            )}
          </Show>
        </div>
      </div>
    );
  };

  // -- Detail View --
  const renderDetail = () => {
    const detail = buildDetail();
    if (!detail) return null;

    return (
      <div>
        <div style={{ "margin-bottom": "16px" }}>
          <button
            class="btn btn-ghost"
            onClick={() => { setSelectedBuild(null); setBuildDetail(null); }}
            style={{ display: "inline-flex", "align-items": "center", gap: "6px", padding: "6px 12px" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
            Back to list
          </button>
        </div>

        {/* Metadata card */}
        <div class="card" style={{ padding: "20px", "margin-bottom": "16px" }}>
          <div style={{ display: "flex", "align-items": "center", gap: "12px", "margin-bottom": "16px" }}>
            <span style={{
              "font-size": "20px",
              color: statusColor(detail.status),
              "font-weight": "bold",
            }}>
              {statusIcon(detail.status)}
            </span>
            <div>
              <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <span style={{ "font-weight": "600", "font-size": "16px" }}>
                  {detail.tag || "(untagged)"}
                </span>
                <Show when={detail.source === "external"}>
                  <span style={{
                    "font-size": "10px",
                    padding: "1px 6px",
                    "border-radius": "4px",
                    background: "rgba(136, 132, 216, 0.15)",
                    color: "#a78bfa",
                    border: "1px solid rgba(136, 132, 216, 0.3)",
                    "white-space": "nowrap",
                  }}>External</span>
                </Show>
              </div>
              <div style={{ color: "#8b949e", "font-size": "13px" }}>
                Build {detail.id}
              </div>
            </div>
            <div style={{ "margin-left": "auto", display: "flex", gap: "8px" }}>
              <button class="btn btn-ghost" onClick={() => rebuild(detail)}>
                Rebuild
              </button>
              <button class="btn btn-danger" onClick={() => deleteBuild(detail.id)}>
                Delete
              </button>
            </div>
          </div>

          <Show when={detail.status === "failed" && detail.error}>
            <div style={{
              background: "rgba(248, 81, 73, 0.1)",
              border: "1px solid rgba(248, 81, 73, 0.3)",
              "border-radius": "6px",
              padding: "12px",
              color: "#f85149",
              "margin-bottom": "16px",
              "font-size": "13px",
              "white-space": "pre-wrap",
              "word-break": "break-word",
              display: "flex",
              "align-items": "flex-start",
              gap: "12px",
            }}>
              <div style={{ flex: "1" }}>{detail.error}</div>
              <Show when={props.onAskAi}>
                <button
                  class="btn"
                  onClick={askAiAboutBuild}
                  style={{
                    background: "rgba(88, 166, 255, 0.15)",
                    color: "#58a6ff",
                    border: "1px solid rgba(88, 166, 255, 0.3)",
                    padding: "6px 14px",
                    "font-size": "13px",
                    "white-space": "nowrap",
                    display: "inline-flex",
                    "align-items": "center",
                    gap: "6px",
                    "border-radius": "6px",
                    cursor: "pointer",
                    "flex-shrink": "0",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg>
                  Ask AI
                </button>
              </Show>
            </div>
          </Show>

          {/* AI button for failed builds without an error message */}
          <Show when={detail.status === "failed" && !detail.error && props.onAskAi}>
            <div style={{
              background: "rgba(248, 81, 73, 0.1)",
              border: "1px solid rgba(248, 81, 73, 0.3)",
              "border-radius": "6px",
              padding: "12px",
              "margin-bottom": "16px",
              display: "flex",
              "align-items": "center",
              gap: "12px",
            }}>
              <span style={{ color: "#f85149", "font-size": "13px" }}>This build failed.</span>
              <button
                class="btn"
                onClick={askAiAboutBuild}
                style={{
                  background: "rgba(88, 166, 255, 0.15)",
                  color: "#58a6ff",
                  border: "1px solid rgba(88, 166, 255, 0.3)",
                  padding: "6px 14px",
                  "font-size": "13px",
                  display: "inline-flex",
                  "align-items": "center",
                  gap: "6px",
                  "border-radius": "6px",
                  cursor: "pointer",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg>
                Ask AI to Debug
              </button>
            </div>
          </Show>

          <div style={{
            display: "grid",
            "grid-template-columns": "repeat(auto-fill, minmax(200px, 1fr))",
            gap: "12px",
          }}>
            <div>
              <div style={{ color: "#8b949e", "font-size": "12px", "margin-bottom": "4px" }}>Status</div>
              <div style={{ color: statusColor(detail.status), "font-weight": "500" }}>
                {detail.status.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
              </div>
            </div>
            <div>
              <div style={{ color: "#8b949e", "font-size": "12px", "margin-bottom": "4px" }}>Duration</div>
              <div>{formatDuration(detail.duration_secs)}</div>
            </div>
            <div>
              <div style={{ color: "#8b949e", "font-size": "12px", "margin-bottom": "4px" }}>Started</div>
              <div>{relativeTime(detail.started_at)}</div>
            </div>
            <div>
              <div style={{ color: "#8b949e", "font-size": "12px", "margin-bottom": "4px" }}>Source</div>
              <div>{sourceLabel(detail.source)}</div>
            </div>
            <div>
              <div style={{ color: "#8b949e", "font-size": "12px", "margin-bottom": "4px" }}>Context Path</div>
              <div style={{ "word-break": "break-all", "font-size": "13px" }}>{detail.context_path}</div>
            </div>
            <div>
              <div style={{ color: "#8b949e", "font-size": "12px", "margin-bottom": "4px" }}>Dockerfile</div>
              <div style={{ "font-size": "13px" }}>{detail.dockerfile}</div>
            </div>
            <Show when={detail.image_id}>
              <div>
                <div style={{ color: "#8b949e", "font-size": "12px", "margin-bottom": "4px" }}>Image ID</div>
                <div style={{ "font-family": "monospace", "font-size": "12px" }}>{detail.image_id!.slice(0, 12)}</div>
              </div>
            </Show>
            <Show when={Object.keys(detail.build_args).length > 0}>
              <div>
                <div style={{ color: "#8b949e", "font-size": "12px", "margin-bottom": "4px" }}>Build Args</div>
                <div style={{ "font-size": "13px" }}>
                  <For each={Object.entries(detail.build_args)}>
                    {([k, v]) => <div><span style={{ color: "#58a6ff" }}>{k}</span>={v}</div>}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </div>

        {/* Cache Insights */}
        <Show when={detail.cache_analysis && detail.cache_analysis.total_steps > 0}>
          {(() => {
            const ca = detail.cache_analysis!;
            const pct = Math.round((ca.cached_steps / ca.total_steps) * 100);
            const color = cacheColor(ca);
            return (
              <div class="card" style={{ padding: "16px", "margin-bottom": "16px" }}>
                <div style={{ "font-weight": "600", "margin-bottom": "10px" }}>Cache Insights</div>
                <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                  <div style={{
                    flex: "1",
                    height: "8px",
                    background: "#21262d",
                    "border-radius": "4px",
                    overflow: "hidden",
                  }}>
                    <div style={{
                      width: `${pct}%`,
                      height: "100%",
                      background: color,
                      "border-radius": "4px",
                      transition: "width 0.3s ease",
                    }} />
                  </div>
                  <span style={{ color, "font-size": "13px", "font-weight": "500", "white-space": "nowrap" }}>
                    Cache: {ca.cached_steps}/{ca.total_steps} steps cached ({pct}%)
                  </span>
                </div>
              </div>
            );
          })()}
        </Show>

        {/* Build log */}
        <div class="card" style={{ padding: "16px" }}>
          <div style={{ "font-weight": "600", "margin-bottom": "12px", display: "flex", "align-items": "center", gap: "8px" }}>
            Build Log
            <Show when={detail.log_lines > 0}>
              <span style={{ color: "#8b949e", "font-weight": "400", "font-size": "12px" }}>
                ({detail.log_lines} lines)
              </span>
            </Show>
          </div>
          <Show when={logsLoading()}>
            <div style={{ color: "#8b949e", padding: "20px", "text-align": "center" }}>Loading logs...</div>
          </Show>
          <Show when={!logsLoading()}>
            <Show when={buildLogs()} fallback={
              <div style={{ color: "#8b949e", padding: "20px", "text-align": "center" }}>No logs available</div>
            }>
              <pre style={{
                background: "#0d1117",
                border: "1px solid #21262d",
                "border-radius": "6px",
                padding: "12px",
                "font-family": "monospace",
                "font-size": "12px",
                "line-height": "1.5",
                "overflow-x": "auto",
                "max-height": "500px",
                "overflow-y": "auto",
                color: "#e6edf3",
                margin: "0",
                "white-space": "pre-wrap",
                "word-break": "break-word",
              }}>
                {buildLogs()}
              </pre>
            </Show>
          </Show>
        </div>
      </div>
    );
  };

  // -- List View --
  const renderList = () => (
    <div>
      {/* Stats summary */}
      <Show when={stats()}>
        {(s) => (
          <div style={{
            display: "flex",
            gap: "16px",
            "margin-bottom": "16px",
            "flex-wrap": "wrap",
          }}>
            <div class="card" style={{ padding: "12px 16px", flex: "1", "min-width": "120px" }}>
              <div style={{ color: "#8b949e", "font-size": "12px" }}>Total Builds</div>
              <div style={{ "font-size": "20px", "font-weight": "600" }}>{s().total_builds}</div>
            </div>
            <div class="card" style={{ padding: "12px 16px", flex: "1", "min-width": "120px" }}>
              <div style={{ color: "#8b949e", "font-size": "12px" }}>Success Rate</div>
              <div style={{ "font-size": "20px", "font-weight": "600", color: "#3fb950" }}>{successRate()}</div>
            </div>
            <div class="card" style={{ padding: "12px 16px", flex: "1", "min-width": "120px" }}>
              <div style={{ color: "#8b949e", "font-size": "12px" }}>Failed</div>
              <div style={{ "font-size": "20px", "font-weight": "600", color: s().failure_count > 0 ? "#f85149" : undefined }}>{s().failure_count}</div>
            </div>
            <div class="card" style={{ padding: "12px 16px", flex: "1", "min-width": "120px" }}>
              <div style={{ color: "#8b949e", "font-size": "12px" }}>Avg Duration</div>
              <div style={{ "font-size": "20px", "font-weight": "600" }}>{formatDuration(s().avg_duration_secs)}</div>
            </div>
          </div>
        )}
      </Show>

      {/* Analytics expandable section */}
      {renderAnalytics()}

      {/* Filter tabs + Compare button */}
      <div style={{ display: "flex", "align-items": "center", gap: "4px", "margin-bottom": "16px" }}>
        <For each={["all", "in_progress", "success", "failed"] as FilterTab[]}>
          {(tab) => (
            <button
              class={`btn ${filter() === tab ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setFilter(tab)}
              style={{ padding: "6px 14px", "font-size": "13px" }}
            >
              {tab === "all" ? "All" : tab === "in_progress" ? "In Progress" : tab === "success" ? "Success" : "Failed"}
            </button>
          )}
        </For>
        <div style={{ "margin-left": "auto", display: "flex", gap: "8px", "align-items": "center" }}>
          <Show when={compareMode() && compareSelected().length === 2}>
            <button
              class="btn btn-primary"
              onClick={runComparison}
              disabled={compareLoading()}
              style={{ "font-size": "13px", padding: "6px 14px" }}
            >
              {compareLoading() ? "Comparing..." : "Compare Selected"}
            </button>
          </Show>
          <Show when={compareMode() && compareSelected().length < 2 && compareSelected().length > 0}>
            <span style={{ color: "#8b949e", "font-size": "12px" }}>
              Select {2 - compareSelected().length} more
            </span>
          </Show>
          <button
            class={`btn ${compareMode() ? "btn-primary" : "btn-ghost"}`}
            onClick={() => compareMode() ? exitCompareMode() : setCompareMode(true)}
            style={{ "font-size": "13px", padding: "6px 14px" }}
          >
            {compareMode() ? "Cancel Compare" : "Compare"}
          </button>
        </div>
      </div>

      {/* Table */}
      <Show when={filtered().length > 0} fallback={
        <Show when={loaded()} fallback={
          <div class="card" style={{ overflow: "hidden" }}>
            <table class="data-table" style={{ width: "100%", "border-collapse": "collapse" }}>
              <thead>
                <tr><th>Status</th><th>Tag</th><th>Duration</th><th>Started</th><th>Source</th><th>Actions</th></tr>
              </thead>
              <tbody>
                <SkeletonRow columns={6} />
                <SkeletonRow columns={6} />
                <SkeletonRow columns={6} />
                <SkeletonRow columns={6} />
              </tbody>
            </table>
          </div>
        }>
          <div class="card" style={{ padding: "40px", "text-align": "center", color: "#8b949e" }}>
            <div style={{ "font-size": "16px", "margin-bottom": "8px" }}>No builds yet</div>
            <div style={{ "font-size": "13px" }}>Build an image from the Images page or use the CLI.</div>
          </div>
        </Show>
      }>
        <div class="card" style={{ overflow: "hidden" }}>
          <table class="data-table" style={{ width: "100%", "border-collapse": "collapse" }}>
            <thead>
              <tr>
                <Show when={compareMode()}>
                  <th style={{ width: "36px", "text-align": "center" }} />
                </Show>
                <th style={{ width: "40px", "text-align": "center" }}>Status</th>
                <th>Tag</th>
                <th>Duration</th>
                <th>Started</th>
                <th>Source</th>
                <th style={{ width: "100px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              <For each={filtered()}>
                {(build) => (
                  <tr
                    onClick={() => compareMode() ? toggleCompareSelect(build.id, new MouseEvent("click")) : selectBuild(build.id)}
                    style={{ cursor: "pointer" }}
                    class="table-row-hover"
                  >
                    <Show when={compareMode()}>
                      <td style={{ "text-align": "center" }} onClick={(e) => toggleCompareSelect(build.id, e)}>
                        <div style={{
                          width: "16px",
                          height: "16px",
                          border: `2px solid ${compareSelected().includes(build.id) ? "#58a6ff" : "#30363d"}`,
                          "border-radius": "3px",
                          background: compareSelected().includes(build.id) ? "#58a6ff" : "transparent",
                          display: "inline-flex",
                          "align-items": "center",
                          "justify-content": "center",
                          transition: "all 0.15s",
                        }}>
                          <Show when={compareSelected().includes(build.id)}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                          </Show>
                        </div>
                      </td>
                    </Show>
                    <td style={{ "text-align": "center" }}>
                      <span style={{
                        color: statusColor(build.status),
                        "font-size": "16px",
                        "font-weight": "bold",
                      }} title={build.status.replace("_", " ")}>
                        {statusIcon(build.status)}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                        <span style={{ "font-weight": "500" }}>{build.tag || "(untagged)"}</span>
                        <Show when={build.source === "external"}>
                          <span style={{
                            "font-size": "10px",
                            padding: "1px 6px",
                            "border-radius": "4px",
                            background: "rgba(136, 132, 216, 0.15)",
                            color: "#a78bfa",
                            border: "1px solid rgba(136, 132, 216, 0.3)",
                            "white-space": "nowrap",
                          }}>External</span>
                        </Show>
                      </div>
                      <div style={{ color: "#8b949e", "font-size": "12px" }}>{build.context_path}</div>
                    </td>
                    <td style={{ color: "#8b949e" }}>{formatDuration(build.duration_secs)}</td>
                    <td style={{ color: "#8b949e" }}>{relativeTime(build.started_at)}</td>
                    <td style={{ color: "#8b949e" }}>{sourceLabel(build.source)}</td>
                    <td>
                      <div style={{ display: "flex", gap: "4px" }}>
                        <button
                          class="btn btn-ghost btn-sm"
                          onClick={(e) => { e.stopPropagation(); selectBuild(build.id); }}
                          title="View"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        </button>
                        <button
                          class="btn btn-ghost btn-sm"
                          onClick={(e) => deleteBuild(build.id, e)}
                          title="Delete"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );

  const startTarget = async (name: string) => {
    setBuildingTargets((prev) => { const s = new Set(prev); s.add(name); return s; });
    try {
      await invoke("start_build_target", { name });
      showToast(`Build started: ${name}`, "success");
      await refresh();
    } catch (e) {
      showToast(`Build failed: ${e}`, "error");
    } finally {
      setBuildingTargets((prev) => { const s = new Set(prev); s.delete(name); return s; });
    }
  };

  const buildAllTargets = async () => {
    const targets = buildTargets();
    if (targets.length === 0) return;
    setBuildingAll(true);
    for (const target of targets) {
      try {
        await invoke("start_build_target", { name: target.name });
        showToast(`Build started: ${target.name}`, "success");
      } catch (e) {
        showToast(`Build failed for ${target.name}: ${e}`, "error");
      }
    }
    await refresh();
    setBuildingAll(false);
  };

  // -- Build Targets Section --
  const renderTargets = () => (
    <Show when={buildTargets().length > 0}>
      <div style={{ "margin-bottom": "16px" }}>
        <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "12px" }}>
          <h2 style={{ "font-size": "16px", "font-weight": "600", margin: "0" }}>Build Targets</h2>
          <button
            class="btn btn-primary btn-sm"
            onClick={buildAllTargets}
            disabled={buildingAll()}
          >
            {buildingAll() ? "Building..." : "Build All"}
          </button>
        </div>
        <div class="card" style={{ overflow: "hidden" }}>
          <table class="data-table" style={{ width: "100%", "border-collapse": "collapse" }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Tag</th>
                <th>Context</th>
                <th>Dockerfile</th>
                <th style={{ width: "100px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              <For each={buildTargets()}>
                {(target) => (
                  <tr>
                    <td style={{ "font-weight": "500" }}>{target.name}</td>
                    <td>
                      <span class="mono" style={{ "font-size": "12px", color: "#58a6ff" }}>{target.tag}</span>
                    </td>
                    <td style={{ color: "#8b949e", "font-size": "13px" }}>{target.context}</td>
                    <td style={{ color: "#8b949e", "font-size": "13px" }}>{target.dockerfile}</td>
                    <td>
                      <button
                        class="btn btn-sm btn-primary"
                        onClick={() => startTarget(target.name)}
                        disabled={buildingTargets().has(target.name)}
                      >
                        {buildingTargets().has(target.name) ? "Building..." : "Build"}
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </div>
    </Show>
  );

  return (
    <div class="page-container">
      <div class="page-header">
        <h1>Builds</h1>
        <div style={{ display: "flex", gap: "8px" }}>
          <button class="btn" onClick={() => setShowUrlDialog(true)}>
            Build from URL
          </button>
        </div>
      </div>

      {/* Build from URL dialog */}
      <Show when={showUrlDialog()}>
        <div class="card" style={{ padding: "20px", "margin-bottom": "16px" }}>
          <div style={{ "font-weight": "600", "margin-bottom": "12px" }}>Build from URL</div>
          <div style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
            <div class="form-group">
              <label class="form-label">Source URL</label>
              <input
                class="form-input"
                type="text"
                placeholder="https://github.com/user/repo.git or Dockerfile URL"
                value={urlInput()}
                onInput={(e) => setUrlInput(e.currentTarget.value)}
              />
            </div>
            <div class="form-group">
              <label class="form-label">Tag (optional)</label>
              <input
                class="form-input"
                type="text"
                placeholder="myapp:latest"
                value={urlTag()}
                onInput={(e) => setUrlTag(e.currentTarget.value)}
              />
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                class="btn btn-primary"
                onClick={submitUrlBuild}
                disabled={urlBuilding() || !urlInput().trim()}
              >
                {urlBuilding() ? "Starting..." : "Build"}
              </button>
              <button
                class="btn btn-ghost"
                onClick={() => { setShowUrlDialog(false); setUrlInput(""); setUrlTag(""); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={!selectedBuild()}>
        {renderTargets()}
      </Show>
      <Show when={selectedBuild()} fallback={renderList()}>
        {renderDetail()}
      </Show>
      {renderComparisonModal()}
    </div>
  );
}
