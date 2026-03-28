import { createSignal, onMount, onCleanup, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./Toast";
import { getAlertEvents, getUnreadCount, markAllRead, clearEvents } from "../lib/activityStore";
import { openAiWindow } from "./AiAssistant";
import type { SystemHealth, RemoteHost, ActiveHost } from "../lib/types";

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
  const [hostMenuOpen, setHostMenuOpen] = createSignal(false);
  const [remoteHosts, setRemoteHosts] = createSignal<RemoteHost[]>([]);
  const [activeHost, setActiveHost] = createSignal<ActiveHost>({ id: null, name: "Local", url: "", is_remote: false });

  const loadHosts = async () => {
    try {
      const hosts = (await invoke("list_remote_hosts")) as RemoteHost[];
      setRemoteHosts(hosts);
      const active = (await invoke("get_active_host")) as ActiveHost;
      setActiveHost(active);
    } catch {}
  };

  const switchToHost = async (id: string | null) => {
    try {
      await invoke("switch_host", { id });
      const active = (await invoke("get_active_host")) as ActiveHost;
      setActiveHost(active);
      setHostMenuOpen(false);
      showToast(`Switched to ${active.name}`, "success");
      // Trigger a full refresh + chart reset across the app
      document.dispatchEvent(new CustomEvent("orca-host-switch"));
      document.dispatchEvent(new CustomEvent("orca-refresh"));
    } catch (e) {
      showToast(`Failed to switch host: ${e}`, "error");
    }
  };

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
    loadHosts();
    const interval = setInterval(pollHealth, 10_000);

    // Reload hosts when settings change
    const onRefresh = () => loadHosts();
    document.addEventListener("orca-refresh", onRefresh);
    onCleanup(() => document.removeEventListener("orca-refresh", onRefresh));

    // Close dropdowns when clicking outside
    const handleClickOutside = (e: MouseEvent) => {
      if (bellOpen()) {
        const bell = document.querySelector(".notification-bell");
        if (bell && !bell.contains(e.target as Node)) {
          setBellOpen(false);
        }
      }
      if (hostMenuOpen()) {
        const hostSel = document.querySelector(".host-selector");
        if (hostSel && !hostSel.contains(e.target as Node)) {
          setHostMenuOpen(false);
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
          <div class="host-selector" data-tauri-drag-region-exclude>
            <button
              class={`host-selector-btn ${activeHost().is_remote ? "host-remote" : ""}`}
              onClick={() => { setHostMenuOpen(!hostMenuOpen()); loadHosts(); }}
              title={activeHost().is_remote ? `Connected to ${activeHost().url}` : "Local daemon"}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
              </svg>
              <span>{activeHost().name}</span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <Show when={hostMenuOpen()}>
              <div class="host-selector-dropdown">
                <div
                  class={`host-selector-item ${!activeHost().is_remote ? "active" : ""}`}
                  onClick={() => switchToHost(null)}
                >
                  <span class="host-dot" style={{ background: "#3fb950" }} />
                  <span>Local</span>
                </div>
                <For each={remoteHosts()}>
                  {(host) => (
                    <div
                      class={`host-selector-item ${activeHost().id === host.id ? "active" : ""}`}
                      onClick={() => switchToHost(host.id)}
                    >
                      <span class="host-dot" style={{ background: activeHost().id === host.id ? "#58a6ff" : "#8b949e" }} />
                      <span>{host.name}</span>
                    </div>
                  )}
                </For>
                <div class="host-selector-divider" />
                <div
                  class="host-selector-item"
                  onClick={() => { setHostMenuOpen(false); props.onNavigate?.("settings"); }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                  <span>Manage Hosts...</span>
                </div>
              </div>
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
            <path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z" />
            <path d="M4 3v2" />
            <path d="M3 4h2" />
            <path d="M20 19v2" />
            <path d="M19 20h2" />
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
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
                  {getAlertEvents().length} alert{getAlertEvents().length !== 1 ? "s" : ""}
                </span>
              </div>
              <div class="notification-dropdown-body">
                <Show
                  when={getAlertEvents().length > 0}
                  fallback={
                    <div style={{ padding: "20px", "text-align": "center", color: "#8b949e", "font-size": "12px" }}>
                      No errors or warnings
                    </div>
                  }
                >
                  <For each={getAlertEvents().slice(0, 10)}>
                    {(event) => (
                      <div
                        class="activity-event activity-event-clickable"
                        onClick={() => { setBellOpen(false); props.onNavigate?.("activity"); }}
                        title="Click to view in Activity"
                      >
                        <div class={`activity-event-icon activity-icon-${event.severity}`}>
                          {event.severity === "error" ? "\u2717" : "\u26A0"}
                        </div>
                        <div class="activity-event-body">
                          <div class="activity-event-title">{event.title}</div>
                          <Show when={event.detail}>
                            <div class="activity-event-detail">{event.detail}</div>
                          </Show>
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
                  View All Activity
                </button>
                <Show when={getAlertEvents().length > 0}>
                  <button
                    class="notification-view-all notification-clear-btn"
                    onClick={() => {
                      clearEvents();
                      setBellOpen(false);
                    }}
                  >
                    Clear
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
