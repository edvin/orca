import { For, Show, onMount } from "solid-js";
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
  onMount(() => {
    markAllRead();
  });

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">Activity</h1>
        <div class="page-actions">
          <Show when={getEvents().length > 0}>
            <button class="btn btn-sm" onClick={clearEvents}>Clear</button>
          </Show>
        </div>
      </div>

      <Show
        when={getEvents().length > 0}
        fallback={
          <div class="empty">
            <div class="empty-title">No activity yet</div>
            <p>Container, image, and volume events will appear here as they happen.</p>
          </div>
        }
      >
        <div class="activity-timeline">
          <For each={getEvents()}>
            {(event) => (
              <div class="activity-event">
                <div class={`activity-event-icon ${severityClass(event.severity)}`}>
                  {eventIcon(event.type)}
                </div>
                <div class="activity-event-body">
                  <div class="activity-event-title">{event.title}</div>
                  <div class="activity-event-time">{relativeTime(event.timestamp)}</div>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
