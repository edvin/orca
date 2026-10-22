import { createSignal, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ContainerStats, SystemHealth, GatewayStatus, GatewayRoute } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { usePoller } from "../lib/poller";
import { containersStore, imagesStore, stacksStore } from "../lib/dockerStore";
import { useHealth, refreshHealth } from "../lib/healthStore";
import { devApi } from "../lib/dev";
import type { DevProject } from "../lib/dev";
import { formatBytes } from "../lib/format";
import { getDashboardCpuHistory, getDashboardMemHistory, getCpuChartHistory, getMemChartHistory } from "../lib/metricsStore";
import { useContainerStats } from "../lib/statsStore";

import TimeChart from "../components/TimeChart";
import LastUpdated from "../components/LastUpdated";

/** Wrap an invoke call with a timeout (ms). Rejects on timeout. */
function invokeWithTimeout<T>(cmd: string, args?: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${cmd} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    invoke(cmd, args)
      .then((v) => { clearTimeout(timer); resolve(v as T); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

type CardState = "loading" | "ready" | "error";

interface DashboardPageProps {
  onNavigate?: (page: string) => void;
}

export default function DashboardPage(props: DashboardPageProps) {
  // Containers, images and stacks come from the shared lists (refreshed by
  // Docker events); gateway, dev projects and stats are polled here.
  const containerList = containersStore.use();
  const imageList = imagesStore.use();
  const stackList = stacksStore.use();
  const containers = containerList.list;
  const images = imageList.list;
  const stacks = stackList.list;
  const [health, setHealth] = createSignal<SystemHealth | null>(null);
  const lastUpdated = () => {
    const t = containerList.updatedAt();
    return t ? new Date(t) : null;
  };

  const [gatewayStatus, setGatewayStatus] = createSignal<GatewayStatus | null>(null);
  const [gatewayRoutes, setGatewayRoutes] = createSignal<GatewayRoute[]>([]);
  const [devProjects, setDevProjects] = createSignal<DevProject[] | null>(null);

  const [healthState, setHealthState] = createSignal<CardState>("loading");
  const [containersError, setContainersError] = createSignal("");
  const [imagesError, setImagesError] = createSignal("");
  const [stacksError, setStacksError] = createSignal("");
  const [healthError, setHealthError] = createSignal("");

  let connectionFailCount = 0;

  const isConnectionError = (e: string) =>
    e.includes("hyper") || e.includes("Connect") || e.includes("connection") ||
    e.includes("not running") || e.includes("timed out") || e.includes("500");

  const friendlyError = (e: string) => {
    if (isConnectionError(e)) {
      connectionFailCount++;
      if (connectionFailCount > 6) {
        return "Docker not reachable. Try Restart Orca on System Health page.";
      }
      return "Waiting for Docker...";
    }
    connectionFailCount = 0;
    return e;
  };

  const cardState = (list: { error: () => string | null; loaded: () => boolean }): CardState =>
    list.error() ? "error" : list.loaded() ? "ready" : "loading";
  const containersState = () => cardState(containerList);
  const imagesState = () => cardState(imageList);
  const stacksState = () => cardState(stackList);
  createEffect(on(containerList.error, (e) => {
    if (e) setContainersError(friendlyError(e));
    else connectionFailCount = 0;
  }));
  createEffect(on(imageList.error, (e) => { if (e) setImagesError(friendlyError(e)); }));
  createEffect(on(stackList.error, (e) => { if (e) setStacksError(friendlyError(e)); }));

  const fetchGateway = async () => {
    try {
      const v = await invokeWithTimeout<GatewayStatus>("gateway_status");
      setGatewayStatus(v);
      setGatewayRoutes(v?.running ? (await invokeWithTimeout<GatewayRoute[]>("gateway_list_routes")) || [] : []);
    } catch {
      setGatewayStatus(null);
      setGatewayRoutes([]);
    }
  };
  const gatewayPoller = usePoller(fetchGateway, 5000);

  // A manual refresh (Ctrl+R) fetches everything now instead of waiting for the polls.
  useRefresh(() => {
    containerList.refresh();
    imageList.refresh();
    stackList.refresh();
    gatewayPoller.now();
    refreshStats();
    refreshHealth();
  });

  // Health comes from the app-wide poll.
  const shared = useHealth();
  createEffect(() => {
    const h = shared.health();
    const e = shared.healthError();
    if (e) {
      setHealthError(friendlyError(e));
      setHealthState("error");
    } else if (h) {
      setHealth(h);
      setHealthState("ready");
    }
  });

  // Reset page-local state when switching hosts (the shared lists reset themselves).
  // NOTE: clearAllMetrics() is NOT called here — the metricsStore module
  // registers its own `orca-host-switch` listener so metrics are cleared
  // even when the Dashboard isn't mounted.
  const handleHostSwitch = () => {
    setHealthState("loading");
    gatewayPoller.now();
  };
  // Worktree instances: a quick view of what's running per project.
  const loadProjects = () => devApi.listProjects(false).then(setDevProjects).catch(() => setDevProjects([]));
  usePoller(loadProjects, 10000);
  const devRunning = () =>
    (devProjects() ?? []).flatMap((p) => p.instances ?? []).filter((i) => i.status === "running" || i.status === "partial").length;
  const devTotal = () => (devProjects() ?? []).reduce((n, p) => n + (p.instances ?? []).length, 0);

  onMount(() => {
    document.addEventListener("orca-host-switch", handleHostSwitch);
    // Keep the metrics store bounded: prune any container ids we no longer
    // see as alive. Without this, short-lived containers accumulate in
    // `metricsHistory` / the CPU alert state over a long session.
    const pruneTimer = setInterval(() => {
      import("../lib/metricsStore").then(({ pruneMetricsExcept }) =>
        pruneMetricsExcept(containers().map((c) => c.id)),
      );
    }, 30000);
    onCleanup(() => {
      document.removeEventListener("orca-host-switch", handleHostSwitch);
      clearInterval(pruneTimer);
    });
  });

  // Stats of all running containers, shared with the containers table.
  const { stats: containerStats, refresh: refreshStats } = useContainerStats();

  const runningCount = () => containers().filter((c) => c.state === "Running").length;
  const totalImageSize = () => images().reduce((sum, img) => sum + img.size_bytes, 0);
  const runningStacks = () => stacks().filter((s) => s.status === "Running").length;

  // Count containers with ports that could be exposed via gateway but aren't yet
  const suggestableCount = () => {
    const gw = gatewayStatus();
    if (!gw?.running) return 0;
    const routedNames = new Set(gatewayRoutes().map((r) => r.container_name));
    return containers().filter(
      (c) => c.state === "Running" && c.ports.length > 0 && c.name !== "orca-gateway" && !routedNames.has(c.name)
    ).length;
  };

  const totalCpu = () => {
    const stats = containerStats();
    return Object.values(stats).reduce((sum, s) => sum + s.cpu_percent, 0);
  };

  const totalMemory = () => {
    const stats = containerStats();
    return Object.values(stats).reduce((sum, s) => sum + s.memory_usage_bytes, 0);
  };

  const topCpu = () => {
    const stats = containerStats();
    const all = containers()
      .filter((c) => stats[c.id])
      .map((c) => ({ container: c, stats: stats[c.id] }))
      .sort((a, b) => b.stats.cpu_percent - a.stats.cpu_percent);
    return all.slice(0, 5);
  };

  const topMemory = () => {
    const stats = containerStats();
    const all = containers()
      .filter((c) => stats[c.id])
      .map((c) => ({ container: c, stats: stats[c.id] }))
      .sort((a, b) => b.stats.memory_usage_bytes - a.stats.memory_usage_bytes);
    return all.slice(0, 5);
  };

  const memPercent = (s: ContainerStats) =>
    s.memory_limit_bytes > 0 ? (s.memory_usage_bytes / s.memory_limit_bytes) * 100 : 0;

  const memoryMax = () => {
    const h = health();
    if (h?.system_resources) return h.system_resources.memory_total_bytes;
    const hist = getDashboardMemHistory();
    if (hist.length === 0) return 1;
    return Math.max(...hist.map(d => d.value)) * 1.5;
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">
          Dashboard
          <LastUpdated timestamp={lastUpdated()} />
        </h1>
      </div>

      {/* Empty state — shown when all cards resolved but nothing exists */}
      <Show when={
        containersState() === "ready" && imagesState() === "ready" && stacksState() === "ready"
        && containers().length === 0 && images().length === 0 && stacks().length === 0
      }>
        <div class="empty">
          <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg></div>
          <p class="empty-title">Welcome to Orca Desktop</p>
          <p>Get started by pulling an image, deploying a template, or running docker compose</p>
          <div class="empty-actions">
            <button class="btn btn-primary" onClick={() => props.onNavigate?.("templates")}>
              Browse App Catalog
            </button>
            <button class="btn" onClick={() => props.onNavigate?.("images")}>
              Pull Image
            </button>
          </div>
        </div>
      </Show>

      {/* Summary cards — each resolves independently */}
      <div class="dashboard-grid">
        <div class="dashboard-stat-card">
          <div class="dashboard-stat-label">Containers</div>
          <Show when={containersState() !== "loading"} fallback={
            <><div class="skeleton-line skeleton-line-short" /><div class="skeleton-line skeleton-line-medium" /></>
          }>
            <Show when={containersState() === "ready"} fallback={
              <div class="dashboard-stat-error">{containersError()}</div>
            }>
              <div class="dashboard-stat-value">{containers().length}</div>
              <div class="dashboard-stat-sub">
                <span style={{ color: "#3fb950" }}>{runningCount()} running</span>
                {containers().length - runningCount() > 0 && (
                  <span style={{ color: "#8b949e" }}>
                    {" / "}{containers().length - runningCount()} stopped
                  </span>
                )}
              </div>
            </Show>
          </Show>
        </div>

        <div class="dashboard-stat-card">
          <div class="dashboard-stat-label">Images</div>
          <Show when={imagesState() !== "loading"} fallback={
            <><div class="skeleton-line skeleton-line-short" /><div class="skeleton-line skeleton-line-medium" /></>
          }>
            <Show when={imagesState() === "ready"} fallback={
              <div class="dashboard-stat-error">{imagesError()}</div>
            }>
              <div class="dashboard-stat-value">{images().length}</div>
              <div class="dashboard-stat-sub">{formatBytes(totalImageSize())} total</div>
            </Show>
          </Show>
        </div>

        <div class="dashboard-stat-card">
          <div class="dashboard-stat-label">Stacks</div>
          <Show when={stacksState() !== "loading"} fallback={
            <><div class="skeleton-line skeleton-line-short" /><div class="skeleton-line skeleton-line-medium" /></>
          }>
            <Show when={stacksState() === "ready"} fallback={
              <div class="dashboard-stat-error">{stacksError()}</div>
            }>
              <div class="dashboard-stat-value">{stacks().length}</div>
              <div class="dashboard-stat-sub">
                <span style={{ color: "#3fb950" }}>{runningStacks()} running</span>
              </div>
            </Show>
          </Show>
        </div>

        <div class="dashboard-stat-card">
          <div class="dashboard-stat-label">System</div>
          <Show when={healthState() !== "loading"} fallback={
            <><div class="skeleton-line skeleton-line-short" /><div class="skeleton-line skeleton-line-medium" /></>
          }>
            <Show when={healthState() === "ready" && health()?.system_resources} fallback={
              <Show when={healthState() === "error"} fallback={
                <div class="dashboard-stat-value" style={{ "font-size": "14px", color: "#8b949e" }}>No data</div>
              }>
                <div class="dashboard-stat-error">{healthError()}</div>
              </Show>
            }>
              {(res) => (
                <>
                  <div class="dashboard-stat-value" style={{ "font-size": "20px" }}>
                    {res().cpu_count} CPUs
                  </div>
                  <div class="dashboard-stat-sub">
                    {formatBytes(res().memory_total_bytes - res().memory_available_bytes)} / {formatBytes(res().memory_total_bytes)} RAM
                  </div>
                </>
              )}
            </Show>
          </Show>
        </div>
        <Show when={health()?.gpu}>
          {(gpu) => (
            <div class="dashboard-stat-card">
              <div class="dashboard-stat-label">GPU</div>
              <div class="dashboard-stat-value" style={{ "font-size": "16px" }}>
                {gpu().utilization_percent}%
              </div>
              <div class="dashboard-stat-sub">
                {(gpu().memory_used_mb / 1024).toFixed(1)} / {(gpu().memory_total_mb / 1024).toFixed(1)} GB VRAM
              </div>
              <div style={{ "font-size": "10px", color: "#6e7681", "margin-top": "2px" }}>
                {gpu().name}
              </div>
            </div>
          )}
        </Show>

        <div
          class="dashboard-stat-card"
          style={{ cursor: "pointer" }}
          onClick={() => props.onNavigate?.("projects")}
          title="Go to Projects"
        >
          <div class="dashboard-stat-label">Worktree instances</div>
          <Show
            when={(devProjects()?.length ?? 0) > 0}
            fallback={
              <>
                <div class="dashboard-stat-value" style={{ "font-size": "14px", color: "#8b949e" }}>No projects</div>
                <div class="dashboard-stat-sub">Run each git worktree as its own copy of the app</div>
              </>
            }
          >
            <div class="dashboard-stat-value">
              {devRunning()}
              <span style={{ "font-size": "13px", color: "#8b949e", "font-weight": 400 }}> / {devTotal()} running</span>
            </div>
            <div class="dashboard-stat-sub">
              {(devProjects() ?? [])
                .map((p) => {
                  const n = (p.instances ?? []).filter((i) => i.status === "running" || i.status === "partial").length;
                  return `${p.id}${n ? ` (${n})` : ""}`;
                })
                .join(" · ")}
            </div>
          </Show>
        </div>

        <div
          class="dashboard-stat-card"
          style={{ cursor: "pointer" }}
          onClick={() => props.onNavigate?.("gateway")}
          title="Go to Gateway"
        >
          <div class="dashboard-stat-label">Gateway</div>
          <Show when={gatewayStatus()} fallback={
            <div class="dashboard-stat-value" style={{ "font-size": "14px", color: "#8b949e" }}>--</div>
          }>
            {(gw) => (
              <>
                <div class="dashboard-stat-value" style={{ "font-size": "14px" }}>
                  <span style={{
                    display: "inline-block",
                    width: "8px",
                    height: "8px",
                    "border-radius": "50%",
                    background: gw().running ? "#3fb950" : "#8b949e",
                    "margin-right": "6px",
                    "vertical-align": "middle",
                  }} />
                  {gw().running ? "Running" : "Inactive"}
                </div>
                <div class="dashboard-stat-sub">
                  <Show when={gw().running} fallback={
                    <span style={{ color: "#8b949e" }}>Enable for clean hostnames</span>
                  }>
                    <span style={{ color: "#3fb950" }}>{gw().routes_active} route{gw().routes_active !== 1 ? "s" : ""}</span>
                    <span style={{ color: "#8b949e" }}> on *.{gw().domain}</span>
                  </Show>
                </div>
                <Show when={gw().running && suggestableCount() > 0}>
                  <div style={{ "font-size": "11px", color: "#58a6ff", "margin-top": "4px" }}>
                    {suggestableCount()} container{suggestableCount() !== 1 ? "s" : ""} could be exposed
                  </div>
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>

      {/* Resource usage charts */}
      <div class="dashboard-chart-row">
        <div class="dashboard-chart-card">
          <div style={{ padding: "16px" }}>
            <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "12px" }}>
              <span style={{ color: "#8b949e", "font-size": "13px" }}>CPU Usage</span>
              <span style={{ color: "#e6edf3", "font-size": "18px", "font-weight": "600" }}>{totalCpu().toFixed(1)}%</span>
            </div>
            <TimeChart
              data={getDashboardCpuHistory()}
              height={120}
              color="#58a6ff"
              fillColor="#58a6ff"
              maxValue={100}
              unit="%"
              formatValue={(v) => `${v.toFixed(0)}%`}
            />
          </div>
        </div>

        <div class="dashboard-chart-card">
          <div style={{ padding: "16px" }}>
            <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "12px" }}>
              <span style={{ color: "#8b949e", "font-size": "13px" }}>Memory Usage</span>
              <span style={{ color: "#e6edf3", "font-size": "18px", "font-weight": "600" }}>{formatBytes(totalMemory())}</span>
            </div>
            <TimeChart
              data={getDashboardMemHistory()}
              height={120}
              color="#3fb950"
              fillColor="#3fb950"
              maxValue={memoryMax()}
              unit="B"
              formatValue={(v) => formatBytes(v)}
            />
          </div>
        </div>
      </div>

      {/* Top consumers */}
      <div class="consumers-grid">
        <div class="consumer-card">
          <div class="consumer-title">Top CPU Consumers</div>
          <Show when={topCpu().length > 0} fallback={
            <div style={{ color: "#484f58", "font-size": "12px" }}>No running containers. Start a container to see resource usage here.</div>
          }>
            <table class="table" style={{ "font-size": "12px" }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Image</th>
                  <th>CPU</th>
                  <th style={{ width: "80px" }}>Trend</th>
                </tr>
              </thead>
              <tbody>
                <For each={topCpu()}>
                  {(item) => (
                    <tr
                      class="clickable-row"
                      onClick={() => props.onNavigate?.(`container:${item.container.id}`)}
                    >
                      <td style={{ "font-weight": "500", color: "#58a6ff", cursor: "pointer" }}>{item.container.name}</td>
                      <td class="mono" style={{ color: "#8b949e", "max-width": "140px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{item.container.image}</td>
                      <td style={{ color: item.stats.cpu_percent > 80 ? "#f85149" : item.stats.cpu_percent > 50 ? "#d29922" : "#3fb950" }}>
                        {item.stats.cpu_percent.toFixed(1)}%
                      </td>
                      <td>
                        <TimeChart
                          data={getCpuChartHistory(item.container.id)}
                          height={40}
                          color="#58a6ff"
                          fillColor="#58a6ff"
                          maxValue={100}
                          mini
                        />
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </div>

        <div class="consumer-card">
          <div class="consumer-title">Top Memory Consumers</div>
          <Show when={topMemory().length > 0} fallback={
            <div style={{ color: "#484f58", "font-size": "12px" }}>No running containers. Start a container to see resource usage here.</div>
          }>
            <table class="table" style={{ "font-size": "12px" }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Image</th>
                  <th>Memory</th>
                  <th style={{ width: "80px" }}>Trend</th>
                </tr>
              </thead>
              <tbody>
                <For each={topMemory()}>
                  {(item) => (
                    <tr
                      class="clickable-row"
                      onClick={() => props.onNavigate?.(`container:${item.container.id}`)}
                    >
                      <td style={{ "font-weight": "500", color: "#58a6ff", cursor: "pointer" }}>{item.container.name}</td>
                      <td class="mono" style={{ color: "#8b949e", "max-width": "140px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{item.container.image}</td>
                      <td>
                        {formatBytes(item.stats.memory_usage_bytes)}
                        <span style={{ color: "#484f58", "margin-left": "4px", "font-size": "10px" }}>
                          ({memPercent(item.stats).toFixed(0)}%)
                        </span>
                      </td>
                      <td>
                        <TimeChart
                          data={getMemChartHistory(item.container.id)}
                          height={40}
                          color="#3fb950"
                          fillColor="#3fb950"
                          mini
                        />
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </div>
      </div>
    </div>
  );
}
