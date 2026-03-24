import { createSignal, onMount, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

interface K8sTerminalProps {
  podName: string;
  namespace: string;
}

export default function K8sTerminal(props: K8sTerminalProps) {
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
    if (termInstance && fitAddonInstance) {
      termInstance.options.fontSize = next;
      fitAddonInstance.fit();
    }
  };

  onMount(async () => {
    await document.fonts.ready;

    const term = new Terminal({
      theme: {
        background: "#0d1117",
        foreground: "#b8c0cc",
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
        white: "#b8c0cc",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#c9d1d9",
      },
      fontFamily: "'JetBrains Mono NF', 'JetBrains Mono', 'Menlo', 'Consolas', monospace",
      fontSize: fontSize(),
      lineHeight: 1.1,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      convertEol: false,
      allowProposedApi: true,
    });

    termInstance = term;
    const fitAddon = new FitAddon();
    fitAddonInstance = fitAddon;
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(termDiv!);

    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    term.focus();

    let token = "";
    try {
      token = await invoke("get_api_token") as string;
    } catch {
      // Token may not be configured
    }

    const wsUrl = `ws://127.0.0.1:9477/api/v1/k8s/pods/${encodeURIComponent(props.namespace)}/${encodeURIComponent(props.podName)}/terminal?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      term.writeln(`\x1b[36mConnected to pod ${props.podName}\x1b[0m`);
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

    term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

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
      <div class="log-header">
        <div class="log-header-left">
          <span class="log-title">Pod Terminal: {props.podName}</span>
        </div>
        <div class="log-header-right">
          <div style={{ display: "flex", "align-items": "center", gap: "1px", background: "#21262d", "border-radius": "4px", padding: "0 2px" }}>
            <button class="action-icon" onClick={() => changeFontSize(-1)} title="Decrease font size" style={{ "font-size": "14px", "font-weight": "700", width: "24px" }}>&minus;</button>
            <span style={{ "font-size": "10px", color: "#8b949e", "min-width": "24px", "text-align": "center" }}>{fontSize()}</span>
            <button class="action-icon" onClick={() => changeFontSize(1)} title="Increase font size" style={{ "font-size": "14px", "font-weight": "700", width: "24px" }}>+</button>
          </div>
        </div>
      </div>
      <div ref={termDiv} class="xterm-container" style={{ flex: "1" }} />
    </div>
  );
}
