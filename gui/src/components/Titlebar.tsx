import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./Toast";
import type { SystemHealth } from "../lib/types";

interface TitlebarProps {
  daemonStatus: string;
}

export default function Titlebar(props: TitlebarProps) {
  const [maximized, setMaximized] = createSignal(false);
  const [dockerConnected, setDockerConnected] = createSignal<boolean | null>(null);
  const [wasDisconnected, setWasDisconnected] = createSignal(false);
  const [warningCount, setWarningCount] = createSignal(0);

  const pollHealth = async () => {
    try {
      const health = (await invoke("system_health")) as SystemHealth;
      const prevConnected = dockerConnected();
      setDockerConnected(health.docker_connected);
      setWarningCount(health.warnings.length);

      // Detect reconnection
      if (prevConnected === false && health.docker_connected) {
        setWasDisconnected(false);
        showToast("Docker connection restored", "success");
      }
      if (!health.docker_connected && prevConnected !== false) {
        setWasDisconnected(true);
      }
    } catch {
      // Daemon not reachable — docker status unknown
      setDockerConnected(null);
      setWarningCount(0);
    }
  };

  onMount(() => {
    pollHealth();
    const interval = setInterval(pollHealth, 10_000);
    onCleanup(() => clearInterval(interval));
  });

  const minimize = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch {}
  };

  const toggleMaximize = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if (await win.isMaximized()) {
        await win.unmaximize();
        setMaximized(false);
      } else {
        await win.maximize();
        setMaximized(true);
      }
    } catch {}
  };

  const close = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
    } catch {}
  };

  const statusColor = () => {
    // Docker connection status takes priority when daemon is running
    if (props.daemonStatus === "running") {
      if (dockerConnected() === false) return "#f85149";
      return "#3fb950";
    }
    switch (props.daemonStatus) {
      case "stopped": return "#f85149";
      default: return "#848d97";
    }
  };

  const statusText = () => {
    if (props.daemonStatus === "running") {
      if (dockerConnected() === false) return "disconnected";
      return "running";
    }
    return props.daemonStatus;
  };

  return (
    <div class="titlebar" data-tauri-drag-region>
      <div class="titlebar-left" data-tauri-drag-region>
        <img src="/icon.png" class="titlebar-icon" alt="" />
        <span class="titlebar-title" data-tauri-drag-region>Orca</span>
        <div class="titlebar-status" data-tauri-drag-region>
          <span class="titlebar-status-dot" style={{ background: statusColor() }} />
          <span class="titlebar-status-text">{statusText()}</span>
          <Show when={dockerConnected() === false && props.daemonStatus === "running"}>
            <span class="titlebar-reconnecting">Reconnecting...</span>
          </Show>
          <Show when={warningCount() > 0}>
            <span class="titlebar-warning-badge" title={`${warningCount()} warning${warningCount() > 1 ? "s" : ""}`}>
              {warningCount()}
            </span>
          </Show>
        </div>
      </div>
      <div class="titlebar-controls">
        <button class="titlebar-btn" onClick={minimize} title="Minimize">
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
        </button>
        <button class="titlebar-btn" onClick={toggleMaximize} title={maximized() ? "Restore" : "Maximize"}>
          <Show when={maximized()} fallback={
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>
          }>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 0h8v8h-2v2H0V2h2V0zm1 1v1h5v5h1V1H3zM1 3v6h6V3H1z" fill="currentColor"/></svg>
          </Show>
        </button>
        <button class="titlebar-btn titlebar-btn-close" onClick={close} title="Close">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 0l4 4L9 0l1 1-4 4 4 4-1 1-4-4-4 4L0 9l4-4L0 1z" fill="currentColor"/></svg>
        </button>
      </div>
    </div>
  );
}
