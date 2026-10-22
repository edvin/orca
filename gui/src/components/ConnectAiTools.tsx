// "Connect your AI tools": one click adds Orca's MCP server to Claude Code,
// Claude Desktop, Cursor, VS Code, Windsurf or Codex. Each runs `orca mcp`,
// which reads Orca's token itself, so no config holds a secret.

import { createResource, createSignal, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./Toast";

interface ClientStatus {
  id: string;
  name: string;
  detected: boolean;
  connected: boolean;
  config_path: string;
  after_connect: string | null;
}

/** A tile colour per tool, so the list scans quickly. */
const TILE: Record<string, [string, string]> = {
  "claude-code": ["#d97757", "C"],
  "claude-desktop": ["#d97757", "C"],
  cursor: ["#e6edf3", "Cu"],
  vscode: ["#3b8eea", "VS"],
  windsurf: ["#3fb9a8", "W"],
  codex: ["#a5d6ff", "Cx"],
};

const PROMPTS = [
  "Start the shop project and give me its URL",
  "Why does the api container keep restarting?",
  "Spin up my feature branch as its own instance with its own database",
  "Turn on the search profile for shop",
];

export default function ConnectAiTools(props: { compact?: boolean }) {
  const [clients, { refetch }] = createResource(() => invoke<ClientStatus[]>("mcp_clients"));
  const [busy, setBusy] = createSignal<string | null>(null);
  const [showManual, setShowManual] = createSignal(false);
  const [command] = createResource(showManual, () => invoke<string>("mcp_command").catch(() => "orca"));

  const connect = async (c: ClientStatus) => {
    setBusy(c.id);
    try {
      const next = await invoke<string>("mcp_connect", { client: c.id });
      showToast(`${c.name} is connected to Orca. ${next}`, "success");
    } catch (e) {
      showToast(`Could not connect ${c.name}: ${e}`, "error");
    }
    setBusy(null);
    await refetch();
  };
  const disconnect = async (c: ClientStatus) => {
    setBusy(c.id);
    try {
      await invoke("mcp_disconnect", { client: c.id });
      showToast(`Removed Orca from ${c.name}`, "info");
    } catch (e) {
      showToast(String(e), "error");
    }
    setBusy(null);
    await refetch();
  };
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(() => showToast(`${what} copied`, "success"), () => {});

  const visible = () => (clients() ?? []).filter((c) => !props.compact || c.detected || c.connected);
  const manualJson = () => JSON.stringify({ mcpServers: { orca: { command: command() ?? "orca", args: ["mcp"] } } }, null, 2);

  return (
    <div class="ai-connect">
      <div class="ai-connect-head">
        <div>
          <div class="ai-connect-title">Connect your AI tools</div>
          <div class="ai-connect-sub">
            Claude and other AI tools can then run, inspect and fix your containers, stacks and worktree instances. One click, no
            API keys or tokens: they run Orca's own <span class="mono">orca mcp</span>.
          </div>
        </div>
      </div>

      <div class="ai-connect-list">
        <For each={visible()} fallback={<div class="ai-connect-empty">Looking for AI tools…</div>}>
          {(c) => {
            const [color, letter] = TILE[c.id] ?? ["#8b949e", c.name[0]];
            return (
              <div class="ai-client" classList={{ connected: c.connected, missing: !c.detected && !c.connected }}>
                <div class="ai-client-tile" style={{ color, "border-color": `${color}55`, background: `${color}14` }}>{letter}</div>
                <div class="ai-client-body">
                  <div class="ai-client-name">{c.name}</div>
                  <div class="ai-client-state">
                    {c.connected ? "Connected" : c.detected ? "Found on this computer" : "Not installed"}
                  </div>
                </div>
                <Show when={c.connected} fallback={
                  <button class="btn btn-sm btn-primary" disabled={!c.detected || busy() === c.id} onClick={() => void connect(c)}
                    title={c.detected ? `Add Orca to ${c.config_path}` : `${c.name} isn't installed`}>
                    {busy() === c.id ? "Connecting…" : "Connect"}
                  </button>
                }>
                  <span class="ai-client-check" title={c.after_connect ?? ""}>✓</span>
                  <button class="btn btn-sm" disabled={busy() === c.id} onClick={() => void disconnect(c)}>Disconnect</button>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      <Show when={!props.compact}>
        <div class="ai-connect-try">
          <div class="ai-connect-label">Then ask, for example</div>
          <div class="ai-prompts">
            <For each={PROMPTS}>{(p) => <button class="ai-prompt" onClick={() => copy(p, "Prompt")}>“{p}”</button>}</For>
          </div>
        </div>

        <button class="ai-connect-more" onClick={() => setShowManual(!showManual())}>
          {showManual() ? "Hide the manual setup" : "Another MCP client? Add it by hand"}
        </button>
        <Show when={showManual()}>
          <div class="ai-connect-manual">
            <p>Any MCP client that starts stdio servers can run Orca. No token needed:</p>
            <pre class="mono">{manualJson()}</pre>
            <button class="btn btn-sm" onClick={() => copy(manualJson(), "Config")}>Copy</button>
            <p class="ai-connect-note">
              From a terminal: <span class="mono">orca mcp install</span> connects every tool it finds. Add
              <span class="mono"> --host &lt;name&gt;</span> to the command to manage a remote host instead.
            </p>
          </div>
        </Show>
      </Show>
    </div>
  );
}
