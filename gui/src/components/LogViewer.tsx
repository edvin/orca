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
  let logContainer: HTMLPreElement | undefined;

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const result = (await invoke("container_logs", {
        id: props.containerId,
        tail: tail(),
      })) as string[];
      setLines(result.flatMap((l) => l.replace(/\r/g, "").split("\n")).map((l) => l.trimEnd()));
    } catch (e) {
      setLines([`Error fetching logs: ${e}`]);
    }
    setLoading(false);
  };

  onMount(() => {
    fetchLogs();
    // Poll for new logs every 2 seconds
    const interval = setInterval(fetchLogs, 2000);
    onCleanup(() => clearInterval(interval));
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
          <input
            class="search-input"
            style={{ width: "160px" }}
            type="text"
            placeholder="Filter logs..."
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
          <select
            class="log-select"
            value={tail()}
            onChange={(e) => {
              setTail(Number(e.currentTarget.value));
              fetchLogs();
            }}
          >
            <option value={100}>100 lines</option>
            <option value={500}>500 lines</option>
            <option value={2000}>2000 lines</option>
            <option value={10000}>10000 lines</option>
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
        >
          {filtered().join("\n") || "(no log output)"}
        </pre>
      </Show>
    </div>
  );
}
