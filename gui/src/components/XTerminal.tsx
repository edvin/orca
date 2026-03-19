import { onMount, onCleanup } from "solid-js";
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
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
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

  return <div ref={termDiv} class="xterm-container" />;
}
