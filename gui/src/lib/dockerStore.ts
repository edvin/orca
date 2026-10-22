import { createSignal, onMount, onCleanup, batch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import type { Container, ComposeProject, Image } from "./types";
import { startPoller, type Poller } from "./poller";
import { onOrcaEvent } from "./events";

// Lists that several parts of the app show at once (the sidebar counts, the
// dashboard, the containers and stacks pages) are fetched here once and
// shared, instead of each component running its own timer. Docker events
// refresh them right away, so the poll is only a safety net.
//
// Rows are reconciled by key, so a refresh only touches the rows that
// changed and keeps the rest of the table's DOM (and its hover or open
// menu state) as it is.

interface Shared<T> {
  /** Subscribe the calling component; the list is kept fresh while anyone is subscribed. */
  use(): {
    list: () => T[];
    error: () => string | null;
    loaded: () => boolean;
    /** When the list was last fetched successfully (ms since epoch). */
    updatedAt: () => number | null;
    refresh: () => Promise<void>;
  };
  /** Fetch now, e.g. right after the GUI changed something. */
  refresh(): Promise<void>;
  /** The current list without subscribing (it may be stale or empty). */
  peek(): T[];
}

function createShared<T>(opts: {
  command: string;
  key: string;
  intervalMs: number;
  /** Orca event types (`kind.type`) after which to refetch. */
  refetchOn: (type: string) => boolean;
}): Shared<T> {
  const [state, setState] = createStore<{ list: T[] }>({ list: [] });
  const [error, setError] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [updatedAt, setUpdatedAt] = createSignal<number | null>(null);
  let subscribers = 0;
  let poller: Poller | null = null;
  let unsubscribeEvents: (() => void) | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  // Fetches can overlap (a refresh during a poll); only the latest one lands.
  let seq = 0;

  const fetchList = async () => {
    const my = ++seq;
    try {
      const list = ((await invoke(opts.command)) as T[]) || [];
      if (my !== seq) return;
      batch(() => {
        setState("list", reconcile(list, { key: opts.key }));
        setError(null);
        setLoaded(true);
        setUpdatedAt(Date.now());
      });
    } catch (e) {
      // An empty message would read as "no error" and leave pages loading.
      if (my === seq) setError(String(e) || `${opts.command} failed`);
    }
  };

  const refresh = () => fetchList();

  document.addEventListener("orca-host-switch", () => {
    batch(() => {
      setState("list", []);
      setError(null);
      setLoaded(false);
      setUpdatedAt(null);
    });
    if (subscribers > 0) void refresh();
  });

  return {
    refresh,
    peek: () => state.list,
    use() {
      onMount(() => {
        if (subscribers++ === 0) {
          poller = startPoller(fetchList, opts.intervalMs);
          unsubscribeEvents = onOrcaEvent((payload: any) => {
            if (!opts.refetchOn(payload?.kind?.type ?? "")) return;
            // Bursts (a stack starting) refetch once.
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => void refresh(), 250);
          });
        }
      });
      onCleanup(() => {
        if (--subscribers === 0) {
          poller?.stop();
          poller = null;
          unsubscribeEvents?.();
          unsubscribeEvents = null;
        }
      });
      return { list: () => state.list, error, loaded, updatedAt, refresh };
    },
  };
}

const containerEvent = (type: string) => type.startsWith("Container");

export const containersStore = createShared<Container>({
  command: "list_containers",
  key: "id",
  intervalMs: 5_000,
  refetchOn: containerEvent,
});

export const stacksStore = createShared<ComposeProject>({
  command: "list_stacks",
  key: "name",
  intervalMs: 5_000,
  refetchOn: containerEvent,
});

export const imagesStore = createShared<Image>({
  command: "list_images",
  key: "id",
  intervalMs: 60_000,
  refetchOn: (type) => type.startsWith("Image"),
});
