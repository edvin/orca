import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Container, ContainerStats, ComposeProject } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { formatPorts, formatTimestamp, shortId, formatBytes } from "../lib/format";
import { showToast } from "../components/Toast";
import { confirmDanger } from "../components/ConfirmDialog";
import RunContainerDialog from "../components/RunContainerDialog";
import CopyButton from "../components/CopyButton";
import Spinner from "../components/Spinner";
import ResourceBar from "../components/ResourceBar";
import Sparkline from "../components/Sparkline";
import LastUpdated from "../components/LastUpdated";
import { recordMetrics, getCpuHistory, getMemoryHistory } from "../lib/metricsStore";
import { logError } from "../lib/activityStore";

interface ContainersPageProps {
  onNavigate?: (page: string) => void;
  onAskAi?: (containerId: string, containerName: string, image: string) => void;
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
  const [menuOpen, setMenuOpen] = createSignal<string | null>(null);
  const [containerMenuOpen, setContainerMenuOpen] = createSignal<string | null>(null);

  const refresh = async () => {
    try {
      const [containerResult, stackResult] = await Promise.all([
        invoke("list_containers") as Promise<Container[]>,
        invoke("list_stacks") as Promise<ComposeProject[]>,
      ]);
      setContainers(containerResult || []);
      setStacks(stackResult || []);
      setLastUpdated(new Date());

      // Auto-expand stacks with running containers (on first load)
      if (expanded().size <= 1) {
        const autoExpand = new Set(expanded());
        for (const stack of stackResult) {
          if (stack.services.some((s) => s.state === "Running")) {
            autoExpand.add(stack.name);
          }
        }
        setExpanded(autoExpand);
      }
    } catch (e) {
      logError(`Failed to list containers/stacks: ${e}`);
    }
  };

  useRefresh(refresh);

