import { createSignal, createEffect, onMount, onCleanup, For, Show, createMemo, type JSX } from "solid-js";
import { openContainerOn } from "../lib/containerTab";
import DockerUnreachable from "../components/DockerUnreachable";
import { onIntent } from "../lib/pageIntent";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { Container, ContainerStats, ComposeProject } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { usePoller } from "../lib/poller";
import { containersStore, stacksStore } from "../lib/dockerStore";
import { formatBytes } from "../lib/format";
import { openFolderDialog } from "../lib/openFolder";
import FolderActions from "../components/FolderActions";
import { showToast } from "../components/Toast";
import { confirmDanger } from "../components/ConfirmDialog";
import RunContainerDialog from "../components/RunContainerDialog";
import Spinner from "../components/Spinner";
import { SkeletonRow } from "../components/Skeleton";
import ResourceBar from "../components/ResourceBar";
import PortLinks from "../components/PortLinks";
import { portGroups } from "../lib/ports";
import LastUpdated from "../components/LastUpdated";
import { useContainerStats } from "../lib/statsStore";
import { getCpuHistory, getMetricsHistory } from "../lib/metricsStore";
import Sparkline from "../components/Sparkline";
import { logError } from "../lib/activityStore";
import MultiLogViewer from "../components/MultiLogViewer";
import { closeOnEscape } from "../lib/closeOnEscape";

interface ContainersPageProps {
  onNavigate?: (page: string) => void;
  onAskAi?: (containerId: string, containerName: string, image: string) => void;
}

interface StackGroup {
  name: string;
  containers: Container[];
  composeProject?: ComposeProject;
}

function readPref<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private window or blocked storage: the default applies next time
  }
}

