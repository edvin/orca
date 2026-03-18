import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Container, ContainerStats } from "../lib/types";
import { formatPorts, formatTimestamp, shortId, formatBytes } from "../lib/format";
import { showToast } from "../components/Toast";
import LogViewer from "../components/LogViewer";
import ExecTerminal from "../components/ExecTerminal";
import RunContainerDialog from "../components/RunContainerDialog";

export default function ContainersPage() {
  const [containers, setContainers] = createSignal<Container[]>([]);
  const [search, setSearch] = createSignal("");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [stats, setStats] = createSignal<ContainerStats | null>(null);
  const [inspectData, setInspectData] = createSignal<any>(null);
  const [activeTab, setActiveTab] = createSignal<string>("stats");
  const [loading, setLoading] = createSignal(false);
  const [showRunDialog, setShowRunDialog] = createSignal(false);

  const refresh = async () => {
    try {
      const result = (await invoke("list_containers")) as Container[];
      setContainers(result);
    } catch (e) {
      console.error("Failed to list containers:", e);
    }
  };

  onMount(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    onCleanup(() => clearInterval(interval));
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
      return;
    }
    setSelected(id);
    setStats(null);
    setInspectData(null);
    setActiveTab("stats");
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
  };

  const doAction = async (action: string, id: string, e: MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    try {
      await invoke(action, { id });
      showToast(`Container ${action.replace("_container", "")} successful`, "success");
      await refresh();
    } catch (err) {
      showToast(`${action} failed: ${err}`, "error");
    }
    setLoading(false);
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
    // Try common inspect response shapes
    const env = data?.Config?.Env || data?.config?.env || data?.env || [];
    return Array.isArray(env) ? env : [];
  };

  const getContainerPorts = (): any[] => {
    const data = inspectData();
    if (!data) return [];
    const ports = data?.ports || data?.NetworkSettings?.Ports || data?.network_settings?.ports || [];
    return Array.isArray(ports) ? ports : [];
  };

  const tabStyle = (tab: string) => ({
    padding: "8px 16px",
    background: activeTab() === tab ? "#1f6feb" : "transparent",
    color: activeTab() === tab ? "#fff" : "#8b949e",
    border: "none",
    "border-radius": "6px",
    cursor: "pointer",
    "font-size": "12px",
    "font-weight": "500",
    transition: "all 0.15s ease",
  });

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
              <th>Ports</th>
              <th>Created</th>
              <th style={{ "text-align": "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={filtered()}>
              {(c) => (
                <>
                  <tr
                    onClick={() => selectContainer(c.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <td>
                      <span style={{ "font-weight": "500" }}>{c.name}</span>
                      <br />
                      <span class="mono" style={{ color: "#8b949e" }}>
                        {shortId(c.id)}
                      </span>
                    </td>
                    <td class="mono">{c.image}</td>
                    <td>
                      <span class={`state-badge ${stateClass(c.state)}`}>
                        {c.state}
                      </span>
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
                        </Show>
                      </div>
                    </td>
                  </tr>
                  <Show when={selected() === c.id}>
                    <tr>
                      <td colspan="6" style={{ padding: 0 }}>
                        {/* Tab bar */}
                        <div style={{
                          display: "flex",
                          gap: "4px",
                          padding: "10px 16px",
                          background: "#1c2128",
                          "border-bottom": "1px solid #21262d",
                          "align-items": "center",
                        }}>
                          <button style={tabStyle("stats")} onClick={(e) => { e.stopPropagation(); setActiveTab("stats"); }}>
                            Stats
                          </button>
                          <button style={tabStyle("details")} onClick={(e) => { e.stopPropagation(); setActiveTab("details"); }}>
                            Details
                          </button>
                          <Show when={c.state === "Running"}>
                            <button style={tabStyle("terminal")} onClick={(e) => { e.stopPropagation(); setActiveTab("terminal"); }}>
                              Terminal
                            </button>
                          </Show>
                          <button style={tabStyle("logs")} onClick={(e) => { e.stopPropagation(); setActiveTab("logs"); }}>
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
                                    </div>
                                    <div class="stat-card">
                                      <div class="stat-label">Network I/O</div>
                                      <div
                                        class="stat-value"
                                        style={{ "font-size": "14px" }}
                                      >
                                        {formatBytes(s().network_rx_bytes)} rx /{" "}
                                        {formatBytes(s().network_tx_bytes)} tx
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
                                <div class="card-value mono">{c.id}</div>

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
                              </div>
                            </div>
                          </Show>

                          {/* Terminal Tab */}
                          <Show when={activeTab() === "terminal" && c.state === "Running"}>
                            <ExecTerminal
                              containerId={c.id}
                              containerName={c.name}
                              onClose={() => setActiveTab("stats")}
                            />
                          </Show>

                          {/* Logs Tab */}
                          <Show when={activeTab() === "logs"}>
                            <LogViewer
                              containerId={c.id}
                              containerName={c.name}
                              onClose={() => setActiveTab("stats")}
                            />
                          </Show>
                        </div>
                      </td>
                    </tr>
                  </Show>
                </>
              )}
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
