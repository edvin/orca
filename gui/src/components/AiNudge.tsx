// A one-line invitation on the dashboard to connect an AI tool that's
// installed but doesn't have Orca yet. Gone once one is connected, or
// for good once dismissed.

import { createResource, createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

const DISMISSED = "orca.aiNudgeDismissed";

export default function AiNudge(props: { onNavigate?: (page: string) => void }) {
  const [dismissed, setDismissed] = createSignal((() => {
    try { return localStorage.getItem(DISMISSED) === "1"; } catch { return false; }
  })());
  const [clients] = createResource(
    () => !dismissed(),
    () => invoke<{ name: string; detected: boolean; connected: boolean }[]>("mcp_clients").catch(() => []),
  );
  const found = () => {
    const list = clients() ?? [];
    return list.some((c) => c.connected) ? [] : list.filter((c) => c.detected).map((c) => c.name);
  };
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISSED, "1"); } catch {}
  };

  return (
    <Show when={!dismissed() && found().length > 0}>
      <div class="ai-nudge">
        <span class="ai-nudge-icon">✦</span>
        <div class="ai-nudge-text">
          <b>Run Orca from {found().slice(0, 2).join(" or ")}</b>
          <span>Ask it to start projects, read logs or fix a failing container. One click, no tokens.</span>
        </div>
        <button class="btn btn-sm btn-primary" onClick={() => props.onNavigate?.("settings:ai")}>Connect</button>
        <button class="ai-nudge-close" title="Don't show again" onClick={dismiss}>×</button>
      </div>
    </Show>
  );
}