export default function ContainersPage(props: ContainersPageProps) {
  // Shared lists, refreshed by Docker events (see lib/dockerStore.ts).
  const containerList = containersStore.use();
  const stackList = stacksStore.use();
  const containers = containerList.list;
  const stacks = stackList.list;
  const [search, setSearch] = createSignal("");
  // The filter and the view are remembered: most visits are to see what runs.
  const [stateFilter, setStateFilter] = createSignal<"all" | "running" | "stopped">(
    readPref("orca.containers.filter", ["running", "stopped", "all"], "running"),
  );
  const [viewMode, setViewMode] = createSignal<"stacks" | "list">(readPref("orca.containers.view", ["stacks", "list"], "stacks"));
  createEffect(() => writePref("orca.containers.filter", stateFilter()));
  createEffect(() => writePref("orca.containers.view", viewMode()));
  const lastUpdated = () => {
    const t = containerList.updatedAt();
    return t ? new Date(t) : null;
  };
  const [loading, setLoading] = createSignal(false);
  const [actionInProgress, setActionInProgress] = createSignal<string | null>(null);
  const [stackActionInProgress, setStackActionInProgress] = createSignal<string | null>(null);
  const [showRunDialog, setShowRunDialog] = createSignal(false);
  onIntent("containers", (a) => { if (a === "run") setShowRunDialog(true); });
  // Stats of all running containers, shared with the dashboard.
  const { stats: inlineStats } = useContainerStats();
  // Stacks the user opened or closed; the rest follow `openByDefault`.
  const [toggled, setToggled] = createSignal<Map<string, boolean>>(new Map());
  const [menuOpen, setMenuOpen] = createSignal<string | null>(null);
  const [containerMenuOpen, setContainerMenuOpen] = createSignal<string | null>(null);
  closeOnEscape(
    () => menuOpen() !== null || containerMenuOpen() !== null,
    () => {
      setMenuOpen(null);
      setContainerMenuOpen(null);
    },
  );
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [batchDeleteProgress, setBatchDeleteProgress] = createSignal<{ done: number; total: number } | null>(null);
  const [showMultiLog, setShowMultiLog] = createSignal(false);

  // Gateway expose state
  const [exposeContainer, setExposeContainer] = createSignal<Container | null>(null);
  const [exposeHostname, setExposeHostname] = createSignal("");
  const [exposePort, setExposePort] = createSignal("80");
  const [exposing, setExposing] = createSignal(false);
  // the gateway's domain (a workspace can set one), for the suffix, preview and new routes
  const [exposeDomain, setExposeDomain] = createSignal("localhost");
  const [exposeExistingRoutes, setExposeExistingRoutes] = createSignal<Array<{ hostname: string; url: string; port: number }>>([]);
  const [gatewayRoutes, setGatewayRoutes] = createSignal<Array<{ hostname: string; container_name: string; port: number }>>([]);

  const loadGatewayRoutes = () =>
    invoke("gateway_list_routes").then((r) => setGatewayRoutes((r as any[]) || [])).catch(() => {});
  usePoller(loadGatewayRoutes, 10_000);

  const refresh = async () => {
    try {
      await Promise.all([containerList.refresh(), stackList.refresh()]);
      const e = containerList.error() ?? stackList.error();
      if (e) logError(`Failed to list containers/stacks: ${e}`);
    } finally {
      loadGatewayRoutes();
    }
  };

  useRefresh(refresh);

  const suggestHostname = (name: string) => {
    let h = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    const parts = h.split("-");
    if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1])) {
      h = parts.slice(1, -1).join("-");
    }
    return h;
  };

  const openExposeDialog = async (c: Container) => {
    try {
      const s = (await invoke("gateway_status")) as { domain?: string } | null;
      setExposeDomain(s?.domain || "localhost");
    } catch {
      setExposeDomain("localhost");
    }
    try {
      const routes = (await invoke("gateway_list_routes")) as Array<{ hostname: string; container_name: string; port: number; url: string }>;
      const existing = routes.filter((r) => r.container_name === c.name);
      setExposeExistingRoutes(existing.map((r) => ({ hostname: r.hostname, url: r.url || `https://${r.hostname}`, port: r.port })));
    } catch {
      setExposeExistingRoutes([]);
    }
    setExposeHostname(suggestHostname(c.name));
    if (c.ports && c.ports.length > 0) {
      setExposePort(String(c.ports[0].container_port));
    } else {
      setExposePort("80");
    }
    setExposeContainer(c);
  };

  const handleExpose = async (e: Event) => {
    e.preventDefault();
    const c = exposeContainer();
    if (!c) return;
    const hostname = exposeHostname().trim();
    const port = parseInt(exposePort(), 10);
    if (!hostname || isNaN(port)) return;

    const fullHostname = hostname.includes(".") ? hostname : `${hostname}.${exposeDomain()}`;
    setExposing(true);
    try {
      await invoke("gateway_add_route", {
        hostname: fullHostname,
        containerName: c.name,
        port,
      });
      showToast(`Exposed ${c.name} at ${fullHostname}`, "success");
      // Add to existing routes list and clear the form for another
      setExposeExistingRoutes([...exposeExistingRoutes(), { hostname: fullHostname, url: `https://${fullHostname}`, port }]);
      setExposeHostname("");
      setExposePort(c.ports?.length > 0 ? String(c.ports[0].container_port) : "80");
    } catch (err) {
      logError(`Failed to expose container: ${err}`);
      showToast(`Failed to expose: ${err}`, "error");
    }
    setExposing(false);
  };

  const handleUnexpose = async (hostname: string) => {
    try {
      await invoke("gateway_remove_route", { hostname });
      showToast(`Route ${hostname} removed`, "success");
      setExposeExistingRoutes(exposeExistingRoutes().filter((r) => r.hostname !== hostname));
    } catch (err) {
      logError(`Failed to remove route: ${err}`);
      showToast(`Failed to remove: ${err}`, "error");
    }
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
    document.addEventListener("click", handleClickOutside);
    onCleanup(() => {
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
    if (!await confirmDanger("Delete stack", `Delete stack "${name}"? This will stop and remove all containers in the stack.`)) return;
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
  let previousGroups = new Map<string, StackGroup>();
  const grouped = createMemo((): { stackGroups: StackGroup[]; standalone: Container[] } => {
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
    const next = new Map<string, StackGroup>();
    for (const [name, ctrs] of projectContainers) {
      // Keep a group's object while its members are the same, so <For>
      // keeps its card (the rows inside update on their own).
      const prev = previousGroups.get(name);
      const composeProject = stackMap.get(name);
      const group =
        prev &&
        prev.composeProject === composeProject &&
        prev.containers.length === ctrs.length &&
        prev.containers.every((c, i) => c === ctrs[i])
          ? prev
          : { name, containers: ctrs, composeProject };
      next.set(name, group);
      groups.push(group);
    }
    previousGroups = next;
    // Sort stack groups alphabetically
    groups.sort((a, b) => a.name.localeCompare(b.name));

    return { stackGroups: groups, standalone: standaloneList };
  });

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

  const filteredGroups = createMemo(() => {
    const { stackGroups, standalone } = grouped();
    const filteredStacks = stackGroups.filter(stackPassesFilter);
    const filteredStandalone = applyFilters(standalone);
    return { stackGroups: filteredStacks, standalone: filteredStandalone };
  });

  // Gateway routes by container name, for the hostname badges on each row.
  const routesByContainer = createMemo(() => {
    const map = new Map<string, Array<{ hostname: string; container_name: string; port: number }>>();
    for (const r of gatewayRoutes()) {
      const list = map.get(r.container_name);
      if (list) list.push(r);
      else map.set(r.container_name, [r]);
    }
    return map;
  });

  const toggleSelect = (id: string, e: MouseEvent) => {
    e.stopPropagation();
    const next = new Set(selected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleGroupSelect = (groupContainers: Container[]) => {
    const ids = groupContainers.map((c) => c.id);
    const sel = selected();
    const allSelected = ids.length > 0 && ids.every((id) => sel.has(id));
    const next = new Set(sel);
    if (allSelected) {
      for (const id of ids) next.delete(id);
    } else {
      for (const id of ids) next.add(id);
    }
    setSelected(next);
  };

  const groupCheckState = (groupContainers: Container[]): "none" | "some" | "all" => {
    const ids = groupContainers.map((c) => c.id);
    if (ids.length === 0) return "none";
    const sel = selected();
    const count = ids.filter((id) => sel.has(id)).length;
    if (count === 0) return "none";
    if (count === ids.length) return "all";
    return "some";
  };

  const CheckboxIndicator = (p: { state: "none" | "some" | "all"; onClick: (e: MouseEvent) => void }) => (
    <span
      onClick={(e) => p.onClick(e)}
      style={{
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        width: "16px",
        height: "16px",
        "border-radius": "3px",
        border: `1.5px solid ${p.state === "none" ? "#484f58" : "#58a6ff"}`,
        background: p.state === "none" ? "transparent" : p.state === "all" ? "#58a6ff" : "transparent",
        cursor: "pointer",
        "flex-shrink": "0",
        transition: "all 0.15s ease",
      }}
    >
      <Show when={p.state === "all"}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="1.5,5.5 4,8 8.5,2" />
        </svg>
      </Show>
      <Show when={p.state === "some"}>
        <span style={{ width: "8px", height: "2px", background: "#58a6ff", "border-radius": "1px" }} />
      </Show>
    </span>
  );

  const batchStart = async () => {
    const ids = Array.from(selected()).filter((id) => {
      const c = containers().find((ct) => ct.id === id);
      return c && c.state !== "Running";
    });
    if (ids.length === 0) {
      showToast("No stopped containers selected", "info");
      return;
    }
    let started = 0;
    for (const id of ids) {
      try {
        await invoke("start_container", { id });
        started++;
      } catch (err) {
        logError(`Failed to start container: ${err}`, `Container ${id}`);
      }
    }
    showToast(`Started ${started} container${started !== 1 ? "s" : ""}`, "success");
    setSelected(new Set<string>());
    await refresh();
  };

  const batchStop = async () => {
    const ids = Array.from(selected()).filter((id) => {
      const c = containers().find((ct) => ct.id === id);
      return c && c.state === "Running";
    });
    if (ids.length === 0) {
      showToast("No running containers selected", "info");
      return;
    }
    let stopped = 0;
    for (const id of ids) {
      try {
        await invoke("stop_container", { id });
        stopped++;
      } catch (err) {
        logError(`Failed to stop container: ${err}`, `Container ${id}`);
      }
    }
    showToast(`Stopped ${stopped} container${stopped !== 1 ? "s" : ""}`, "success");
    setSelected(new Set<string>());
    await refresh();
  };

  const batchDelete = async () => {
    const ids = Array.from(selected());
    if (ids.length === 0) return;
    const count = ids.length;
    if (!await confirmDanger(
      "Delete containers",
      `Delete ${count} selected container${count !== 1 ? "s" : ""}? This cannot be undone.`
    )) return;
    setBatchDeleteProgress({ done: 0, total: count });
    let deleted = 0;
    try {
      for (const id of ids) {
        try {
          await invoke("remove_container", { id, force: true });
          deleted++;
        } catch (err) {
          logError(`Failed to remove container: ${err}`, `Container ${id}`);
        }
        setBatchDeleteProgress({ done: deleted, total: count });
      }
    } finally {
      setBatchDeleteProgress(null);
    }
    showToast(`Deleted ${deleted} container${deleted !== 1 ? "s" : ""}`, "success");
    setSelected(new Set<string>());
    await refresh();
  };

  const totalCount = () => (containers() || []).length;
  const runningCount = () => (containers() || []).filter((c) => c.state === "Running").length;
  const stoppedCount = () => (containers() || []).filter((c) => c.state !== "Running").length;

  const runningContainers = createMemo(() =>
    (containers() || []).filter((c) => c.state === "Running")
  );

  // Open unless nothing in it runs, while showing everything: a filter or
  // a search shows only what matches, so that's open.
  const openByDefault = (list: Container[]) =>
    stateFilter() !== "all" || search() !== "" || list.some((c) => c.state === "Running");
  const isOpen = (name: string, list: Container[]) => toggled().get(name) ?? openByDefault(list);
  const toggleExpand = (name: string, list: Container[]) => {
    const next = new Map(toggled());
    next.set(name, !isOpen(name, list));
    setToggled(next);
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

  // What a container is doing, in a word, and how it should look.
  const status = (c: Container): { label: string; tone: "ok" | "warn" | "bad" | "off"; pulse?: boolean; title?: string } => {
    if (c.state === "Running") {
      if (c.health_status === "unhealthy") {
        const out = c.health_log?.[0]?.output?.trim();
        return { label: "Unhealthy", tone: "bad", title: out ? `Unhealthy: ${out}` : "Its health check fails" };
      }
      if (c.health_status === "starting") return { label: "Starting", tone: "warn", pulse: true, title: "Health check starting" };
      if (c.health_status === "healthy") return { label: "Healthy", tone: "ok", title: "Running, health check passes" };
      return { label: "Running", tone: "ok" };
    }
    if (c.state === "Paused") return { label: "Paused", tone: "warn" };
    if (c.state === "Restarting") return { label: "Restarting", tone: "warn", pulse: true };
    if (c.state === "Created") return { label: "Created", tone: "off", title: "Created, never started" };
    return { label: c.state || "Stopped", tone: "off" };
  };

  const memPercent = (s: ContainerStats) => {
    if (!s.memory_limit_bytes || s.memory_limit_bytes === 0) return 0;
    return (s.memory_usage_bytes / s.memory_limit_bytes) * 100;
  };

  // A container has a real limit if the percentage is meaningful (> 1%)
  // When Docker returns host RAM as the limit, small containers show < 1%
  const hasRealMemLimit = (s: ContainerStats) => memPercent(s) > 1;

  // Inside a stack the stack name is already the group header, so show
  // "clickhouse" for "ai-platform-clickhouse" (and "web-1" for "shop-web-1").
  const shortName = (c: Container, stackName?: string) => {
    if (stackName && c.name.startsWith(stackName + "-") && c.name.length > stackName.length + 1) {
      return c.name.slice(stackName.length + 1);
    }
    return c.name;
  };

  const containerPage = (c: Container) => {
    const stack = c.labels?.["com.docker.compose.project"];
    return stack ? `container:${c.id},stack:${stack}` : `container:${c.id}`;
  };

  const MenuIcon = (p: { children: JSX.Element }) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      {p.children}
    </svg>
  );

  const containerRow = (c: Container, stackName?: string) => {
    const cStats = () => (c.state === "Running" ? inlineStats()[c.id] : undefined);
    const st = () => status(c);
    // The list view names the stack, which the stacks view says in the card.
    const stackLabel = () => (stackName ? undefined : c.labels?.["com.docker.compose.project"]);
    return (
      <div
        class={`ctr-row ${c.state === "Running" ? "" : "ctr-row-off"} ${selected().has(c.id) ? "ctr-row-selected" : ""} ${containerMenuOpen() === c.id ? "ctr-row-menu" : ""}`}
        onClick={() => props.onNavigate?.(containerPage(c))}
      >
        <div class="ctr-check">
          <input
            type="checkbox"
            checked={selected().has(c.id)}
            onChange={(e) => toggleSelect(c.id, e as any)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${c.name}`}
          />
        </div>
        <div class="ctr-name">
          <div class="ctr-name-line">
            <span class="ctr-title" title={c.name}>{shortName(c, stackName)}</span>
            <For each={routesByContainer().get(c.name) ?? []}>
              {(route) => (
                <span
                  class="ctr-route"
                  title={`Gateway: https://${route.hostname}. Click to manage`}
                  onClick={(ev) => { ev.stopPropagation(); openExposeDialog(c); }}
                >
                  {route.hostname}
                </span>
              )}
            </For>
          </div>
          <div class="ctr-sub" title={c.image}>
            <Show when={stackLabel()}>{(s) => <span class="ctr-stack-tag">{s()}</span>}</Show>
            <span class="ctr-image">{c.image.startsWith("sha256:") ? c.image.slice(7, 19) : c.image}</span>
          </div>
        </div>
        <div class="ctr-status">
          <span class={`ctr-pill ctr-pill-${st().tone} ${st().pulse ? "ctr-pulse" : ""}`} title={st().title ?? st().label}>
            <span class="ctr-pill-dot" />
            {st().label}
          </span>
          <Show when={c.restart_count && c.restart_count > 0}>
            <span class="ctr-restarts" title={`Restarted ${c.restart_count} time${c.restart_count === 1 ? "" : "s"}`}>
              {"↻"} {c.restart_count}
            </span>
          </Show>
        </div>
        <div class="ctr-cpu">
          <Show when={cStats()} fallback={<span class="ctr-none">{c.state === "Running" ? "…" : ""}</span>}>
            {(s) => (
              <>
                <span class="ctr-spark">
                  <Sparkline
                    data={getCpuHistory(c.id).slice(-24)}
                    times={getMetricsHistory(c.id).slice(-24).map((m) => m.timestamp)}
                    width={52}
                    height={18}
                    color={s().cpu_percent > 80 ? "#f85149" : s().cpu_percent > 50 ? "#d29922" : "#58a6ff"}
                    fillOpacity={0.15}
                  />
                </span>
                <span class="ctr-num">{s().cpu_percent < 10 ? s().cpu_percent.toFixed(1) : Math.round(s().cpu_percent)}%</span>
              </>
            )}
          </Show>
        </div>
        <div class="ctr-mem">
          <Show when={cStats()} fallback={<span class="ctr-none">{c.state === "Running" ? "…" : ""}</span>}>
            {(s) => (
              <div class="ctr-mem-inner" title={hasRealMemLimit(s()) ? `${memPercent(s()).toFixed(0)}% of ${formatBytes(s().memory_limit_bytes)}` : undefined}>
                <span class="ctr-num">{formatBytes(s().memory_usage_bytes)}</span>
                <Show when={hasRealMemLimit(s())}>
                  <ResourceBar value={memPercent(s())} showLabel={false} />
                </Show>
              </div>
            )}
          </Show>
        </div>
        <div class="ctr-ports">
          <Show when={c.ports && c.ports.length > 0}>
            <PortLinks groups={portGroups(c.image, c.ports)} />
          </Show>
        </div>
        <div class="ctr-net">
          <Show when={cStats()}>
            {(s) => (
              <span title="Sent and received since the container started">
                <span class="ctr-net-up">{"↑"}</span>{formatBytes(s().network_tx_bytes)}
                <br />
                <span class="ctr-net-down">{"↓"}</span>{formatBytes(s().network_rx_bytes)}
              </span>
            )}
          </Show>
        </div>
        <div class="ctr-actions" onClick={(e) => e.stopPropagation()}>
          <div class={`action-icons ${actionInProgress() === c.id ? "loading" : ""}`}>
            <Show when={actionInProgress() === c.id}>
              <div class="action-spinner"><Spinner size={14} /></div>
            </Show>
            <Show when={props.onAskAi}>
              <button
                class="action-icon ctr-hover-only"
                onClick={(e) => { e.stopPropagation(); props.onAskAi?.(c.id, c.name, c.image); }}
                title="Ask AI about this container"
              >
                <MenuIcon><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></MenuIcon>
              </button>
            </Show>
            <Show
              when={c.state === "Running"}
              fallback={
                <button class="action-icon action-icon-start" onClick={(e) => doAction("start_container", c.id, e)} disabled={loading()} title={`Start ${c.name}`}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" /></svg>
                </button>
              }
            >
              <button class="action-icon action-icon-stop" onClick={(e) => doAction("stop_container", c.id, e)} disabled={loading()} title={`Stop ${c.name}`}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="3" /></svg>
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
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" /></svg>
              </button>
              <Show when={containerMenuOpen() === c.id}>
                <div class="dropdown-menu" onClick={(e: MouseEvent) => e.stopPropagation()}>
                  <button
                    class="dropdown-item ctr-menu-item"
                    onClick={() => { doRestart(c.id, new MouseEvent("click")); setContainerMenuOpen(null); }}
                    disabled={loading() || c.state !== "Running"}
                  >
                    <MenuIcon><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></MenuIcon> Restart
                  </button>
                  <button class="dropdown-item ctr-menu-item" onClick={() => { props.onNavigate?.(containerPage(c)); setContainerMenuOpen(null); }}>
                    <MenuIcon><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></MenuIcon> Logs
                  </button>
                  <Show when={c.state === "Running"}>
                    <button
                      class="dropdown-item ctr-menu-item"
                      onClick={() => {
                        openContainerOn(c.id, "terminal");
                        props.onNavigate?.(containerPage(c));
                        setContainerMenuOpen(null);
                      }}
                    >
                      <MenuIcon><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></MenuIcon> Open shell
                    </button>
                  </Show>
                  <button class="dropdown-item ctr-menu-item" onClick={() => { openExposeDialog(c); setContainerMenuOpen(null); }}>
                    <MenuIcon><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></MenuIcon> Expose via gateway
                  </button>
                  <button class="dropdown-item ctr-menu-item" onClick={() => { props.onNavigate?.("settings:schedules"); setContainerMenuOpen(null); }}>
                    <MenuIcon><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></MenuIcon> Schedule restarts…
                  </button>
                  <button class="dropdown-item ctr-menu-item" onClick={() => { props.onNavigate?.("settings:auto-deploy"); setContainerMenuOpen(null); }}>
                    <MenuIcon><polyline points="23 4 23 10 17 10"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></MenuIcon> Auto-deploy on new image…
                  </button>
                  <div class="dropdown-divider" />
                  <button
                    class="dropdown-item dropdown-item-danger ctr-menu-item"
                    onClick={async () => {
                      setContainerMenuOpen(null);
                      if (await confirmDanger("Remove container", `Remove container '${c.name}'? This cannot be undone.`)) {
                        doAction("remove_container", c.id, new MouseEvent("click"));
                      }
                    }}
                    disabled={loading() || c.state === "Running"}
                  >
                    <MenuIcon><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></MenuIcon> Remove container
                  </button>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // A stack's containers as one bar: a segment each, in the order of the rows.
  const HealthBar = (p: { containers: Container[] }) => (
    <span class="ctr-health" style={{ width: `${Math.min(p.containers.length * 14, 140)}px` }}>
      <For each={p.containers}>
        {(c) => <span class={`ctr-health-seg ctr-health-${status(c).tone}`} title={`${c.name}: ${status(c).label}`} />}
      </For>
    </span>
  );

  const stackSummary = (list: Container[]) => {
    const running = list.filter((c) => c.state === "Running").length;
    const unhealthy = list.filter((c) => status(c).tone === "bad").length;
    const parts = [
      running === 0 ? "Stopped" : running === list.length ? `All ${list.length} running` : `${running} of ${list.length} running`,
    ];
    if (unhealthy > 0) parts.push(`${unhealthy} unhealthy`);
    return parts.join(" · ");
  };

  const ColumnHeads = () => (
    <div class="ctr-heads">
      <span />
      <span>Name</span>
      <span>Status</span>
      <span>CPU</span>
      <span>Memory</span>
      <span>Ports</span>
      <span class="ctr-net">Network</span>
      <span />
    </div>
  );

  // The list view: every container that passes the filters, running first.
  const flatList = createMemo(() => {
    const { stackGroups, standalone } = grouped();
    const all = [...stackGroups.flatMap((g) => g.containers), ...standalone];
    return applyFilters(all).sort(
      (a, b) => Number(b.state === "Running") - Number(a.state === "Running") || a.name.localeCompare(b.name),
    );
  });

  const nothingShown = () =>
    viewMode() === "list"
      ? flatList().length === 0
      : filteredGroups().stackGroups.length === 0 && filteredGroups().standalone.length === 0;

  const StackCard = (p: { group: StackGroup }) => {
    const group = p.group;
    const isExpanded = () => isOpen(group.name, group.containers);
    const isLoading = () => stackActionInProgress() === group.name;
    const groupRunning = () => group.containers.filter((c) => c.state === "Running").length;
    const allRunning = () => group.containers.length > 0 && groupRunning() === group.containers.length;
    const filteredContainers = () => applyFilters(group.containers);
    const dir = () => group.containers.map((c) => c.labels?.["com.docker.compose.project.working_dir"]).find(Boolean);

    return (
      <div class={`ctr-card ${groupRunning() === 0 ? "ctr-card-off" : ""} ${menuOpen() === group.name ? "ctr-card-menu" : ""}`}>
        <div class="ctr-card-head" onClick={() => toggleExpand(group.name, group.containers)}>
          <span class={`ctr-chevron ${isExpanded() ? "open" : ""}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
          </span>
          <span class="ctr-check">
            <CheckboxIndicator
              state={groupCheckState(filteredContainers())}
              onClick={(e) => { e.stopPropagation(); toggleGroupSelect(filteredContainers()); }}
            />
          </span>
          <button
            class="ctr-card-name"
            title={`Open ${group.name}: profiles, logs, compose file and orca.yaml`}
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              props.onNavigate?.(`stack:${group.name}`);
            }}
          >
            {group.name}
            <svg class="ctr-card-name-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
          </button>
          <HealthBar containers={group.containers} />
          <span class={`ctr-card-meta ${allRunning() ? "ctr-card-meta-ok" : ""}`}>{stackSummary(group.containers)}</span>
          <span class="ctr-card-spacer" />
          <div class="ctr-card-actions" onClick={(e) => e.stopPropagation()}>
            <Show when={dir()}>
              {(d) => <span class="ctr-hover-only"><FolderActions path={d()} compact /></span>}
            </Show>
            <div class={`action-icons ${isLoading() ? "loading" : ""}`}>
              <Show when={isLoading()}>
                <div class="action-spinner"><Spinner size={14} /></div>
              </Show>
              <Show
                when={allRunning()}
                fallback={
                  <button class="action-icon action-icon-start" onClick={(e) => doStackAction("start_stack", group.name, e)} disabled={isLoading()} title={`Start ${group.name}`}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" /></svg>
                  </button>
                }
              >
                <button class="action-icon action-icon-stop" onClick={(e) => doStackAction("stop_stack", group.name, e)} disabled={isLoading()} title={`Stop ${group.name}`}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="3" /></svg>
                </button>
              </Show>
              <div class="dropdown-wrapper">
                <button
                  class="action-icon"
                  onClick={() => setMenuOpen(menuOpen() === group.name ? null : group.name)}
                  title="More actions"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" /></svg>
                </button>
                <Show when={menuOpen() === group.name}>
                  <div class="dropdown-menu" onClick={(e) => e.stopPropagation()}>
                    <button class="dropdown-item ctr-menu-item" onClick={() => { props.onNavigate?.(`stack:${group.name}`); setMenuOpen(null); }}>
                      <MenuIcon><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></MenuIcon> Open stack
                    </button>
                    <button class="dropdown-item ctr-menu-item" onClick={() => { restartStack(group.name); setMenuOpen(null); }}>
                      <MenuIcon><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></MenuIcon> Restart
                    </button>
                    <button class="dropdown-item ctr-menu-item" onClick={() => { pullStack(group.name); setMenuOpen(null); }}>
                      <MenuIcon><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></MenuIcon> Pull images
                    </button>
                    <div class="dropdown-divider" />
                    <button class="dropdown-item dropdown-item-danger ctr-menu-item" onClick={() => { deleteStack(group.name); setMenuOpen(null); }}>
                      <MenuIcon><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></MenuIcon> Delete stack
                    </button>
                  </div>
                </Show>
              </div>
            </div>
          </div>
        </div>
        <Show when={isExpanded() && filteredContainers().length > 0}>
          <div class="ctr-rows">
            <For each={filteredContainers()}>{(c) => containerRow(c, group.name)}</For>
          </div>
        </Show>
      </div>
    );
  };

  const filterLabel = () => (stateFilter() === "running" ? "running" : "stopped");

  return (
    <div class={`ctr-page ${selected().size > 0 ? "ctr-selecting" : ""}`}>
      <div class="ctr-header">
        <div class="ctr-heading">
          <h1 class="page-title">Containers</h1>
          <div class="ctr-counts">
            <span><span class="ctr-count-dot ctr-count-dot-ok" />{runningCount()} running</span>
            <span><span class="ctr-count-dot" />{stoppedCount()} stopped</span>
            <Show when={grouped().stackGroups.length > 0}>
              <span>{grouped().stackGroups.length} stack{grouped().stackGroups.length === 1 ? "" : "s"}</span>
            </Show>
            <LastUpdated timestamp={lastUpdated()} />
          </div>
        </div>
        <div class="ctr-header-actions">
          <Show when={runningContainers().length >= 2}>
            <button class="btn btn-ghost btn-iconed" onClick={() => setShowMultiLog(true)} title="Follow the logs of all running containers together">
              <MenuIcon><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></MenuIcon>
              Logs
            </button>
          </Show>
          <Show when={runningContainers().length > 0}>
            <button class="btn btn-ghost btn-iconed btn-ghost-danger" title="Stop every running container" onClick={async () => {
              const running = runningContainers();
              if (!await confirmDanger("Stop all containers", `Stop all ${running.length} running containers?`)) return;
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
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="3" /></svg>
              Stop all
            </button>
          </Show>
          <button class="btn btn-ghost btn-iconed" onClick={() => openFolderDialog()} title="Start a project from a folder with a compose file">
            <MenuIcon><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></MenuIcon>
            Open folder
          </button>
          <button class="btn btn-accent btn-iconed" onClick={() => setShowRunDialog(true)} title="Run a container from an image">
            <MenuIcon><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></MenuIcon>
            Run
          </button>
        </div>
      </div>

      <div class="ctr-toolbar">
        <div class="segmented ctr-filter" role="tablist">
          <button class={stateFilter() === "running" ? "active" : ""} onClick={() => setStateFilter("running")}>
            Running <span class="ctr-seg-count">{runningCount()}</span>
          </button>
          <button class={stateFilter() === "stopped" ? "active" : ""} onClick={() => setStateFilter("stopped")}>
            Stopped <span class="ctr-seg-count">{stoppedCount()}</span>
          </button>
          <button class={stateFilter() === "all" ? "active" : ""} onClick={() => setStateFilter("all")}>
            All <span class="ctr-seg-count">{totalCount()}</span>
          </button>
        </div>
        <div class="ctr-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input
            type="text"
            placeholder="Search names, images, stacks"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
          />
          <Show when={search().length > 0}>
            <button class="ctr-search-clear" onClick={() => setSearch("")} title="Clear search" type="button">&times;</button>
          </Show>
        </div>
        <div class="segmented ctr-view" role="tablist">
          <button class={viewMode() === "stacks" ? "active" : ""} onClick={() => setViewMode("stacks")} title="Grouped by stack">
            <MenuIcon><rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/></MenuIcon>
            Stacks
          </button>
          <button class={viewMode() === "list" ? "active" : ""} onClick={() => setViewMode("list")} title="One list">
            <MenuIcon><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></MenuIcon>
            List
          </button>
        </div>
      </div>

      <DockerUnreachable error={containerList.error()} stale={lastUpdated() !== null} onNavigate={props.onNavigate} />

      <Show
        when={totalCount() > 0}
        fallback={
          <Show when={lastUpdated() !== null || !!containerList.error()} fallback={
            <table class="table">
              <tbody>
                <SkeletonRow columns={5} />
                <SkeletonRow columns={5} />
                <SkeletonRow columns={5} />
                <SkeletonRow columns={5} />
                <SkeletonRow columns={5} />
              </tbody>
            </table>
          }>
            <div class="empty">
              <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05"/><path d="M12 22.08V12"/></svg></div>
              <p class="empty-title">No containers yet</p>
              <p>Open a project folder with a compose file, start an app from the catalog, or run any image.</p>
              <div class="empty-actions">
                <button class="btn btn-primary" onClick={() => openFolderDialog()}>
                  Open a project folder
                </button>
                <button class="btn" onClick={() => props.onNavigate?.("templates")}>
                  Browse the catalog
                </button>
                <button class="btn" onClick={() => setShowRunDialog(true)}>
                  Run a container
                </button>
              </div>
            </div>
          </Show>
        }
      >
        <Show
          when={!nothingShown()}
          fallback={
            <div class="ctr-nothing">
              <Show
                when={search()}
                fallback={
                  <>
                    <p>No {filterLabel()} containers.</p>
                    <button class="btn btn-ghost" onClick={() => setStateFilter("all")}>Show all {totalCount()}</button>
                  </>
                }
              >
                <p>Nothing matches “{search()}”{stateFilter() === "all" ? "" : ` among the ${filterLabel()} containers`}.</p>
                <Show when={stateFilter() !== "all"}>
                  <button class="btn btn-ghost" onClick={() => setStateFilter("all")}>Search all {totalCount()}</button>
                </Show>
              </Show>
            </div>
          }
        >
          <ColumnHeads />
          <Show
            when={viewMode() === "stacks"}
            fallback={
              <div class="ctr-card">
                <div class="ctr-rows ctr-rows-flat">
                  <For each={flatList()}>{(c) => containerRow(c)}</For>
                </div>
              </div>
            }
          >
            <div class="ctr-cards">
              <For each={filteredGroups().stackGroups}>{(group) => <StackCard group={group} />}</For>

              <Show when={filteredGroups().standalone.length > 0}>
                <div class="ctr-card">
                  <div class="ctr-card-head" onClick={() => toggleExpand("__standalone__", filteredGroups().standalone)}>
                    <span class={`ctr-chevron ${isOpen("__standalone__", filteredGroups().standalone) ? "open" : ""}`}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
                    </span>
                    <span class="ctr-check">
                      <CheckboxIndicator
                        state={groupCheckState(filteredGroups().standalone)}
                        onClick={(e) => { e.stopPropagation(); toggleGroupSelect(filteredGroups().standalone); }}
                      />
                    </span>
                    <span class="ctr-card-name ctr-card-name-plain">Standalone</span>
                    <HealthBar containers={filteredGroups().standalone} />
                    <span class="ctr-card-meta">{stackSummary(filteredGroups().standalone)}</span>
                  </div>
                  <Show when={isOpen("__standalone__", filteredGroups().standalone)}>
                    <div class="ctr-rows">
                      <For each={filteredGroups().standalone}>{(c) => containerRow(c)}</For>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>

      {/* Floating batch action bar */}
      <Show when={selected().size > 0 || batchDeleteProgress()}>
        <div style={{
          position: "fixed",
          bottom: "32px",
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          "align-items": "center",
          gap: "12px",
          padding: "10px 20px",
          background: "rgba(22, 27, 34, 0.95)",
          "backdrop-filter": "blur(12px)",
          "-webkit-backdrop-filter": "blur(12px)",
          border: "1px solid #30363d",
          "border-radius": "12px",
          "box-shadow": "0 8px 32px rgba(0, 0, 0, 0.4)",
          "z-index": "100",
          animation: "batch-bar-slide-in 0.25s ease-out",
        }}>
          <Show when={batchDeleteProgress()} fallback={
            <span style={{ "font-size": "13px", color: "#e6edf3" }}>
              {selected().size} container{selected().size !== 1 ? "s" : ""} selected
            </span>
          }>
            {(p) => (
              <span style={{ "font-size": "13px", color: "#e6edf3", display: "inline-flex", "align-items": "center", gap: "8px" }}>
                <Spinner size={12} /> Deleting containers... ({p().done}/{p().total})
              </span>
            )}
          </Show>
          <button class="btn btn-sm" style={{ display: "inline-flex", "align-items": "center", gap: "6px" }} onClick={batchStart} disabled={!!batchDeleteProgress()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start
          </button>
          <button class="btn btn-sm" style={{ display: "inline-flex", "align-items": "center", gap: "6px" }} onClick={batchStop} disabled={!!batchDeleteProgress()}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="3"/></svg> Stop
          </button>
          <button class="btn btn-sm btn-danger" onClick={batchDelete} disabled={!!batchDeleteProgress()} style={{ display: "inline-flex", "align-items": "center", gap: "6px" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            {batchDeleteProgress() ? "Deleting..." : "Delete"}
          </button>
          <button class="btn btn-sm" onClick={() => setSelected(new Set<string>())} disabled={!!batchDeleteProgress()}>
            Clear
          </button>
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

      {/* Expose via gateway Dialog */}
      <Show when={exposeContainer()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setExposeContainer(null); }}>
          <div class="modal-dialog">
            <div class="modal-header">
              <h2 class="modal-title">Expose via gateway</h2>
              <button class="modal-close" onClick={() => setExposeContainer(null)}>{"\u00d7"}</button>
            </div>
            <form onSubmit={handleExpose}>
              <div class="modal-body">
                {/* Existing routes for this container */}
                <Show when={exposeExistingRoutes().length > 0}>
                  <div style={{ "margin-bottom": "16px" }}>
                    <label class="form-label">Active routes</label>
                    <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                      <For each={exposeExistingRoutes()}>
                        {(route) => (
                          <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "8px 12px", background: "rgba(63,185,80,0.06)", border: "1px solid rgba(63,185,80,0.15)", "border-radius": "8px" }}>
                            <span style={{ color: "#3fb950", "font-size": "8px" }}>{"\u25CF"}</span>
                            <a href={route.url} class="mono" style={{ flex: "1", "font-size": "13px", color: "#58a6ff", "text-decoration": "none" }} title={`Open ${route.url}`}
                              onClick={(e) => { e.preventDefault(); void shellOpen(route.url); }}>{route.hostname}</a>
                            <span style={{ color: "#6e7681", "font-size": "11px" }}>:{route.port}</span>
                            <button type="button" class="btn btn-sm" onClick={() => void shellOpen(route.url)}>Open</button>
                            <button type="button" class="action-icon" style={{ color: "#f85149", "flex-shrink": "0" }} onClick={() => handleUnexpose(route.hostname)} title="Remove route">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* Add new route form */}
                <Show when={exposeExistingRoutes().length > 0}>
                  <div style={{ "border-top": "1px solid #21262d", "padding-top": "16px", "margin-bottom": "8px" }}>
                    <label class="form-label" style={{ "font-size": "13px", "font-weight": "600" }}>Add another route</label>
                  </div>
                </Show>
                <div class="form-group">
                  <label class="form-label">Hostname <span style={{ color: "#f85149" }}>*</span></label>
                  <div style={{ display: "flex", "align-items": "center", gap: "4px" }}>
                    <input
                      class="form-input"
                      type="text"
                      placeholder="myapp"
                      value={exposeHostname()}
                      onInput={(e) => setExposeHostname(e.currentTarget.value)}
                      autofocus
                      style={{ flex: "1" }}
                    />
                    <span style={{ color: "#8b949e", "font-size": "13px" }}>.{exposeDomain()}</span>
                  </div>
                </div>
                <div class="form-group">
                  <label class="form-label">Container port <span style={{ color: "#f85149" }}>*</span></label>
                  <Show when={exposeContainer()!.ports.length > 0}>
                    <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap", "margin-bottom": "8px" }}>
                      <For each={[...new Set(exposeContainer()!.ports.map((p) => p.container_port))]}>
                        {(port) => (
                          <button
                            type="button"
                            onClick={() => setExposePort(String(port))}
                            style={{
                              padding: "4px 12px",
                              "border-radius": "12px",
                              border: `1px solid ${exposePort() === String(port) ? "#58a6ff" : "rgba(255,255,255,0.1)"}`,
                              background: exposePort() === String(port) ? "rgba(88,166,255,0.15)" : "rgba(255,255,255,0.04)",
                              color: exposePort() === String(port) ? "#58a6ff" : "#8b949e",
                              "font-size": "12px",
                              "font-family": "monospace",
                              cursor: "pointer",
                              transition: "all 0.15s",
                            }}
                          >
                            :{port}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <input
                    class="form-input"
                    type="number"
                    value={exposePort()}
                    onInput={(e) => setExposePort(e.currentTarget.value)}
                    min="1"
                    max="65535"
                    placeholder="8080"
                  />
                  <p style={{ "font-size": "11px", color: "#6e7681", "margin-top": "4px" }}>The port your app listens on inside the container</p>
                </div>
                <Show when={exposeHostname().trim()}>
                  <div style={{ "font-size": "12px", color: "#8b949e", "margin-top": "8px" }}>
                    URL: <span class="mono" style={{ color: "#58a6ff" }}>https://{exposeHostname().includes(".") ? exposeHostname() : `${exposeHostname()}.${exposeDomain()}`}</span>
                  </div>
                </Show>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn" onClick={() => setExposeContainer(null)} disabled={exposing()}>Close</button>
                <button type="submit" class="btn btn-primary" disabled={exposing() || !exposeHostname().trim()}>
                  {exposing() ? "Exposing..." : "Add route"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </Show>
    </div>
  );
}
