import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import type { SystemHealth, ActiveHost } from "../lib/types";
import { showToast } from "./Toast";
import { confirm } from "./ConfirmDialog";
import { getOllamaSetupState, getOllamaSetupStatus, isOllamaSetupRunning } from "../lib/ollamaSetup";
import { t } from "../i18n";

interface StatusBarProps {
  onNavigate?: (page: string) => void;
}

export default function StatusBar(props: StatusBarProps) {
  const [health, setHealth] = createSignal<SystemHealth | null>(null);
  const [updateAvailable, setUpdateAvailable] = createSignal<{version: string; body?: string} | null>(null);
  const [installing, setInstalling] = createSignal(false);
  const [appVersion, setAppVersion] = createSignal<string | null>(null);
  const [activeHost, setActiveHost] = createSignal<ActiveHost | null>(null);

  const pollHealth = async () => {
    try {
      const h = (await invoke("system_health")) as SystemHealth;
      setHealth(h);
    } catch { /* daemon not ready */ }
    try {
      const host = (await invoke("get_active_host")) as ActiveHost;
      setActiveHost(host);
    } catch { /* ignore */ }
  };

  // Flipped on cleanup so the 5s-delayed `checkUpdate` (and hourly poll)
  // don't call `setUpdateAvailable` after the component is unmounted.
  let disposed = false;

  const checkUpdate = async () => {
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (disposed) return;
      // Real tauri-plugin-updater returns `null` when no update is
      // available or an `Update` object with `.version` set. Defend
      // against a truthy-but-empty response (broken backend, test
      // harness that returns `{}` for unmocked commands) so we never
      // render "Update available: vundefined" in the status bar.
      if (update && typeof update.version === "string" && update.version.length > 0) {
        setUpdateAvailable({ version: update.version, body: update.body ?? undefined });
      }
    } catch { /* updater not configured or not in Tauri context */ }
  };

  const installUpdate = async () => {
    const info = updateAvailable();
    if (!info) return;

    const confirmed = await confirm({
      title: t("components.status.updateTitle"),
      message: t("components.status.updateMessage", { version: info.version, notes: info.body ? t("components.status.whatsNew", { body: info.body }) : "" }),
      confirmLabel: t("components.status.update"),
    });
    if (!confirmed) return;

    setInstalling(true);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        showToast(t("components.status.downloading"), "info");
        // Stop the daemon before installing so the installer can replace the binary
        try { await invoke("stop_daemon"); } catch { /* ignore */ }
        await update.downloadAndInstall();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      }
    } catch (e) {
      showToast(t("components.status.updateFailed", { error: e }), "error");
      setInstalling(false);
    }
  };

  onMount(() => {
    pollHealth();
    // Check for updates after 5 seconds, then every hour. The initial
    // setTimeout handle must be captured so we can cancel it if the
    // component unmounts before the 5s elapses.
    const t = setTimeout(checkUpdate, 5000);
    const updateInterval = setInterval(checkUpdate, 3600000);
    getVersion().then((v) => { if (!disposed) setAppVersion(v); }).catch(() => {});
    const interval = setInterval(pollHealth, 15000);
    onCleanup(() => {
      disposed = true;
      clearTimeout(t);
      clearInterval(interval);
      clearInterval(updateInterval);
    });
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
        <Show when={activeHost()}>
          <span class="status-bar-item" title={activeHost()!.is_remote ? t("components.status.connectedTo", { url: activeHost()!.url }) : t("components.status.localDaemon")}>
            <span class="status-bar-dot" style={{ background: activeHost()!.is_remote ? "#58a6ff" : "#3fb950" }} />
            {activeHost()!.name}
          </span>
          <span class="status-bar-separator" />
        </Show>
        <Show when={health()?.docker_connected}>
          <span class="status-bar-item">
            <span class="status-bar-dot" style={{ background: "#3fb950" }} />
            Docker
          </span>
        </Show>
        <Show when={health()?.docker_connected === false}>
          <span class="status-bar-item">
            <span class="status-bar-dot" style={{ background: "#f85149" }} />
            {t("components.status.disconnected")}
          </span>
        </Show>

        <Show when={health()?.system_resources}>
          <span class="status-bar-separator" />
          <span class="status-bar-item" title={t("components.status.cpuCores", { count: health()!.system_resources!.cpu_count })}>
            CPU {health()!.system_resources!.cpu_count}
          </span>
          <span class="status-bar-separator" />
          <span class="status-bar-item" title={t("components.status.memoryUsed", { percent: memPercent().toFixed(0) })}>
            RAM
            <span class="status-bar-mini-bar">
              <span class="status-bar-mini-fill" style={{ width: `${memPercent()}%`, background: barColor(memPercent()) }} />
            </span>
            {memPercent().toFixed(0)}%
          </span>
          <span class="status-bar-separator" />
          <span class="status-bar-item" title={t("components.status.diskUsed", { percent: diskPercent().toFixed(0) })}>
            {t("components.status.disk")}
            <span class="status-bar-mini-bar">
              <span class="status-bar-mini-fill" style={{ width: `${diskPercent()}%`, background: barColor(diskPercent()) }} />
            </span>
            {diskPercent().toFixed(0)}%
          </span>
        </Show>

        <Show when={health()?.gpu}>
          <span class="status-bar-separator" />
          <span class="status-bar-item" title={t("components.status.gpu", { name: health()!.gpu!.name })}>
            GPU
            <span class="status-bar-mini-bar">
              <span class="status-bar-mini-fill" style={{ width: `${Math.round(health()!.gpu!.memory_used_mb / health()!.gpu!.memory_total_mb * 100)}%`, background: barColor(Math.round(health()!.gpu!.memory_used_mb / health()!.gpu!.memory_total_mb * 100)) }} />
            </span>
            {(health()!.gpu!.memory_used_mb / 1024).toFixed(1)}G
          </span>
        </Show>

        <Show when={health()?.warnings && health()!.warnings.length > 0}>
          <span class="status-bar-separator" />
          <span
            class="status-bar-item status-bar-warning status-bar-clickable"
            onClick={() => props.onNavigate?.("environment")}
          >
            {t("components.status.warnings", { count: health()!.warnings.length })}
          </span>
        </Show>

        <Show when={getOllamaSetupState() !== "idle"}>
          <span class="status-bar-separator" />
          <span
            class="status-bar-item status-bar-clickable"
            onClick={() => props.onNavigate?.("settings")}
            style={{
              color: getOllamaSetupState() === "done" ? "#3fb950"
                : getOllamaSetupState() === "error" ? "#f85149"
                : "#58a6ff",
              "max-width": "300px",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            <Show when={isOllamaSetupRunning()}>
              <span class="status-bar-spinner" />
            </Show>
            {getOllamaSetupState() === "done" ? "\u2713 " : ""}
            {getOllamaSetupStatus()}
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
              ? t("components.status.installing")
              : t("components.status.available", { version: updateAvailable()!.version })}
          </button>
        </Show>
        <Show when={appVersion()}>
          <span class="status-bar-item" style={{ opacity: 0.5 }}>v{appVersion()}</span>
        </Show>
      </div>
    </div>
  );
}
