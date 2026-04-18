import { createSignal } from "solid-js";
import { showToast } from "../components/Toast";
import { formatBytes } from "./format";

export interface MetricSnapshot {
  timestamp: number;
  cpu: number;
  memory: number;
  memoryLimit: number;
  networkRx: number;
  networkTx: number;
}

const MAX_POINTS = 60;
// Metrics for a container whose most recent snapshot is older than this are
// considered stale and opportunistically pruned on the next recordMetrics()
// call. This guarantees the history map is bounded even when the user
// never opens the Dashboard (which is the only page wiring
// `pruneMetricsExcept`).
const STALE_AFTER_MS = 10 * 60 * 1000;
const [metricsHistory, setMetricsHistory] = createSignal<Record<string, MetricSnapshot[]>>({});

// --- Resource usage alerts ---
const MEMORY_THRESHOLD_PERCENT = 90;
const CPU_THRESHOLD_PERCENT = 90;
const CPU_CONSECUTIVE_READINGS = 3;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Track last alert time per container+metric to avoid spam
const lastAlertTime: Record<string, number> = {};
// Track consecutive high-CPU readings per container
const highCpuStreak: Record<string, number> = {};

function canAlert(key: string): boolean {
  const now = Date.now();
  const last = lastAlertTime[key];
  if (last && now - last < ALERT_COOLDOWN_MS) return false;
  lastAlertTime[key] = now;
  return true;
}

function evaluateAlerts(containerId: string, containerName: string, snapshot: MetricSnapshot) {
  // Memory alert: only when a limit is set
  if (snapshot.memoryLimit > 0) {
    const memPercent = (snapshot.memory / snapshot.memoryLimit) * 100;
    if (memPercent > MEMORY_THRESHOLD_PERCENT) {
      const key = `${containerId}:memory`;
      if (canAlert(key)) {
        showToast(
          `Container '${containerName}' is using ${Math.round(memPercent)}% of its memory limit (${formatBytes(snapshot.memory)} / ${formatBytes(snapshot.memoryLimit)})`,
          "info"
        );
      }
    }
  }

  // CPU alert: must exceed threshold for N consecutive readings
  if (snapshot.cpu > CPU_THRESHOLD_PERCENT) {
    highCpuStreak[containerId] = (highCpuStreak[containerId] || 0) + 1;
  } else {
    highCpuStreak[containerId] = 0;
  }

  if (highCpuStreak[containerId] >= CPU_CONSECUTIVE_READINGS) {
    const key = `${containerId}:cpu`;
    if (canAlert(key)) {
      showToast(
        `Container '${containerName}' CPU usage is at ${snapshot.cpu.toFixed(1)}% (sustained high usage)`,
        "info"
      );
    }
  }
}

export function recordMetrics(containerId: string, snapshot: MetricSnapshot, containerName?: string) {
  const cutoff = Date.now() - STALE_AFTER_MS;
  const staleIds: string[] = [];
  setMetricsHistory((prev) => {
    // Opportunistically drop history for any container whose most recent
    // snapshot is older than the staleness window. This covers the case
    // where a user never visits the Dashboard — otherwise a
    // MetricSnapshot[] would accumulate per distinct short-lived container
    // id for the lifetime of the session.
    const next: Record<string, MetricSnapshot[]> = {};
    for (const [id, hist] of Object.entries(prev)) {
      if (id === containerId) continue; // re-added below
      const lastTs = hist.length > 0 ? hist[hist.length - 1].timestamp : 0;
      if (lastTs >= cutoff) {
        next[id] = hist;
      } else {
        staleIds.push(id);
      }
    }
    const existing = prev[containerId] || [];
    next[containerId] = [...existing, snapshot].slice(-MAX_POINTS);
    return next;
  });

  // Drop the paired alert-tracking state for any ids we just pruned so
  // `lastAlertTime` / `highCpuStreak` can't leak after history is gone.
  if (staleIds.length > 0) {
    const stale = new Set(staleIds);
    for (const k of Object.keys(lastAlertTime)) {
      const id = k.split(":")[0];
      if (stale.has(id)) delete lastAlertTime[k];
    }
    for (const k of Object.keys(highCpuStreak)) {
      if (stale.has(k)) delete highCpuStreak[k];
    }
  }

  // Evaluate resource alerts after recording
  evaluateAlerts(containerId, containerName || containerId.slice(0, 12), snapshot);
}

export function getMetricsHistory(containerId: string): MetricSnapshot[] {
  return metricsHistory()[containerId] || [];
}

export function getCpuHistory(containerId: string): number[] {
  return getMetricsHistory(containerId).map((s) => s.cpu);
}

export function getMemoryHistory(containerId: string): number[] {
  return getMetricsHistory(containerId).map((s) =>
    s.memoryLimit > 0 ? (s.memory / s.memoryLimit) * 100 : 0
  );
}

