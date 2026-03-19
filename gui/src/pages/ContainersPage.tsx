import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Container, ContainerStats, ComposeProject } from "../lib/types";
import { formatPorts, formatTimestamp, shortId, formatBytes } from "../lib/format";
import { showToast } from "../components/Toast";
import RunContainerDialog from "../components/RunContainerDialog";
import CopyButton from "../components/CopyButton";
import Spinner from "../components/Spinner";
import ResourceBar from "../components/ResourceBar";
import Sparkline from "../components/Sparkline";
import LastUpdated from "../components/LastUpdated";
import { recordMetrics, getCpuHistory, getMemoryHistory } from "../lib/metricsStore";

interface ContainersPageProps {
  onNavigate?: (page: string) => void;
}

interface StackGroup {
  name: string;
  containers: Container[];
  composeProject?: ComposeProject;
}

export default function ContainersPage(props: ContainersPageProps) {
  const [containers, setContainers] = createSignal<Container[]>([]);
  const [stacks, setStacks] = createSignal<ComposeProject[]>([]);
  const [search, setSearch] = createSignal("");
  const [stateFilter, setStateFilter] = createSignal<"all" | "running" | "stopped">("all");
  const [lastUpdated, setLastUpdated] = createSignal<Date | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [actionInProgress, setActionInProgress] = createSignal<string | null>(null);
  const [stackActionInProgress, setStackActionInProgress] = createSignal<string | null>(null);
  const [showRunDialog, setShowRunDialog] = createSignal(false);
  const [inlineStats, setInlineStats] = createSignal<Record<string, ContainerStats>>({});
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(["__standalone__"]));
  const [composeOutput, setComposeOutput] = createSignal<{ name: string; output: any } | null>(null);

  const refresh = async () => {
    try {
      const [containerResult, stackResult] = await Promise.all([
        invoke("list_containers") as Promise<Container[]>,
        invoke("list_stacks") as Promise<ComposeProject[]>,
      ]);
      setContainers(containerResult);
      setStacks(stackResult);
      setLastUpdated(new Date());
    } catch (e) {
      console.error("Failed to list containers/stacks:", e);
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
    onCleanup(() => clearInterval(interval));
  });

  // Group containers by compose project label
  const grouped = (): { stackGroups: StackGroup[]; standalone: Container[] } => {
    const allContainers = containers();
    const stackMap = new Map<string, ComposeProject>();
    for (const s of stacks()) {
      stackMap.set(s.name, s);
    }

    // Containers that belong to a compose project (by label)
    const projectContainers = new Map<string, Container[]>();
    const standaloneList: Container[] = [];

    for (const c of allContainers) {
      const projectName = c.labels?.["com.docker.compose.project"];
      if (projectName) {
        if (!projectContainers.has(projectName)) {
          projectContainers.set(projectName, []);
        }
        projectContainers.get(projectName)!.push(c);
      } else {
        standaloneList.push(c);
      }
    }

    const groups: StackGroup[] = [];
    for (const [name, ctrs] of projectContainers) {
      groups.push({
        name,
        containers: ctrs,
        composeProject: stackMap.get(name),
      });
    }
    // Sort stack groups alphabetically
    groups.sort((a, b) => a.name.localeCompare(b.name));

    return { stackGroups: groups, standalone: standaloneList };
  };

  // Apply search + state filter to a list of containers
  const applyFilters = (list: Container[]): Container[] => {
    let result = list;
    const sf = stateFilter();
    if (sf === "running") {
      result = result.filter((c) => c.state === "Running");
    } else if (sf === "stopped") {
      result = result.filter((c) => c.state !== "Running");
    }
    const q = search().toLowerCase();
    if (q) {
      result = result.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.image.toLowerCase().includes(q) ||
          c.id.includes(q)
      );
    }
    return result;
  };

  // Check if a stack group has any containers that pass the filter
  const stackPassesFilter = (group: StackGroup): boolean => {
    const q = search().toLowerCase();
    if (q && group.name.toLowerCase().includes(q)) return true;
    return applyFilters(group.containers).length > 0;
  };

  const filteredGroups = () => {
    const { stackGroups, standalone } = grouped();
    const filteredStacks = stackGroups.filter(stackPassesFilter);
    const filteredStandalone = applyFilters(standalone);
    return { stackGroups: filteredStacks, standalone: filteredStandalone };
  };

  const totalCount = () => containers().length;
  const runningCount = () => containers().filter((c) => c.state === "Running").length;
  const stoppedCount = () => containers().filter((c) => c.state !== "Running").length;

  const toggleExpand = (name: string) => {
    const next = new Set(expanded());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setExpanded(next);
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

  const doStackAction = async (action: string, name: string, e: MouseEvent) => {
    e.stopPropagation();
    setStackActionInProgress(name);
    setComposeOutput(null);
    try {
      const result = await invoke(action, { name });
      if (result && typeof result === "object") {
        setComposeOutput({ name, output: result as any });
      }
      setTimeout(refresh, 500);
    } catch (err) {
      showToast(`${action} failed: ${err}`, "error");
    }
    setStackActionInProgress(null);
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

  const containerRow = (c: Container, stackName?: string) => {
    const cStats = () => inlineStats()[c.id];
    return (
      <tr
        onClick={() =>
          props.onNavigate?.(
            stackName
              ? `container:${c.id},stack:${stackName}`
              : `container:${c.id}`
          )
        }
        style={{ cursor: "pointer" }}
      >
        <td style={{ "padding-left": stackName ? "44px" : "16px" }}>
          <span class={c.state === "Running" ? "state-indicator-running" : "state-indicator-stopped"}>
            {c.state === "Running" ? "\u25B6" : "\u25B7"}
          </span>
          <span style={{ "font-weight": "500", "margin-left": "6px" }}>{c.name}</span>
        </td>
        <td class="mono" style={{ color: "#8b949e" }}>{c.image}</td>
        <td>
          <span class={`state-badge ${stateClass(c.state)}`}>{c.state}</span>
        </td>
        <td>
          <Show when={c.state === "Running" && cStats()} fallback={
            <span style={{ color: "#484f58", "font-size": "11px" }}>
              {c.state === "Running" ? "-" : "\u2014"}
            </span>
          }>
            {(s) => (
              <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                <ResourceBar value={s().cpu_percent} label={`${s().cpu_percent.toFixed(1)}%`} />
                <Sparkline data={getCpuHistory(c.id)} width={40} height={16} color="#58a6ff" max={100} />
              </div>
            )}
          </Show>
        </td>
        <td>
          <Show when={c.state === "Running" && cStats()} fallback={
            <span style={{ color: "#484f58", "font-size": "11px" }}>
              {c.state === "Running" ? "-" : "\u2014"}
            </span>
          }>
            {(s) => (
              <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                <ResourceBar value={memPercent(s())} label={formatBytes(s().memory_usage_bytes)} />
                <Sparkline data={getMemoryHistory(c.id)} width={40} height={16} color="#a371f7" max={100} />
              </div>
            )}
          </Show>
        </td>
        <td class="mono">{formatPorts(c.ports)}</td>
        <td style={{ "text-align": "right" }}>
          <div class="action-icons">
            <Show when={actionInProgress() === c.id}>
              <Spinner size={14} />
            </Show>
            <button
              class="action-icon action-icon-start"
              onClick={(e) => doAction("start_container", c.id, e)}
              disabled={loading() || c.state === "Running"}
              title="Start"
            >
              &#9654;
            </button>
            <button
              class="action-icon action-icon-stop"
              onClick={(e) => doAction("stop_container", c.id, e)}
              disabled={loading() || c.state !== "Running"}
              title="Stop"
            >
              &#9632;
            </button>
            <button
              class="action-icon action-icon-restart"
              onClick={(e) => doRestart(c.id, e)}
              disabled={loading() || c.state !== "Running"}
              title="Restart"
            >
              &#8635;
            </button>
            <button
              class="action-icon action-icon-logs"
              onClick={(e) => {
                e.stopPropagation();
                props.onNavigate?.(
                  stackName
                    ? `container:${c.id},stack:${stackName}`
                    : `container:${c.id}`
                );
              }}
              title="Logs"
            >
              &#128203;
            </button>
            <button
              class="action-icon action-icon-delete"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Remove container '${c.name}'? This cannot be undone.`)) {
                  doAction("remove_container", c.id, e);
                }
              }}
              disabled={loading() || c.state === "Running"}
              title="Remove"
            >
              &#128465;
            </button>
          </div>
        </td>
      </tr>
    );
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">
          Containers
          <span style={{ "font-size": "13px", color: "#8b949e", "font-weight": "400", "margin-left": "8px" }}>
            {totalCount()}
          </span>
          <LastUpdated timestamp={lastUpdated()} />
        </h1>
        <div class="page-actions">
          <div class="filter-pills">
            <button
              class={`filter-pill ${stateFilter() === "all" ? "active" : ""}`}
              onClick={() => setStateFilter("all")}
            >
              All ({totalCount()})
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
            placeholder="Search containers & stacks..."
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
          <button class="btn btn-primary" onClick={() => setShowRunDialog(true)}>
            Run
          </button>
        </div>
      </div>

      {/* Compose CLI output banner */}
      <Show when={composeOutput()}>
        {(co) => (
          <div
            class="card"
            style={{
              "margin-bottom": "16px",
              "border-color": co().output.success ? "#238636" : "#da3633",
            }}
          >
            <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "8px" }}>
              <span style={{ "font-weight": "600", "font-size": "13px" }}>
                Compose output: {co().name}
                {co().output.success ? " (success)" : " (failed)"}
              </span>
              <button class="btn btn-sm" onClick={() => setComposeOutput(null)}>
                Dismiss
              </button>
            </div>
            <Show when={co().output.stdout}>
              <pre class="mono" style={{ color: "#c9d1d9", "white-space": "pre-wrap", "margin-bottom": "4px" }}>
                {co().output.stdout}
              </pre>
            </Show>
            <Show when={co().output.stderr}>
              <pre class="mono" style={{ color: "#f85149", "white-space": "pre-wrap" }}>
                {co().output.stderr}
              </pre>
            </Show>
          </div>
        )}
      </Show>

      <Show
        when={totalCount() > 0}
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
        <div class="stack-list">
          {/* Stack groups */}
          <For each={filteredGroups().stackGroups}>
            {(group) => {
              const isExpanded = () => expanded().has(group.name);
              const isLoading = () => stackActionInProgress() === group.name;
              const groupRunning = () => group.containers.filter((c) => c.state === "Running").length;
              const allRunning = () => group.containers.length > 0 && groupRunning() === group.containers.length;
              const filteredContainers = () => applyFilters(group.containers);

              return (
                <div class={`stack-card ${allRunning() ? "stack-card-healthy" : ""}`}>
                  <div class="stack-header" onClick={() => toggleExpand(group.name)}>
                    <div class="stack-header-left">
                      <span class={`expand-arrow ${isExpanded() ? "expanded" : ""}`}>
                        &#9654;
                      </span>
                      <div>
                        <div class="stack-name">
                          <span
                            style={{ cursor: "pointer" }}
                            onClick={(e: MouseEvent) => {
                              e.stopPropagation();
                              props.onNavigate?.(`stack:${group.name}`);
                            }}
                          >
                            {group.name}
                          </span>
                          <span class="service-dots" style={{ "margin-left": "10px", display: "inline-flex" }}>
                            <For each={group.containers}>
                              {(c) => (
                                <span
                                  class={`service-dot ${
                                    c.state === "Running"
                                      ? "service-dot-running"
                                      : c.state === "Exited"
                                      ? "service-dot-stopped"
                                      : "service-dot-other"
                                  }`}
                                  title={`${c.name}: ${c.state}`}
                                />
                              )}
                            </For>
                          </span>
                        </div>
                        <div class="stack-meta">
                          {groupRunning()}/{group.containers.length} running
                        </div>
                      </div>
                    </div>
                    <div class="stack-header-right">
                      <div class="action-icons" style={{ "margin-right": "8px" }}>
                        <button
                          class="action-icon action-icon-start"
                          onClick={(e) => {
                            e.stopPropagation();
                            for (const c of group.containers) {
                              if (c.state !== "Running") {
                                invoke("start_container", { id: c.id }).catch(() => {});
                              }
                            }
                            setTimeout(refresh, 800);
                          }}
                          disabled={isLoading()}
                          title="Start all"
                        >
                          &#9654;
                        </button>
                        <button
                          class="action-icon action-icon-stop"
                          onClick={(e) => {
                            e.stopPropagation();
                            for (const c of group.containers) {
                              if (c.state === "Running") {
                                invoke("stop_container", { id: c.id }).catch(() => {});
                              }
                            }
                            setTimeout(refresh, 800);
                          }}
                          disabled={isLoading()}
                          title="Stop all"
                        >
                          &#9632;
                        </button>
                        <button
                          class="action-icon action-icon-restart"
                          onClick={(e) => {
                            e.stopPropagation();
                            doStackAction("compose_pull", group.name, e);
                          }}
                          disabled={isLoading()}
                          title="Pull"
                        >
                          &#8635;
                        </button>
                      </div>
                      <Show when={group.composeProject?.working_dir}>
                        <div class="btn-group">
                          <button
                            class="btn btn-sm btn-outline"
                            onClick={(e) => doStackAction("compose_up", group.name, e)}
                            disabled={isLoading()}
                            title="docker compose up -d"
                          >
                            {isLoading() ? <><Spinner size={12} />{" ..."}</> : "\u2191 Up"}
                          </button>
                          <button
                            class="btn btn-sm btn-outline"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm(`Run docker compose down for '${group.name}'? This will stop and remove all containers.`)) {
                                doStackAction("compose_down", group.name, e);
                              }
                            }}
                            disabled={isLoading()}
                            title="docker compose down"
                          >
                            &#8595; Down
                          </button>
                        </div>
                      </Show>
                    </div>
                  </div>

                  <Show when={isExpanded()}>
                    <div class="stack-services">
                      <table class="table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Image</th>
                            <th>State</th>
                            <th>CPU</th>
                            <th>Memory</th>
                            <th>Ports</th>
                            <th style={{ "text-align": "right" }}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={filteredContainers()}>
                            {(c) => containerRow(c, group.name)}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>

          {/* Standalone containers */}
          <Show when={filteredGroups().standalone.length > 0}>
            <div class="stack-card">
              <div class="stack-header" onClick={() => toggleExpand("__standalone__")}>
                <div class="stack-header-left">
                  <span class={`expand-arrow ${expanded().has("__standalone__") ? "expanded" : ""}`}>
                    &#9654;
                  </span>
                  <div>
                    <div class="stack-name">Standalone</div>
                    <div class="stack-meta">
                      {filteredGroups().standalone.filter((c) => c.state === "Running").length}/{filteredGroups().standalone.length} running
                    </div>
                  </div>
                </div>
              </div>

              <Show when={expanded().has("__standalone__")}>
                <div class="stack-services">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Image</th>
                        <th>State</th>
                        <th>CPU</th>
                        <th>Memory</th>
                        <th>Ports</th>
                        <th style={{ "text-align": "right" }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={filteredGroups().standalone}>
                        {(c) => containerRow(c)}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </div>
          </Show>
        </div>
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
