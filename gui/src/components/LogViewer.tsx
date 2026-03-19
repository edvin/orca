import { createSignal, onMount, onCleanup, Show, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { copyToClipboard } from "../lib/clipboard";

interface LogViewerProps {
  containerId: string;
  containerName: string;
  onClose: () => void;
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
      setLines(result.map((l) => l.replace(/\n$/, "")));
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
            {"\uD83D\uDCCB"}
          </button>
          <button class="action-icon" onClick={downloadLogs} title="Download logs">
            {"\u2B07\uFE0F"}
          </button>
          <button class="action-icon" onClick={fetchLogs} title="Refresh">
            {"\uD83D\uDD04"}
          </button>
          <button class="action-icon" onClick={props.onClose} title="Close">
            {"\u2715"}
          </button>
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
