import { createSignal, onMount, onCleanup, Show, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { copyToClipboard } from "../lib/clipboard";

interface LogViewerProps {
  containerId: string;
  containerName: string;
  onClose?: () => void;
}

export default function LogViewer(props: LogViewerProps) {
  const [lines, setLines] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [autoScroll, setAutoScroll] = createSignal(true);
  const [filter, setFilter] = createSignal("");
  const [tail, setTail] = createSignal(500);
  const [fontSize, setFontSize] = createSignal(
    parseInt(localStorage.getItem("log-font-size") || "13", 10)
  );
  let logContainer: HTMLPreElement | undefined;
  let filterRef: HTMLInputElement | undefined;

  const changeFontSize = (delta: number) => {
    const next = Math.max(9, Math.min(24, fontSize() + delta));
    setFontSize(next);
    localStorage.setItem("log-font-size", String(next));
  };

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const result = (await invoke("container_logs", {
        id: props.containerId,
        tail: tail(),
      })) as string[];
      setLines(result
        .flatMap((l) => l.replace(/\r/g, "").split("\n"))
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
      );
    } catch (e) {
      setLines([`Error fetching logs: ${e}`]);
    }
    setLoading(false);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault();
      filterRef?.focus();
    }
  };

  onMount(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      clearInterval(interval);
      document.removeEventListener("keydown", handleKeyDown);
    });
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
    const q = filter().toLowerCase();
    let result = lines();
    if (q) {
      result = result.filter((l) => l.toLowerCase().includes(q));
    }
    // Remove consecutive empty lines
    return result.filter((line, i, arr) => {
      if (line.trim() === "" && i > 0 && arr[i - 1].trim() === "") return false;
      return true;
    });
  };

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

  return (
    <div class="log-viewer">
      <div class="log-header">
        <div class="log-header-left">
          <span class="log-title">Logs: {props.containerName}</span>
          <span class="log-count">{filtered().length} lines</span>
        </div>
        <div class="log-header-right">
          <div style={{ position: "relative", display: "inline-flex", "align-items": "center" }}>
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
          </div>
          <select
            class="form-input"
            style={{ width: "120px", "font-size": "12px", padding: "5px 32px 5px 8px" }}
            value={tail()}
            onChange={(e) => {
              setTail(Number(e.currentTarget.value));
              fetchLogs();
            }}
          >
            <option value={100}>100 lines</option>
            <option value={500}>500 lines</option>
            <option value={2000}>2,000 lines</option>
            <option value={10000}>10,000 lines</option>
          </select>
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
          <button class="action-icon" onClick={fetchLogs} title="Refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          </button>
          <Show when={props.onClose}>
            <button class="action-icon" onClick={props.onClose} title="Close">
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
        <pre
          class="log-content"
          ref={logContainer}
          onScroll={handleScroll}
          style={{ "font-size": `${fontSize()}px` }}
        >
          {filtered().join("\n") || "(no log output)"}
        </pre>
      </Show>
    </div>
  );
}