  const deduplicatePorts = (ports: { host_ip?: string | null; host_port: number; container_port: number }[]) => {
    const seen = new Set<string>();
    return ports.filter((p) => {
      const key = `${p.host_port}:${p.container_port}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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

  // Close dropdown menus when clicking outside
  const handleClickOutside = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // Don't close if the click is inside a dropdown-wrapper (toggle or menu item)
    if (target.closest?.(".dropdown-wrapper")) return;
    setMenuOpen(null);
    setContainerMenuOpen(null);
  };

  onMount(() => {
    refresh().then(fetchAllRunningStats);
    const interval = setInterval(() => {
      refresh();
      fetchAllRunningStats();
    }, 3000);
    document.addEventListener("click", handleClickOutside);
    onCleanup(() => {
      clearInterval(interval);
      document.removeEventListener("click", handleClickOutside);
    });
  });

  const restartStack = async (name: string) => {
    setStackActionInProgress(name);
    try {
      await invoke("restart_stack", { name });
      showToast("Stack restarted", "success");
      setTimeout(refresh, 500);
    } catch (err) {
      logError(`Failed to restart stack: ${err}`, `Stack "${name}"`);
      showToast(`Restart failed: ${err}`, "error");
    }
    setStackActionInProgress(null);
  };

  const pullStack = async (name: string) => {
    setStackActionInProgress(name);
    try {
      const result = await invoke("compose_pull", { name });
      if (result && typeof result === "object") {
        const output = result as any;
        if (!output.success) {
          showToast(`Pull failed: ${output.stderr || "Unknown error"}`, "error");
        } else {
          showToast("Images pulled successfully", "success");
        }
      }
      setTimeout(refresh, 500);
    } catch (err) {
      logError(`Failed to pull stack images: ${err}`, `Stack "${name}"`);
      showToast(`Pull failed: ${err}`, "error");
    }
    setStackActionInProgress(null);
  };

  const deleteStack = async (name: string) => {
    if (!await confirmDanger("Delete Stack", `Delete stack "${name}"? This will stop and remove all containers in the stack.`)) return;
    setStackActionInProgress(name);
    try {
      await invoke("compose_down", { name });
      showToast(`Stack "${name}" removed`, "success");
      await refresh();
    } catch (err) {
      logError(`Failed to delete stack: ${err}`, `Stack "${name}"`);
      showToast(`Failed to delete stack: ${err}`, "error");
    }
    setStackActionInProgress(null);
  };

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

  const totalCount = () => (containers() || []).length;
  const runningCount = () => (containers() || []).filter((c) => c.state === "Running").length;
  const stoppedCount = () => (containers() || []).filter((c) => c.state !== "Running").length;

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
      logError(`Failed to ${action.replace("_container", "")} container: ${err}`, `Container ${id}`);
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
      logError(`Failed to restart container: ${err}`, `Container ${id}`);
      showToast(`Restart failed: ${err}`, "error");
    }
    setLoading(false);
    setActionInProgress(null);
  };

  const doStackAction = async (action: string, name: string, e: MouseEvent) => {
    e.stopPropagation();
    const label = action.replace(/_/g, " ").replace("compose ", "");
    setStackActionInProgress(name);
    try {
      const result = await invoke(action, { name });
      if (result && typeof result === "object") {
        const output = result as any;
        if (output.success === false) {
          showToast(`Stack ${label} failed: ${output.stderr || output.stdout || "Check container logs for details"}`, "error");
        } else {
          showToast(`Stack ${label} completed`, "success");
        }
      } else {
        showToast(`Stack ${label} completed`, "success");
      }
      setTimeout(refresh, 500);
    } catch (err) {
      const errStr = String(err);
      logError(`Failed to ${label} stack: ${errStr}`, `Stack "${name}"`);
      if (errStr.includes("compose file") || errStr.includes("not found")) {
        showToast(`Stack ${label} failed: No compose file found. This stack was auto-detected from container labels.`, "error");
      } else {
        showToast(`Stack ${label} failed: ${errStr}`, "error");
      }
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

  // A container has a real limit if the percentage is meaningful (> 1%)
  // When Docker returns host RAM as the limit, small containers show < 1%
  const hasRealMemLimit = (s: ContainerStats) => memPercent(s) > 1;

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
              <ResourceBar value={s().cpu_percent} label={`${s().cpu_percent.toFixed(1)}%`} />
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
              <Show when={hasRealMemLimit(s())} fallback={
                <span style={{ "font-size": "11px", color: "#8b949e" }}>{formatBytes(s().memory_usage_bytes)}</span>
              }>
                <ResourceBar value={memPercent(s())} label={formatBytes(s().memory_usage_bytes)} />
              </Show>
            )}
          </Show>
        </td>
        <td class="mono" style={{ "max-width": "200px" }}>
          <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap", "align-items": "center" }}>
            {c.ports && c.ports.length > 0 ? (
              <For each={deduplicatePorts(c.ports)}>
                {(p) => {
                  const proto = [443, 8443, 9443].includes(p.host_port) ? "https" : "http";
                  return (
                    <a
                      href={`${proto}://localhost:${p.host_port}`}
                      target="_blank"
                      onClick={(e) => e.stopPropagation()}
                      style={{ color: "#58a6ff", "font-size": "12px" }}
                      title={`Open ${proto}://localhost:${p.host_port}`}
                    >
                      {p.host_port}:{p.container_port}
                    </a>
                  );
                }}
              </For>
            ) : (
              <span style={{ color: "#484f58" }}>-</span>
            )}
          </div>
        </td>
        <td>
          <Show when={c.state === "Running" && cStats()} fallback={
            <span style={{ color: "#484f58", "font-size": "11px" }}>{c.state === "Running" ? "-" : "\u2014"}</span>
          }>
            {(s) => (
              <span style={{ "font-size": "11px", color: "#8b949e", "white-space": "nowrap" }}>
                {"\u2191"}{formatBytes(s().network_tx_bytes)} {"\u2193"}{formatBytes(s().network_rx_bytes)}
              </span>
            )}
          </Show>
        </td>
        <td style={{ "text-align": "right" }}>
          <div class={`action-icons ${actionInProgress() === c.id ? "loading" : ""}`}>
            <Show when={actionInProgress() === c.id}>
              <div class="action-spinner"><Spinner size={14} /></div>
            </Show>
            <Show when={c.state === "Running"}>
              <button
                class="action-icon action-icon-stop"
                onClick={(e) => doAction("stop_container", c.id, e)}
                disabled={loading()}
                title="Stop"
              >
                &#9632;
              </button>
            </Show>
            <Show when={c.state !== "Running"}>
              <button
                class="action-icon action-icon-start"
                onClick={(e) => doAction("start_container", c.id, e)}
                disabled={loading()}
                title="Start"
              >
                &#9654;
              </button>
            </Show>
            <Show when={props.onAskAi}>
              <button
                class="action-icon"
                onClick={(e) => { e.stopPropagation(); props.onAskAi?.(c.id, c.name, c.image); }}
                title="Ask AI about this container"
                style={{ "font-size": "14px" }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/><path d="M4 3v2"/><path d="M3 4h2"/><path d="M20 19v2"/><path d="M19 20h2"/></svg>
              </button>
            </Show>
            <div class="dropdown-wrapper">
              <button
                class="action-icon"
                onClick={(e) => {
                  e.stopPropagation();
                  setContainerMenuOpen(containerMenuOpen() === c.id ? null : c.id);
                }}
                title="More actions"
                style={{ color: "#8b949e" }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>
              </button>
              <Show when={containerMenuOpen() === c.id}>
                <div class="dropdown-menu" onClick={(e: MouseEvent) => e.stopPropagation()}>
                  <button
                    class="dropdown-item"
                    onClick={() => { doRestart(c.id, new MouseEvent("click")); setContainerMenuOpen(null); }}
                    disabled={loading() || c.state !== "Running"}
                  >
                    &#10227; Restart
                  </button>
                  <button
                    class="dropdown-item"
                    onClick={() => {
                      props.onNavigate?.(
                        stackName
                          ? `container:${c.id},stack:${stackName}`
                          : `container:${c.id}`
                      );
                      setContainerMenuOpen(null);
                    }}
                  >
                    &#128203; Logs
                  </button>
                  <div class="dropdown-divider" />
                  <button
                    class="dropdown-item dropdown-item-danger"
                    onClick={async () => {
                      if (await confirmDanger("Remove Container", `Remove container '${c.name}'? This cannot be undone.`)) {
                        doAction("remove_container", c.id, new MouseEvent("click"));
                      }
                      setContainerMenuOpen(null);
                    }}
                    disabled={loading() || c.state === "Running"}
                  >
                    &#128465; Delete
                  </button>
                </div>
              </Show>
            </div>
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
          <div style={{ position: "relative", display: "inline-flex", "align-items": "center" }}>
            <input
              class="search-input"
              type="text"
              placeholder="Search containers & stacks..."
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              style={{ "padding-right": "30px" }}
            />
            <Show when={search().length > 0}>
              <button
                class="search-clear-btn"
                onClick={() => setSearch("")}
                title="Clear search"
                type="button"
              >
                &times;
              </button>
            </Show>
          </div>
          <button class="btn btn-primary" onClick={() => setShowRunDialog(true)}>
            Run
          </button>
        </div>
      </div>

      <Show
        when={totalCount() > 0}
        fallback={
          <div class="empty">
            <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05"/><path d="M12 22.08V12"/></svg></div>
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
                      <div class={`action-icons ${isLoading() ? "loading" : ""}`} style={{ "margin-right": "4px" }}>
                        <Show when={isLoading()}>
                          <div class="action-spinner"><Spinner size={14} /></div>
                        </Show>
                        <Show when={allRunning()}>
                          <button
                            class="action-icon action-icon-stop"
                            onClick={(e) => {
                              e.stopPropagation();
                              doStackAction("stop_stack", group.name, e);
                            }}
                            disabled={isLoading()}
                            title="Stop stack"
                          >
                            &#9632;
                          </button>
                        </Show>
                        <Show when={!allRunning()}>
                          <button
                            class="action-icon action-icon-start"
                            onClick={(e) => {
                              e.stopPropagation();
                              doStackAction("start_stack", group.name, e);
                            }}
                            disabled={isLoading()}
                            title="Start stack"
                          >
                            &#9654;
                          </button>
                        </Show>
                        <div class="dropdown-wrapper">
                          <button
                            class="action-icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuOpen(menuOpen() === group.name ? null : group.name);
                            }}
                            title="More actions"
                            style={{ color: "#8b949e" }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>
                          </button>
                          <Show when={menuOpen() === group.name}>
                            <div class="dropdown-menu" onClick={(e) => e.stopPropagation()}>
                              <button class="dropdown-item" onClick={() => { restartStack(group.name); setMenuOpen(null); }}>&#10227; Restart</button>
                              <button class="dropdown-item" onClick={() => { pullStack(group.name); setMenuOpen(null); }}>&#8595; Pull Images</button>
                              <div class="dropdown-divider" />
                              <button class="dropdown-item dropdown-item-danger" onClick={() => { deleteStack(group.name); setMenuOpen(null); }}>&#128465; Delete Stack</button>
                            </div>
                          </Show>
                        </div>
                      </div>
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
                            <th>Net I/O</th>
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
                        <th>Net I/O</th>
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
