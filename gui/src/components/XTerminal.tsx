import { createSignal, onMount, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

interface XTerminalProps {
  containerId: string;
  containerName: string;
}

export default function XTerminal(props: XTerminalProps) {
  let termDiv: HTMLDivElement | undefined;
  let termInstance: Terminal | undefined;
  let fitAddonInstance: FitAddon | undefined;
  const [fontSize, setFontSize] = createSignal(
    parseInt(localStorage.getItem("terminal-font-size") || "13", 10)
  );

  const changeFontSize = (delta: number) => {
    const next = Math.max(9, Math.min(24, fontSize() + delta));
    setFontSize(next);
    localStorage.setItem("terminal-font-size", String(next));
    if (termInstance) {
      termInstance.options.fontSize = next;
      fitAddonInstance?.fit();
    }
  };

  onMount(async () => {
    const term = new Terminal({
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#58a6ff",
        cursorAccent: "#0d1117",
        selectionBackground: "#1f6feb44",
        black: "#0d1117",
        red: "#f85149",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#e6edf3",
      },
      fontFamily: "'JetBrains Mono NF', 'SFMono-Regular', 'Menlo', 'Consolas', monospace",
      fontSize: fontSize(),
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      convertEol: true,
    });

    termInstance = term;
    const fitAddon = new FitAddon();
    fitAddonInstance = fitAddon;
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(termDiv!);
    fitAddon.fit();
    term.focus();

    // Read API token from config
    let token = "";
    try {
      token = await invoke("get_api_token") as string;
    } catch {
      // Token may not be configured (--no-auth mode)
    }

    // Connect WebSocket to daemon
    const wsUrl = `ws://127.0.0.1:9477/api/v1/containers/${encodeURIComponent(props.containerId)}/terminal?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      term.writeln(`\x1b[36mConnected to ${props.containerName}\x1b[0m`);

      // Send initial resize
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        ws.send(JSON.stringify({ cols: dims.cols, rows: dims.rows }));
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      } else {
        term.write(event.data);
      }
    };

    ws.onclose = () => {
      term.writeln("\r\n\x1b[90mConnection closed\x1b[0m");
    };

    ws.onerror = () => {
      term.writeln("\r\n\x1b[31mWebSocket error\x1b[0m");
    };

    // Terminal input -> WebSocket
    term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Handle resize
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ cols, rows }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    if (termDiv) resizeObserver.observe(termDiv);

    onCleanup(() => {
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    });
  });

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
      <div style={{ display: "flex", "align-items": "center", "justify-content": "flex-end", padding: "4px 8px", background: "#0d1117", "border-bottom": "1px solid #21262d", gap: "4px" }}>
        <div style={{ display: "flex", "align-items": "center", gap: "1px", background: "#21262d", "border-radius": "4px", padding: "0 2px" }}>
          <button class="action-icon" onClick={() => changeFontSize(-1)} title="Decrease font size" style={{ "font-size": "14px", "font-weight": "700", width: "24px" }}>&minus;</button>
          <span style={{ "font-size": "10px", color: "#8b949e", "min-width": "24px", "text-align": "center" }}>{fontSize()}</span>
          <button class="action-icon" onClick={() => changeFontSize(1)} title="Increase font size" style={{ "font-size": "14px", "font-weight": "700", width: "24px" }}>+</button>
        </div>
      </div>
      <div ref={termDiv} class="xterm-container" style={{ flex: "1" }} />
    </div>
  );
}
