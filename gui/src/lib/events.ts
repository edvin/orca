import { invoke } from "@tauri-apps/api/core";

export type EventCallback = (event: unknown) => void;

// Using a Set so adding the same callback twice is a no-op and unsubscribe
// is O(1) — the previous array-based store allowed duplicates and was
// O(n) to remove.
const listeners = new Set<EventCallback>();

/** Register a callback for orca events. Returns an unsubscribe function. */
export function onOrcaEvent(callback: EventCallback): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

// Tracks the Tauri listener handle so we can unsubscribe when restarting.
let unlistenTauri: (() => void) | null = null;
let started = false;
let starting: Promise<void> | null = null;

/**
 * Start (or restart) the event subscription. Idempotent — repeat calls
 * reuse the existing subscription. To explicitly re-subscribe after the
 * daemon reconnects, call {@link restartEventSubscription} instead.
 */
export async function startEventSubscription(): Promise<void> {
  if (started) return;
  if (starting) return starting;
  starting = (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenTauri = await listen("orca-event", (event) => {
        for (const cb of Array.from(listeners)) {
          try {
            cb(event.payload);
          } catch (e) {
            console.error("Event handler error:", e);
          }
        }
      });
      // Tell the Tauri backend to start streaming events from the daemon.
      // `subscribe_events` is itself idempotent on the Rust side — it
      // cancels any previous SSE task before starting a new one.
      await invoke("subscribe_events");
      started = true;
    } catch (e) {
      console.warn("Event subscription failed (running outside Tauri?):", e);
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/** Tear down the current subscription, if any. */
export async function stopEventSubscription(): Promise<void> {
  if (unlistenTauri) {
    try {
      unlistenTauri();
    } catch (e) {
      console.warn("Failed to unlisten:", e);
    }
    unlistenTauri = null;
  }
  started = false;
}

/** Explicitly re-subscribe (used on daemon reconnect). */
export async function restartEventSubscription(): Promise<void> {
  await stopEventSubscription();
  await startEventSubscription();
}
