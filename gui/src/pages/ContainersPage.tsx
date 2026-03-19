import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Container, ContainerStats } from "../lib/types";
import { formatPorts, formatTimestamp, shortId, formatBytes } from "../lib/format";
import { showToast } from "../components/Toast";
import RunContainerDialog from "../components/RunContainerDialog";
import CopyButton from "../components/CopyButton";
import Spinner from "../components/Spinner";
import ResourceBar from "../components/ResourceBar";
import Sparkline from "../components/Sparkline";
import LastUpdated from "../components/LastUpdated";
import SortableHeader from "../components/SortableHeader";
import { recordMetrics, getCpuHistory, getMemoryHistory } from "../lib/metricsStore";
import { useSort } from "../lib/useSort";

interface ContainersPageProps {
  onNavigate?: (page: string) => void;
}

export default function ContainersPage(props: ContainersPageProps) {
  const [containers, setContainers] = createSignal<Container[]>([]);
  const [search, setSearch] = createSignal("");
  const [stateFilter, setStateFilter] = createSignal<"all" | "running" | "stopped">("all");
  const [checkedIds, setCheckedIds] = createSignal<Set<string>>(new Set());
  const [lastUpdated, setLastUpdated] = createSignal<Date | null>(null);
  const [bulkInProgress, setBulkInProgress] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [actionInProgress, setActionInProgress] = createSignal<string | null>(null);
  const [showRunDialog, setShowRunDialog] = createSignal(false);
  // Inline stats for all running containers, keyed by container ID
  const [inlineStats, setInlineStats] = createSignal<Record<string, ContainerStats>>({});
  const { sortField, sortDir, toggleSort, sortFn } = useSort<Container>("name");

  const refresh = async () => {
    try {
      const result = (await invoke("list_containers")) as Container[];
      setContainers(result);
      setLastUpdated(new Date());
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

  onMount(() => {
    refresh().then(fetchAllRunningStats);
    const interval = setInterval(() => {
      refresh();
      fetchAllRunningStats();
    }, 3000);
    onCleanup(() => {
      clearInterval(interval);
    });
  });

  const filtered = () => {
    let list = containers();
    const sf = stateFilter();
    if (sf === "running") {
      list = list.filter((c) => c.state === "Running");
    } else if (sf === "stopped") {
      list = list.filter((c) => c.state !== "Running");
    }
    const q = search().toLowerCase();
    if (q) {
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.image.toLowerCase().includes(q) ||
          c.id.includes(q)
      );
    }
    return sortFn(list, (item, field) => {
      switch (field) {
        case "name": return item.name;
        case "image": return item.image;
        case "state": return item.state;
        case "created": return item.created_at;
        default: return "";
      }
    });
  };

  const runningCount = () => containers().filter((c) => c.state === "Running").length;
  const stoppedCount = () => containers().filter((c) => c.state !== "Running").length;

  const toggleCheck = (id: string, e: MouseEvent) => {
    e.stopPropagation();
    const next = new Set(checkedIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCheckedIds(next);
  };

  const selectAllChecked = () => {
    if (checkedIds().size === filtered().length) {
      setCheckedIds(new Set<string>());
    } else {
      setCheckedIds(new Set<string>(filtered().map((c) => c.id)));
    }
  };

  const bulkAction = async (action: string) => {
    const ids = Array.from(checkedIds());
    if (ids.length === 0) return;
    setBulkInProgress(true);
    let successCount = 0;
    let failCount = 0;
    for (const id of ids) {
      try {
        if (action === "remove") {
          await invoke("remove_container", { id });
        } else {
          await invoke(`${action}_container`, { id });
        }
        successCount++;
      } catch {
        failCount++;
      }
    }
    const label = action === "remove" ? "removed" : action === "start" ? "started" : "stopped";
    showToast(
      `${successCount} container${successCount !== 1 ? "s" : ""} ${label}${failCount ? `, ${failCount} failed` : ""}`,
      failCount ? "error" : "success"
    );
    setCheckedIds(new Set<string>());
    setBulkInProgress(false);
    await refresh();
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
          <LastUpdated timestamp={lastUpdated()} />
        </h1>
        <div class="page-actions">
          <div class="filter-pills">
            <button
              class={`filter-pill ${stateFilter() === "all" ? "active" : ""}`}
              onClick={() => setStateFilter("all")}
            >
              All ({containers().length})
            </button>
            <button
              class={`filter-pill ${stateFilter() === "running" ? "active" : ""}`}
              onClick={() => setStateFilter("running")}
            >
              Running ({runningCount()})
            </button>
            <button
              class={`filter-pill ${stateFilter() === "stopped" ? "active" : ""}`}
              onClick={() => setStateFilter("stopped")}
            >
              Stopped ({stoppedCount()})
            </button>
          </div>
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

      {/* Bulk action bar */}
      <Show when={checkedIds().size > 0}>
        <div class="bulk-action-bar">
          <span>
            {checkedIds().size} selected
          </span>
          <button class="btn btn-sm btn-primary" onClick={() => bulkAction("start")} disabled={bulkInProgress()}>
            Start
          </button>
          <button class="btn btn-sm" onClick={() => bulkAction("stop")} disabled={bulkInProgress()}>
            Stop
          </button>
          <button
            class="btn btn-sm btn-danger"
            onClick={() => {
              if (window.confirm(`Remove ${checkedIds().size} container(s)? This cannot be undone.`)) {
                bulkAction("remove");
              }
            }}
            disabled={bulkInProgress()}
          >
            Remove
          </button>
          <button class="btn btn-sm" onClick={() => setCheckedIds(new Set())}>
            Clear
          </button>
        </div>
      </Show>

      <Show
        when={filtered().length > 0}
        fallback={
          <div class="empty">
            <div class="empty-icon">{"📦"}</div>
            <p class="empty-title">No containers yet</p>
            <p>Run a container from the Images page or use a template</p>
            <div class="empty-actions">
              <button class="btn btn-primary" onClick={() => props.onNavigate?.("templates")}>
                Browse Templates
              </button>
            </div>
          </div>
        }
      >
        <table class="table">
          <thead>
            <tr>
              <th style={{ width: "36px" }}>
                <input
                  type="checkbox"
                  checked={checkedIds().size === filtered().length && filtered().length > 0}
                  onChange={selectAllChecked}
                  style={{ cursor: "pointer", "accent-color": "#58a6ff" }}
                />
              </th>
              <SortableHeader label="Name" field="name" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <SortableHeader label="Image" field="image" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <SortableHeader label="State" field="state" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <th>CPU</th>
              <th>Memory</th>
              <th>Ports</th>
              <SortableHeader label="Created" field="created" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <th style={{ "text-align": "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={filtered()}>
              {(c) => {
                const cStats = () => inlineStats()[c.id];
                return (
                    <tr
                      onClick={() => props.onNavigate?.(`container:${c.id}`)}
                      style={{
                        cursor: "pointer",
                        background: checkedIds().has(c.id) ? "#1f6feb11" : undefined,
                      }}
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={checkedIds().has(c.id)}
                          onChange={(e) => toggleCheck(c.id, e as any)}
                          onClick={(e) => e.stopPropagation()}
                          style={{ cursor: "pointer", "accent-color": "#58a6ff" }}
                        />
                      </td>
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
