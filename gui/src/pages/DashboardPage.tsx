import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Container, ContainerStats, Image, ComposeProject, SystemHealth, GatewayStatus, GatewayRoute } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { formatBytes } from "../lib/format";
import { recordMetrics, getDashboardCpuHistory, getDashboardMemHistory, getPerContainerCpuChartHistory, getPerContainerMemChartHistory, clearAllMetrics } from "../lib/metricsStore";

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
  const [containers, setContainers] = createSignal<Container[]>([]);
  const [images, setImages] = createSignal<Image[]>([]);
  const [stacks, setStacks] = createSignal<ComposeProject[]>([]);
  const [health, setHealth] = createSignal<SystemHealth | null>(null);
  const [containerStats, setContainerStats] = createSignal<Record<string, ContainerStats>>({});
  const [lastUpdated, setLastUpdated] = createSignal<Date | null>(null);

  const [gatewayStatus, setGatewayStatus] = createSignal<GatewayStatus | null>(null);
  const [gatewayRoutes, setGatewayRoutes] = createSignal<GatewayRoute[]>([]);

  const [containersState, setContainersState] = createSignal<CardState>("loading");
  const [imagesState, setImagesState] = createSignal<CardState>("loading");
  const [stacksState, setStacksState] = createSignal<CardState>("loading");
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

  const fetchAll = () => {
    // Each card fetches independently — no waiting for the others
    // Don't log connection errors to Activity (they're transient during startup)
    invokeWithTimeout<Container[]>("list_containers")
      .then((v) => { setContainers(v || []); setContainersState("ready"); connectionFailCount = 0; })
      .catch((e) => { setContainersError(friendlyError(String(e))); setContainersState("error"); })
      .finally(() => setLastUpdated(new Date()));

    invokeWithTimeout<Image[]>("list_images")
      .then((v) => { setImages(v || []); setImagesState("ready"); })
      .catch((e) => { setImagesError(friendlyError(String(e))); setImagesState("error"); });

    invokeWithTimeout<ComposeProject[]>("list_stacks")
      .then((v) => { setStacks(v || []); setStacksState("ready"); })
      .catch((e) => { setStacksError(friendlyError(String(e))); setStacksState("error"); });

    invokeWithTimeout<SystemHealth>("system_health", undefined, 15_000)
      .then((v) => { setHealth(v); setHealthState("ready"); })
      .catch((e) => { setHealthError(friendlyError(String(e))); setHealthState("error"); });

    invokeWithTimeout<GatewayStatus>("gateway_status")
      .then((v) => {
        setGatewayStatus(v);
        if (v?.running) {
          invokeWithTimeout<GatewayRoute[]>("gateway_list_routes")
            .then((r) => setGatewayRoutes(r || []))
            .catch(() => setGatewayRoutes([]));
        } else {
          setGatewayRoutes([]);
        }
      })
      .catch(() => { setGatewayStatus(null); setGatewayRoutes([]); });
  };

  useRefresh(fetchAll);

  // Reset chart history when switching hosts
  const handleHostSwitch = () => {
    clearAllMetrics();
    setContainerStats({});
    setContainersState("loading");
    setImagesState("loading");
    setStacksState("loading");
    setHealthState("loading");
    fetchAll();
  };
  onMount(() => {
    document.addEventListener("orca-host-switch", handleHostSwitch);
    onCleanup(() => document.removeEventListener("orca-host-switch", handleHostSwitch));
  });

  const fetchStats = async () => {
    const running = containers().filter((c) => c.state === "Running");
    if (running.length === 0) return;
    const results = await Promise.allSettled(
      running.map((c) => invokeWithTimeout<ContainerStats>("container_stats", { id: c.id }))
    );
    const newStats: Record<string, ContainerStats> = {};
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const s = r.value;
        newStats[running[i].id] = s;
        recordMetrics(running[i].id, {
          timestamp: Date.now(),
          cpu: s.cpu_percent,
          memory: s.memory_usage_bytes,
          memoryLimit: s.memory_limit_bytes,
          networkRx: s.network_rx_bytes,
          networkTx: s.network_tx_bytes,
        }, running[i].name);
      }
    });
    setContainerStats(newStats);
  };

  onMount(() => {
    fetchAll();
    // Stats depend on containers being loaded; kick off after a short delay
    setTimeout(fetchStats, 2000);
    const interval = setInterval(() => {
      fetchAll();
      fetchStats();
    }, 5000);
    onCleanup(() => clearInterval(interval));
  });

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
                          data={getPerContainerCpuChartHistory()[item.container.id] || []}
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
                          data={getPerContainerMemChartHistory()[item.container.id] || []}
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
