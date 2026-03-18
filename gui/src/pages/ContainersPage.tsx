import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Container, ContainerStats } from "../lib/types";
import { formatPorts, formatTimestamp, shortId, formatBytes } from "../lib/format";
import LogViewer from "../components/LogViewer";

export default function ContainersPage() {
  const [containers, setContainers] = createSignal<Container[]>([]);
  const [search, setSearch] = createSignal("");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [stats, setStats] = createSignal<ContainerStats | null>(null);
  const [logsFor, setLogsFor] = createSignal<Container | null>(null);
  const [loading, setLoading] = createSignal(false);

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
      return;
    }
    setSelected(id);
    setStats(null);
    try {
      const s = (await invoke("container_stats", { id })) as ContainerStats;
      setStats(s);
    } catch {
      // Stats may fail for non-running containers
    }
  };

  const doAction = async (action: string, id: string, e: MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    try {
      await invoke(action, { id });
      await refresh();
    } catch (err) {
      console.error(`${action} failed:`, err);
    }
    setLoading(false);
  };

  const openLogs = (c: Container, e: MouseEvent) => {
    e.stopPropagation();
    setLogsFor(c);
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
          <button class="btn" onClick={refresh}>
            Refresh
          </button>
        </div>
      </div>

      {/* Log Viewer Panel */}
      <Show when={logsFor()}>
        {(c) => (
          <div style={{ "margin-bottom": "16px" }}>
            <LogViewer
              containerId={c().id}
              containerName={c().name}
              onClose={() => setLogsFor(null)}
            />
          </div>
        )}
      </Show>

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
                        <button
                          class="btn btn-sm"
                          onClick={(e) => openLogs(c, e)}
                        >
                          Logs
                        </button>
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
                              </div>
                            )}
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
    </div>
  );
}
