import { createSignal } from "solid-js";

export interface ActivityEvent {
  id: string;
  timestamp: Date;
  type: string;
  title: string;
  detail?: string;
  severity: "info" | "success" | "warning" | "error";
}

const [events, setEvents] = createSignal<ActivityEvent[]>([]);
const [unreadCount, setUnreadCount] = createSignal(0);

let nextId = 0;

export function addEvent(event: Omit<ActivityEvent, "id" | "timestamp">) {
  const full: ActivityEvent = {
    ...event,
    id: String(nextId++),
    timestamp: new Date(),
  };
  setEvents((prev) => {
    const updated = [full, ...prev];
    if (updated.length > 200) updated.length = 200;
    return updated;
  });
  setUnreadCount((c) => c + 1);
}

export function getEvents() {
  return events();
}

export function getUnreadCount() {
  return unreadCount();
}

export function markAllRead() {
  setUnreadCount(0);
}

export function clearEvents() {
  setEvents([]);
  setUnreadCount(0);
}

/** Log an app-level error to the activity feed */
export function logError(title: string, detail?: string) {
  addEvent({ type: "app-error", title, detail, severity: "error" });
}

/** Log an app-level warning */
export function logWarning(title: string, detail?: string) {
  addEvent({ type: "app-warning", title, detail, severity: "warning" });
}

/** Log an app-level info event */
export function logInfo(title: string, detail?: string) {
  addEvent({ type: "app-info", title, detail, severity: "info" });
}
