import { batch, createSignal, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { hiddenInterval, startPoller, type Poller } from "./poller";
import type { SystemHealth } from "./types";

// One `system_health` poll for the whole app. The Titlebar, StatusBar,
// Dashboard and Machine page all read from here instead of running their
// own timers: each call costs the daemon a ping and several host probes.
const POLL_MS = 15_000;
const TIMEOUT_MS = 15_000;

const [health, setHealth] = createSignal<SystemHealth | null>(null);
const [healthError, setHealthError] = createSignal<string | null>(null);

let subscribers = 0;
let poller: Poller | null = null;
let inflight: Promise<void> | null = null;

function fetchHealth(refresh: boolean): Promise<void> {
  return new Promise<SystemHealth>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`system_health timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
    invoke("system_health", { refresh })
      .then((v) => { clearTimeout(t); resolve(v as SystemHealth); })
      .catch((e) => { clearTimeout(t); reject(e); });
  })
    .then((h) => batch(() => { setHealth(h); setHealthError(null); }))
    .catch((e) => { setHealthError(String(e)); });
}

/**
 * Fetch health now. Calls made while a fetch is running share it.
 * `recomputeDisk` asks the daemon to recompute the engine's disk usage,
 * which it otherwise reuses for several minutes.
 */
export function refreshHealth(opts?: { recomputeDisk?: boolean }): Promise<void> {
  if (inflight && !opts?.recomputeDisk) return inflight;
  const p: Promise<void> = fetchHealth(!!opts?.recomputeDisk).finally(() => {
    if (inflight === p) inflight = null;
  });
  inflight = p;
  return p;
}

/** Subscribe the calling component to the shared poll; it runs while anyone is subscribed. */
export function useHealth() {
  onMount(() => {
    subscribers++;
    // keeps running, slowly, while hidden, so the figures on screen when the window is shown are at most a few minutes old
    if (!poller) poller = startPoller(() => refreshHealth(), POLL_MS, { hiddenMs: hiddenInterval(POLL_MS) });
    onCleanup(() => {
      subscribers--;
      if (subscribers === 0 && poller) {
        poller.stop();
        poller = null;
      }
    });
  });
  return { health, healthError };
}

// A different host has different health: drop the old one and fetch at once.
document.addEventListener("orca-host-switch", () => {
  batch(() => { setHealth(null); setHealthError(null); });
  if (subscribers > 0) refreshHealth();
});
