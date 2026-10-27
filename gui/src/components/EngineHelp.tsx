// When Orca's engine doesn't come up (macOS: its Lima VM): the VM's console,
// live, and a way to hand the problem to Claude Code or Codex with
// everything Orca knows. Reads files directly through Tauri, so it works on
// the connection screen too, while the daemon is down.

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { showToast } from "./Toast";

interface Diagnosis {
  dir: string;
  prompt: string;
}

export default function EngineHelp(props: { problem: string }) {
  const isMac = navigator.platform.includes("Mac");
  const [vm, setVm] = createSignal<string | null>(null);
  const [consoleText, setConsoleText] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [diagnosis, setDiagnosis] = createSignal<Diagnosis | null>(null);
  let consoleEl: HTMLPreElement | undefined;

  const poll = async () => {
    try {
      const r = await invoke<{ vm: string | null; text: string | null }>("vm_console");
      setVm(r.vm);
      const atBottom = !consoleEl || consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 24;
      setConsoleText(r.text);
      if (atBottom) requestAnimationFrame(() => consoleEl && (consoleEl.scrollTop = consoleEl.scrollHeight));
    } catch { /* not in Tauri */ }
  };
  onMount(() => {
    void poll();
    const t = setInterval(() => { if (!document.hidden) void poll(); }, 2000);
    onCleanup(() => clearInterval(t));
  });

  // A fresh diagnosis each time: what Orca knows now.
  const diagnose = async () => {
    const d = await invoke<Diagnosis>("vm_diagnosis", { problem: props.problem });
    setDiagnosis(d);
    return d;
  };

  const ask = async (tool: "claude" | "codex") => {
    setBusy(tool);
    try {
      const d = await diagnose();
      await invoke("ask_ai_about_engine", { tool, dir: d.dir });
      showToast(`${tool === "claude" ? "Claude Code" : "Codex"} opens in Terminal with what Orca knows`, "success");
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const openFolder = async () => {
    setBusy("folder");
    try {
      const d = await diagnose();
      await shellOpen(d.dir);
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const copyPrompt = async () => {
    try {
      const d = diagnosis() ?? (await diagnose());
      await navigator.clipboard.writeText(`${d.prompt}\n\nThe folder: ${d.dir}`);
      showToast("Copied: paste it into Claude, Codex or another AI tool", "success");
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  return (
    <div class="engine-help">
      <Show when={vm()}>
        <div class="engine-help-head">
          <b>The VM's console</b>
          <span>Where its boot shows, live. Empty: Linux in it hasn't printed anything yet.</span>
        </div>
        <pre class="engine-help-console selectable" ref={(el) => (consoleEl = el)}>
          {consoleText()?.trim() ? consoleText() : "(nothing on the console)"}
        </pre>
      </Show>
      <div class="engine-help-head" style={{ "margin-top": vm() ? "14px" : "0" }}>
        <b>Ask an AI tool</b>
        <span>
          Orca writes what it knows (its logs, the VM's logs, config and console, what runs, free space) to a folder and
          starts the tool there. It asks before changing anything.
        </span>
      </div>
      <div class="engine-help-actions">
        <Show when={isMac}>
          <button class="btn btn-sm" disabled={!!busy()} onClick={() => void ask("claude")}>
            {busy() === "claude" ? "Gathering…" : "Ask Claude Code"}
          </button>
          <button class="btn btn-sm" disabled={!!busy()} onClick={() => void ask("codex")}>
            {busy() === "codex" ? "Gathering…" : "Ask Codex"}
          </button>
        </Show>
        <button class="btn btn-sm" disabled={!!busy()} onClick={() => void openFolder()}>
          {busy() === "folder" ? "Gathering…" : "Open what Orca knows"}
        </button>
        <button class="btn btn-sm" disabled={!!busy()} onClick={() => void copyPrompt()}>Copy prompt</button>
      </div>
    </div>
  );
}
