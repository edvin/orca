import { createSignal, onMount, onCleanup, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Container, ContainerStats } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { formatBytes, formatTimestamp, shortId, formatPorts } from "../lib/format";
import { showToast } from "../components/Toast";
import { confirmDanger } from "../components/ConfirmDialog";
import LogViewer from "../components/LogViewer";
import XTerminal from "../components/XTerminal";
import CopyButton from "../components/CopyButton";
import Spinner from "../components/Spinner";
import ResourceBar from "../components/ResourceBar";
import Sparkline from "../components/Sparkline";
import { recordMetrics, getCpuHistory, getMemoryHistory } from "../lib/metricsStore";
import { copyToClipboard } from "../lib/clipboard";
import Breadcrumb from "../components/Breadcrumb";
import Dropdown from "../components/Dropdown";
import { logError } from "../lib/activityStore";

interface ContainerDetailPageProps {
  containerId: string;
  onBack: () => void;
  onNavigate?: (target: string) => void;
  breadcrumbStack?: string | null;
}

type DetailTab = "overview" | "logs" | "terminal" | "inspect" | "volumes" | "resources" | "export" | "files";

export default function ContainerDetailPage(props: ContainerDetailPageProps) {
  const [container, setContainer] = createSignal<Container | null>(null);
  const [stats, setStats] = createSignal<ContainerStats | null>(null);
  const [inspectData, setInspectData] = createSignal<any>(null);
  const [activeTab, setActiveTab] = createSignal<DetailTab>("overview");
  const [loading, setLoading] = createSignal(false);
  const [actionInProgress, setActionInProgress] = createSignal(false);
  const [dockerRunCmd, setDockerRunCmd] = createSignal<string | null>(null);
  const [composeYaml, setComposeYaml] = createSignal<string | null>(null);

  // Resource editing state
  const [editMemory, setEditMemory] = createSignal("");
  const [editCpu, setEditCpu] = createSignal("");
  const [editRestart, setEditRestart] = createSignal("no");
  const [resourceSaving, setResourceSaving] = createSignal(false);

  // File browser state
  interface FileEntry { name: string; size: string; permissions: string; modified: string; is_dir: boolean; link_target?: string }
  const [fileBrowserPath, setFileBrowserPath] = createSignal("/");
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = createSignal(false);
  const [fileError, setFileError] = createSignal<string | null>(null);
  const [fileContent, setFileContent] = createSignal<string | null>(null);
  const [fileContentPath, setFileContentPath] = createSignal("");

  // Commit dialog state
  const [showCommitDialog, setShowCommitDialog] = createSignal(false);
  const [commitRepo, setCommitRepo] = createSignal("");
  const [commitTag, setCommitTag] = createSignal("latest");
  const [committing, setCommitting] = createSignal(false);

  let statsInterval: ReturnType<typeof setInterval> | undefined;

  const fetchContainer = async () => {
    try {
      const containers = (await invoke("list_containers")) as Container[];
      const c = containers.find((x) => x.id === props.containerId);
      if (c) setContainer(c);
    } catch (e) {
    }
  };

  useRefresh(fetchContainer);

  const fetchStats = async () => {
    try {
      const s = (await invoke("container_stats", { id: props.containerId })) as ContainerStats;
      setStats(s);
      recordMetrics(props.containerId, {
        timestamp: Date.now(),
        cpu: s.cpu_percent,
        memory: s.memory_usage_bytes,
        memoryLimit: s.memory_limit_bytes,
        networkRx: s.network_rx_bytes,
        networkTx: s.network_tx_bytes,
      });
    } catch {
      // Container may not be running
    }
  };

  const fetchInspect = async () => {
    try {
      const data = await invoke("inspect_container", { id: props.containerId });
      setInspectData(data);
    } catch {
      // May fail
    }
  };

  const startStatsRefresh = () => {
    stopStatsRefresh();
    fetchStats();
    statsInterval = setInterval(fetchStats, 3000);
  };

  const stopStatsRefresh = () => {
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = undefined;
    }
  };

  onMount(async () => {
    setLoading(true);
    await Promise.all([fetchContainer(), fetchInspect()]);
    setLoading(false);

    // Start stats refresh if running
    const c = container();
    if (c?.state === "Running") {
      startStatsRefresh();
    }

    // Poll container state
    const interval = setInterval(async () => {
      await fetchContainer();
      const cur = container();
      if (cur?.state === "Running" && !statsInterval) {
        startStatsRefresh();
      } else if (cur?.state !== "Running" && statsInterval) {
        stopStatsRefresh();
      }
    }, 3000);

    onCleanup(() => {
      clearInterval(interval);
      stopStatsRefresh();
    });
  });

  const switchTab = (tab: DetailTab) => {
    setActiveTab(tab);
    if (tab === "overview" && container()?.state === "Running") {
      startStatsRefresh();
    } else if (tab !== "overview") {
      stopStatsRefresh();
    }

    if (tab === "resources") {
      initResourceFields();
    }
    if (tab === "export") {
      fetchExportData();
    }
    if (tab === "files") {
      setFileBrowserPath("/");
      setFileContent(null);
      setFileError(null);
      fetchContainerFiles("/");
    }
  };

  const fetchExportData = async () => {
    try {
      const [run, compose] = await Promise.allSettled([
        invoke("export_docker_run", { id: props.containerId }),
        invoke("export_compose", { id: props.containerId }),
      ]);
      if (run.status === "fulfilled") setDockerRunCmd(run.value as string);
      if (compose.status === "fulfilled") setComposeYaml(compose.value as string);
    } catch {
      // May fail
    }
  };

  const initResourceFields = () => {
    const data = inspectData();
    if (!data) return;
    // Memory: show in MB if set, empty if unlimited
    const memBytes = data.memory_limit;
    if (memBytes && memBytes > 0) {
      const mb = memBytes / (1024 * 1024);
      if (mb >= 1024 && mb % 1024 === 0) {
        setEditMemory(`${mb / 1024}`);
      } else {
        setEditMemory(`${Math.round(mb)}`);
      }
    } else {
      setEditMemory("");
    }
    // CPU: show cores if set
    const cpuCores = data.cpu_limit;
    if (cpuCores && cpuCores > 0) {
      setEditCpu(`${cpuCores}`);
    } else {
      setEditCpu("");
    }
    // Restart policy
    setEditRestart(data.restart_policy || "no");
  };

  // --- File Browser ---
  const fetchContainerFiles = async (path: string) => {
    setFilesLoading(true);
    setFileContent(null);
    setFileError(null);
    try {
      const result = (await invoke("container_list_files", { id: props.containerId, path })) as { entries: FileEntry[]; path: string };
      setFiles(result.entries);
      setFileBrowserPath(path || "/");
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as any)?.message || String(e);
      logError(`Failed to browse container files: ${msg}`, `Container ${props.containerId}, path "${path}"`);
      setFileError(msg);
      setFiles([]);
    } finally {
      setFilesLoading(false);
    }
  };

  const navigateToDir = (dirName: string) => {
    const current = fileBrowserPath();
    const newPath = current === "/" ? `/${dirName}` : `${current}/${dirName}`;
    fetchContainerFiles(newPath);
  };

  const navigateUp = () => {
    const current = fileBrowserPath();
    const parent = current.substring(0, current.lastIndexOf("/")) || "/";
    fetchContainerFiles(parent);
  };

  const navigateToSegment = (index: number) => {
    const segments = fileBrowserPath().split("/").filter(Boolean);
    const newPath = "/" + segments.slice(0, index + 1).join("/");
    fetchContainerFiles(newPath);
  };

  const readContainerFile = async (filePath: string) => {
    const current = fileBrowserPath();
    const fullPath = current === "/" ? `/${filePath}` : `${current}/${filePath}`;
    try {
      const result = (await invoke("container_read_file", { id: props.containerId, path: fullPath })) as { content: string };
      setFileContent(result.content);
      setFileContentPath(filePath);
    } catch (e) {
      logError(`Failed to read container file: ${e}`, `Container ${props.containerId}, path "${fullPath}"`);
      showToast(`Failed to read file: ${e}`, "error");
    }
  };

  // --- Container Commit ---
  const doCommit = async () => {
    const repo = commitRepo().trim();
    if (!repo) {
      showToast("Repository name is required", "error");
      return;
    }
    setCommitting(true);
    try {
      const tag = commitTag().trim() || "latest";
      await invoke("commit_container", { id: props.containerId, repo, tag });
      showToast(`Image created: ${repo}:${tag}`, "success");
      setShowCommitDialog(false);
      setCommitRepo("");
      setCommitTag("latest");
    } catch (e) {
      logError(`Failed to commit container: ${e}`, `Container ${container()?.name || props.containerId}`);
      showToast(`Commit failed: ${e}`, "error");
    } finally {
      setCommitting(false);
    }
  };

  const saveResources = async () => {
    setResourceSaving(true);
    try {
      const memStr = editMemory().trim();
      const cpuStr = editCpu().trim();

      // Build the update params
      const params: any = { id: props.containerId };

      if (memStr) {
        const num = parseFloat(memStr);
        if (!isNaN(num) && memStr === `${num}`) {
          params.memory_limit = `${num}m`;
        } else {
          params.memory_limit = memStr;
        }
      }

      if (cpuStr) {
        const cpuNum = parseFloat(cpuStr);
        if (!isNaN(cpuNum) && cpuNum > 0) {
          params.cpu_limit = cpuNum;
        }
      }

      params.restart_policy = editRestart();

      await invoke("update_container", params);
      showToast("Resources updated", "success");
      // Re-fetch to reflect new values
      await fetchInspect();
    } catch (err) {
      const cName = container()?.name || props.containerId;
      logError(`Failed to update container resources: ${err}`, `Container "${cName}"`);
      showToast(`Update failed: ${err}`, "error");
    }
    setResourceSaving(false);
  };

  const doAction = async (action: string) => {
    setActionInProgress(true);
    try {
      await invoke(action, { id: props.containerId });
      showToast(`Container ${action.replace("_container", "")} successful`, "success");
      await fetchContainer();
    } catch (err) {
      const cName = container()?.name || props.containerId;
      logError(`Failed to ${action.replace("_container", "")} container: ${err}`, `Container "${cName}"`);
      showToast(`${action} failed: ${err}`, "error");
    }
    setActionInProgress(false);
  };

  const doRestart = async () => {
    setActionInProgress(true);
    try {
      await invoke("stop_container", { id: props.containerId });
      await invoke("start_container", { id: props.containerId });
      showToast("Container restart successful", "success");
      await fetchContainer();
    } catch (err) {
      const cName = container()?.name || props.containerId;
      logError(`Failed to restart container: ${err}`, `Container "${cName}"`);
      showToast(`Restart failed: ${err}`, "error");
    }
    setActionInProgress(false);
  };

  const doRemove = async () => {
    const c = container();
    if (!c) return;
    if (!await confirmDanger("Remove Container", `Remove container '${c.name}'? This cannot be undone.`)) return;
    setActionInProgress(true);
    try {
      await invoke("remove_container", { id: props.containerId });
      showToast("Container removed", "success");
      props.onBack();
    } catch (err) {
      const cName = container()?.name || props.containerId;
      logError(`Failed to remove container: ${err}`, `Container "${cName}"`);
      showToast(`Remove failed: ${err}`, "error");
      setActionInProgress(false);
    }
  };

  const stateClass = (state: string) => {
    switch (state) {
      case "Running": return "state-running";
      case "Exited": return "state-exited";
      case "Created": return "state-created";
      case "Paused": return "state-paused";
      default: return "state-stopped";
    }
  };

  const memPercent = (s: ContainerStats) => {
    if (!s.memory_limit_bytes || s.memory_limit_bytes === 0) return 0;
    return (s.memory_usage_bytes / s.memory_limit_bytes) * 100;
  };

  const getContainerEnv = (): string[] => {
    const data = inspectData();
    if (!data) return [];
    const env = data?.Config?.Env || data?.config?.env || data?.env || [];
    return Array.isArray(env) ? env : [];
  };

  const getContainerMounts = (): any[] => {
    const data = inspectData();
    if (!data) return [];
    return data?.mounts || data?.Mounts || [];
  };

  const getContainerCommand = (): string[] => {
    const data = inspectData();
    if (!data) return [];
    return data?.command || data?.Config?.Cmd || [];
  };

  const deduplicatePorts = (ports: { host_ip?: string | null; host_port: number; container_port: number; protocol?: string }[]) => {
    const seen = new Set<string>();
    return ports.filter((p) => {
      const key = `${p.host_port}:${p.container_port}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const formatUptime = (createdAt: string | number | undefined | null): string => {
    if (!createdAt) return "-";
    try {
      let created: Date;
      if (typeof createdAt === "number") {
        created = new Date(createdAt < 1e12 ? createdAt * 1000 : createdAt);
      } else {
        // Try parsing as number first (string "1234567890")
        const num = Number(createdAt);
        if (!isNaN(num) && num > 1e8) {
          created = new Date(num < 1e12 ? num * 1000 : num);
        } else {
          created = new Date(createdAt);
        }
      }
      if (isNaN(created.getTime())) return "-";
      const now = new Date();
      const diff = now.getTime() - created.getTime();
      if (diff < 0) return "-";
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      if (days > 0) return `${days}d ${hours}h`;
      if (hours > 0) return `${hours}h ${minutes}m`;
      if (minutes > 0) return `${minutes}m`;
      return "< 1m";
    } catch {
      return "-";
    }
  };

  return (
    <div class="detail-page">
      {/* Breadcrumb */}
      <Breadcrumb
        items={
          props.breadcrumbStack
            ? [
                { label: "Containers", onClick: () => props.onNavigate?.("containers") },
                { label: props.breadcrumbStack, onClick: () => props.onNavigate?.(`stack:${props.breadcrumbStack}`) },
                { label: container()?.name ?? "..." },
              ]
            : [
                { label: "Containers", onClick: () => props.onBack() },
                { label: container()?.name ?? "..." },
              ]
        }
      />

      {/* Header bar */}
      <div class="detail-page-header">

        <Show when={container()} fallback={
          <div class="detail-page-info">
            <div class="detail-page-name">Loading...</div>
          </div>
        }>
          {(c) => (
            <>
              <div class="detail-page-info">
                <div class="detail-page-name">{c().name}</div>
                <div class="detail-page-image">{c().image}</div>
              </div>

              <span class={`state-badge ${stateClass(c().state)}`}>
                {c().state}
              </span>

              <div class={`detail-page-actions action-icons ${actionInProgress() ? "loading" : ""}`}>
                <Show when={actionInProgress()}>
                  <div class="action-spinner"><Spinner size={14} /></div>
                </Show>
                <Show when={c().state !== "Running"}>
                  <button
                    class="action-icon action-icon-start"
                    onClick={() => doAction("start_container")}
                    disabled={actionInProgress()}
                    title="Start"
                  >
                    &#9654;
                  </button>
                </Show>
                <Show when={c().state === "Running"}>
                  <button
                    class="action-icon action-icon-stop"
                    onClick={() => doAction("stop_container")}
                    disabled={actionInProgress()}
                    title="Stop"
                  >
                    &#9632;
                  </button>
                  <button
                    class="action-icon"
                    onClick={doRestart}
                    disabled={actionInProgress()}
                    title="Restart"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
                  </button>
                </Show>
                <Show when={c().state !== "Running"}>
                  <button
                    class="action-icon action-icon-delete"
                    onClick={doRemove}
                    disabled={actionInProgress()}
                    title="Remove container"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                  </button>
                </Show>
                <button
                  class="action-icon"
                  onClick={() => setShowCommitDialog(true)}
                  disabled={actionInProgress()}
                  title="Save as Image"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                </button>
              </div>
            </>
          )}
        </Show>
      </div>

      {/* Tab bar */}
      <div class="detail-tab-bar">
        <button
          class={`detail-tab-item ${activeTab() === "overview" ? "active" : ""}`}
          onClick={() => switchTab("overview")}
        >
          Overview
        </button>
        <button
          class={`detail-tab-item ${activeTab() === "logs" ? "active" : ""}`}
          onClick={() => switchTab("logs")}
        >
          Logs
        </button>
        <Show when={container()?.state === "Running"}>
          <button
            class={`detail-tab-item ${activeTab() === "terminal" ? "active" : ""}`}
            onClick={() => switchTab("terminal")}
          >
            Terminal
          </button>
        </Show>
        <Show when={container()?.state === "Running"}>
          <button
            class={`detail-tab-item ${activeTab() === "files" ? "active" : ""}`}
            onClick={() => switchTab("files")}
          >
            Files
          </button>
        </Show>
        <button
          class={`detail-tab-item ${activeTab() === "inspect" ? "active" : ""}`}
          onClick={() => switchTab("inspect")}
        >
          Inspect
        </button>
        <button
          class={`detail-tab-item ${activeTab() === "volumes" ? "active" : ""}`}
          onClick={() => switchTab("volumes")}
        >
          Volumes
        </button>
        <button
          class={`detail-tab-item ${activeTab() === "resources" ? "active" : ""}`}
          onClick={() => switchTab("resources")}
        >
          Resources
        </button>
        <button
          class={`detail-tab-item ${activeTab() === "export" ? "active" : ""}`}
          onClick={() => switchTab("export")}
        >
          Export
        </button>
      </div>

      {/* Tab content */}
      <div class="detail-tab-content">
        {/* Overview tab */}
        <Show when={activeTab() === "overview"}>
          <div class="detail-overview">
            {/* Stat cards */}
            <div class="detail-stats-row">
              <div class="detail-stat-card">
                <div class="detail-stat-label">CPU</div>
                <Show when={stats()} fallback={
                  <div class="detail-stat-value" style={{ color: "#484f58" }}>
                    {container()?.state === "Running" ? "-" : "N/A"}
                  </div>
                }>
                  {(s) => (
                    <>
                      <div class="detail-stat-value">{s().cpu_percent.toFixed(1)}%</div>
                      <div class="detail-stat-bar">
                        <ResourceBar
                          value={s().cpu_percent}
                          label=""
                        />
                      </div>
                      <div class="detail-stat-sparkline">
                        <Sparkline
                          data={getCpuHistory(props.containerId)}
                          width={120}
                          height={28}
                          color="#58a6ff"
                          max={100}
                        />
                      </div>
                    </>
                  )}
                </Show>
              </div>

              <div class="detail-stat-card">
                <div class="detail-stat-label">Memory</div>
                <Show when={stats()} fallback={
                  <div class="detail-stat-value" style={{ color: "#484f58" }}>
                    {container()?.state === "Running" ? "-" : "N/A"}
                  </div>
                }>
                  {(s) => {
                    const hasLimit = memPercent(s()) > 1;
                    return (
                    <>
                      <div class="detail-stat-value">
                        {formatBytes(s().memory_usage_bytes)}
                        <Show when={hasLimit}>
                          <span class="detail-stat-secondary">
                            {" / "}{formatBytes(s().memory_limit_bytes)}
                          </span>
                        </Show>
                      </div>
                      <Show when={hasLimit}>
                        <div class="detail-stat-bar">
                          <ResourceBar
                            value={memPercent(s())}
                            label=""
                          />
                        </div>
                      </Show>
                      <div class="detail-stat-sparkline">
                        <Sparkline
                          data={getMemoryHistory(props.containerId)}
                          width={120}
                          height={28}
                          color="#a371f7"
                          max={100}
                        />
                      </div>
                    </>
                  );}}
                </Show>
              </div>

              <div class="detail-stat-card">
                <div class="detail-stat-label">Network I/O</div>
                <Show when={stats()} fallback={
                  <div class="detail-stat-value" style={{ color: "#484f58" }}>
                    {container()?.state === "Running" ? "-" : "N/A"}
                  </div>
                }>
                  {(s) => (
                    <div class="detail-stat-value" style={{ "font-size": "16px" }}>
                      <span style={{ color: "#58a6ff" }}>{"\u2193"}</span> {formatBytes(s().network_rx_bytes)}
                      <span style={{ color: "#8b949e", margin: "0 6px" }}>/</span>
                      <span style={{ color: "#f0883e" }}>{"\u2191"}</span> {formatBytes(s().network_tx_bytes)}
                    </div>
                  )}
                </Show>
              </div>

              <div class="detail-stat-card">
                <div class="detail-stat-label">Uptime</div>
                <Show when={container()} fallback={
                  <div class="detail-stat-value" style={{ color: "#484f58" }}>-</div>
                }>
                  {(c) => (
                    <div class="detail-stat-value">
                      {c().state === "Running"
                        ? formatUptime(inspectData()?.started_at || inspectData()?.State?.StartedAt || c().created_at)
                        : "Stopped"}
                    </div>
                  )}
                </Show>
              </div>
            </div>

            {/* Container info grid */}
            <Show when={container()}>
              {(c) => (<>
                <div class="detail-info-section">
                  <h3 class="detail-section-title">Container Info</h3>
                  <div class="card-grid">
                    <div class="card-label">Container ID</div>
                    <div class="card-value mono" style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                      {c().id}
                      <CopyButton text={c().id} label="Copy full container ID" />
                    </div>

                    <div class="card-label">Image</div>
                    <div class="card-value mono">{c().image}</div>

                    <div class="card-label">Created</div>
                    <div class="card-value">{formatTimestamp(c().created_at)}</div>

                    <div class="card-label">State</div>
                    <div class="card-value">
                      <span class={`state-badge ${stateClass(c().state)}`}>{c().state}</span>
                    </div>

                    <div class="card-label">Command</div>
                    <div class="card-value mono" style={{ "font-size": "12px" }}>
                      {getContainerCommand().join(" ") || "-"}
                    </div>

                    <div class="card-label">Port Mappings</div>
                    <div class="card-value">
                      <Show when={c().ports.length > 0} fallback={<span style={{ color: "#8b949e" }}>None</span>}>
                        <For each={deduplicatePorts(c().ports)}>
                          {(p) => {
                            const proto = [443, 8443, 9443].includes(p.host_port) ? "https" : "http";
                            return (
                              <div class="mono" style={{ "line-height": "1.8", "font-size": "12px", display: "flex", "align-items": "center", gap: "6px" }}>
                                <a href={`${proto}://localhost:${p.host_port}`} target="_blank" style={{ color: "#58a6ff" }} title={`Open ${proto}://localhost:${p.host_port}`}>
                                  :{p.host_port}
                                </a>
                                <span style={{ color: "#484f58" }}>{"\u2192"}</span>
                                <span style={{ color: "#8b949e" }}>{p.container_port}/{p.protocol || "tcp"}</span>
                              </div>
                            );
                          }}
                        </For>
                      </Show>
                    </div>
                  </div>

                  {/* Restart Policy & Restart Count */}
                  <div style={{ display: "flex", "align-items": "center", gap: "12px", "margin-top": "16px" }}>
                    <Show when={c().restart_policy && c().restart_policy !== "no"}>
                      <span style={{
                        display: "inline-flex",
                        "align-items": "center",
                        padding: "3px 10px",
                        "border-radius": "12px",
                        "font-size": "11px",
                        "font-weight": "500",
                        background: "rgba(88, 166, 255, 0.1)",
                        color: "#58a6ff",
                        border: "1px solid rgba(88, 166, 255, 0.2)",
                      }}>
                        Restart: {c().restart_policy}
                      </span>
                    </Show>
                    <Show when={c().restart_count !== undefined && c().restart_count !== null && c().restart_count! > 0}>
                      <span style={{
                        "font-size": "12px",
                        color: "#d29922",
                      }}>
                        Restarted {c().restart_count} {c().restart_count === 1 ? "time" : "times"}
                      </span>
                    </Show>
                  </div>
                </div>

                {/* Health Check Section */}
                <Show when={inspectData()}>
                  <div class="detail-info-section">
                    <h3 class="detail-section-title">Health</h3>
                    <Show when={inspectData()?.health_status && inspectData()?.health_status !== "none" && inspectData()?.health_status !== ""}
                      fallback={
                        <div style={{ color: "#484f58", "font-size": "13px", padding: "8px 0" }}>
                          No health check configured
                        </div>
                      }
                    >
                      <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
                        {/* Health status badge */}
                        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                          <span style={{
                            display: "inline-flex",
                            "align-items": "center",
                            gap: "6px",
                            padding: "4px 12px",
                            "border-radius": "12px",
                            "font-size": "12px",
                            "font-weight": "600",
                            background:
                              inspectData()?.health_status === "healthy"
                                ? "rgba(63, 185, 80, 0.15)"
                                : inspectData()?.health_status === "unhealthy"
                                ? "rgba(248, 81, 73, 0.15)"
                                : "rgba(210, 153, 34, 0.15)",
                            color:
                              inspectData()?.health_status === "healthy"
                                ? "#3fb950"
                                : inspectData()?.health_status === "unhealthy"
                                ? "#f85149"
                                : "#d29922",
                            border: `1px solid ${
                              inspectData()?.health_status === "healthy"
                                ? "rgba(63, 185, 80, 0.3)"
                                : inspectData()?.health_status === "unhealthy"
                                ? "rgba(248, 81, 73, 0.3)"
                                : "rgba(210, 153, 34, 0.3)"
                            }`,
                          }}>
                            <span style={{ "font-size": "10px" }}>{"\u25CF"}</span>
                            {inspectData()?.health_status === "healthy"
                              ? "Healthy"
                              : inspectData()?.health_status === "unhealthy"
                              ? "Unhealthy"
                              : "Starting"}
                          </span>
                        </div>

                        {/* Health check log table */}
                        <Show when={inspectData()?.health_log && inspectData()?.health_log.length > 0}>
                          <div style={{ "overflow-x": "auto" }}>
                            <table style={{
                              width: "100%",
                              "border-collapse": "collapse",
                              "font-size": "12px",
                            }}>
                              <thead>
                                <tr style={{ "border-bottom": "1px solid rgba(255,255,255,0.06)" }}>
                                  <th style={{ padding: "6px 10px", "text-align": "left", color: "#8b949e", "font-weight": "500", "font-size": "11px" }}>Time</th>
                                  <th style={{ padding: "6px 10px", "text-align": "center", color: "#8b949e", "font-weight": "500", "font-size": "11px" }}>Exit Code</th>
                                  <th style={{ padding: "6px 10px", "text-align": "left", color: "#8b949e", "font-weight": "500", "font-size": "11px" }}>Output</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For each={inspectData()?.health_log || []}>
                                  {(entry: { output: string; exit_code: number; started_at: string; finished_at: string }) => (
                                    <tr style={{ "border-bottom": "1px solid rgba(255,255,255,0.03)" }}>
                                      <td style={{
                                        padding: "6px 10px",
                                        color: "#8b949e",
                                        "white-space": "nowrap",
                                        "font-size": "11px",
                                      }}>
                                        {entry.started_at ? formatTimestamp(entry.started_at) : "-"}
                                      </td>
                                      <td style={{
                                        padding: "6px 10px",
                                        "text-align": "center",
                                        color: entry.exit_code === 0 ? "#3fb950" : "#f85149",
                                        "font-weight": "600",
                                      }}>
                                        {entry.exit_code}
                                      </td>
                                      <td style={{
                                        padding: "6px 10px",
                                        color: "#e6edf3",
                                        "max-width": "400px",
                                        overflow: "hidden",
                                        "text-overflow": "ellipsis",
                                        "white-space": "nowrap",
                                        "font-family": "monospace",
                                        "font-size": "11px",
                                      }}
                                        title={entry.output?.trim() || ""}
                                      >
                                        {entry.output?.trim() || "-"}
                                      </td>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                </Show>
              </>)}
            </Show>
          </div>
        </Show>

        {/* Logs tab */}
        <Show when={activeTab() === "logs" && container()}>
          {(c) => (
            <LogViewer
              containerId={c().id}
              containerName={c().name}
            />
          )}
        </Show>

        {/* Terminal tab */}
        <Show when={activeTab() === "terminal" && container()?.state === "Running" && container()}>
          {(c) => (
            <XTerminal
              containerId={c().id}
              containerName={c().name}
            />
          )}
        </Show>

        {/* Inspect tab */}
        <Show when={activeTab() === "inspect"}>
          <div class="detail-inspect">
            <Show when={container()}>
              {(c) => (
                <div class="detail-info-section">
                  {/* Environment variables */}
                  <h3 class="detail-section-title">Environment Variables</h3>
                  <Show when={getContainerEnv().length > 0} fallback={
                    <div style={{ color: "#8b949e", padding: "8px 0" }}>Not available</div>
                  }>
                    <div class="detail-env-list">
                      <For each={getContainerEnv()}>
                        {(envVar) => {
                          const parts = (envVar as string).split("=");
                          const key = parts[0];
                          const val = parts.slice(1).join("=");
                          return (
                            <div class="mono" style={{ "line-height": "1.8", "font-size": "12px" }}>
                              <span style={{ color: "#58a6ff" }}>{key}</span>=<span>{val}</span>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </Show>

                  {/* Ports */}
                  <h3 class="detail-section-title" style={{ "margin-top": "24px" }}>Port Mappings</h3>
                  <Show when={c().ports.length > 0} fallback={
                    <div style={{ color: "#8b949e", padding: "8px 0" }}>No ports exposed</div>
                  }>
                    <div style={{ display: "flex", "flex-wrap": "wrap", gap: "8px", "margin-top": "8px" }}>
                      <For each={deduplicatePorts(c().ports)}>
                        {(p) => {
                          const proto = [443, 8443, 9443].includes(p.host_port) ? "https" : "http";
                          return (
                            <div style={{
                              display: "flex",
                              "align-items": "center",
                              gap: "10px",
                              padding: "10px 14px",
                              background: "rgba(255, 255, 255, 0.03)",
                              border: "1px solid rgba(255, 255, 255, 0.06)",
                              "border-radius": "8px",
                              "min-width": "200px",
                            }}>
                              <div style={{ flex: "1" }}>
                                <div style={{ display: "flex", "align-items": "center", gap: "8px", "font-size": "13px" }}>
                                  <div>
                                    <div style={{ "font-size": "10px", color: "#6e7681", "text-transform": "uppercase", "letter-spacing": "0.5px", "margin-bottom": "2px" }}>Host</div>
                                    <span class="mono" style={{ "font-weight": "600", color: "#e6edf3" }}>{p.host_port}</span>
                                  </div>
                                  <span style={{ color: "#484f58", "font-size": "16px" }}>{"\u2192"}</span>
                                  <div>
                                    <div style={{ "font-size": "10px", color: "#6e7681", "text-transform": "uppercase", "letter-spacing": "0.5px", "margin-bottom": "2px" }}>Container</div>
                                    <span class="mono" style={{ color: "#8b949e" }}>{p.container_port}<span style={{ "font-size": "10px", "margin-left": "3px" }}>/{p.protocol || "tcp"}</span></span>
                                  </div>
                                </div>
                                <a
                                  href={`${proto}://localhost:${p.host_port}`}
                                  target="_blank"
                                  style={{ color: "#58a6ff", "font-size": "12px", "margin-top": "6px", display: "inline-block" }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {proto}://localhost:{p.host_port} {"\u2197"}
                                </a>
                              </div>
                              <a
                                href={`${proto}://localhost:${p.host_port}`}
                                target="_blank"
                                class="btn btn-sm"
                                style={{ "font-size": "11px", padding: "4px 10px", "flex-shrink": "0" }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                Open
                              </a>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </Show>

                  {/* Mounts */}
                  <h3 class="detail-section-title" style={{ "margin-top": "24px" }}>Mounts</h3>
                  <Show when={getContainerMounts().length > 0} fallback={
                    <div style={{ color: "#8b949e", padding: "8px 0" }}>None</div>
                  }>
                    <For each={getContainerMounts()}>
                      {(m: any) => {
                        const mountType = m.type || m.Type || (m.source?.startsWith("/") ? "bind" : "volume");
                        const isVolume = mountType === "volume";
                        const volumeName = isVolume ? (m.name || m.Name || m.source || m.Source) : null;
                        return (
                          <div class="mono" style={{ "line-height": "1.8", "font-size": "12px", display: "flex", "align-items": "center", gap: "4px" }}>
                            <Show when={isVolume && volumeName && props.onNavigate} fallback={
                              <span style={{ color: "#8b949e" }}>{m.source || m.Source}</span>
                            }>
                              <a
                                style={{ color: "#58a6ff", cursor: "pointer" }}
                                onClick={() => props.onNavigate?.(`volume:${volumeName}`)}
                              >
                                {m.source || m.Source}
                              </a>
                            </Show>
                            <span style={{ color: "#484f58" }}> {"\u2192"} </span>
                            <span>{m.destination || m.Destination}</span>
                            <span style={{ color: "#6e7681", "font-size": "11px", "margin-left": "4px" }}>({m.rw === false ? "ro" : "rw"})</span>
                          </div>
                        );
                      }}
                    </For>
                  </Show>

                  {/* Labels */}
                  <h3 class="detail-section-title" style={{ "margin-top": "24px" }}>Labels</h3>
                  <Show when={Object.keys(c().labels).length > 0} fallback={
                    <div style={{ color: "#8b949e", padding: "8px 0" }}>None</div>
                  }>
                    <For each={Object.entries(c().labels)}>
                      {([k, v]) => (
                        <div class="mono" style={{ "line-height": "1.8", "font-size": "12px" }}>
                          <span style={{ color: "#58a6ff" }}>{k}</span>=<span>{v}</span>
                        </div>
                      )}
                    </For>
                  </Show>

                  {/* Diagnostics */}
                  <Show when={inspectData() && (c().state === "Exited" || c().state === "Dead" || c().state === "Created")}>
                    <h3 class="detail-section-title" style={{ "margin-top": "24px", color: "#f85149" }}>Diagnostics</h3>
                    <div style={{ background: "#da363311", border: "1px solid #da363333", "border-radius": "8px", padding: "14px", "font-size": "13px" }}>
                      <Show when={inspectData()?.exit_code !== undefined && inspectData()?.exit_code !== null}>
                        <div>
                          <span style={{ color: "#8b949e" }}>Exit Code:</span>{" "}
                          <span class="mono" style={{ color: inspectData()?.exit_code === 0 ? "#3fb950" : "#f85149" }}>
                            {inspectData()?.exit_code}
                          </span>
                        </div>
                      </Show>
                      <Show when={inspectData()?.error}>
                        <div style={{ "margin-top": "6px" }}>
                          <span style={{ color: "#8b949e" }}>Error:</span>{" "}
                          <span class="mono" style={{ color: "#f85149" }}>{inspectData()?.error}</span>
                        </div>
                      </Show>
                      <Show when={inspectData()?.oom_killed}>
                        <div style={{ "margin-top": "6px", color: "#f85149", "font-weight": "600" }}>
                          Container was killed due to out-of-memory (OOM)
                        </div>
                      </Show>
                      <Show when={inspectData()?.started_at}>
                        <div style={{ "margin-top": "6px" }}>
                          <span style={{ color: "#8b949e" }}>Started:</span>{" "}
                          <span class="mono">{inspectData()?.started_at}</span>
                        </div>
                      </Show>
                      <Show when={inspectData()?.finished_at}>
                        <div style={{ "margin-top": "6px" }}>
                          <span style={{ color: "#8b949e" }}>Finished:</span>{" "}
                          <span class="mono">{inspectData()?.finished_at}</span>
                        </div>
                      </Show>
                      <Show when={!inspectData()?.error && inspectData()?.exit_code !== 0 && inspectData()?.exit_code !== undefined}>
                        <div style={{ "margin-top": "10px", color: "#8b949e", "font-style": "italic" }}>
                          Tip: Check the Logs tab for more details about why this container exited.
                        </div>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </Show>

        {/* Volumes tab */}
        <Show when={activeTab() === "volumes"}>
          <div class="detail-overview">
            <div class="detail-info-section">
              <h3 class="detail-section-title">Mounts & Volumes</h3>
              <Show when={getContainerMounts().length > 0} fallback={
                <div style={{ color: "#8b949e", padding: "8px 0" }}>No mounts configured for this container.</div>
              }>
                <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
                  <For each={getContainerMounts()}>
                    {(m: any) => {
                      const mountType = m.type || m.Type || (m.source && m.source.startsWith("/") ? "bind" : "volume");
                      const mountSource = m.source || m.Source || "-";
                      const mountDest = m.destination || m.Destination || m.target || m.Target || "-";
                      const isReadOnly = m.rw === false || m.RW === false || m.read_only === true || m.mode === "ro";
                      const mode = isReadOnly ? "ro" : "rw";
                      const volumeName = mountType === "volume" ? (m.name || m.Name || mountSource) : null;
                      return (
                        <div style={{
                          background: "rgba(255, 255, 255, 0.03)",
                          border: "1px solid rgba(255, 255, 255, 0.06)",
                          "border-radius": "8px",
                          padding: "16px",
                        }}>
                          <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "12px" }}>
                            <span style={{
                              padding: "2px 8px",
                              "border-radius": "4px",
                              "font-size": "11px",
                              "font-weight": "600",
                              "text-transform": "uppercase",
                              background: mountType === "volume" ? "rgba(88, 166, 255, 0.15)" : mountType === "bind" ? "rgba(163, 113, 247, 0.15)" : "rgba(139, 148, 158, 0.15)",
                              color: mountType === "volume" ? "#58a6ff" : mountType === "bind" ? "#a371f7" : "#8b949e",
                            }}>
                              {mountType}
                            </span>
                            <span style={{
                              padding: "2px 8px",
                              "border-radius": "4px",
                              "font-size": "11px",
                              "font-weight": "600",
                              background: mode === "ro" ? "rgba(248, 81, 73, 0.15)" : "rgba(63, 185, 80, 0.15)",
                              color: mode === "ro" ? "#f85149" : "#3fb950",
                            }}>
                              {mode}
                            </span>
                          </div>
                          <div class="card-grid">
                            <div class="card-label">Source</div>
                            <div class="card-value mono" style={{ "font-size": "12px", "word-break": "break-all" }}>{mountSource}</div>
                            <div class="card-label">Destination</div>
                            <div class="card-value mono" style={{ "font-size": "12px", "word-break": "break-all" }}>{mountDest}</div>
                          </div>
                          <Show when={volumeName && props.onNavigate}>
                            <div style={{ "margin-top": "12px", display: "flex", gap: "8px" }}>
                              <button
                                class="btn btn-sm"
                                onClick={() => props.onNavigate?.(`volume:${volumeName}`)}
                                style={{ "font-size": "12px" }}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0021 19V5"/><path d="M3 12A9 3 0 0021 12"/></svg>
                                View Volume
                              </button>
                              <button
                                class="btn btn-sm"
                                onClick={() => props.onNavigate?.(`volume:${volumeName}`)}
                                style={{ "font-size": "12px" }}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7v10c0 1.1.9 2 2 2h12a2 2 0 002-2V7"/><path d="M7 4h10a2 2 0 012 2v1H5V6a2 2 0 012-2z"/><line x1="9" y1="11" x2="15" y2="11"/></svg>
                                Browse Files
                              </button>
                            </div>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        {/* Resources tab */}
        <Show when={activeTab() === "resources"}>
          <div class="detail-overview">
            <div class="detail-info-section">
              <h3 class="detail-section-title">Resource Limits</h3>
              <p style={{ color: "#8b949e", "font-size": "13px", "margin-bottom": "16px" }}>
                Configure memory and CPU limits for this container. Changes apply immediately to the running container.
              </p>

              <div style={{ display: "flex", "flex-direction": "column", gap: "16px", "max-width": "480px" }}>
                {/* Memory Limit */}
                <div style={{
                  background: "rgba(255, 255, 255, 0.03)",
                  border: "1px solid rgba(255, 255, 255, 0.06)",
                  "border-radius": "8px",
                  padding: "16px",
                }}>
                  <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "8px" }}>
                    <label style={{ color: "#e6edf3", "font-size": "13px", "font-weight": "500" }}>Memory Limit</label>
                    <Show when={inspectData()?.memory_limit}>
                      <span style={{ color: "#8b949e", "font-size": "12px" }}>
                        Current: {formatBytes(inspectData()?.memory_limit || 0)}
                      </span>
                    </Show>
                  </div>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <input
                      type="text"
                      class="form-input"
                      placeholder="e.g. 512 (MB)"
                      value={editMemory()}
                      onInput={(e) => setEditMemory(e.currentTarget.value)}
                      style={{ flex: "1" }}
                    />
                    <span style={{ color: "#8b949e", "font-size": "13px", "min-width": "24px" }}>MB</span>
                  </div>
                  <div style={{ color: "#484f58", "font-size": "11px", "margin-top": "6px" }}>
                    Leave empty for no limit. Supports values like 512, 1024, or 2048.
                  </div>
                </div>

                {/* CPU Limit */}
                <div style={{
                  background: "rgba(255, 255, 255, 0.03)",
                  border: "1px solid rgba(255, 255, 255, 0.06)",
                  "border-radius": "8px",
                  padding: "16px",
                }}>
                  <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "8px" }}>
                    <label style={{ color: "#e6edf3", "font-size": "13px", "font-weight": "500" }}>CPU Limit</label>
                    <Show when={inspectData()?.cpu_limit}>
                      <span style={{ color: "#8b949e", "font-size": "12px" }}>
                        Current: {inspectData()?.cpu_limit?.toFixed(2)} cores
                      </span>
                    </Show>
                  </div>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <input
                      type="text"
                      class="form-input"
                      placeholder="e.g. 0.5, 1.0, 2.0"
                      value={editCpu()}
                      onInput={(e) => setEditCpu(e.currentTarget.value)}
                      style={{ flex: "1" }}
                    />
                    <span style={{ color: "#8b949e", "font-size": "13px", "min-width": "40px" }}>cores</span>
                  </div>
                  <div style={{ color: "#484f58", "font-size": "11px", "margin-top": "6px" }}>
                    Leave empty for no limit. Use decimal values: 0.5 = half a core, 2.0 = two cores.
                  </div>
                </div>

                {/* Restart Policy */}
                <div style={{
                  background: "rgba(255, 255, 255, 0.03)",
                  border: "1px solid rgba(255, 255, 255, 0.06)",
                  "border-radius": "8px",
                  padding: "16px",
                }}>
                  <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "8px" }}>
                    <label style={{ color: "#e6edf3", "font-size": "13px", "font-weight": "500" }}>Restart Policy</label>
                    <Show when={inspectData()?.restart_policy}>
                      <span style={{ color: "#8b949e", "font-size": "12px" }}>
                        Current: {inspectData()?.restart_policy}
                      </span>
                    </Show>
                  </div>
                  <Dropdown
                    value={editRestart()}
                    options={[
                      { value: "no", label: "No" },
                      { value: "always", label: "Always" },
                      { value: "unless-stopped", label: "Unless Stopped" },
                      { value: "on-failure", label: "On Failure" },
                    ]}
                    onChange={(v) => setEditRestart(v)}
                  />
                  <div style={{ color: "#484f58", "font-size": "11px", "margin-top": "6px" }}>
                    Controls whether the container restarts automatically after exiting or on system reboot.
                  </div>
                </div>

                {/* Save button */}
                <div style={{ display: "flex", gap: "8px", "margin-top": "4px" }}>
                  <button
                    class="btn btn-primary"
                    onClick={saveResources}
                    disabled={resourceSaving()}
                  >
                    {resourceSaving() ? "Saving..." : "Apply Changes"}
                  </button>
                  <button
                    class="btn"
                    onClick={initResourceFields}
                    disabled={resourceSaving()}
                  >
                    Reset
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Show>

        {/* Files tab */}
        <Show when={activeTab() === "files"}>
          <Show when={container()?.state === "Running"} fallback={
            <div style={{ padding: "24px", "text-align": "center", color: "#8b949e" }}>
              File browser is only available for running containers.
            </div>
          }>
            <div style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
              {/* Breadcrumb */}
              <div style={{ padding: "8px 16px", background: "#161b22", "border-bottom": "1px solid #21262d", "font-size": "12px", display: "flex", "align-items": "center", gap: "2px", "flex-wrap": "wrap" }}>
                <button
                  style={{ background: "none", border: "none", color: fileBrowserPath() === "/" || fileBrowserPath() === "" ? "#e6edf3" : "#58a6ff", cursor: "pointer", padding: "2px 6px", "font-size": "12px", "border-radius": "4px" }}
                  onClick={() => fetchContainerFiles("/")}
                  title="Root"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "vertical-align": "middle" }}><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
                </button>
                <For each={fileBrowserPath().split("/").filter(Boolean)}>
                  {(segment, i) => {
                    const segments = () => fileBrowserPath().split("/").filter(Boolean);
                    const isLast = () => i() === segments().length - 1;
                    return (
                      <>
                        <span style={{ color: "#484f58", "font-size": "10px" }}>{"\u203A"}</span>
                        <button
                          style={{
                            background: "none", border: "none",
                            color: isLast() ? "#e6edf3" : "#58a6ff",
                            cursor: "pointer", padding: "2px 6px", "font-size": "12px", "border-radius": "4px",
                            "font-weight": isLast() ? "600" : "400",
                          }}
                          onClick={() => navigateToSegment(i())}
                        >{segment}</button>
                      </>
                    );
                  }}
                </For>
              </div>

              <div style={{ flex: "1", overflow: "auto" }}>
                <Show when={fileContent() !== null} fallback={
                  <Show when={!filesLoading()} fallback={
                    <div style={{ padding: "20px", "text-align": "center", color: "#8b949e" }}><Spinner size={14} /> Loading files...</div>
                  }>
                    <Show when={files().length > 0} fallback={
                      <Show when={fileError()} fallback={
                        <div style={{ padding: "20px", "text-align": "center", color: "#8b949e" }}>Empty directory</div>
                      }>
                        <div style={{ padding: "16px 20px", color: "#f85149", background: "rgba(248, 81, 73, 0.1)", "border-radius": "6px", margin: "12px 16px", "font-size": "13px" }}>
                          <strong>Error:</strong> {fileError()}
                        </div>
                      </Show>
                    }>
                      {/* Back button */}
                      <Show when={fileBrowserPath() !== "/"}>
                        <div
                          class="file-browser-row"
                          style={{ color: "#8b949e" }}
                          onClick={navigateUp}
                        >
                          <span style={{ color: "#8b949e", width: "16px", "text-align": "center", "flex-shrink": "0", "font-size": "10px" }}>{"\u25C0"}</span>
                          <span>.. (parent)</span>
                        </div>
                      </Show>
                      <For each={files()}>
                        {(f) => (
                          <div
                            class="file-browser-row"
                            onClick={() => f.is_dir ? navigateToDir(f.name) : readContainerFile(f.name)}
                          >
                            <span style={{ color: f.is_dir ? "#58a6ff" : "#8b949e", width: "16px", "text-align": "center", "flex-shrink": "0" }}>
                              {f.is_dir ? "\u{1F4C1}" : "\u{1F4C4}"}
                            </span>
                            <span style={{ flex: "1", color: f.is_dir ? "#58a6ff" : "#e6edf3", "min-width": "0", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                              {f.name}
                              <Show when={f.link_target}>
                                <span style={{ color: "#484f58", "margin-left": "6px" }}>{"\u2192"} {f.link_target}</span>
                              </Show>
                            </span>
                            <span class="mono" style={{ color: "#484f58", "font-size": "11px", "flex-shrink": "0" }}>{f.permissions}</span>
                            <span style={{ color: "#484f58", "font-size": "11px", "flex-shrink": "0", "min-width": "60px", "text-align": "right" }}>{f.size}</span>
                          </div>
                        )}
                      </For>
                    </Show>
                  </Show>
                }>
                  {/* File content viewer */}
                  <div style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
                    <div style={{ padding: "8px 16px", background: "#161b22", "border-bottom": "1px solid #21262d", display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                      <span style={{ "font-size": "12px", color: "#e6edf3" }}>{fileContentPath()}</span>
                      <button class="btn btn-sm" onClick={() => setFileContent(null)} style={{ "font-size": "11px", padding: "2px 8px" }}>Back</button>
                    </div>
                    <pre style={{
                      padding: "12px 16px",
                      margin: 0,
                      "font-family": "'JetBrains Mono NF', monospace",
                      "font-size": "12px",
                      "line-height": "1.5",
                      color: "#c9d1d9",
                      "white-space": "pre-wrap",
                      "word-break": "break-all",
                      overflow: "auto",
                      flex: "1",
                    }}>{fileContent()}</pre>
                  </div>
                </Show>
              </div>
            </div>
          </Show>
        </Show>

        {/* Export tab */}
        <Show when={activeTab() === "export"}>
          <div class="detail-export">
            <div class="detail-info-section">
              <h3 class="detail-section-title">Docker Run Command</h3>
              <Show when={dockerRunCmd()} fallback={
                <div style={{ color: "#8b949e", padding: "8px 0" }}>Loading...</div>
              }>
                {(cmd) => (
                  <div class="detail-export-block">
                    <pre class="detail-export-code">{cmd()}</pre>
                    <button
                      class="btn btn-sm detail-export-copy"
                      onClick={() => copyToClipboard(cmd())}
                    >
                      Copy
                    </button>
                  </div>
                )}
              </Show>

              <h3 class="detail-section-title" style={{ "margin-top": "24px" }}>Compose YAML</h3>
              <Show when={composeYaml()} fallback={
                <div style={{ color: "#8b949e", padding: "8px 0" }}>Loading...</div>
              }>
                {(yaml) => (
                  <div class="detail-export-block">
                    <pre class="detail-export-code">{yaml()}</pre>
                    <button
                      class="btn btn-sm detail-export-copy"
                      onClick={() => copyToClipboard(yaml())}
                    >
                      Copy
                    </button>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Show>
      </div>

      {/* Commit Container Dialog */}
      <Show when={showCommitDialog()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdOverlay = (e.target as HTMLElement).classList.contains("modal-overlay"); }}
          onClick={(e) => { if ((e.currentTarget as any).__mdOverlay && (e.target as HTMLElement).classList.contains("modal-overlay")) setShowCommitDialog(false); (e.currentTarget as any).__mdOverlay = false; }}
        >
          <div class="modal-dialog" style={{ "max-width": "460px" }}>
            <div class="modal-header">
              <span class="modal-title">Save as Image</span>
              <button class="modal-close" onClick={() => setShowCommitDialog(false)}>{"\u00d7"}</button>
            </div>
            <div class="modal-body">
              <p style={{ color: "#8b949e", "font-size": "13px", "margin-bottom": "16px" }}>
                Create a new image from this container's current state.
              </p>
              <div class="form-group" style={{ "margin-bottom": "12px" }}>
                <label class="form-label">Repository</label>
                <input
                  class="form-input"
                  type="text"
                  placeholder="e.g. myapp"
                  value={commitRepo()}
                  onInput={(e) => setCommitRepo(e.currentTarget.value)}
                />
              </div>
              <div class="form-group" style={{ "margin-bottom": "16px" }}>
                <label class="form-label">Tag</label>
                <input
                  class="form-input"
                  type="text"
                  placeholder="latest"
                  value={commitTag()}
                  onInput={(e) => setCommitTag(e.currentTarget.value)}
                />
              </div>
              <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end" }}>
                <button class="btn" onClick={() => setShowCommitDialog(false)} disabled={committing()}>Cancel</button>
                <button class="btn btn-primary" onClick={doCommit} disabled={committing() || !commitRepo().trim()}>
                  {committing() ? "Saving..." : "Save as Image"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
