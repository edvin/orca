import { createSignal, onMount, onCleanup, For, Show, Index } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Container, ContainerStats, Image, ComposeProject, SystemHealth } from "../lib/types";
import { formatBytes } from "../lib/format";
import { recordMetrics, getCpuHistory, getMemoryHistory, getAggregatedCpuHistory, getAggregatedMemoryHistory } from "../lib/metricsStore";
import Sparkline from "../components/Sparkline";
import LastUpdated from "../components/LastUpdated";

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

  const fetchAll = async () => {
    const [cRes, iRes, sRes, hRes] = await Promise.allSettled([
      invoke("list_containers"),
      invoke("list_images"),
      invoke("list_stacks"),
      invoke("system_health"),
    ]);
    if (cRes.status === "fulfilled") setContainers(cRes.value as Container[]);
    if (iRes.status === "fulfilled") setImages(iRes.value as Image[]);
    if (sRes.status === "fulfilled") setStacks(sRes.value as ComposeProject[]);
    if (hRes.status === "fulfilled") setHealth(hRes.value as SystemHealth);
    setLastUpdated(new Date());
  };

  const fetchStats = async () => {
    const running = containers().filter((c) => c.state === "Running");
    if (running.length === 0) return;
    const results = await Promise.allSettled(
      running.map((c) => invoke("container_stats", { id: c.id }))
    );
    const newStats: Record<string, ContainerStats> = {};
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
    setContainerStats(newStats);
  };

  onMount(() => {
    fetchAll().then(fetchStats);
    const interval = setInterval(() => {
      fetchAll().then(fetchStats);
    }, 5000);
    onCleanup(() => clearInterval(interval));
  });

  const runningCount = () => containers().filter((c) => c.state === "Running").length;
  const totalImageSize = () => images().reduce((sum, img) => sum + img.size_bytes, 0);
  const runningStacks = () => stacks().filter((s) => s.status === "Running").length;

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

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">
          Dashboard
          <LastUpdated timestamp={lastUpdated()} />
        </h1>
      </div>

      {/* Skeleton loading state */}
      <Show when={!lastUpdated()}>
        <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", "margin-bottom": "16px" }}>
          <Index each={[1, 2, 3, 4]}>{() => <div class="skeleton-card" style={{ height: "70px" }}><div class="skeleton-line skeleton-line-short" /><div class="skeleton-line skeleton-line-medium" /></div>}</Index>
        </div>
        <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "12px" }}>
          <div class="skeleton-card" style={{ height: "80px" }}><div class="skeleton-line skeleton-line-short" /><div class="skeleton-line skeleton-line-medium" /></div>
          <div class="skeleton-card" style={{ height: "80px" }}><div class="skeleton-line skeleton-line-short" /><div class="skeleton-line skeleton-line-medium" /></div>
        </div>
      </Show>

      <Show when={containers().length === 0 && images().length === 0 && stacks().length === 0 && lastUpdated()}>
        <div class="empty">
          <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg></div>
          <p class="empty-title">Welcome to Orca Desktop</p>
          <p>Get started by pulling an image, deploying a template, or running docker compose</p>
          <div class="empty-actions">
            <button class="btn btn-primary" onClick={() => props.onNavigate?.("templates")}>
              Browse Templates
            </button>
            <button class="btn" onClick={() => props.onNavigate?.("images")}>
              Pull Image
            </button>
          </div>
        </div>
      </Show>

      {/* Summary cards — only show after first data load */}
      <Show when={lastUpdated()}>
      <div class="dashboard-grid">
        <div class="dashboard-stat-card">
          <div class="dashboard-stat-label">Containers</div>
          <div class="dashboard-stat-value">{containers().length}</div>
          <div class="dashboard-stat-sub">
            <span style={{ color: "#3fb950" }}>{runningCount()} running</span>
            {containers().length - runningCount() > 0 && (
              <span style={{ color: "#8b949e" }}>
                {" / "}{containers().length - runningCount()} stopped
              </span>
            )}
          </div>
        </div>

        <div class="dashboard-stat-card">
          <div class="dashboard-stat-label">Images</div>
          <div class="dashboard-stat-value">{images().length}</div>
          <div class="dashboard-stat-sub">{formatBytes(totalImageSize())} total</div>
        </div>

        <div class="dashboard-stat-card">
          <div class="dashboard-stat-label">Stacks</div>
          <div class="dashboard-stat-value">{stacks().length}</div>
          <div class="dashboard-stat-sub">
            <span style={{ color: "#3fb950" }}>{runningStacks()} running</span>
          </div>
        </div>

        <div class="dashboard-stat-card">
          <div class="dashboard-stat-label">System</div>
          <Show when={health()?.system_resources} fallback={
            <div class="dashboard-stat-value" style={{ "font-size": "14px", color: "#8b949e" }}>Loading...</div>
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
        </div>
      </div>

      {/* Resource usage charts */}
      <div class="dashboard-chart-row">
        <div class="dashboard-chart-card">
          <div class="dashboard-chart-label">Combined CPU Usage</div>
          <div class="dashboard-chart-value">{totalCpu().toFixed(1)}%</div>
          <Sparkline
            data={getAggregatedCpuHistory()}
            width={480}
            height={48}
            color="#58a6ff"
            fillOpacity={0.15}
          />
        </div>

        <div class="dashboard-chart-card">
          <div class="dashboard-chart-label">Combined Memory Usage</div>
          <div class="dashboard-chart-value">{formatBytes(totalMemory())}</div>
          <Sparkline
            data={getAggregatedMemoryHistory()}
            width={480}
            height={48}
            color="#a371f7"
            fillOpacity={0.15}
          />
        </div>
      </div>

      {/* Top consumers */}
      <div class="consumers-grid">
        <div class="consumer-card">
          <div class="consumer-title">Top CPU Consumers</div>
          <Show when={topCpu().length > 0} fallback={
            <div style={{ color: "#484f58", "font-size": "12px" }}>No running containers</div>
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
                        <Sparkline
                          data={getCpuHistory(item.container.id)}
                          width={70}
                          height={20}
                          color="#58a6ff"
                          max={100}
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
            <div style={{ color: "#484f58", "font-size": "12px" }}>No running containers</div>
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
                        <Sparkline
                          data={getMemoryHistory(item.container.id)}
                          width={70}
                          height={20}
                          color="#a371f7"
                          max={100}
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
      </Show>
    </div>
  );
}
