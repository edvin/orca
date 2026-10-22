import { createSignal, onMount, onCleanup, For, Show, createEffect, createMemo } from "solid-js";
import VirtualLogList from "./VirtualLogList";
import { LogBuffer, FilteredView, createFrameBatcher } from "../lib/logBuffer";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { copyToClipboard } from "../lib/clipboard";

// Cap the combined in-memory buffer so following many containers at once
// can't grow unbounded.
const MAX_ENTRIES = 20_000;

interface MultiLogViewerProps {
  containers: Array<{ id: string; name: string }>;
  onClose: () => void;
}

const COLORS = [
  "#58a6ff",
  "#3fb950",
  "#d29922",
  "#f85149",
  "#bc8cff",
  "#79c0ff",
  "#56d364",
  "#e3b341",
];

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileHighlight(filter: string, isRegex: boolean, caseSensitive: boolean): RegExp | null {
  if (!filter) return null;
  const flags = caseSensitive ? "g" : "gi";
  const source = isRegex ? filter : escapeRegex(filter);
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function highlightLine(line: string, regex: RegExp | null): string {
  if (!regex) return escapeHtml(line);
  let out = "";
  let last = 0;
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > last) out += escapeHtml(line.slice(last, m.index));
    out += `<mark class="log-hl">${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) regex.lastIndex++;
  }
  if (last < line.length) out += escapeHtml(line.slice(last));
  return out;
}

interface LogEntry {
  containerId: string;
  containerName: string;
  line: string;
}

export default function MultiLogViewer(props: MultiLogViewerProps) {
  // Entries live in a plain capped buffer; `version` is bumped once per
  // applied batch so dependants re-run without copying the array.
  const buffer = new LogBuffer<LogEntry>(MAX_ENTRIES);
  const view = new FilteredView<LogEntry>();
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);
  const entryCount = () => {
    version();
    return buffer.length;
  };
  const [loading, setLoading] = createSignal(true);
  const [filter, setFilter] = createSignal("");
  const [useRegex, setUseRegex] = createSignal(false);
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [autoScroll, setAutoScroll] = createSignal(true);
  const [visibleContainers, setVisibleContainers] = createSignal<Set<string>>(
    new Set(props.containers.map((c) => c.id))
  );
  const [fontSize] = createSignal(
    parseInt(localStorage.getItem("log-font-size") || "13", 10)
  );
  // Reactive colorMap driven by a createEffect so adds/removes in
  // props.containers update in-place — existing containers keep their
  // assigned color, freed slots are reused for new ones. Previously this
  // was computed once from the initial prop snapshot, so any later change
  // caused later containers to render without a color.
  const [colorMap, setColorMap] = createSignal<Map<string, string>>(new Map());

  // Module-level for this component instance — flipped synchronously on
  // unmount so any in-flight async callback skips its state writes.
  let disposed = false;

  // Assign a stable color per container id. When props.containers changes,
  // preserve existing assignments and reuse released colors for new ids.
  createEffect(() => {
    const ids = props.containers.map((c) => c.id);
    const idSet = new Set(ids);
    setColorMap((prev) => {
      const next = new Map<string, string>();
      const used = new Set<string>();
      // Keep previous assignments for ids that still exist.
      for (const id of ids) {
        const existing = prev.get(id);
        if (existing) {
          next.set(id, existing);
          used.add(existing);
        }
      }
      // Assign from the first available color for new ids.
      for (const id of ids) {
        if (next.has(id)) continue;
        const free = COLORS.find((c) => !used.has(c)) ?? COLORS[next.size % COLORS.length];
        next.set(id, free);
        used.add(free);
      }
      return next;
    });
    // Also drop visibility entries for removed containers so the filter
    // doesn't include stale ids.
    setVisibleContainers((prev) => {
      const filtered = new Set<string>();
      for (const id of prev) if (idSet.has(id)) filtered.add(id);
      // Newly added containers default to visible.
      for (const id of ids) if (!prev.has(id)) filtered.add(id);
      return filtered;
    });
    // Drop entries from containers that have been removed.
    const kept = buffer.toArray().filter((e) => idSet.has(e.containerId));
    if (kept.length !== buffer.length) {
      buffer.reset(kept);
      bump();
    }
  });

  const colorFor = (id: string): string => colorMap().get(id) || COLORS[0];

  // Live lines arrive in batches per container (one event per ~50 ms each);
  // apply them at most once per frame.
  const incoming = createFrameBatcher<LogEntry>((raw) => {
    if (disposed) return;
    const newItems: LogEntry[] = [];
    for (const e of raw) {
      for (const l of e.line.replace(/\r/g, "").split("\n")) {
        const line = l.trimEnd();
        if (line.length > 0) newItems.push({ containerId: e.containerId, containerName: e.containerName, line });
      }
    }
    if (newItems.length === 0) return;
    buffer.push(newItems);
    bump();
  }, MAX_ENTRIES);

  // Subscribe per-container to the streaming log endpoint and merge incoming
  // lines into a single chronologically-appended store. This replaces the
  // 2s full-replacement polling that churned the DOM for every refresh.
  onMount(() => {
    let unlistens: UnlistenFn[] = [];
    let subscribedIds = new Set<string>();
    let refreshPending = false;

    onCleanup(() => {
      disposed = true;
      incoming.cancel();
      for (const u of unlistens) {
        try { u(); } catch {}
      }
      unlistens = [];
      for (const id of subscribedIds) {
        invoke("unsubscribe_container_logs", { id }).catch(() => {});
      }
      subscribedIds.clear();
    });

    const resubscribeAll = async () => {
      if (disposed) return;
      // Tear down any old subscriptions/listeners from a previous containers prop.
      for (const u of unlistens) { try { u(); } catch {} }
      unlistens = [];
      for (const id of subscribedIds) {
        invoke("unsubscribe_container_logs", { id }).catch(() => {});
      }
      subscribedIds = new Set();

      setLoading(true);
      const list = props.containers.slice();

      // Initial tail fetch per container — faster than waiting for each
      // to trickle in over SSE.
      const results = await Promise.allSettled(
        list.map((c) => invoke("container_logs", { id: c.id, tail: 200 }) as Promise<string[]>),
      );
      if (disposed) return;

      const allEntries: LogEntry[] = [];
      results.forEach((result, idx) => {
        if (result.status !== "fulfilled") return;
        const c = list[idx];
        for (const raw of result.value) {
          const cleaned = raw.replace(/\r/g, "").split("\n")
            .map((l) => l.trimEnd())
            .filter((l) => l.length > 0);
          for (const line of cleaned) {
            allEntries.push({ containerId: c.id, containerName: c.name, line });
          }
        }
      });
      // Replace the seed snapshot (we're starting fresh for this containers list).
      incoming.cancel();
      buffer.reset(allEntries);
      bump();
      setLoading(false);

      // Attach the event listener once and dispatch by containerId.
      const byId = new Map(list.map((c) => [c.id, c] as const));
      const unlisten = await listen<{ containerId: string; lines: string[] }>(
        "container-log-lines",
        (event) => {
          if (disposed) return;
          const c = byId.get(event.payload.containerId);
          if (!c) return;
          incoming.push(event.payload.lines.map((line) => ({ containerId: c.id, containerName: c.name, line })));
        },
      );
      if (disposed) {
        try { unlisten(); } catch {}
        return;
      }
      unlistens.push(unlisten);

      // Kick off streaming subscriptions.
      for (const c of list) {
        subscribedIds.add(c.id);
        invoke("subscribe_container_logs", { id: c.id, tail: 0 }).catch((e) => {
          console.error(`Failed to subscribe to logs for ${c.name}:`, e);
        });
      }
    };

    // Reactively refresh subscriptions when the set of containers changes.
    createEffect(() => {
      // Track props.containers identity (and length) to rebuild on change.
      const ids = props.containers.map((c) => c.id).join("\u0000");
      // Collapse rapid prop changes into one async rebuild.
      if (refreshPending) return;
      refreshPending = true;
      queueMicrotask(() => {
        refreshPending = false;
        if (disposed) return;
        resubscribeAll().catch((e) => console.error("MultiLogViewer resubscribe failed:", e));
      });
      // Read `ids` so Solid tracks it.
      void ids;
    });
  });

  // Expose a refresh hook for the toolbar button.
  const refreshLogs = async () => {
    if (disposed) return;
    setLoading(true);
    incoming.cancel();
    buffer.reset([]);
    bump();
    // Re-run the initial tail fetch for all currently-subscribed containers.
    const list = props.containers.slice();
    const results = await Promise.allSettled(
      list.map((c) => invoke("container_logs", { id: c.id, tail: 200 }) as Promise<string[]>),
    );
    if (disposed) return;
    const allEntries: LogEntry[] = [];
    results.forEach((result, idx) => {
      if (result.status !== "fulfilled") return;
      const c = list[idx];
      for (const raw of result.value) {
        const cleaned = raw.replace(/\r/g, "").split("\n")
          .map((l) => l.trimEnd())
          .filter((l) => l.length > 0);
        for (const line of cleaned) {
          allEntries.push({ containerId: c.id, containerName: c.name, line });
        }
      }
    });
    buffer.reset(allEntries);
    bump();
    setLoading(false);
  };

  // Entry predicate: visible container and, if set, the filter matching
  // the line or the container name (an invalid regex filters nothing).
  const matcher = createMemo((): ((e: LogEntry) => number) => {
    const visible = visibleContainers();
    const f = filter();
    let regex: RegExp | null = null;
    if (f) {
      try {
        const flags = caseSensitive() ? "" : "i";
        regex = useRegex() ? new RegExp(f, flags) : new RegExp(escapeRegex(f), flags);
      } catch {
        // Invalid regex
      }
    }
    return (e) =>
      visible.has(e.containerId) && (!regex || regex.test(e.line) || regex.test(e.containerName)) ? 1 : 0;
  });

  // Seqs of the entries that pass the predicate; while it is unchanged only
  // newly appended entries are tested.
  const filteredEntries = createMemo(
    () => {
      version();
      view.update(buffer, matcher());
      return view.seqs;
    },
    undefined,
    { equals: false },
  );

  const highlightRegex = createMemo(() =>
    compileHighlight(filter(), useRegex(), caseSensitive()),
  );


  const toggleContainer = (id: string) => {
    const next = new Set(visibleContainers());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setVisibleContainers(next);
  };

  const copyAll = () => {
    const text = filteredEntries()
      .map((seq) => {
        const e = buffer.at(seq);
        return `[${e.containerName}] ${e.line}`;
      })
      .join("\n");
    copyToClipboard(text);
  };

  const toggleBtnStyle = (active: boolean) => ({
    background: active ? "#388bfd30" : "transparent",
    color: active ? "#58a6ff" : "#8b949e",
    border: active ? "1px solid #388bfd" : "1px solid #30363d",
    "border-radius": "4px",
    padding: "2px 6px",
    cursor: "pointer",
    "font-size": "12px",
    "font-family": "'JetBrains Mono NF', monospace",
    "font-weight": "600",
    "line-height": "1",
    height: "26px",
    display: "inline-flex",
    "align-items": "center",
  });

  return (
    <div
      style={{
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        "z-index": "1000",
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        style={{
          background: "#0d1117",
          border: "1px solid #30363d",
          "border-radius": "8px",
          width: "90vw",
          height: "85vh",
          display: "flex",
          "flex-direction": "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "space-between",
            padding: "12px 16px",
            "border-bottom": "1px solid #21262d",
            background: "#161b22",
            "flex-shrink": "0",
          }}
        >
          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
            <span style={{ "font-weight": "600", color: "#e6edf3", "font-size": "14px" }}>
              Combined logs
            </span>
            <span style={{ "font-size": "12px", color: "#8b949e" }}>
              {filteredEntries().length} lines from {props.containers.length} containers
            </span>
          </div>
          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <div style={{ display: "inline-flex", "align-items": "center", gap: "4px" }}>
              <input
                class="search-input"
                style={{ width: "240px", "font-size": "12px" }}
                type="text"
                placeholder="Filter logs..."
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
              />
              <button
                onClick={() => setUseRegex(!useRegex())}
                title={useRegex() ? "Regex mode" : "Plain text mode"}
                style={toggleBtnStyle(useRegex())}
              >
                .*
              </button>
              <button
                onClick={() => setCaseSensitive(!caseSensitive())}
                title={caseSensitive() ? "Case sensitive" : "Case insensitive"}
                style={toggleBtnStyle(caseSensitive())}
              >
                Aa
              </button>
            </div>
            <button
              class={`btn btn-sm ${autoScroll() ? "btn-primary" : ""}`}
              onClick={() => setAutoScroll(!autoScroll())}
              style={{ "font-size": "12px" }}
            >
              Auto-scroll
            </button>
            <button class="action-icon" onClick={copyAll} title="Copy all logs">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            </button>
            <button class="action-icon" onClick={refreshLogs} title="Refresh">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
            </button>
            <button class="action-icon" onClick={() => props.onClose()} title="Close">
              {"\u2715"}
            </button>
          </div>
        </div>

        {/* Container checkboxes */}
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "12px",
            padding: "8px 16px",
            "border-bottom": "1px solid #21262d",
            background: "#161b22",
            "flex-wrap": "wrap",
            "flex-shrink": "0",
          }}
        >
          <For each={props.containers}>
            {(c) => {
              const color = () => colorFor(c.id);
              const isVisible = () => visibleContainers().has(c.id);
              return (
                <label
                  style={{
                    display: "inline-flex",
                    "align-items": "center",
                    gap: "6px",
                    cursor: "pointer",
                    "font-size": "12px",
                    color: isVisible() ? "#e6edf3" : "#484f58",
                    "user-select": "none",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isVisible()}
                    onChange={() => toggleContainer(c.id)}
                    style={{ "accent-color": color() }}
                  />
                  <span
                    style={{
                      width: "8px",
                      height: "8px",
                      "border-radius": "50%",
                      background: isVisible() ? color() : "#484f58",
                      "flex-shrink": "0",
                    }}
                  />
                  {c.name}
                </label>
              );
            }}
          </For>
        </div>

        {/* Log content */}
        <Show
          when={!loading() || entryCount() > 0}
          fallback={
            <div style={{ padding: "24px", color: "#8b949e", "text-align": "center" }}>
              Loading logs...
            </div>
          }
        >
          <VirtualLogList
            class="selectable"
            style={{
              flex: "1",
              padding: "8px 0",
              "font-family": "'JetBrains Mono NF', monospace",
            }}
            keys={filteredEntries()}
            textLength={(seq) => buffer.at(seq).line.length}
            fontSize={fontSize()}
            lineHeight={1.4}
            // Row margin + border + padding + name column + its margin.
            gutter={8 + 3 + 8 + 140 + 8}
            follow={autoScroll()}
            onScrolled={setAutoScroll}
            empty={
              <div style={{ padding: "24px", color: "#8b949e", "text-align": "center" }}>
                (no log output)
              </div>
            }
            renderRow={(seq) => {
              const entry = buffer.at(seq);
              const entryColor = () => colorFor(entry.containerId);
              return (
                <div class="multi-log-row" style={{ "border-left-color": entryColor() }}>
                  <span class="multi-log-name" style={{ color: entryColor() }} title={entry.containerName}>
                    {entry.containerName}
                  </span>
                  <span
                    class="multi-log-text"
                    // eslint-disable-next-line solid/no-innerhtml -- highlightLine produces pre-escaped HTML with safe <mark> tags
                    innerHTML={highlightLine(entry.line, highlightRegex())}
                  />
                </div>
              );
            }}
          />
        </Show>
      </div>
    </div>
  );
}
