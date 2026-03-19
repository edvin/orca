import { onMount, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

interface XTerminalProps {
  containerId: string;
  containerName: string;
}

export default function XTerminal(props: XTerminalProps) {
  let termDiv: HTMLDivElement | undefined;
  let term: Terminal;
  let fitAddon: FitAddon;
  let currentLine = "";
  let history: string[] = [];
  let historyIndex = -1;

  onMount(() => {
    term = new Terminal({
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
      fontFamily: "'SFMono-Regular', 'Menlo', 'Consolas', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termDiv!);
    fitAddon.fit();

    // Welcome message
    term.writeln(`\x1b[36mConnected to ${props.containerName}\x1b[0m`);
    term.writeln(`\x1b[90mType commands to execute inside the container\x1b[0m`);
    term.writeln("");
    writePrompt();

    // Handle input
    term.onData((data: string) => {
      switch (data) {
        case "\r": // Enter
          term.writeln("");
          if (currentLine.trim()) {
            history.unshift(currentLine);
            historyIndex = -1;
            executeCommand(currentLine);
          } else {
            writePrompt();
          }
          currentLine = "";
          break;
        case "\x7f": // Backspace
          if (currentLine.length > 0) {
            currentLine = currentLine.slice(0, -1);
            term.write("\b \b");
          }
          break;
        case "\x1b[A": // Up arrow
          if (historyIndex < history.length - 1) {
            historyIndex++;
            replaceCurrentLine(history[historyIndex]);
          }
          break;
        case "\x1b[B": // Down arrow
          if (historyIndex > 0) {
            historyIndex--;
            replaceCurrentLine(history[historyIndex]);
          } else if (historyIndex === 0) {
            historyIndex = -1;
            replaceCurrentLine("");
          }
          break;
        case "\x03": // Ctrl+C
          term.writeln("^C");
          currentLine = "";
          writePrompt();
          break;
        default:
          if (data >= " " || data === "\t") {
            currentLine += data;
            term.write(data);
          }
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    if (termDiv) resizeObserver.observe(termDiv);

    onCleanup(() => {
      resizeObserver.disconnect();
      term.dispose();
    });
  });

  const writePrompt = () => {
    term.write(`\x1b[32m$\x1b[0m `);
  };

  const replaceCurrentLine = (newLine: string) => {
    // Clear current line
    term.write("\r\x1b[K");
    writePrompt();
    term.write(newLine);
    currentLine = newLine;
  };

  const executeCommand = async (cmd: string) => {
    try {
      const result = await invoke("exec_container", {
        id: props.containerId,
        command: ["sh", "-c", cmd],
      }) as { exit_code: number; output: string };

      if (result.output) {
        // Write output, handling newlines properly
        const lines = result.output.split("\n");
        for (const line of lines) {
          if (line) term.writeln(line);
        }
      }

      if (result.exit_code !== 0) {
        term.writeln(`\x1b[31mexit code: ${result.exit_code}\x1b[0m`);
      }
    } catch (e) {
      term.writeln(`\x1b[31mError: ${e}\x1b[0m`);
    }
    writePrompt();
  };

  return (
    <div
      ref={termDiv}
      class="xterm-container"
    />
  );
}
