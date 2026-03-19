import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { SystemHealth } from "../lib/types";
import { formatBytes } from "../lib/format";
import { showToast } from "./Toast";

export default function StatusBar() {
  const [health, setHealth] = createSignal<SystemHealth | null>(null);
  const [updateAvailable, setUpdateAvailable] = createSignal<{version: string; body?: string} | null>(null);
  const [installing, setInstalling] = createSignal(false);

  const pollHealth = async () => {
    try {
      const h = (await invoke("system_health")) as SystemHealth;
      setHealth(h);
    } catch { /* daemon not ready */ }
  };

  const checkUpdate = async () => {
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setUpdateAvailable({ version: update.version, body: update.body ?? undefined });
      }
    } catch { /* updater not configured or not in Tauri context */ }
  };

  const installUpdate = async () => {
    const info = updateAvailable();
    if (!info) return;

    const confirmed = window.confirm(
      `Update to Orca v${info.version}?\n\nThe app will download the update and restart.\n${info.body ? `\nWhat's new:\n${info.body}` : ""}`
    );
    if (!confirmed) return;

    setInstalling(true);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        showToast("Downloading update...", "info");
        await update.downloadAndInstall();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      }
    } catch (e) {
      showToast(`Update failed: ${e}`, "error");
      setInstalling(false);
    }
  };

  onMount(() => {
    pollHealth();
    checkUpdate();
    const interval = setInterval(pollHealth, 15000);
    onCleanup(() => clearInterval(interval));
  });

  const memPercent = () => {
    const h = health();
    if (!h?.system_resources) return 0;
    const { memory_total_bytes, memory_available_bytes } = h.system_resources;
    if (!memory_total_bytes) return 0;
    return ((memory_total_bytes - memory_available_bytes) / memory_total_bytes * 100);
  };

  const diskPercent = () => {
    const h = health();
    return h?.system_resources?.disk_usage_percent ?? 0;
  };

  const barColor = (pct: number) => {
    if (pct > 90) return "#f85149";
    if (pct > 70) return "#d29922";
    return "#3fb950";
  };

  return (
    <div class="status-bar">
      <div class="status-bar-left">
        <Show when={health()?.docker_connected}>
          <span class="status-bar-item">
            <span class="status-bar-dot" style={{ background: "#3fb950" }} />
            Docker
          </span>
        </Show>
        <Show when={health()?.docker_connected === false}>
          <span class="status-bar-item">
            <span class="status-bar-dot" style={{ background: "#f85149" }} />
            Disconnected
          </span>
        </Show>

        <Show when={health()?.system_resources}>
          <span class="status-bar-separator" />
          <span class="status-bar-item" title={`CPU: ${health()!.system_resources!.cpu_count} cores`}>
            CPU {health()!.system_resources!.cpu_count}
          </span>
          <span class="status-bar-separator" />
          <span class="status-bar-item" title={`Memory: ${memPercent().toFixed(0)}% used`}>
            RAM
            <span class="status-bar-mini-bar">
              <span class="status-bar-mini-fill" style={{ width: `${memPercent()}%`, background: barColor(memPercent()) }} />
            </span>
            {memPercent().toFixed(0)}%
          </span>
          <span class="status-bar-separator" />
          <span class="status-bar-item" title={`Disk: ${diskPercent().toFixed(0)}% used`}>
            Disk
            <span class="status-bar-mini-bar">
              <span class="status-bar-mini-fill" style={{ width: `${diskPercent()}%`, background: barColor(diskPercent()) }} />
            </span>
            {diskPercent().toFixed(0)}%
          </span>
        </Show>

        <Show when={health()?.warnings && health()!.warnings.length > 0}>
          <span class="status-bar-separator" />
          <span class="status-bar-item status-bar-warning">
            ⚠ {health()!.warnings.length} warning{health()!.warnings.length > 1 ? "s" : ""}
          </span>
        </Show>
      </div>

      <div class="status-bar-right">
        <Show when={updateAvailable()}>
          <button
            class="status-bar-update"
            onClick={installUpdate}
            disabled={installing()}
          >
            {installing()
              ? "Installing..."
              : `Update available: v${updateAvailable()!.version}`}
          </button>
        </Show>
        <span class="status-bar-item" style={{ opacity: 0.5 }}>v0.1.3</span>
      </div>
    </div>
  );
}
