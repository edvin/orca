import { createSignal, onMount, onCleanup, For, Show, createEffect, createMemo, untrack } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { copyToClipboard } from "../lib/clipboard";

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
    out += `<mark style="background:#d29922;color:#0d1117;border-radius:2px;padding:0 1px">${escapeHtml(m[0])}</mark>`;
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
  color: string;
}

export default function MultiLogViewer(props: MultiLogViewerProps) {
  const [entries, setEntries] = createSignal<LogEntry[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [filter, setFilter] = createSignal("");
  const [useRegex, setUseRegex] = createSignal(false);
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [autoScroll, setAutoScroll] = createSignal(true);
  const initialContainers = untrack(() => props.containers);
  const [visibleContainers, setVisibleContainers] = createSignal<Set<string>>(
    new Set(initialContainers.map((c) => c.id))
  );
  const [fontSize] = createSignal(
    parseInt(localStorage.getItem("log-font-size") || "13", 10)
  );
  let logContainer: HTMLDivElement | undefined;

  const colorMap = new Map<string, string>();
  initialContainers.forEach((c, i) => {
    colorMap.set(c.id, COLORS[i % COLORS.length]);
  });

  // Module-level for this component instance — flipped synchronously on
  // unmount so any in-flight fetch skips its state writes.
  let disposed = false;
  // Prevents a slow fetch from being re-issued every 2s before it finishes,
  // which used to let concurrent fetches race each other into setEntries.
  let inFlight = false;

  const fetchAllLogs = async () => {
    if (disposed) return;
    setLoading(true);
    try {
      const results = await Promise.allSettled(
        props.containers.map((c) =>
          invoke("container_logs", { id: c.id, tail: 200 }) as Promise<string[]>
        )
      );
      if (disposed) return;

      const allEntries: LogEntry[] = [];
      results.forEach((result, idx) => {
        if (result.status === "fulfilled") {
          const container = props.containers[idx];
          const color = colorMap.get(container.id) || COLORS[0];
          const logLines = result.value
            .flatMap((l) => l.replace(/\r/g, "").split("\n"))
            .map((l) => l.trimEnd())
            .filter((l) => l.length > 0);
          for (const line of logLines) {
            allEntries.push({
              containerId: container.id,
              containerName: container.name,
              line,
              color,
            });
          }
        }
      });

      setEntries(allEntries);
    } catch (e) {
      if (disposed) return;
      setEntries([{
        containerId: "",
        containerName: "Error",
        line: `Failed to fetch logs: ${e}`,
        color: "#f85149",
      }]);
    }
    if (!disposed) setLoading(false);
  };

  onMount(() => {
    onCleanup(() => {
      disposed = true;
    });
    fetchAllLogs();
    const interval = setInterval(() => {
      if (inFlight || disposed) return;
      inFlight = true;
      fetchAllLogs().finally(() => {
        inFlight = false;
      });
    }, 2000);
    onCleanup(() => clearInterval(interval));
  });

  createEffect(() => {
    if (autoScroll() && logContainer) {
      entries();
      requestAnimationFrame(() => {
        if (logContainer) {
          logContainer.scrollTop = logContainer.scrollHeight;
        }
      });
    }
  });

  const filteredEntries = () => {
    const visible = visibleContainers();
    const f = filter();
    let result = entries().filter((e) => visible.has(e.containerId));
    if (f) {
      try {
        const flags = caseSensitive() ? "" : "i";
        const regex = useRegex()
          ? new RegExp(f, flags)
          : new RegExp(escapeRegex(f), flags);
        result = result.filter((e) => regex.test(e.line) || regex.test(e.containerName));
      } catch {
        // Invalid regex
      }
    }
    return result;
  };

  const highlightRegex = createMemo(() =>
    compileHighlight(filter(), useRegex(), caseSensitive()),
  );

  const handleScroll = () => {
    if (!logContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = logContainer;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  };

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
      .map((e) => `[${e.containerName}] ${e.line}`)
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
              Combined Logs
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
              onClick={() => {
                setAutoScroll(!autoScroll());
                if (!autoScroll() && logContainer) {
                  logContainer.scrollTop = logContainer.scrollHeight;
                }
              }}
              style={{ "font-size": "12px" }}
            >
              Auto-scroll
            </button>
            <button class="action-icon" onClick={copyAll} title="Copy all logs">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            </button>
            <button class="action-icon" onClick={fetchAllLogs} title="Refresh">
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
              const color = colorMap.get(c.id) || COLORS[0];
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
                    style={{ "accent-color": color }}
                  />
                  <span
                    style={{
                      width: "8px",
                      height: "8px",
                      "border-radius": "50%",
                      background: isVisible() ? color : "#484f58",
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
          when={!loading() || entries().length > 0}
          fallback={
            <div style={{ padding: "24px", color: "#8b949e", "text-align": "center" }}>
              Loading logs...
            </div>
          }
        >
          <div
            ref={logContainer}
            onScroll={handleScroll}
            style={{
              flex: "1",
              overflow: "auto",
              padding: "8px 0",
              "font-size": `${fontSize()}px`,
            }}
          >
            <Show when={filteredEntries().length > 0} fallback={
              <div style={{ padding: "24px", color: "#8b949e", "text-align": "center", "font-family": "'JetBrains Mono NF', monospace" }}>
                (no log output)
              </div>
            }>
              <For each={filteredEntries()}>
                {(entry) => {
                  return (
                    <div
                      style={{
                        display: "flex",
                        "font-family": "'JetBrains Mono NF', monospace",
                        "font-size": `${fontSize()}px`,
                        "line-height": "1.4",
                        "border-left": `3px solid ${entry.color}`,
                        "margin-left": "8px",
                        "padding-left": "8px",
                      }}
                    >
                      <span
                        style={{
                          color: entry.color,
                          "min-width": "140px",
                          "max-width": "140px",
                          "flex-shrink": "0",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                          "margin-right": "8px",
                          "font-size": "11px",
                          "padding-top": "1px",
                        }}
                        title={entry.containerName}
                      >
                        {entry.containerName}
                      </span>
                      <span
                        style={{
                          "white-space": "pre-wrap",
                          "word-break": "break-all",
                          flex: "1",
                        }}
                        {...(highlightRegex()
                          ? { innerHTML: highlightLine(entry.line, highlightRegex()) }
                          : { textContent: entry.line }
                        )}
                      />
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
