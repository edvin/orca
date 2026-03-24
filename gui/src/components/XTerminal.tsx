import { createSignal, onMount, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

const TERM_FONT = "'JetBrains Mono NF', Menlo, Monaco, 'Courier New', monospace";

// Load the Nerd Font via FontFace API for canvas rendering
const fontFace = new FontFace(
  "JetBrains Mono NF",
  "url(/fonts/JetBrainsMonoNerdFont-Regular.ttf)",
  { weight: "400", style: "normal" },
);
const fontFaceBold = new FontFace(
  "JetBrains Mono NF",
  "url(/fonts/JetBrainsMonoNerdFont-Bold.ttf)",
  { weight: "700", style: "normal" },
);
document.fonts.add(fontFace);
document.fonts.add(fontFaceBold);
const fontsReady = Promise.all([fontFace.load(), fontFaceBold.load()]).catch(() => {});

interface XTerminalProps {
  containerId: string;
  containerName: string;
}

export default function XTerminal(props: XTerminalProps) {
  let termDiv: HTMLDivElement | undefined;
  let termInstance: Terminal | undefined;
  let fitAddonInstance: FitAddon | undefined;
  const [fontSize, setFontSize] = createSignal(
    parseInt(localStorage.getItem("terminal-font-size") || "14", 10)
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
    await fontsReady;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: TERM_FONT,
      fontSize: fontSize(),
      theme: {
        background: "#1a1b26",
        foreground: "#a9b1d6",
        cursor: "#c0caf5",
        selectionBackground: "#33467c",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
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
    fitAddon.fit();
    term.focus();

    let token = "";
    try {
      token = await invoke("get_api_token") as string;
    } catch {}

    const wsUrl = `ws://127.0.0.1:9477/api/v1/containers/${encodeURIComponent(props.containerId)}/terminal?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      term.writeln(`\x1b[36mConnected to ${props.containerName}\x1b[0m`);
      const dims = { cols: term.cols, rows: term.rows };
      ws.send(JSON.stringify(dims));
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

    // Send terminal input as binary (preserves byte sequences)
    term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
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
          <span class="log-title">Terminal: {props.containerName}</span>
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
