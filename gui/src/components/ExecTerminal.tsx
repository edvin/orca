import { createSignal, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { copyToClipboard } from "../lib/clipboard";

interface ExecTerminalProps {
  containerId: string;
  containerName: string;
  onClose: () => void;
}

interface HistoryEntry {
  command: string;
  output: string;
  exitCode: number;
}

export default function ExecTerminal(props: ExecTerminalProps) {
  const [input, setInput] = createSignal("");
  const [history, setHistory] = createSignal<HistoryEntry[]>([]);
  const [running, setRunning] = createSignal(false);
  const [cmdHistory, setCmdHistory] = createSignal<string[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal(-1);
  let outputEl: HTMLDivElement | undefined;

  const runCommand = async () => {
    const cmd = input().trim();
    if (!cmd || running()) return;

    setRunning(true);
    setInput("");
    setCmdHistory((prev) => [cmd, ...prev]);
    setHistoryIndex(-1);

    try {
      // Split command respecting quotes
      const parts = parseCommand(cmd);
      const result = (await invoke("exec_container", {
        id: props.containerId,
        command: parts,
      })) as { exit_code: number; output: string };

      setHistory((prev) => [
        ...prev,
        {
          command: cmd,
          output: result.output,
          exitCode: result.exit_code,
        },
      ]);
    } catch (e) {
      setHistory((prev) => [
        ...prev,
        {
          command: cmd,
          output: `Error: ${e}`,
          exitCode: -1,
        },
      ]);
    }

    setRunning(false);
    requestAnimationFrame(() => {
      if (outputEl) outputEl.scrollTop = outputEl.scrollHeight;
    });
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      runCommand();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const hist = cmdHistory();
      const idx = historyIndex();
      if (idx < hist.length - 1) {
        const newIdx = idx + 1;
        setHistoryIndex(newIdx);
        setInput(hist[newIdx]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const idx = historyIndex();
      if (idx > 0) {
        const newIdx = idx - 1;
        setHistoryIndex(newIdx);
        setInput(cmdHistory()[newIdx]);
      } else if (idx === 0) {
        setHistoryIndex(-1);
        setInput("");
      }
    }
  };

  const copyLastOutput = () => {
    const hist = history();
    if (hist.length === 0) return;
    const last = hist[hist.length - 1];
    copyToClipboard(last.output);
  };

  return (
    <div class="exec-terminal">
      <div class="exec-header">
        <span class="exec-title">Exec: {props.containerName}</span>
        <div class="btn-group">
          <button
            class="btn btn-sm"
            onClick={copyLastOutput}
            disabled={history().length === 0}
            title="Copy last command output"
          >
            Copy Output
          </button>
          <button class="btn btn-sm" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
      <div class="exec-output" ref={outputEl}>
        <For each={history()}>
          {(entry) => (
            <div class="exec-entry">
              <div class="exec-prompt">
                <span class="exec-prompt-char">$</span> {entry.command}
              </div>
              <pre class="exec-result">{entry.output}</pre>
              {entry.exitCode !== 0 && (
                <div class="exec-exit-code">exit code: {entry.exitCode}</div>
              )}
            </div>
          )}
        </For>
        {history().length === 0 && (
          <div style={{ color: "#8b949e", padding: "8px 0" }}>
            Run commands inside the container. Try: ls, pwd, env, cat /etc/os-release
          </div>
        )}
      </div>
      <div class="exec-input-bar">
        <span class="exec-prompt-char">$</span>
        <input
          class="exec-input"
          type="text"
          placeholder={running() ? "Running..." : "Enter command..."}
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          disabled={running()}
          autofocus
        />
      </div>
    </div>
  );
}

/** Simple command parser that splits on spaces but respects quotes. */
function parseCommand(cmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (const ch of cmd) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " ") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);

  // If single word, wrap in sh -c for shell features (pipes, etc.)
  if (parts.length === 1 && (cmd.includes("|") || cmd.includes(">"))) {
    return ["sh", "-c", cmd];
  }

  return parts;
}
