import { createSignal, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ContainerStats } from "./types";
import { hiddenInterval, startPoller, type Poller } from "./poller";
import { recordMetricsBatch } from "./metricsStore";
import { containersStore } from "./dockerStore";

// Stats of all running containers, fetched in one request for every view
// that shows them (dashboard, containers table) and recorded into the
// metrics history once per poll.
const POLL_MS = 5_000;

const [stats, setStats] = createSignal<Record<string, ContainerStats>>({});
let subscribers = 0;
let poller: Poller | null = null;

async function fetchStats() {
  try {
    const list = ((await invoke("all_container_stats")) as ContainerStats[]) || [];
    const byId: Record<string, ContainerStats> = {};
    for (const s of list) byId[s.container_id] = s;
    setStats(byId);
    const names = new Map(containersStore.peek().map((c) => [c.id, c.name]));
    const now = Date.now();
    recordMetricsBatch(
      list.map((s) => ({
        id: s.container_id,
        name: names.get(s.container_id),
        snapshot: {
          timestamp: now,
          cpu: s.cpu_percent,
          memory: s.memory_usage_bytes,
          memoryLimit: s.memory_limit_bytes,
          networkRx: s.network_rx_bytes,
          networkTx: s.network_tx_bytes,
        },
      })),
    );
  } catch {
    // Docker unreachable: keep the last figures; the lists show the error.
  }
}

document.addEventListener("orca-host-switch", () => {
  setStats({});
  poller?.now();
});

/** Subscribe the calling component to the shared stats poll. */
export function useContainerStats() {
  onMount(() => {
    // keeps running, slowly, while hidden: the metrics history and the CPU alert need readings without a hole
    if (subscribers++ === 0) poller = startPoller(fetchStats, POLL_MS, { hiddenMs: hiddenInterval(POLL_MS) });
  });
  onCleanup(() => {
    if (--subscribers === 0) {
      poller?.stop();
      poller = null;
    }
  });
  return { stats, refresh: () => poller?.now() };
}
