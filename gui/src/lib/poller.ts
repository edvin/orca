import { onMount, onCleanup } from "solid-js";
import { appVisible, onVisibilityChange } from "./visibility";

export interface Poller {
  /** Run now (or once more right after the run in progress) and restart the interval. */
  now(): void;
  stop(): void;
}

export interface PollerOptions {
  immediate?: boolean;
  /**
   * Interval while the app is hidden; by default (`null`) the poll pauses and
   * catches up when the app is visible again. Only polls that should stay
   * current while hidden (stats for the metrics history and CPU alert, health)
   * keep running, usually at {@link hiddenInterval}.
   */
  hiddenMs?: number | null;
}

/**
 * A slow rate for a poll that keeps running while the app is hidden: twelve
 * times the visible one, between 1 and 5 minutes, which costs Docker next to
 * nothing.
 */
export function hiddenInterval(intervalMs: number): number {
  return Math.min(Math.max(intervalMs * 12, 60_000), 300_000);
}

/**
 * Run `fn` every `intervalMs`, counted from when the previous run finished,
 * so a slow daemon never gets overlapping requests. While the app is hidden
 * it pauses, or runs at `hiddenMs` when given, and runs once more as soon as
 * it is visible again if the visible interval has passed.
 */
export function startPoller(fn: () => unknown, intervalMs: number, opts?: PollerOptions): Poller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let stopped = false;
  let lastRun = 0;
  const hiddenMs = opts?.hiddenMs ?? null;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped) return;
    const every = appVisible() ? intervalMs : hiddenMs;
    if (every === null) return;
    timer = setTimeout(run, Math.max(0, lastRun + every - Date.now()));
  };

  const run = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = null;
    running = true;
    try {
      await fn();
    } catch {
      // Callers handle their own errors; a failed run must not stop the poll.
    } finally {
      running = false;
      lastRun = Date.now();
    }
    if (again) {
      again = false;
      void run();
    } else {
      schedule();
    }
  };

  const unsubscribe = onVisibilityChange((visible) => {
    if (running) return; // the run in progress schedules the next one at the new rate
    if (visible && Date.now() - lastRun >= intervalMs) void run();
    else schedule();
  });

  if (opts?.immediate === false) {
    lastRun = Date.now();
    schedule();
  } else {
    void run();
  }

  return {
    now: () => void run(),
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      unsubscribe();
    },
  };
}

/** {@link startPoller} for the lifetime of the calling component. */
export function usePoller(fn: () => unknown, intervalMs: number, opts?: PollerOptions): Poller {
  let poller: Poller | null = null;
  onMount(() => {
    poller = startPoller(fn, intervalMs, opts);
  });
  onCleanup(() => poller?.stop());
  return {
    now: () => poller?.now(),
    stop: () => poller?.stop(),
  };
}
