import { createSignal, onMount, onCleanup, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Container, ContainerStats } from "../lib/types";
import { formatBytes, formatTimestamp, shortId, formatPorts } from "../lib/format";
import { showToast } from "../components/Toast";
import LogViewer from "../components/LogViewer";
import XTerminal from "../components/XTerminal";
import CopyButton from "../components/CopyButton";
import Spinner from "../components/Spinner";
import ResourceBar from "../components/ResourceBar";
import Sparkline from "../components/Sparkline";
import { recordMetrics, getCpuHistory, getMemoryHistory } from "../lib/metricsStore";
import { copyToClipboard } from "../lib/clipboard";
import Breadcrumb from "../components/Breadcrumb";

interface ContainerDetailPageProps {
  containerId: string;
  onBack: () => void;
  onNavigate?: (target: string) => void;
  breadcrumbStack?: string | null;
}

type DetailTab = "overview" | "logs" | "terminal" | "inspect" | "volumes" | "resources" | "export";

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

  let statsInterval: ReturnType<typeof setInterval> | undefined;

  const fetchContainer = async () => {
    try {
      const containers = (await invoke("list_containers")) as Container[];
      const c = containers.find((x) => x.id === props.containerId);
      if (c) setContainer(c);
    } catch (e) {
      console.error("Failed to fetch container:", e);
    }
  };

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

  const saveResources = async () => {
    setResourceSaving(true);
    try {
      const memStr = editMemory().trim();
      const cpuStr = editCpu().trim();

      // Build the update params
      const params: any = { id: props.containerId };

      if (memStr) {
        // If it's just a number, treat it as MB
        const num = parseFloat(memStr);
        if (!isNaN(num) && memStr === `${num}`) {
          params.memoryLimit = `${num}m`;
        } else {
          params.memoryLimit = memStr;
        }
      }

      if (cpuStr) {
        const cpuNum = parseFloat(cpuStr);
        if (!isNaN(cpuNum) && cpuNum > 0) {
          params.cpuLimit = cpuNum;
        }
      }

      params.restartPolicy = editRestart();

      await invoke("update_container", params);
      showToast("Resources updated", "success");
      // Re-fetch to reflect new values
      await fetchInspect();
    } catch (err) {
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
      showToast(`Restart failed: ${err}`, "error");
    }
    setActionInProgress(false);
  };

  const doRemove = async () => {
    const c = container();
    if (!c) return;
    if (!window.confirm(`Remove container '${c.name}'? This cannot be undone.`)) return;
    setActionInProgress(true);
    try {
      await invoke("remove_container", { id: props.containerId });
      showToast("Container removed", "success");
      props.onBack();
    } catch (err) {
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

  const formatUptime = (createdAt: string | number): string => {
    try {
      // Docker returns created_at as either ISO string or Unix timestamp (seconds)
      let created: Date;
      if (typeof createdAt === "number") {
        // Unix timestamp in seconds — convert to milliseconds
        created = new Date(createdAt < 1e12 ? createdAt * 1000 : createdAt);
      } else {
        created = new Date(createdAt);
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
      return `${minutes}m`;
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
                    class="btn btn-sm btn-primary"
                    onClick={() => doAction("start_container")}
                    disabled={actionInProgress()}
                  >
                    Start
                  </button>
                </Show>
                <Show when={c().state === "Running"}>
                  <button
                    class="btn btn-sm"
                    onClick={() => doAction("stop_container")}
                    disabled={actionInProgress()}
                  >
                    Stop
                  </button>
                  <button
                    class="btn btn-sm"
                    onClick={doRestart}
                    disabled={actionInProgress()}
                  >
                    Restart
                  </button>
                </Show>
                <Show when={c().state !== "Running"}>
                  <button
                    class="btn btn-sm btn-danger"
                    onClick={doRemove}
                    disabled={actionInProgress()}
                    title="Remove container"
                    style={{ color: "#f85149" }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                  </button>
                </Show>
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
                      {c().state === "Running" ? formatUptime(c().created_at) : "Stopped"}
                    </div>
                  )}
                </Show>
              </div>
            </div>

            {/* Container info grid */}
            <Show when={container()}>
              {(c) => (
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
                        <For each={c().ports}>
                          {(p) => (
                            <div class="mono" style={{ "line-height": "1.6" }}>
                              {p.host_ip || "0.0.0.0"}:{p.host_port} {"->"}  {p.container_port}/{p.protocol}
                            </div>
                          )}
                        </For>
                      </Show>
                    </div>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </Show>

        {/* Logs tab */}
        <Show when={activeTab() === "logs" && container()}>
          {(c) => (
            <LogViewer
              containerId={c().id}
              containerName={c().name}
              onClose={() => switchTab("overview")}
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
                          const httpPorts = [80, 443, 3000, 4200, 5000, 5173, 8000, 8080, 8443, 8888, 9000, 9090, 9443, 15672, 18789];
                          const isHttp = httpPorts.includes(p.host_port);
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
                                <div style={{ "font-size": "13px", "font-weight": "500", color: "#e6edf3" }}>
                                  <span class="mono">{p.host_port}</span>
                                  <span style={{ color: "#484f58", margin: "0 6px" }}>{"\u2192"}</span>
                                  <span class="mono" style={{ color: "#8b949e" }}>{p.container_port}</span>
                                  <span style={{ color: "#484f58", "font-size": "11px", "margin-left": "4px" }}>/{p.protocol || "tcp"}</span>
                                </div>
                                <Show when={isHttp}>
                                  <div style={{ "margin-top": "4px" }}>
                                    <a
                                      href={`${proto}://localhost:${p.host_port}`}
                                      target="_blank"
                                      style={{ color: "#58a6ff", "font-size": "12px" }}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      {proto}://localhost:{p.host_port} {"\u2197"}
                                    </a>
                                  </div>
                                </Show>
                              </div>
                              <Show when={isHttp}>
                                <a
                                  href={`${proto}://localhost:${p.host_port}`}
                                  target="_blank"
                                  class="btn btn-sm"
                                  style={{ "font-size": "11px", padding: "4px 10px", "flex-shrink": "0" }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  Open
                                </a>
                              </Show>
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
                      {(m: any) => (
                        <div class="mono" style={{ "line-height": "1.8", "font-size": "12px" }}>
                          {m.source} {"\u2192"} {m.destination} ({m.rw ? "rw" : "ro"})
                        </div>
                      )}
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
                            <div style={{ "margin-top": "12px" }}>
                              <button
                                class="btn btn-sm"
                                onClick={() => props.onNavigate?.(`volume:${volumeName}`)}
                                style={{ "font-size": "12px" }}
                              >
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
                  <select
                    class="form-select"
                    value={editRestart()}
                    onChange={(e) => setEditRestart(e.currentTarget.value)}
                  >
                    <option value="no">No</option>
                    <option value="always">Always</option>
                    <option value="unless-stopped">Unless Stopped</option>
                    <option value="on-failure">On Failure</option>
                  </select>
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
    </div>
  );
}
