import { createSignal, onMount, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

const TERM_FONT = "'JetBrains Mono NF', Menlo, Monaco, 'Courier New', monospace";

// Load fonts for canvas rendering. We wait on document.fonts.ready so the
// browser's own font-loading pipeline is done before xterm measures its
// glyph metrics — previously xterm could lay out at Menlo dimensions and
// then paint in JetBrains, producing the off-screen cursor seen on macOS.
const fontFace = new FontFace("JetBrains Mono NF", "url(/fonts/JetBrainsMonoNerdFont-Regular.ttf)", { weight: "400", style: "normal" });
const fontFaceBold = new FontFace("JetBrains Mono NF", "url(/fonts/JetBrainsMonoNerdFont-Bold.ttf)", { weight: "700", style: "normal" });
try { document.fonts.add(fontFace); document.fonts.add(fontFaceBold); } catch (e) { console.warn("FontFace add failed:", e); }
const fontsReady = Promise.allSettled([fontFace.load(), fontFaceBold.load(), document.fonts.ready]);

interface XTerminalProps {
  containerId: string;
  containerName: string;
}

export default function XTerminal(props: XTerminalProps) {
  let termDiv: HTMLDivElement | undefined;
  let ws: WebSocket | undefined;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let canvasAddon: CanvasAddon | undefined;
  let observer: ResizeObserver | undefined;
  let resizeRaf = 0;
  let disposed = false;

  const [fontSize, setFontSize] = createSignal(
    parseInt(localStorage.getItem("terminal-font-size") || "14", 10)
  );

  const changeFontSize = (delta: number) => {
    const next = Math.max(9, Math.min(24, fontSize() + delta));
    setFontSize(next);
    localStorage.setItem("terminal-font-size", String(next));
    if (!term || !fitAddon) return;
    term.options.fontSize = next;
    // Tear down and reload the CanvasAddon: its glyph atlas is keyed to the
    // initial font size, so without this the underlying canvas keeps drawing
    // the old glyphs at the wrong size.
    try { canvasAddon?.dispose(); } catch {}
    canvasAddon = new CanvasAddon();
    term.loadAddon(canvasAddon);
    requestAnimationFrame(() => {
      if (disposed) return;
      try { fitAddon!.fit(); } catch {}
      try { term!.refresh(0, term!.rows - 1); } catch {}
    });
  };

  // Register cleanup SYNCHRONOUSLY on mount so async awaits later can't
  // detach us from Solid's owner. `disposed` is checked inside every async
  // callback before it touches the terminal.
  onMount(() => {
    onCleanup(() => {
      disposed = true;
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      try { observer?.disconnect(); } catch {}
      if (ws) {
        try {
          ws.onmessage = null;
          ws.onclose = null;
          ws.onerror = null;
          ws.onopen = null;
          ws.close();
        } catch {}
      }
      try { canvasAddon?.dispose(); } catch {}
      try { term?.dispose(); } catch {}
    });

    (async () => {
      await fontsReady;
      if (disposed) return;

      term = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily: TERM_FONT,
        fontSize: fontSize(),
        theme: {
          background: "#1a1b26",
          foreground: "#a9b1d6",
          cursor: "#c0caf5",
          cursorAccent: "#1a1b26",
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
      });

      fitAddon = new FitAddon();
      canvasAddon = new CanvasAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(canvasAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(termDiv!);
      try { fitAddon.fit(); } catch {}
      term.focus();

      const wsUrl = await invoke("get_daemon_ws_url", { path: `/containers/${encodeURIComponent(props.containerId)}/terminal` }) as string;
      if (disposed) return;

      ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        if (disposed || !term) return;
        term.writeln(`\x1b[36mConnected to ${props.containerName}\x1b[0m`);
        setTimeout(() => {
          if (!disposed && ws?.readyState === WebSocket.OPEN && term) {
            ws.send(JSON.stringify({ cols: term.cols, rows: term.rows }));
          }
        }, 200);
      };

      ws.onmessage = (event: MessageEvent) => {
        if (disposed || !term) return;
        if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data));
        } else {
          term.write(event.data);
        }
      };

      ws.onclose = () => { if (!disposed && term) term.writeln("\r\n\x1b[90mConnection closed\x1b[0m"); };
      ws.onerror = () => { if (!disposed && term) term.writeln("\r\n\x1b[31mWebSocket error\x1b[0m"); };

      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== "keydown" || !term) return true;
        if (e.ctrlKey && e.key === "c" && term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection());
          term.clearSelection();
          return false;
        }
        if (e.ctrlKey && e.key === "v") {
          navigator.clipboard.readText().then((text) => {
            if (!disposed && ws?.readyState === WebSocket.OPEN) {
              // Normalize \r\n → \r so pasted Windows text doesn't double-enter.
              const normalized = text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
              ws.send(new TextEncoder().encode(normalized));
            }
          });
          return false;
        }
        return true;
      });

      term.onData((data: string) => {
        if (!disposed && ws?.readyState === WebSocket.OPEN) {
          ws.send(new TextEncoder().encode(data));
        }
      });

      term.onResize(({ cols, rows }) => {
        if (!disposed && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ cols, rows }));
        }
      });

      // Debounce fits with requestAnimationFrame so rapid window resizes
      // don't trigger a full canvas re-render per pixel.
      observer = new ResizeObserver(() => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          if (!disposed) { try { fitAddon?.fit(); } catch {} }
        });
      });
      if (termDiv) observer.observe(termDiv);
    })().catch((e) => console.error("XTerminal init failed:", e));
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
