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
// Monotonically incremented on every stop/restart so a start() attempt
// that crosses a stop() boundary can detect it was cancelled mid-await and
// clean up its own listener handle instead of committing stale state.
let generation = 0;

/**
 * Start (or restart) the event subscription. Idempotent — repeat calls
 * reuse the existing subscription. To explicitly re-subscribe after the
 * daemon reconnects, call {@link restartEventSubscription} instead.
 */
export async function startEventSubscription(): Promise<void> {
  if (started) return;
  if (starting) return starting;
  const my = ++generation;
  starting = (async () => {
    let localUnlisten: (() => void) | null = null;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      if (my !== generation) return; // cancelled during dynamic import
      localUnlisten = await listen("orca-event", (event) => {
        for (const cb of Array.from(listeners)) {
          try {
            cb(event.payload);
          } catch (e) {
            console.error("Event handler error:", e);
          }
        }
      });
      if (my !== generation) {
        // stopEventSubscription() ran while we were awaiting listen().
        // Drop the handle we just got — nobody is going to consume these
        // events and committing `unlistenTauri` would shadow whatever the
        // next start() installs.
        try { localUnlisten(); } catch {}
        localUnlisten = null;
        return;
      }
      unlistenTauri = localUnlisten;
      // Tell the Tauri backend to start streaming events from the daemon.
      // `subscribe_events` is itself idempotent on the Rust side — it
      // cancels any previous SSE task before starting a new one.
      await invoke("subscribe_events");
      if (my !== generation) {
        // Cancelled while waiting on invoke(). Clean up our listener and
        // bail without flipping `started`.
        if (unlistenTauri === localUnlisten) {
          try { unlistenTauri(); } catch {}
          unlistenTauri = null;
        }
        return;
      }
      started = true;
    } catch (e) {
      console.warn("Event subscription failed (running outside Tauri?):", e);
      // If the listen() succeeded but invoke() (or anything after) threw,
      // don't leak the live listener handle.
      if (localUnlisten) {
        try { localUnlisten(); } catch {}
        if (unlistenTauri === localUnlisten) unlistenTauri = null;
      }
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/** Tear down the current subscription, if any. */
export async function stopEventSubscription(): Promise<void> {
  // Bump the generation first so any in-flight start() sees it's been
  // cancelled the next time it checks after an await.
  generation++;
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
