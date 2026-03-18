import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Container, ContainerStats } from "../lib/types";
import { formatPorts, formatTimestamp, shortId, formatBytes } from "../lib/format";
import { showToast } from "../components/Toast";
import LogViewer from "../components/LogViewer";
import ExecTerminal from "../components/ExecTerminal";
import RunContainerDialog from "../components/RunContainerDialog";
import CopyButton from "../components/CopyButton";
import Spinner from "../components/Spinner";
import ResourceBar from "../components/ResourceBar";
import Sparkline from "../components/Sparkline";
import { recordMetrics, getCpuHistory, getMemoryHistory } from "../lib/metricsStore";

export default function ContainersPage() {
  const [containers, setContainers] = createSignal<Container[]>([]);
  const [search, setSearch] = createSignal("");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [stats, setStats] = createSignal<ContainerStats | null>(null);
  const [inspectData, setInspectData] = createSignal<any>(null);
  const [activeTab, setActiveTab] = createSignal<string>("stats");
  const [loading, setLoading] = createSignal(false);
  const [actionInProgress, setActionInProgress] = createSignal<string | null>(null);
  const [showRunDialog, setShowRunDialog] = createSignal(false);
  // Inline stats for all running containers, keyed by container ID
  const [inlineStats, setInlineStats] = createSignal<Record<string, ContainerStats>>({});

  const refresh = async () => {
    try {
      const result = (await invoke("list_containers")) as Container[];
      setContainers(result);
    } catch (e) {
      console.error("Failed to list containers:", e);
    }
  };

  const fetchAllRunningStats = async () => {
    const running = containers().filter((c) => c.state === "Running");
    if (running.length === 0) return;
    const results = await Promise.allSettled(
      running.map((c) => invoke("container_stats", { id: c.id }))
    );
    const newStats: Record<string, ContainerStats> = { ...inlineStats() };
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const s = r.value as ContainerStats;
        newStats[running[i].id] = s;
        recordMetrics(running[i].id, {
          timestamp: Date.now(),
          cpu: s.cpu_percent,
          memory: s.memory_usage_bytes,
          memoryLimit: s.memory_limit_bytes,
          networkRx: s.network_rx_bytes,
          networkTx: s.network_tx_bytes,
        });
      }
    });
    setInlineStats(newStats);
  };

  // Auto-refresh stats for selected container when stats tab is active
  let statsInterval: ReturnType<typeof setInterval> | undefined;

  const startStatsRefresh = (id: string) => {
    stopStatsRefresh();
    const fetchStats = async () => {
      try {
        const s = await invoke("container_stats", { id });
        setStats(s as ContainerStats);
      } catch {
        // Container may have stopped
      }
    };
    fetchStats();
    statsInterval = setInterval(fetchStats, 3000);
  };

  const stopStatsRefresh = () => {
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = undefined;
    }
  };

  onMount(() => {
    refresh().then(fetchAllRunningStats);
    const interval = setInterval(() => {
      refresh();
      fetchAllRunningStats();
    }, 3000);
    onCleanup(() => {
      clearInterval(interval);
      stopStatsRefresh();
    });
  });

  const filtered = () => {
    const q = search().toLowerCase();
    if (!q) return containers();
    return containers().filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.image.toLowerCase().includes(q) ||
        c.id.includes(q)
    );
  };

  const selectContainer = async (id: string) => {
    if (selected() === id) {
      setSelected(null);
      setStats(null);
      setInspectData(null);
      setActiveTab("stats");
      stopStatsRefresh();
      return;
    }
    setSelected(id);
    setStats(null);
    setInspectData(null);
    setActiveTab("stats");

    // Find container to check state
    const container = containers().find((c) => c.id === id);

    try {
      const [s, inspect] = await Promise.allSettled([
        invoke("container_stats", { id }),
        invoke("inspect_container", { id }),
      ]);
      if (s.status === "fulfilled") setStats(s.value as ContainerStats);
      if (inspect.status === "fulfilled") setInspectData(inspect.value);
    } catch {
      // Stats may fail for non-running containers
    }

    // Start auto-refresh if running and stats tab
    if (container?.state === "Running") {
      startStatsRefresh(id);
    }
  };

  // Watch tab changes to start/stop stats refresh
  const switchTab = (tab: string) => {
    setActiveTab(tab);
    const id = selected();
    if (!id) return;
    const container = containers().find((c) => c.id === id);
    if (tab === "stats" && container?.state === "Running") {
      startStatsRefresh(id);
    } else {
      stopStatsRefresh();
    }
  };

  const doAction = async (action: string, id: string, e: MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    setActionInProgress(id);
    try {
      await invoke(action, { id });
      showToast(`Container ${action.replace("_container", "")} successful`, "success");
      await refresh();
    } catch (err) {
      showToast(`${action} failed: ${err}`, "error");
    }
    setLoading(false);
    setActionInProgress(null);
  };

  const doRestart = async (id: string, e: MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    setActionInProgress(id);
    try {
      await invoke("stop_container", { id });
      await invoke("start_container", { id });
      showToast("Container restart successful", "success");
      await refresh();
    } catch (err) {
      showToast(`Restart failed: ${err}`, "error");
    }
    setLoading(false);
    setActionInProgress(null);
  };

  const stateClass = (state: string) => {
    switch (state) {
      case "Running":
        return "state-running";
      case "Exited":
        return "state-exited";
      case "Created":
        return "state-created";
      case "Paused":
        return "state-paused";
      default:
        return "state-stopped";
    }
  };

  const getContainerEnv = (): string[] => {
    const data = inspectData();
    if (!data) return [];
    const env = data?.Config?.Env || data?.config?.env || data?.env || [];
    return Array.isArray(env) ? env : [];
  };

  const memPercent = (s: ContainerStats) => {
    if (!s.memory_limit_bytes || s.memory_limit_bytes === 0) return 0;
    return (s.memory_usage_bytes / s.memory_limit_bytes) * 100;
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">
          Containers
          <span
            style={{
              "font-size": "13px",
              color: "#8b949e",
              "font-weight": "400",
              "margin-left": "8px",
            }}
          >
            {filtered().length}
          </span>
        </h1>
        <div class="page-actions">
          <input
            class="search-input"
            type="text"
            placeholder="Filter containers..."
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
          <button class="btn btn-primary" onClick={() => setShowRunDialog(true)}>
            Run
          </button>
          <button class="btn" onClick={refresh}>
            Refresh
          </button>
        </div>
      </div>

      <Show
        when={filtered().length > 0}
        fallback={
          <div class="empty">
            <p class="empty-title">No containers found</p>
            <p>Start a container to see it here.</p>
          </div>
        }
      >
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Image</th>
              <th>State</th>
              <th>CPU</th>
              <th>Memory</th>
              <th>Ports</th>
              <th>Created</th>
              <th style={{ "text-align": "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={filtered()}>
              {(c) => {
                const cStats = () => inlineStats()[c.id];
                return (
                  <>
                    <tr
                      onClick={() => selectContainer(c.id)}
                      style={{ cursor: "pointer" }}
                    >
                      <td>
                        <span style={{ "font-weight": "500" }}>{c.name}</span>
                        <br />
                        <span class="mono" style={{ color: "#8b949e", display: "inline-flex", "align-items": "center", gap: "4px" }}>
                          {shortId(c.id)}
                          <CopyButton text={c.id} label="Copy container ID" />
                        </span>
                      </td>
                      <td class="mono">{c.image}</td>
                      <td>
                        <span class={`state-badge ${stateClass(c.state)}`}>
                          {c.state}
                        </span>
                      </td>
                      {/* Inline CPU bar */}
                      <td>
                        <Show when={c.state === "Running" && cStats()} fallback={
                          <span style={{ color: "#484f58", "font-size": "11px" }}>
                            {c.state === "Running" ? "-" : ""}
                          </span>
                        }>
                          {(s) => (
                            <div class="inline-resources" style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                              <ResourceBar
                                value={s().cpu_percent}
                                label={`${s().cpu_percent.toFixed(1)}%`}
                              />
                              <Sparkline
                                data={getCpuHistory(c.id)}
                                width={50}
                                height={18}
                                color="#58a6ff"
                                max={100}
                              />
                            </div>
                          )}
                        </Show>
                      </td>
                      {/* Inline Memory bar */}
                      <td>
                        <Show when={c.state === "Running" && cStats()} fallback={
                          <span style={{ color: "#484f58", "font-size": "11px" }}>
                            {c.state === "Running" ? "-" : ""}
                          </span>
                        }>
                          {(s) => (
                            <div class="inline-resources" style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                              <ResourceBar
                                value={memPercent(s())}
                                label={formatBytes(s().memory_usage_bytes)}
                              />
                              <Sparkline
                                data={getMemoryHistory(c.id)}
                                width={50}
                                height={18}
                                color="#a371f7"
                                max={100}
                              />
                            </div>
                          )}
                        </Show>
                      </td>
                      <td class="mono">{formatPorts(c.ports)}</td>
                      <td style={{ color: "#8b949e" }}>
                        {formatTimestamp(c.created_at)}
                      </td>
                      <td style={{ "text-align": "right" }}>
                        <div
                          class="btn-group"
                          style={{ "justify-content": "flex-end" }}
                        >
                          <Show when={actionInProgress() === c.id}>
                            <Spinner />
                          </Show>
                          <Show when={c.state !== "Running"}>
                            <button
                              class="btn btn-sm btn-primary"
                              onClick={(e) =>
                                doAction("start_container", c.id, e)
                              }
                              disabled={loading()}
                            >
                              Start
                            </button>
                          </Show>
                          <Show when={c.state === "Running"}>
                            <button
                              class="btn btn-sm"
                              onClick={(e) =>
                                doAction("stop_container", c.id, e)
                              }
                              disabled={loading()}
                            >
                              Stop
                            </button>
                            <button
                              class="btn btn-sm"
                              onClick={(e) => doRestart(c.id, e)}
                              disabled={loading()}
                            >
                              Restart
                            </button>
                          </Show>
                          <Show when={c.state !== "Running"}>
                            <button
                              class="btn btn-sm btn-danger"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (window.confirm(`Remove container '${c.name}'? This cannot be undone.`)) {
                                  doAction("remove_container", c.id, e);
                                }
                              }}
                              disabled={loading()}
                            >
                              Remove
                            </button>
                          </Show>
                        </div>
                      </td>
                    </tr>
                    <Show when={selected() === c.id}>
                      <tr>
                        <td colspan="8" style={{ padding: 0 }}>
                          {/* Tab bar */}
                          <div class="tab-bar" style={{ padding: "0 16px", background: "#1c2128" }}>
                            <button
                              class={`tab-item ${activeTab() === "stats" ? "active" : ""}`}
                              onClick={(e) => { e.stopPropagation(); switchTab("stats"); }}
                            >
                              Stats
                            </button>
                            <button
                              class={`tab-item ${activeTab() === "details" ? "active" : ""}`}
                              onClick={(e) => { e.stopPropagation(); switchTab("details"); }}
                            >
                              Details
                            </button>
                            <Show when={c.state === "Running"}>
                              <button
                                class={`tab-item ${activeTab() === "terminal" ? "active" : ""}`}
                                onClick={(e) => { e.stopPropagation(); switchTab("terminal"); }}
                              >
                                Terminal
                              </button>
                            </Show>
                            <button
                              class={`tab-item ${activeTab() === "logs" ? "active" : ""}`}
                              onClick={(e) => { e.stopPropagation(); switchTab("logs"); }}
                            >
                              Logs
                            </button>
                          </div>

                          {/* Tab content */}
                          <div style={{ height: "500px", overflow: "auto" }}>
                            {/* Stats Tab */}
                            <Show when={activeTab() === "stats"}>
                              <div class="detail-body">
                                <Show
                                  when={stats()}
                                  fallback={
                                    <span style={{ color: "#8b949e" }}>
                                      {c.state === "Running"
                                        ? "Loading stats..."
                                        : "Stats unavailable (container not running)"}
                                    </span>
                                  }
                                >
                                  {(s) => (
                                    <div class="stats-grid">
                                      <div class="stat-card">
                                        <div class="stat-label">CPU</div>
                                        <div class="stat-value">
                                          {s().cpu_percent.toFixed(1)}%
                                        </div>
                                        <div class="stat-card-bar">
                                          <div class="resource-bar" style={{ height: "6px", "min-width": "unset" }}>
                                            <div
                                              class={`resource-bar-fill ${s().cpu_percent > 80 ? "resource-bar-fill-red" : s().cpu_percent > 50 ? "resource-bar-fill-yellow" : "resource-bar-fill-green"}`}
                                              style={{ width: `${Math.min(s().cpu_percent, 100)}%` }}
                                            />
                                          </div>
                                        </div>
                                      </div>
                                      <div class="stat-card">
                                        <div class="stat-label">Memory</div>
                                        <div class="stat-value">
                                          {formatBytes(s().memory_usage_bytes)}
                                          <span
                                            style={{
                                              "font-size": "12px",
                                              color: "#8b949e",
                                              "font-weight": "400",
                                            }}
                                          >
                                            {" / "}
                                            {formatBytes(s().memory_limit_bytes)}
                                          </span>
                                        </div>
                                        <div class="stat-card-bar">
                                          <div class="resource-bar" style={{ height: "6px", "min-width": "unset" }}>
                                            <div
                                              class={`resource-bar-fill ${memPercent(s()) > 80 ? "resource-bar-fill-red" : memPercent(s()) > 50 ? "resource-bar-fill-yellow" : "resource-bar-fill-green"}`}
                                              style={{ width: `${Math.min(memPercent(s()), 100)}%` }}
                                            />
                                          </div>
                                        </div>
                                        <div style={{ "font-size": "11px", color: "#8b949e", "margin-top": "4px" }}>
                                          {memPercent(s()).toFixed(1)}% used
                                        </div>
                                      </div>
                                      <div class="stat-card">
                                        <div class="stat-label">Network I/O</div>
                                        <div
                                          class="stat-value"
                                          style={{ "font-size": "14px" }}
                                        >
                                          <span style={{ color: "#58a6ff" }}>{"\u2193"}</span> {formatBytes(s().network_rx_bytes)}
                                          <span style={{ color: "#8b949e", margin: "0 6px" }}>/</span>
                                          <span style={{ color: "#f0883e" }}>{"\u2191"}</span> {formatBytes(s().network_tx_bytes)}
                                        </div>
                                      </div>
                                      <div class="stat-card">
                                        <div class="stat-label">Block I/O</div>
                                        <div
                                          class="stat-value"
                                          style={{ "font-size": "14px" }}
                                        >
                                          {formatBytes(s().block_read_bytes)} read /{" "}
                                          {formatBytes(s().block_write_bytes)} write
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </Show>
                              </div>
                            </Show>

                            {/* Details Tab */}
                            <Show when={activeTab() === "details"}>
                              <div class="detail-body">
                                <div class="card-grid">
                                  <div class="card-label">Container ID</div>
                                  <div class="card-value mono" style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                                    {c.id}
                                    <CopyButton text={c.id} label="Copy full container ID" />
                                  </div>

                                  <div class="card-label">Image</div>
                                  <div class="card-value mono">{c.image}</div>

                                  <div class="card-label">State</div>
                                  <div class="card-value">
                                    <span class={`state-badge ${stateClass(c.state)}`}>
                                      {c.state}
                                    </span>
                                  </div>

                                  <div class="card-label">Created</div>
                                  <div class="card-value">{formatTimestamp(c.created_at)}</div>

                                  <div class="card-label">Port Mappings</div>
                                  <div class="card-value">
                                    <Show when={c.ports.length > 0} fallback={<span style={{ color: "#8b949e" }}>None</span>}>
                                      <For each={c.ports}>
                                        {(p) => (
                                          <div class="mono" style={{ "line-height": "1.6" }}>
                                            {p.host_ip || "0.0.0.0"}:{p.host_port} {"->"}  {p.container_port}/{p.protocol}
                                          </div>
                                        )}
                                      </For>
                                    </Show>
                                  </div>

                                  <div class="card-label">Labels</div>
                                  <div class="card-value">
                                    <Show when={Object.keys(c.labels).length > 0} fallback={<span style={{ color: "#8b949e" }}>None</span>}>
                                      <For each={Object.entries(c.labels)}>
                                        {([k, v]) => (
                                          <div class="mono" style={{ "line-height": "1.6", "font-size": "11px" }}>
                                            <span style={{ color: "#58a6ff" }}>{k}</span>=<span>{v}</span>
                                          </div>
                                        )}
                                      </For>
                                    </Show>
                                  </div>

                                  <div class="card-label">Environment</div>
                                  <div class="card-value">
                                    <Show when={getContainerEnv().length > 0} fallback={<span style={{ color: "#8b949e" }}>Not available</span>}>
                                      <div style={{ "max-height": "200px", overflow: "auto" }}>
                                        <For each={getContainerEnv()}>
                                          {(envVar) => {
                                            const parts = (envVar as string).split("=");
                                            const key = parts[0];
                                            const val = parts.slice(1).join("=");
                                            return (
                                              <div class="mono" style={{ "line-height": "1.6", "font-size": "11px" }}>
                                                <span style={{ color: "#58a6ff" }}>{key}</span>=<span>{val}</span>
                                              </div>
                                            );
                                          }}
                                        </For>
                                      </div>
                                    </Show>
                                  </div>
                                  {/* Debug info for non-running containers */}
                                  <Show when={inspectData() && (c.state === "Exited" || c.state === "Dead" || c.state === "Created")}>
                                    <div class="card-label" style={{ color: "#f85149", "font-weight": "600" }}>Diagnostics</div>
                                    <div class="card-value">
                                      <div style={{ background: "#da363311", border: "1px solid #da363333", "border-radius": "6px", padding: "10px", "font-size": "12px" }}>
                                        <Show when={inspectData()?.exit_code !== undefined && inspectData()?.exit_code !== null}>
                                          <div><span style={{ color: "#8b949e" }}>Exit Code:</span> <span class="mono" style={{ color: inspectData()?.exit_code === 0 ? "#3fb950" : "#f85149" }}>{inspectData()?.exit_code}</span></div>
                                        </Show>
                                        <Show when={inspectData()?.error}>
                                          <div style={{ "margin-top": "4px" }}><span style={{ color: "#8b949e" }}>Error:</span> <span class="mono" style={{ color: "#f85149" }}>{inspectData()?.error}</span></div>
                                        </Show>
                                        <Show when={inspectData()?.oom_killed}>
                                          <div style={{ "margin-top": "4px", color: "#f85149", "font-weight": "600" }}>Container was killed due to out-of-memory (OOM)</div>
                                        </Show>
                                        <Show when={inspectData()?.started_at}>
                                          <div style={{ "margin-top": "4px" }}><span style={{ color: "#8b949e" }}>Started:</span> <span class="mono">{inspectData()?.started_at}</span></div>
                                        </Show>
                                        <Show when={inspectData()?.finished_at}>
                                          <div style={{ "margin-top": "4px" }}><span style={{ color: "#8b949e" }}>Finished:</span> <span class="mono">{inspectData()?.finished_at}</span></div>
                                        </Show>
                                        <Show when={inspectData()?.command}>
                                          <div style={{ "margin-top": "4px" }}><span style={{ color: "#8b949e" }}>Command:</span> <span class="mono">{(inspectData()?.command || []).join(" ")}</span></div>
                                        </Show>
                                        <Show when={inspectData()?.mounts && inspectData()?.mounts.length > 0}>
                                          <div style={{ "margin-top": "8px" }}>
                                            <span style={{ color: "#8b949e" }}>Mounts:</span>
                                            <For each={inspectData()?.mounts || []}>
                                              {(m: any) => (
                                                <div class="mono" style={{ "font-size": "11px", "margin-left": "8px" }}>
                                                  {m.source} {"\u2192"} {m.destination} ({m.rw ? "rw" : "ro"})
                                                </div>
                                              )}
                                            </For>
                                          </div>
                                        </Show>
                                        <Show when={!inspectData()?.error && inspectData()?.exit_code !== 0 && inspectData()?.exit_code !== undefined}>
                                          <div style={{ "margin-top": "8px", color: "#8b949e", "font-style": "italic" }}>
                                            Tip: Check the Logs tab for more details about why this container exited.
                                          </div>
                                        </Show>
                                      </div>
                                    </div>
                                  </Show>

                                </div>
                              </div>
                            </Show>

                            {/* Terminal Tab */}
                            <Show when={activeTab() === "terminal" && c.state === "Running"}>
                              <ExecTerminal
                                containerId={c.id}
                                containerName={c.name}
                                onClose={() => switchTab("stats")}
                              />
                            </Show>

                            {/* Logs Tab */}
                            <Show when={activeTab() === "logs"}>
                              <LogViewer
                                containerId={c.id}
                                containerName={c.name}
                                onClose={() => switchTab("stats")}
                              />
                            </Show>
                          </div>
                        </td>
                      </tr>
                    </Show>
                  </>
                );
              }}
            </For>
          </tbody>
        </table>
      </Show>

      <Show when={showRunDialog()}>
        <RunContainerDialog
          onClose={() => setShowRunDialog(false)}
          onCreated={refresh}
        />
      </Show>
    </div>
  );
}