export function getAllContainerIds(): string[] {
  return Object.keys(metricsHistory());
}

export function getAggregatedCpuHistory(): number[] {
  const history = metricsHistory();
  const ids = Object.keys(history);
  if (ids.length === 0) return [];

  const maxLen = Math.max(...ids.map((id) => history[id].length));
  const result: number[] = [];
  for (let i = 0; i < maxLen; i++) {
    let sum = 0;
    for (const id of ids) {
      const arr = history[id];
      const idx = arr.length - maxLen + i;
      if (idx >= 0) sum += arr[idx].cpu;
    }
    result.push(sum);
  }
  return result;
}

export function getAggregatedMemoryHistory(): number[] {
  const history = metricsHistory();
  const ids = Object.keys(history);
  if (ids.length === 0) return [];

  const maxLen = Math.max(...ids.map((id) => history[id].length));
  const result: number[] = [];
  for (let i = 0; i < maxLen; i++) {
    let sum = 0;
    for (const id of ids) {
      const arr = history[id];
      const idx = arr.length - maxLen + i;
      if (idx >= 0) sum += arr[idx].memory;
    }
    result.push(sum);
  }
  return result;
}

// --- Dashboard chart helpers (return {time, value}[] for TimeChart) ---

export function getDashboardCpuHistory(): Array<{ time: number; value: number }> {
  const history = metricsHistory();
  const ids = Object.keys(history);
  if (ids.length === 0) return [];

  const maxLen = Math.max(...ids.map((id) => history[id].length));
  // Use timestamps from the longest array as reference
  const longestId = ids.reduce((a, b) => (history[a].length >= history[b].length ? a : b));
  const refArr = history[longestId];
  const result: Array<{ time: number; value: number }> = [];
  for (let i = 0; i < maxLen; i++) {
    let sum = 0;
    for (const id of ids) {
      const arr = history[id];
      const idx = arr.length - maxLen + i;
      if (idx >= 0) sum += arr[idx].cpu;
    }
    const refIdx = refArr.length - maxLen + i;
    const time = refIdx >= 0 ? refArr[refIdx].timestamp : Date.now();
    result.push({ time, value: sum });
  }
  return result;
}

export function getDashboardMemHistory(): Array<{ time: number; value: number }> {
  const history = metricsHistory();
  const ids = Object.keys(history);
  if (ids.length === 0) return [];

  const maxLen = Math.max(...ids.map((id) => history[id].length));
  const longestId = ids.reduce((a, b) => (history[a].length >= history[b].length ? a : b));
  const refArr = history[longestId];
  const result: Array<{ time: number; value: number }> = [];
  for (let i = 0; i < maxLen; i++) {
    let sum = 0;
    for (const id of ids) {
      const arr = history[id];
      const idx = arr.length - maxLen + i;
      if (idx >= 0) sum += arr[idx].memory;
    }
    const refIdx = refArr.length - maxLen + i;
    const time = refIdx >= 0 ? refArr[refIdx].timestamp : Date.now();
    result.push({ time, value: sum });
  }
  return result;
}

export function getPerContainerCpuChartHistory(): Record<string, Array<{ time: number; value: number }>> {
  const history = metricsHistory();
  const result: Record<string, Array<{ time: number; value: number }>> = {};
  for (const [id, snapshots] of Object.entries(history)) {
    result[id] = snapshots.map((s) => ({ time: s.timestamp, value: s.cpu }));
  }
  return result;
}

export function getPerContainerMemChartHistory(): Record<string, Array<{ time: number; value: number }>> {
  const history = metricsHistory();
  const result: Record<string, Array<{ time: number; value: number }>> = {};
  for (const [id, snapshots] of Object.entries(history)) {
    result[id] = snapshots.map((s) => ({ time: s.timestamp, value: s.memory }));
  }
  return result;
}

export function clearAllMetrics() {
  setMetricsHistory({});
  for (const k of Object.keys(lastAlertTime)) delete lastAlertTime[k];
  for (const k of Object.keys(highCpuStreak)) delete highCpuStreak[k];
}

/**
 * Drop metrics for containers that are no longer present. Call this from a
 * single place (e.g. the Dashboard after it reconciles the container list)
 * so dead IDs don't leak memory across a long session.
 */
export function pruneMetricsExcept(liveIds: Iterable<string>) {
  const keep = new Set(liveIds);
  setMetricsHistory((prev) => {
    const next: Record<string, MetricSnapshot[]> = {};
    for (const [id, hist] of Object.entries(prev)) {
      if (keep.has(id)) next[id] = hist;
    }
    return next;
  });
  for (const k of Object.keys(lastAlertTime)) {
    const id = k.split(":")[0];
    if (!keep.has(id)) delete lastAlertTime[k];
  }
  for (const k of Object.keys(highCpuStreak)) {
    if (!keep.has(k)) delete highCpuStreak[k];
  }
}
