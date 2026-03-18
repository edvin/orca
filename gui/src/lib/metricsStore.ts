import { createSignal } from "solid-js";

export interface MetricSnapshot {
  timestamp: number;
  cpu: number;
  memory: number;
  memoryLimit: number;
  networkRx: number;
  networkTx: number;
}

const MAX_POINTS = 60;
const [metricsHistory, setMetricsHistory] = createSignal<Record<string, MetricSnapshot[]>>({});

export function recordMetrics(containerId: string, snapshot: MetricSnapshot) {
  setMetricsHistory((prev) => {
    const existing = prev[containerId] || [];
    const updated = [...existing, snapshot].slice(-MAX_POINTS);
    return { ...prev, [containerId]: updated };
  });
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
