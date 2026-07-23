import { createSignal, onMount, onCleanup, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { MachineInfo, SystemHealth } from "../lib/types";
import { formatBytes } from "../lib/format";
import { showToast } from "../components/Toast";
import { logError } from "../lib/activityStore";
import { confirmDanger } from "../components/ConfirmDialog";
import { t, lang } from "../i18n";
import { settingsDetailEn, settingsDetailZhCN } from "../i18n/settingsDetail";

const tr = (key: string, params: Record<string, string | number> = {}) => {
  const central = t(key);
  const value = central === key ? (lang() === "zh-CN" ? settingsDetailZhCN[key] : settingsDetailEn[key]) ?? key : central;
  return Object.entries(params).reduce((text, [name, replacement]) => text.replaceAll(`{${name}}`, String(replacement)), value);
};

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
    const ok = await confirmDanger({
      title: tr("machine.pruneDialogTitle"),
      message: tr("machine.pruneDialogMessage"),
      confirmLabel: tr("machine.pruneConfirm"),
    });
    if (!ok) return;
    setPruning(true);
    try {
      await invoke("prune_images");
      showToast("Docker system pruned successfully", "success");
      await refreshHealth();
    } catch (e) {
      logError(`Failed to prune Docker system: ${e}`);
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
        <h1 class="page-title">{tr("machine.title")}</h1>
        <button class="btn" onClick={refresh}>{tr("common.refresh")}</button>
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
              <h3 style={{ "margin-bottom": "12px", "font-size": "14px", color: "#e6edf3" }}>{tr("machine.info")}</h3>
              <div class="card-grid">
                <span class="card-label">{tr("machine.name")}</span>
                <span class="card-value">{m().name}</span>

                <span class="card-label">{tr("machine.backend")}</span>
                <span class="card-value">{m().backend}</span>

                <span class="card-label">{tr("common.state")}</span>
                <span class={`state-badge ${m().state === "Running" ? "state-running" : "state-stopped"}`}>
                  {m().state}
                </span>

                <span class="card-label">{tr("machine.runtime")}</span>
                <span class="card-value">{m().config.runtime}</span>

                <span class="card-label">{tr("settings.general.cpus")}</span>
                <span class="card-value">{m().config.cpus}</span>

                <span class="card-label">t("corePages.common.memory")</span>
                <span class="card-value">{formatBytes(m().config.memory_mb * 1024 * 1024)}</span>

                <Show when={m().config.disk_gb > 0}>
                  <span class="card-label">t("settings.general.disk")</span>
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
              <h3 style={{ "margin-bottom": "12px", "font-size": "14px", color: "#e6edf3" }}>{tr("machine.dockerStatus")}</h3>
              <div class="card-grid">
                <span class="card-label">{tr("machine.connection")}</span>
                <span class={`state-badge ${h().docker_connected ? "state-running" : "state-stopped"}`}>
                  {h().docker_connected ? tr("machine.connected") : tr("machine.disconnected")}
                </span>

                <Show when={h().docker_version}>
                  <span class="card-label">{tr("machine.version")}</span>
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
              <h3 style={{ "margin-bottom": "12px", "font-size": "14px", color: "#e6edf3" }}>{tr("machine.systemResources")}</h3>
              <div class="card-grid" style={{ "margin-bottom": "16px" }}>
                <span class="card-label">{tr("machine.cpuCores")}</span>
                <span class="card-value">{res().cpu_count}</span>
              </div>
              <UsageBar
                label={tr("container.memory")}
                used={res().memory_total_bytes - res().memory_available_bytes}
                total={res().memory_total_bytes}
              />
              <UsageBar
                label={tr("settings.general.disk")}
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
                <h3 style={{ "font-size": "14px", color: "#e6edf3" }}>{tr("machine.dockerDiskUsage")}</h3>
                <button
                  class="btn btn-sm"
                  onClick={pruneAll}
                  disabled={pruning()}
                  title={tr("machine.pruneTitle")}
                  style={{ "font-size": "11px", padding: "2px 8px" }}
                >
                  {pruning() ? tr("machine.pruning") : tr("machine.pruneAll")}
                </button>
              </div>
              <div class="card-grid">
                <span class="card-label">{tr("machine.images")}</span>
                <span class="card-value">{formatBytes(du().images_size_bytes)}</span>

                <span class="card-label">{tr("machine.containers")}</span>
                <span class="card-value">{formatBytes(du().containers_size_bytes)}</span>

                <span class="card-label">{tr("machine.volumes")}</span>
                <span class="card-value">{formatBytes(du().volumes_size_bytes)}</span>

                <span class="card-label">{tr("machine.buildCache")}</span>
                <span class="card-value">{formatBytes(du().build_cache_size_bytes)}</span>

                <span class="card-label">t("machine.total")</span>
                <span class="card-value" style={{ "font-weight": "600" }}>{formatBytes(du().total_size_bytes)}</span>

                <span class="card-label">{tr("machine.reclaimable")}</span>
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
          <h3 style={{ "margin-bottom": "8px", "font-size": "14px", color: "#d29922" }}>{tr("machine.warnings")}</h3>
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
