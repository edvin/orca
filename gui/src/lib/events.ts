import { invoke } from "@tauri-apps/api/core";

export type EventCallback = (event: any) => void;

const listeners: EventCallback[] = [];

/** Register a callback for vessel events. Returns an unsubscribe function. */
export function onVesselEvent(callback: EventCallback): () => void {
  listeners.push(callback);
  return () => {
    const idx = listeners.indexOf(callback);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

/** Start the event subscription. Call once at app startup. */
export async function startEventSubscription() {
  try {
    // Dynamic import to avoid issues when running outside Tauri
    const { listen } = await import("@tauri-apps/api/event");
    await listen("vessel-event", (event) => {
      for (const cb of listeners) {
        try {
          cb(event.payload);
        } catch (e) {
          console.error("Event handler error:", e);
        }
      }
    });
    // Tell the Tauri backend to start streaming events from the daemon
    await invoke("subscribe_events");
  } catch (e) {
    console.warn("Event subscription failed (running outside Tauri?):", e);
  }
}
