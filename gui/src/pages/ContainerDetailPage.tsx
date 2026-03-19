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

type DetailTab = "overview" | "logs" | "terminal" | "inspect" | "export";

export default function ContainerDetailPage(props: ContainerDetailPageProps) {
  const [container, setContainer] = createSignal<Container | null>(null);
  const [stats, setStats] = createSignal<ContainerStats | null>(null);
  const [inspectData, setInspectData] = createSignal<any>(null);
  const [activeTab, setActiveTab] = createSignal<DetailTab>("overview");
  const [loading, setLoading] = createSignal(false);
  const [actionInProgress, setActionInProgress] = createSignal(false);
  const [dockerRunCmd, setDockerRunCmd] = createSignal<string | null>(null);
  const [composeYaml, setComposeYaml] = createSignal<string | null>(null);

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

  const formatUptime = (createdAt: string): string => {
    try {
      const created = new Date(createdAt);
      const now = new Date();
      const diff = now.getTime() - created.getTime();
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

              <div class="detail-page-actions">
                <Show when={actionInProgress()}>
                  <Spinner />
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
                  >
                    Remove
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
                  {(s) => (
                    <>
                      <div class="detail-stat-value">
                        {formatBytes(s().memory_usage_bytes)}
                        <span class="detail-stat-secondary">
                          {" / "}{formatBytes(s().memory_limit_bytes)}
                        </span>
                      </div>
                      <div class="detail-stat-bar">
                        <ResourceBar
                          value={memPercent(s())}
                          label=""
                        />
                      </div>
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
                  )}
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
                    <div style={{ color: "#8b949e", padding: "8px 0" }}>None</div>
                  }>
                    <For each={c().ports}>
                      {(p) => (
                        <div class="mono" style={{ "line-height": "1.8", "font-size": "12px" }}>
                          {p.host_ip || "0.0.0.0"}:{p.host_port} {"->"}  {p.container_port}/{p.protocol}
                        </div>
                      )}
                    </For>
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
