import { createSignal, onMount, onCleanup, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./Toast";
import { getEvents, getUnreadCount, markAllRead, clearEvents } from "../lib/activityStore";
import { openAiWindow } from "./AiAssistant";
import type { SystemHealth } from "../lib/types";

interface TitlebarProps {
  daemonStatus: string;
  onNavigate?: (page: string) => void;
}

function relativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function Titlebar(props: TitlebarProps) {
  const [maximized, setMaximized] = createSignal(false);
  const [dockerConnected, setDockerConnected] = createSignal<boolean | null>(null);
  const [wasDisconnected, setWasDisconnected] = createSignal(false);
  const [warningCount, setWarningCount] = createSignal(0);
  const [runtimeInfo, setRuntimeInfo] = createSignal<string | null>(null);
  const [bellOpen, setBellOpen] = createSignal(false);

  const pollHealth = async () => {
    try {
      const health = (await invoke("system_health")) as SystemHealth;
      const prevConnected = dockerConnected();
      setDockerConnected(health.docker_connected);
      setWarningCount(health.warnings.length);
      setRuntimeInfo(health.docker_version ? `Docker ${health.docker_version}` : null);

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

    // Close bell dropdown when clicking outside
    const handleClickOutside = (e: MouseEvent) => {
      if (bellOpen()) {
        const bell = document.querySelector(".notification-bell");
        if (bell && !bell.contains(e.target as Node)) {
          setBellOpen(false);
        }
      }
    };
    document.addEventListener("mousedown", handleClickOutside);

    onCleanup(() => {
      clearInterval(interval);
      document.removeEventListener("mousedown", handleClickOutside);
    });
  });

  const minimize = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch (e) {
      console.error("Minimize failed:", e);
    }
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
    } catch (e) {
      console.error("Maximize toggle failed:", e);
    }
  };

  const close = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
    } catch (e) {
      console.error("Close/hide failed:", e);
    }
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
        <span class="titlebar-title" data-tauri-drag-region>Orca Desktop</span>
        <div class="titlebar-status" onClick={() => props.onNavigate?.("environment")} title="System Health">
          <span class="titlebar-status-dot" style={{ background: statusColor() }} />
          <span class="titlebar-status-text">{statusText()}</span>
          <Show when={runtimeInfo() && dockerConnected()}>
            <span class="titlebar-runtime">{runtimeInfo()}</span>
          </Show>
          <Show when={dockerConnected() === false && props.daemonStatus === "running"}>
            <span class="titlebar-reconnecting" title="Click to check System Health">No runtime</span>
          </Show>
          <Show when={warningCount() > 0}>
            <span class="titlebar-warning-badge" title={`${warningCount()} warning${warningCount() > 1 ? "s" : ""}`}>
              {warningCount()}
            </span>
          </Show>
        </div>
      </div>
      <button
        class="titlebar-search"
        onClick={() => {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
        }}
        data-tauri-drag-region-exclude
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ opacity: 0.5 }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <span>Search...</span>
        <span class="titlebar-search-shortcut">⌘K</span>
      </button>
      <div class="titlebar-controls">
        <button
          class="notification-btn"
          title="AI Assistant"
          onClick={openAiWindow}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="16" height="12" x="4" y="8" rx="2"/>
            <path d="M2 14h2"/>
            <path d="M20 14h2"/>
            <path d="M15 13v2"/>
            <path d="M9 13v2"/>
            <path d="M12 8V4H8"/>
          </svg>
        </button>
        <div class="notification-bell">
          <button
            class="notification-btn"
            title="Notifications"
            onClick={() => {
              const opening = !bellOpen();
              setBellOpen(opening);
              if (opening) markAllRead();
            }}
          >
            {"\u{1F514}"}
            <Show when={getUnreadCount() > 0}>
              <span class="notification-badge">
                {getUnreadCount() > 99 ? "99+" : getUnreadCount()}
              </span>
            </Show>
          </button>
          <Show when={bellOpen()}>
            <div class="notification-dropdown">
              <div class="notification-dropdown-header">
                <span>Notifications</span>
                <span style={{ color: "#8b949e", "font-weight": "400" }}>
                  {getEvents().length} events
                </span>
              </div>
              <div class="notification-dropdown-body">
                <Show
                  when={getEvents().length > 0}
                  fallback={
                    <div style={{ padding: "20px", "text-align": "center", color: "#8b949e", "font-size": "12px" }}>
                      No events yet
                    </div>
                  }
                >
                  <For each={getEvents().slice(0, 10)}>
                    {(event) => (
                      <div class="activity-event">
                        <div class={`activity-event-icon activity-icon-${event.severity}`}>
                          {event.type.startsWith("container") ? "\u25a3" : event.type.startsWith("image") ? "\u25ce" : "\u2139"}
                        </div>
                        <div class="activity-event-body">
                          <div class="activity-event-title">{event.title}</div>
                          <div class="activity-event-time">{relativeTime(event.timestamp)}</div>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
              <div class="notification-dropdown-footer">
                <button
                  class="notification-view-all"
                  onClick={() => {
                    setBellOpen(false);
                    if (props.onNavigate) props.onNavigate("activity");
                  }}
                >
                  View All
                </button>
                <Show when={getEvents().length > 0}>
                  <button
                    class="notification-view-all notification-clear-btn"
                    onClick={() => {
                      clearEvents();
                      setBellOpen(false);
                    }}
                  >
                    Clear All
                  </button>
                </Show>
              </div>
            </div>
          </Show>
        </div>
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
