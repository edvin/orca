import { createSignal, onMount, onCleanup, For, Show, createMemo } from "solid-js";
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
import MultiLogViewer from "../components/MultiLogViewer";

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
  let hasAutoExpanded = false;
  const [menuOpen, setMenuOpen] = createSignal<string | null>(null);
  const [containerMenuOpen, setContainerMenuOpen] = createSignal<string | null>(null);
  const [showMultiLog, setShowMultiLog] = createSignal(false);
  const [showComposeEditor, setShowComposeEditor] = createSignal(false);
  const [composePath, setComposePath] = createSignal("");
  const [composeContent, setComposeContent] = createSignal("");
  const [composeDeploying, setComposeDeploying] = createSignal(false);
  const [composeValidating, setComposeValidating] = createSignal(false);
  const [composeError, setComposeError] = createSignal("");

  const refresh = async () => {
    try {
      const [containerResult, stackResult] = await Promise.all([
        invoke("list_containers") as Promise<Container[]>,
        invoke("list_stacks") as Promise<ComposeProject[]>,
      ]);
      setContainers(containerResult || []);
      setStacks(stackResult || []);
      setLastUpdated(new Date());

      // Auto-expand stacks with running containers (only on first load)
      if (!hasAutoExpanded) {
        hasAutoExpanded = true;
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

  const runningContainers = createMemo(() =>
    (containers() || []).filter((c) => c.state === "Running")
  );

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
        <td class="mono" style={{ color: "#8b949e", "max-width": "280px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }} title={c.image}>
          {c.image.startsWith("sha256:") ? c.image.slice(0, 19) + "..." : c.image}
        </td>
        <td>
          <span class={`state-badge ${stateClass(c.state)}`}>{c.state}</span>
          <Show when={c.health_status && c.health_status !== "none" && c.health_status !== ""}>
            <span
              title={
                c.health_status === "unhealthy"
                  ? `Unhealthy${c.health_log?.[0]?.output ? ": " + c.health_log[0].output.trim() : ""}`
                  : c.health_status === "healthy"
                  ? "Healthy"
                  : "Health check starting..."
              }
              style={{
                "margin-left": "6px",
                "font-size": "10px",
                color:
                  c.health_status === "healthy"
                    ? "#3fb950"
                    : c.health_status === "unhealthy"
                    ? "#f85149"
                    : "#d29922",
                ...(c.health_status === "starting"
                  ? { animation: "pulse 1.5s ease-in-out infinite" }
                  : {}),
              }}
            >
              {"\u25CF"}
            </span>
          </Show>
          <Show when={c.restart_count && c.restart_count > 0}>
            <span
              title={`Restarted ${c.restart_count} time${c.restart_count === 1 ? "" : "s"}`}
              style={{
                "margin-left": "6px",
                "font-size": "10px",
                color: "#d29922",
                "font-weight": "500",
              }}
            >
              {"\u21BB"} {c.restart_count}
            </span>
          </Show>
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
          <Show when={runningContainers().length >= 2}>
            <button class="btn" onClick={() => setShowMultiLog(true)}>
              Combined Logs
            </button>
          </Show>
          <Show when={runningContainers().length > 0}>
            <button class="btn" style={{ color: "#f85149" }} onClick={async () => {
              const running = runningContainers();
              if (!await confirmDanger("Stop All Containers", `Stop all ${running.length} running containers?`)) return;
              let stopped = 0;
              for (const c of running) {
                try {
                  await invoke("stop_container", { id: c.id });
                  stopped++;
                } catch (err) {
                  logError(`Failed to stop container ${c.name}: ${err}`, `Container ${c.id}`);
                }
              }
              showToast(`Stopped ${stopped} container${stopped !== 1 ? "s" : ""}`, "success");
              await refresh();
            }}>
              Stop All
            </button>
          </Show>
          <button class="btn" onClick={() => {
            setComposePath("");
            setComposeContent(`version: "3.8"\n\nservices:\n  app:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n    restart: unless-stopped\n`);
            setComposeError("");
            setShowComposeEditor(true);
          }}>
            Compose
          </button>
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
            <p>Deploy a pre-configured app from the catalog, or click Run Container to start any Docker image with custom settings.</p>
            <div class="empty-actions">
              <button class="btn btn-primary" onClick={() => props.onNavigate?.("templates")}>
                Browse App Catalog
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
          onCreated={(id) => { refresh(); if (id) props.onNavigate?.(`container:${id}`); }}
        />
      </Show>

      <Show when={showMultiLog()}>
        <MultiLogViewer
          containers={runningContainers().map((c) => ({ id: c.id, name: c.name }))}
          onClose={() => setShowMultiLog(false)}
        />
      </Show>

      {/* Compose Editor Dialog */}
      <Show when={showComposeEditor()}>
        <div class="modal-overlay" onClick={(e) => { if ((e.target as HTMLElement).classList.contains("modal-overlay") && !composeDeploying()) setShowComposeEditor(false); }}>
          <div class="modal-dialog" style={{ "max-width": "800px", height: "80vh", display: "flex", "flex-direction": "column" }}>
            <div class="modal-header">
              <h2 class="modal-title">Deploy Compose Stack</h2>
              <button class="modal-close" onClick={() => { if (!composeDeploying()) setShowComposeEditor(false); }}>{"\u00d7"}</button>
            </div>
            <div class="modal-body" style={{ flex: "1", display: "flex", "flex-direction": "column", gap: "12px", overflow: "hidden" }}>
              <div class="form-group">
                <label class="form-label">Directory Path</label>
                <input class="form-input mono" type="text"
                  placeholder="/path/to/project (docker-compose.yml will be saved here)"
                  value={composePath()}
                  onInput={(e) => setComposePath(e.currentTarget.value)}
                />
                <span class="form-hint">The directory where docker-compose.yml will be created. Must be an absolute path.</span>
              </div>
              <div style={{ flex: "1", "min-height": "0", border: "1px solid #30363d", "border-radius": "8px", overflow: "hidden" }}>
                <textarea class="form-textarea mono" style={{
                  width: "100%", height: "100%", resize: "none",
                  background: "#0d1117", color: "#e6edf3", border: "none",
                  "font-size": "13px", padding: "12px", "line-height": "1.5",
                  "box-sizing": "border-box",
                }}
                  value={composeContent()}
                  onInput={(e) => setComposeContent(e.currentTarget.value)}
                  spellcheck={false}
                />
              </div>
              <Show when={composeError()}>
                <div style={{
                  background: "rgba(248, 81, 73, 0.1)",
                  border: "1px solid #f85149",
                  "border-radius": "8px",
                  padding: "10px 12px",
                  color: "#f85149",
                  "font-size": "12px",
                  "font-family": "'JetBrains Mono', monospace",
                  "white-space": "pre-wrap",
                  "max-height": "120px",
                  "overflow-y": "auto",
                }}>{composeError()}</div>
              </Show>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setShowComposeEditor(false)} disabled={composeDeploying() || composeValidating()}>Cancel</button>
              <button class="btn" disabled={composeValidating() || composeDeploying() || !composePath().trim() || !composeContent().trim()}
                onClick={async () => {
                  const dir = composePath().trim();
                  if (!dir) return;
                  setComposeValidating(true);
                  setComposeError("");
                  try {
                    const filePath = dir.endsWith("/") ? `${dir}docker-compose.yml` : `${dir}/docker-compose.yml`;
                    await invoke("save_compose_file", { path: filePath, content: composeContent() });
                    const result = await invoke("validate_compose", { path: filePath }) as { valid: boolean; error?: string };
                    if (result.valid) {
                      showToast("Compose file is valid", "success");
                    } else {
                      setComposeError(result.error || "Validation failed");
                    }
                  } catch (e) {
                    setComposeError(`${e}`);
                  }
                  setComposeValidating(false);
                }}
              >
                {composeValidating() ? (<><Spinner size={12} />{" Validating..."}</>) : "Validate"}
              </button>
              <button class="btn btn-primary" disabled={composeDeploying() || composeValidating() || !composePath().trim() || !composeContent().trim()}
                onClick={async () => {
                  const dir = composePath().trim();
                  if (!dir) return;
                  setComposeDeploying(true);
                  setComposeError("");
                  try {
                    // Save the compose file
                    const filePath = dir.endsWith("/") ? `${dir}docker-compose.yml` : `${dir}/docker-compose.yml`;
                    await invoke("save_compose_file", { path: filePath, content: composeContent() });
                    // Validate before deploying
                    const result = await invoke("validate_compose", { path: filePath }) as { valid: boolean; error?: string };
                    if (!result.valid) {
                      setComposeError(result.error || "Validation failed");
                      setComposeDeploying(false);
                      return;
                    }
                    // Run compose up from the directory
                    await invoke("compose_deploy_path", { path: dir });
                    showToast("Stack deployed!", "success");
                    setShowComposeEditor(false);
                    refresh();
                  } catch (e) {
                    showToast(`Deploy failed: ${e}`, "error");
                  }
                  setComposeDeploying(false);
                }}
              >
                {composeDeploying() ? (<><Spinner size={12} />{" Deploying..."}</>) : "Deploy"}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
