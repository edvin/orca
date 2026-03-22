import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getEvents, clearEvents, markAllRead } from "../lib/activityStore";
import type { ActivityEvent } from "../lib/activityStore";

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

function eventIcon(type: string): string {
  if (type.startsWith("container")) return "\u25a3";
  if (type.startsWith("image")) return "\u25ce";
  if (type.startsWith("volume")) return "\u25c8";
  if (type.startsWith("network")) return "\u25cc";
  return "\u2139";
}

function severityClass(severity: ActivityEvent["severity"]): string {
  switch (severity) {
    case "success": return "activity-icon-success";
    case "error": return "activity-icon-error";
    case "warning": return "activity-icon-warning";
    default: return "activity-icon-info";
  }
}

export default function ActivityPage() {
  const [daemonLog, setDaemonLog] = createSignal<string[]>([]);
  const [logLoading, setLogLoading] = createSignal(false);
  let logRef: HTMLPreElement | undefined;

  const fetchDaemonLog = async () => {
    setLogLoading(true);
    try {
      const info = (await invoke("get_daemon_info")) as { log_tail?: string };
      if (info?.log_tail) {
        // Strip ANSI escape codes from tracing output
        const stripped = info.log_tail.replace(/\x1b\[[0-9;]*m/g, "");
        setDaemonLog(stripped.split("\n").filter((l) => l.length > 0));
      }
    } catch {}
    setLogLoading(false);
    // Auto-scroll to bottom
    requestAnimationFrame(() => {
      if (logRef) logRef.scrollTop = logRef.scrollHeight;
    });
  };

  onMount(() => {
    markAllRead();
    fetchDaemonLog();
    const interval = setInterval(fetchDaemonLog, 5000);
    onCleanup(() => clearInterval(interval));
  });

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
      <div class="page-header">
        <h1 class="page-title">Activity</h1>
        <div class="page-actions">
          <Show when={getEvents().length > 0}>
            <button class="btn btn-sm" onClick={clearEvents}>Clear</button>
          </Show>
        </div>
      </div>

      {/* App events */}
      <Show
        when={getEvents().length > 0}
        fallback={
          <div class="empty" style={{ padding: "20px 0" }}>
            <div class="empty-title">No activity yet</div>
            <p>Errors and events will appear here as they happen.</p>
          </div>
        }
      >
        <div class="activity-timeline" style={{ "max-height": "40vh", "overflow-y": "auto", "margin-bottom": "16px" }}>
          <For each={getEvents()}>
            {(event) => (
              <div class="activity-event">
                <div class={`activity-event-icon ${severityClass(event.severity)}`}>
                  {eventIcon(event.type)}
                </div>
                <div class="activity-event-body">
                  <div class="activity-event-title">{event.title}</div>
                  <Show when={event.detail}>
                    <div style={{ "font-size": "11px", color: "#6e7681", "margin-top": "2px" }}>{event.detail}</div>
                  </Show>
                  <div class="activity-event-time">{relativeTime(event.timestamp)}</div>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Daemon log */}
      <div style={{
        flex: "1",
        display: "flex",
        "flex-direction": "column",
        "min-height": "200px",
        background: "#0d1117",
        border: "1px solid #21262d",
        "border-radius": "8px",
        overflow: "hidden",
      }}>
        <div style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          padding: "8px 14px",
          background: "#161b22",
          "border-bottom": "1px solid #21262d",
          "font-size": "12px",
          "font-weight": "600",
          color: "#8b949e",
        }}>
          <span>Daemon Log</span>
          <button class="btn btn-sm" onClick={fetchDaemonLog} disabled={logLoading()} style={{ "font-size": "11px", padding: "2px 8px" }}>
            Refresh
          </button>
        </div>
        <pre
          ref={logRef}
          style={{
            flex: "1",
            overflow: "auto",
            padding: "10px 14px",
            margin: "0",
            "font-family": "'JetBrains Mono NF', monospace",
            "font-size": "11px",
            "line-height": "1.5",
            color: "#8b949e",
            "white-space": "pre-wrap",
            "word-break": "break-all",
          }}
        >
          {daemonLog().length > 0
            ? daemonLog().join("\n")
            : logLoading()
            ? "Loading..."
            : "No daemon log available"}
        </pre>
      </div>
    </div>
  );
}
