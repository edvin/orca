import { createSignal, onMount, onCleanup, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { MachineInfo, SystemHealth } from "../lib/types";
import { formatBytes } from "../lib/format";
import { showToast } from "../components/Toast";
import { logError } from "../lib/activityStore";

function UsageBar(props: { used: number; total: number; label: string }) {
  const percent = () => (props.total > 0 ? (props.used / props.total) * 100 : 0);
  const barColor = () => {
    const p = percent();
    if (p > 90) return "#f85149";
    if (p > 70) return "#d29922";
    return "#3fb950";
  };

  return (
    <div style={{ "margin-bottom": "12px" }}>
      <div style={{ display: "flex", "justify-content": "space-between", "margin-bottom": "4px" }}>
        <span style={{ "font-size": "12px", color: "#8b949e" }}>{props.label}</span>
        <span style={{ "font-size": "12px", color: "#e6edf3" }}>
          {formatBytes(props.used)} / {formatBytes(props.total)} ({percent().toFixed(1)}%)
        </span>
      </div>
      <div style={{
        width: "100%",
        height: "8px",
        background: "#21262d",
        "border-radius": "4px",
        overflow: "hidden",
      }}>
        <div style={{
          width: `${Math.min(percent(), 100)}%`,
          height: "100%",
          background: barColor(),
          "border-radius": "4px",
          transition: "width 0.3s ease",
        }} />
      </div>
    </div>
  );
}

export default function MachinePage() {
  const [machine, setMachine] = createSignal<MachineInfo | null>(null);
  const [health, setHealth] = createSignal<SystemHealth | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [pruning, setPruning] = createSignal(false);

  const refreshMachine = async () => {
    try {
      const info = (await invoke("get_machine_info")) as MachineInfo;
      setMachine(info);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const refreshHealth = async () => {
    try {
      const h = (await invoke("system_health")) as SystemHealth;
      setHealth(h);
    } catch {
      // Daemon not ready
    }
  };

  const refresh = async () => {
    await Promise.all([refreshMachine(), refreshHealth()]);
  };

  const pruneAll = async () => {
    setPruning(true);
    try {
      await invoke("prune_images");
      showToast("Docker system pruned successfully", "success");
      await refreshHealth();
    } catch (e) {
      logError("Docker system prune", `${e}`);
      showToast(`Prune failed: ${e}`, "error");
    } finally {
      setPruning(false);
    }
  };

  onMount(() => {
    refresh();
    const interval = setInterval(refreshHealth, 15_000);
    onCleanup(() => clearInterval(interval));
  });

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">Machine</h1>
        <button class="btn" onClick={refresh}>Refresh</button>
      </div>

      <Show when={error()}>
        <div class="card" style={{ "border-color": "#da3633", "margin-bottom": "16px" }}>
          <span style={{ color: "#f85149" }}>{error()}</span>
        </div>
      </Show>

      <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "16px", "max-width": "900px" }}>
        {/* Machine Info */}
        <Show when={machine()} fallback={
          <div class="skeleton-card" style={{ height: "200px" }}>
            <div class="skeleton-line skeleton-line-short" />
            <div class="skeleton-line" />
            <div class="skeleton-line skeleton-line-medium" />
            <div class="skeleton-line" />
            <div class="skeleton-line skeleton-line-short" />
            <div class="skeleton-line skeleton-line-medium" />
          </div>
        }>
          {(m) => (
            <div class="card">
              <h3 style={{ "margin-bottom": "12px", "font-size": "14px", color: "#e6edf3" }}>Machine Info</h3>
              <div class="card-grid">
                <span class="card-label">Name</span>
                <span class="card-value">{m().name}</span>

                <span class="card-label">Backend</span>
                <span class="card-value">{m().backend}</span>

                <span class="card-label">State</span>
                <span class={`state-badge ${m().state === "Running" ? "state-running" : "state-stopped"}`}>
                  {m().state}
                </span>

                <span class="card-label">Runtime</span>
                <span class="card-value">{m().config.runtime}</span>

                <span class="card-label">CPUs</span>
                <span class="card-value">{m().config.cpus}</span>

                <span class="card-label">Memory</span>
                <span class="card-value">{formatBytes(m().config.memory_mb * 1024 * 1024)}</span>

                <Show when={m().config.disk_gb > 0}>
                  <span class="card-label">Disk</span>
                  <span class="card-value">{m().config.disk_gb} GB</span>
                </Show>
              </div>
            </div>
          )}
        </Show>

        {/* Docker Connection */}
        <Show when={health()} fallback={
          <div class="skeleton-card" style={{ height: "100px" }}>
            <div class="skeleton-line skeleton-line-short" />
            <div class="skeleton-line skeleton-line-medium" />
            <div class="skeleton-line" />
          </div>
        }>
          {(h) => (
            <div class="card">
              <h3 style={{ "margin-bottom": "12px", "font-size": "14px", color: "#e6edf3" }}>Docker Status</h3>
              <div class="card-grid">
                <span class="card-label">Connection</span>
                <span class={`state-badge ${h().docker_connected ? "state-running" : "state-stopped"}`}>
                  {h().docker_connected ? "Connected" : "Disconnected"}
                </span>

                <Show when={h().docker_version}>
                  <span class="card-label">Version</span>
                  <span class="card-value">{h().docker_version}</span>
                </Show>
              </div>
            </div>
          )}
        </Show>

        {/* System Resources */}
        <Show when={health()?.system_resources}>
          {(res) => (
            <div class="card">
              <h3 style={{ "margin-bottom": "12px", "font-size": "14px", color: "#e6edf3" }}>System Resources</h3>
              <div class="card-grid" style={{ "margin-bottom": "16px" }}>
                <span class="card-label">CPU Cores</span>
                <span class="card-value">{res().cpu_count}</span>
              </div>
              <UsageBar
                label="Memory"
                used={res().memory_total_bytes - res().memory_available_bytes}
                total={res().memory_total_bytes}
              />
              <UsageBar
                label="Disk"
                used={res().disk_total_bytes - res().disk_free_bytes}
                total={res().disk_total_bytes}
              />
            </div>
          )}
        </Show>

        {/* Docker Disk Usage */}
        <Show when={health()?.disk_usage}>
          {(du) => (
            <div class="card">
              <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "12px" }}>
                <h3 style={{ "font-size": "14px", color: "#e6edf3" }}>Docker Disk Usage</h3>
                <button
                  class="btn btn-sm"
                  onClick={pruneAll}
                  disabled={pruning()}
                  title="Remove unused images, containers, and build cache"
                  style={{ "font-size": "11px", padding: "2px 8px" }}
                >
                  {pruning() ? "Pruning..." : "Prune All"}
                </button>
              </div>
              <div class="card-grid">
                <span class="card-label">Images</span>
                <span class="card-value">{formatBytes(du().images_size_bytes)}</span>

                <span class="card-label">Containers</span>
                <span class="card-value">{formatBytes(du().containers_size_bytes)}</span>

                <span class="card-label">Volumes</span>
                <span class="card-value">{formatBytes(du().volumes_size_bytes)}</span>

                <span class="card-label">Build Cache</span>
                <span class="card-value">{formatBytes(du().build_cache_size_bytes)}</span>

                <span class="card-label">Total</span>
                <span class="card-value" style={{ "font-weight": "600" }}>{formatBytes(du().total_size_bytes)}</span>

                <span class="card-label">Reclaimable</span>
                <span class="card-value" style={{ color: du().reclaimable_bytes > 1024 * 1024 * 1024 ? "#d29922" : "#8b949e" }}>
                  {formatBytes(du().reclaimable_bytes)}
                </span>
              </div>
            </div>
          )}
        </Show>
      </div>

      {/* Warnings */}
      <Show when={health()?.warnings && health()!.warnings.length > 0}>
        <div class="card" style={{ "max-width": "900px", "margin-top": "16px", "border-color": "#d29922" }}>
          <h3 style={{ "margin-bottom": "8px", "font-size": "14px", color: "#d29922" }}>Warnings</h3>
          <For each={health()!.warnings}>
            {(warning) => (
              <div style={{ padding: "4px 0", color: "#e6edf3", "font-size": "13px" }}>
                {warning}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
