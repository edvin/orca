import { createSignal, onMount, onCleanup, Show, createEffect, For, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { copyToClipboard } from "../lib/clipboard";
import Dropdown from "./Dropdown";

interface LogViewerProps {
  containerId: string;
  containerName: string;
  onClose?: () => void;
}

// Cap the in-memory log buffer so a long-running follow doesn't grow
// unbounded and freeze the renderer.
const MAX_LINES = 20_000;

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

/**
 * Compile a case-/regex-config'd highlight pattern once. Returns null when
 * the filter is empty or the user-supplied regex fails to compile.
 *
 * The pattern uses a non-capturing-but-anchored alternation so user
 * capturing groups can't shift the parity of `split()` results — the
 * previous implementation relied on odd-indexed chunks being matches,
 * which a pattern like `(foo|bar)` could break.
 */
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
  // Reset lastIndex — regex is reused across many calls.
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > last) out += escapeHtml(line.slice(last, m.index));
    out += `<mark style="background:#d29922;color:#0d1117;border-radius:2px;padding:0 1px">${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
    // Guard against zero-length matches spinning forever.
    if (m[0].length === 0) regex.lastIndex++;
  }
  if (last < line.length) out += escapeHtml(line.slice(last));
  return out;
}

function countMatches(lines: string[], filter: string, isRegex: boolean, caseSensitive: boolean): number {
  if (!filter) return 0;
  try {
    const flags = caseSensitive ? "g" : "gi";
    const regex = isRegex ? new RegExp(filter, flags) : new RegExp(escapeRegex(filter), flags);
    let count = 0;
    for (const line of lines) {
      const matches = line.match(regex);
      if (matches) count += matches.length;
    }
    return count;
  } catch {
    return 0;
  }
}

export default function LogViewer(props: LogViewerProps) {
  const [lines, setLines] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [autoScroll, setAutoScroll] = createSignal(true);
  const [filter, setFilter] = createSignal("");
  const [useRegex, setUseRegex] = createSignal(false);
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [tail, setTail] = createSignal(500);
  const [fontSize, setFontSize] = createSignal(
    parseInt(localStorage.getItem("log-font-size") || "13", 10)
  );
  let logContainer: HTMLDivElement | undefined;
  let filterRef: HTMLInputElement | undefined;

  const changeFontSize = (delta: number) => {
    const next = Math.max(9, Math.min(24, fontSize() + delta));
    setFontSize(next);
    localStorage.setItem("log-font-size", String(next));
  };

  const processLines = (raw: string[]): string[] =>
    raw
      .flatMap((l) => l.replace(/\r/g, "").split("\n"))
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const result = (await invoke("container_logs", {
        id: props.containerId,
        tail: tail(),
      })) as string[];
      setLines(processLines(result));
    } catch (e) {
      setLines([`Error fetching logs: ${e}`]);
    }
    setLoading(false);
  };

  // Only intercept Ctrl/Cmd+F when the keydown target is inside our own
  // log container — otherwise we hijack find from every other pane,
  // including xterm and the YAML editor.
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!((e.ctrlKey || e.metaKey) && e.key === "f")) return;
    const target = e.target as Node | null;
    if (!logContainer || !target || !logContainer.contains(target)) return;
    e.preventDefault();
    filterRef?.focus();
  };

  onMount(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    const containerId = props.containerId;

    // Register cleanup synchronously so the onCleanup survives the async
    // fetchLogs().then(...) chain.
    onCleanup(() => {
      disposed = true;
      try { unlisten?.(); } catch {}
      invoke("unsubscribe_container_logs", { id: props.containerId }).catch(() => {});
      document.removeEventListener("keydown", handleKeyDown);
    });

    fetchLogs().then(async () => {
      if (disposed) return;
      unlisten = await listen<{ containerId: string; line: string }>(
        "container-log-line",
        (event) => {
          if (disposed) return;
          if (event.payload.containerId === containerId) {
            const newLines = processLines([event.payload.line]);
            if (newLines.length > 0) {
              setLines((prev) => {
                const combined = [...prev, ...newLines];
                return combined.length > MAX_LINES ? combined.slice(-MAX_LINES) : combined;
              });
            }
          }
        }
      );
      if (disposed) {
        try { unlisten(); } catch {}
        unlisten = null;
        return;
      }

      invoke("subscribe_container_logs", {
        id: containerId,
        tail: 0,
      }).catch((e) => {
        console.error("Failed to subscribe to log stream:", e);
      });
    });

    document.addEventListener("keydown", handleKeyDown);
  });

  createEffect(() => {
    // Auto-scroll to bottom when new lines arrive
    if (autoScroll() && logContainer) {
      lines(); // track dependency
      requestAnimationFrame(() => {
        if (logContainer) {
          logContainer.scrollTop = logContainer.scrollHeight;
        }
      });
    }
  });

  const filtered = () => {
    const f = filter();
    let result = lines();
    if (f) {
      try {
        const flags = caseSensitive() ? "" : "i";
        const regex = useRegex()
          ? new RegExp(f, flags)
          : new RegExp(escapeRegex(f), flags);
        result = result.filter((l) => regex.test(l));
      } catch {
        // Invalid regex, fall back to no filtering
      }
    }
    // Remove consecutive empty lines
    return result.filter((line, i, arr) => {
      if (line.trim() === "" && i > 0 && arr[i - 1].trim() === "") return false;
      return true;
    });
  };

  const matchCount = () => {
    if (!filter()) return 0;
    return countMatches(filtered(), filter(), useRegex(), caseSensitive());
  };

  // Memoize the compiled highlight regex so we don't rebuild it per rendered
  // line — the previous version called `new RegExp` on every `<For>` row.
  const highlightRegex = createMemo(() =>
    compileHighlight(filter(), useRegex(), caseSensitive()),
  );

  const handleScroll = () => {
    if (!logContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = logContainer;
    // If user scrolled up more than 50px from bottom, disable auto-scroll
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  };

  const copyAll = () => {
    const text = filtered().join("\n");
    copyToClipboard(text);
  };

  const downloadLogs = () => {
    const text = filtered().join("\n");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = props.containerName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${safeName}-${timestamp}.log`;

    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const reloadLogs = async () => {
    // Unsubscribe, re-fetch, re-subscribe
    await invoke("unsubscribe_container_logs", { id: props.containerId }).catch(() => {});
    await fetchLogs();
    invoke("subscribe_container_logs", {
      id: props.containerId,
      tail: 0,
    }).catch((e) => {
      console.error("Failed to re-subscribe to log stream:", e);
    });
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
    <div class="log-viewer">
      <div class="log-header">
        <div class="log-header-left">
          <span class="log-title">Logs: {props.containerName}</span>
          <span class="log-count">{filtered().length} lines</span>
        </div>
        <div class="log-header-right">
          <div style={{ position: "relative", display: "inline-flex", "align-items": "center", gap: "4px" }}>
            <input
              ref={filterRef}
              class="search-input"
              style={{ width: "320px", "padding-right": "28px" }}
              type="text"
              placeholder="Filter logs... (Ctrl+F)"
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
            <Show when={filter().length > 0}>
              <button
                class="search-clear-btn"
                onClick={() => setFilter("")}
                title="Clear filter"
                type="button"
              >
                &times;
              </button>
            </Show>
            <button
              onClick={() => setUseRegex(!useRegex())}
              title={useRegex() ? "Regex mode (click to switch to plain text)" : "Plain text mode (click to switch to regex)"}
              style={toggleBtnStyle(useRegex())}
            >
              .*
            </button>
            <button
              onClick={() => setCaseSensitive(!caseSensitive())}
              title={caseSensitive() ? "Case sensitive (click for insensitive)" : "Case insensitive (click for sensitive)"}
              style={toggleBtnStyle(caseSensitive())}
            >
              Aa
            </button>
            <Show when={filter().length > 0}>
              <span style={{ "font-size": "11px", color: "#8b949e", "white-space": "nowrap" }}>
                {matchCount()} matches
              </span>
            </Show>
          </div>
          <Dropdown
            value={String(tail())}
            options={[
              { value: "100", label: "100 lines" },
              { value: "500", label: "500 lines" },
              { value: "2000", label: "2,000 lines" },
              { value: "10000", label: "10,000 lines" },
            ]}
            onChange={(v) => {
              setTail(Number(v));
              reloadLogs();
            }}
            style={{ width: "120px", "font-size": "12px" }}
          />
          <button
            class={`btn btn-sm ${autoScroll() ? "btn-primary" : ""}`}
            onClick={() => {
              setAutoScroll(!autoScroll());
              if (!autoScroll() && logContainer) {
                logContainer.scrollTop = logContainer.scrollHeight;
              }
            }}
          >
            Auto-scroll
          </button>
          <div style={{ display: "flex", "align-items": "center", gap: "1px", background: "#21262d", "border-radius": "4px", padding: "0 2px" }}>
            <button class="action-icon" onClick={() => changeFontSize(-1)} title="Decrease font size" style={{ "font-size": "14px", "font-weight": "700", width: "24px" }}>&minus;</button>
            <span style={{ "font-size": "10px", color: "#8b949e", "min-width": "24px", "text-align": "center" }}>{fontSize()}</span>
            <button class="action-icon" onClick={() => changeFontSize(1)} title="Increase font size" style={{ "font-size": "14px", "font-weight": "700", width: "24px" }}>+</button>
          </div>
          <button class="action-icon" onClick={copyAll} title="Copy all logs">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
          </button>
          <button class="action-icon" onClick={downloadLogs} title="Download logs">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="action-icon" onClick={reloadLogs} title="Refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          </button>
          <Show when={props.onClose}>
            <button class="action-icon" onClick={() => props.onClose?.()} title="Close">
              {"\u2715"}
            </button>
          </Show>
        </div>
      </div>
      <Show
        when={!loading() || lines().length > 0}
        fallback={
          <div class="log-loading">Loading logs...</div>
        }
      >
        <div
          class="log-content"
          ref={logContainer}
          onScroll={handleScroll}
          style={{ "font-size": `${fontSize()}px`, overflow: "auto" }}
        >
          <Show when={filtered().length > 0} fallback={
            <div style={{ "font-family": "'JetBrains Mono NF', monospace", "font-size": `${fontSize()}px`, color: "#8b949e", padding: "8px" }}>
              (no log output)
            </div>
          }>
            <For each={filtered()}>
              {(line) => {
                const regex = highlightRegex();
                if (regex) {
                  return (
                    <div
                      style={{
                        "font-family": "'JetBrains Mono NF', monospace",
                        "font-size": `${fontSize()}px`,
                        "white-space": "pre-wrap",
                        "word-break": "break-all",
                        "line-height": "1.4",
                      }}
                      // eslint-disable-next-line solid/no-innerhtml -- highlightLine produces pre-escaped HTML with safe <mark> tags
                      innerHTML={highlightLine(line, regex)}
                    />
                  );
                }
                return (
                  <div
                    style={{
                      "font-family": "'JetBrains Mono NF', monospace",
                      "font-size": `${fontSize()}px`,
                      "white-space": "pre-wrap",
                      "word-break": "break-all",
                      "line-height": "1.4",
                    }}
                  >
                    {line}
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}
