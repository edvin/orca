// The top of the dashboard: the apps on this machine (compose stacks) with
// their HTTPS URLs, or, on a fresh install, the three ways to get started.

import { createSignal, For, Show, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { ComposeProject, GatewayRoute } from "../lib/types";
import { stackUrls } from "../lib/stackUrls";
import { openFolderDialog } from "../lib/openFolder";
import { showToast } from "./Toast";

const svg = (children: JSX.Element) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">{children}</svg>
);
const ICON = {
  folder: () => svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  branch: () => svg(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9a6 6 0 0 1-6 6H6" /></>),
  grid: () => svg(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>),
};

const openUrl = (url: string) => shellOpen(url).catch(() => window.open(url, "_blank", "noopener,noreferrer"));

export default function AppsOverview(props: {
  stacks: ComposeProject[];
  routes: GatewayRoute[];
  loaded: boolean;
  hasProjects: boolean;
  onNavigate?: (target: string) => void;
}) {
  const [starting, setStarting] = createSignal<string | null>(null);
  const apps = () => props.stacks.filter((s) => !s.name.startsWith("orca-")).sort((a, b) => {
    const rank = (s: ComposeProject) => (s.status === "Running" ? 0 : s.status === "Partial" ? 1 : 2);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  const running = (s: ComposeProject) => s.services.filter((x) => x.state.toLowerCase() === "running").length;

  const start = async (s: ComposeProject) => {
    setStarting(s.name);
    try {
      await invoke("compose_up", { name: s.name });
      showToast(`${s.name} is starting`, "success");
    } catch (e) {
      showToast(`Could not start ${s.name}: ${e}`, "error");
    }
    setStarting(null);
  };

  return (
    <Show when={props.loaded}>
      <Show when={apps().length > 0} fallback={
        <Show when={!props.hasProjects}>
          <div class="get-started">
            <div class="get-started-title">Get your first app running</div>
            <div class="get-started-sub">Orca runs compose projects with real HTTPS URLs, a copy per git worktree, and lets your AI tools drive it.</div>
            <div class="get-started-grid">
              <button class="get-started-card primary" onClick={() => openFolderDialog()}>
                <span class="get-started-icon">{ICON.folder()}</span>
                <b>Open a project folder</b>
                <span>A folder with a compose file. Orca starts it and shows its URLs.</span>
              </button>
              <button class="get-started-card" onClick={() => props.onNavigate?.("projects")}>
                <span class="get-started-icon">{ICON.branch()}</span>
                <b>Add a git repository</b>
                <span>Run every worktree of it side by side, each with its own URLs.</span>
              </button>
              <button class="get-started-card" onClick={() => props.onNavigate?.("workspace")}>
                <span class="get-started-icon">{svg(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h5v-6h4v6h5V9.5" /></>)}</span>
                <b>Join your team's workspace</b>
                <span>One repo sets up shared services, the gateway and every project.</span>
              </button>
              <button class="get-started-card" onClick={() => props.onNavigate?.("templates")}>
                <span class="get-started-icon">{ICON.grid()}</span>
                <b>Start from the catalog</b>
                <span>Postgres, Redis, Keycloak and more, in one click.</span>
              </button>
            </div>
          </div>
        </Show>
      }>
        <div class="apps-overview">
          <div class="apps-overview-head">
            <span>Your apps</span>
          </div>
          <div class="apps-grid">
            <For each={apps()}>
              {(s) => {
                const urls = () => stackUrls(s, props.routes);
                return (
                  <div class="app-card" classList={{ stopped: s.status === "Stopped" || s.status === "Empty" }}
                    onClick={() => props.onNavigate?.(`stack:${s.name}`)}>
                    <div class="app-card-head">
                      <span class={`app-dot ${s.status.toLowerCase()}`} />
                      <b>{s.name}</b>
                      <span class="app-card-count">{running(s)}/{s.services.length}</span>
                    </div>
                    <div class="app-card-urls">
                      <Show when={s.status !== "Stopped" && s.status !== "Empty"} fallback={
                        <button class="btn btn-sm btn-primary" disabled={starting() === s.name}
                          onClick={(e) => { e.stopPropagation(); void start(s); }}>
                          {starting() === s.name ? "Starting…" : "Start"}
                        </button>
                      }>
                        <For each={urls().slice(0, 2)} fallback={<span class="app-card-none">No HTTPS route yet</span>}>
                          {(u) => (
                            <button class="app-url" title={`Open ${u.url}`} onClick={(e) => { e.stopPropagation(); void openUrl(u.url); }}>
                              {u.url.replace(/^https:\/\//, "")}
                            </button>
                          )}
                        </For>
                        <Show when={urls().length > 2}><span class="app-card-none">+{urls().length - 2}</span></Show>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      </Show>
    </Show>
  );
}
