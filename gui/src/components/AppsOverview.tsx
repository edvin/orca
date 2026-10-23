// The top of the dashboard: the apps on this machine (compose stacks) with
// their HTTPS URLs, grouped by where they come from (the team workspace, a
// project's worktrees, the rest), or, on a fresh install, the ways to get
// started. Apps can be pinned to the top or hidden; that's remembered here.

import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { ComposeProject, GatewayRoute } from "../lib/types";
import type { DevProject } from "../lib/dev";
import type { WorkspaceStatus } from "../lib/workspace";
import { stackUrls } from "../lib/stackUrls";
import { iconSrc, stackIcon } from "../lib/icons";
import AppIcon from "./AppIcon";
import { openFolderDialog } from "../lib/openFolder";
import { showToast } from "./Toast";

const svg = (children: JSX.Element) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">{children}</svg>
);
const ICON = {
  folder: () => svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  branch: () => svg(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9a6 6 0 0 1-6 6H6" /></>),
  pin: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z" /></svg>,
  hide: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3 3.9M6.3 6.3C3.9 8 2.5 12 2.5 12S6 19 12 19a9.6 9.6 0 0 0 5.7-1.7" /></svg>,
  chevron: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>,
  grid: () => svg(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>),
};

const openUrl = (url: string) => shellOpen(url).catch(() => window.open(url, "_blank", "noopener,noreferrer"));

/** A set of names kept in localStorage: pinned apps, hidden apps, folded groups. */
function storedSet(key: string) {
  const read = (): string[] => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "[]");
    } catch {
      return [];
    }
  };
  const [items, setItems] = createSignal<string[]>(read());
  const toggle = (name: string) => {
    const next = items().includes(name) ? items().filter((x) => x !== name) : [...items(), name];
    setItems(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* private window: remembered until Orca restarts */
    }
  };
  return { has: (name: string) => items().includes(name), toggle, count: () => items().length };
}

const pinned = storedSet("orca.apps.pinned");
const hidden = storedSet("orca.apps.hidden");
const folded = storedSet("orca.apps.folded");

/** One card: a stack, with the name it goes by in its group. */
interface App {
  stack: ComposeProject;
  title: string;
  sub?: string | null;
  /** Set by the workspace file; else the stack's routes and images pick one. */
  icon?: string | null;
}

interface Group {
  key: string;
  title: string;
  sub?: string;
  apps: App[];
  /** The workspace's shared services, as one compact row. */
  shared?: { stack: ComposeProject | null; running: number; total: number; urls: { title: string; url: string; icon?: string | null }[] };
}

export default function AppsOverview(props: {
  stacks: ComposeProject[];
  routes: GatewayRoute[];
  loaded: boolean;
  hasProjects: boolean;
  devProjects: DevProject[];
  workspace: WorkspaceStatus | null;
  onNavigate?: (target: string) => void;
}) {
  const [starting, setStarting] = createSignal<string | null>(null);
  const [showHidden, setShowHidden] = createSignal(false);
  const stacks = () => props.stacks.filter((s) => !s.name.startsWith("orca-"));
  const rank = (s: ComposeProject) => (s.status === "Running" ? 0 : s.status === "Partial" ? 1 : 2);
  const byState = (a: App, b: App) => rank(a.stack) - rank(b.stack) || a.title.localeCompare(b.title);
  const running = (s: ComposeProject) => s.services.filter((x) => x.state.toLowerCase() === "running").length;

  // Every stack lands in one group: the workspace's projects, a project's
  // worktree instances, or the rest. Pinned ones move to the top.
  const groups = createMemo<Group[]>(() => {
    const byName = new Map(stacks().map((s) => [s.name, s]));
    const placed = new Set<string>();
    const take = (name: string | null | undefined) => {
      const s = name ? byName.get(name) : undefined;
      if (!s || placed.has(s.name)) return null;
      placed.add(s.name);
      return s;
    };
    const out: Group[] = [];

    const ws = props.workspace;
    if (ws?.joined && ws.projects) {
      const shared = take(ws.shared?.name);
      const apps: App[] = [];
      for (const p of ws.projects) {
        const s = take(p.stack);
        if (s) apps.push({ stack: s, title: p.key, sub: p.description, icon: p.icon });
      }
      out.push({
        key: "workspace",
        title: ws.name ?? "Workspace",
        sub: "Workspace",
        apps,
        shared: shared || ws.shared || ws.shared_urls?.length
          ? {
              stack: shared,
              running: shared ? running(shared) : (ws.shared?.running ?? 0),
              total: shared ? shared.services.length : (ws.shared?.total ?? 0),
              urls: ws.shared_urls ?? [],
            }
          : undefined,
      });
    }

    // A worktree instance wears its project's icon from the workspace.
    const wsIcon = (id: string) => ws?.projects?.find((x) => x.key === id)?.icon ?? null;
    for (const p of props.devProjects) {
      const apps: App[] = [];
      for (const i of p.instances ?? []) {
        const s = take(i.compose_project);
        if (s) apps.push({ stack: s, title: i.branch ?? i.name, sub: i.is_main ? "main checkout" : null, icon: wsIcon(p.id) });
      }
      if (apps.length) out.push({ key: `project:${p.id}`, title: p.id, sub: "Worktrees", apps });
    }

    const rest = stacks().filter((s) => !placed.has(s.name)).map((s) => ({ stack: s, title: s.name }));
    if (rest.length) out.push({ key: "other", title: out.length ? "Other stacks" : "", apps: rest });

    const all = out.flatMap((g) => g.apps);
    const pins = all.filter((a) => pinned.has(a.stack.name));
    const visible = (a: App) => !pinned.has(a.stack.name) && (showHidden() || !hidden.has(a.stack.name));
    const result = out
      .map((g) => ({ ...g, apps: g.apps.filter(visible).sort(byState) }))
      .filter((g) => g.apps.length || g.shared);
    return pins.length ? [{ key: "pinned", title: "Pinned", apps: pins.sort(byState) }, ...result] : result;
  });
  const hiddenCount = () => stacks().filter((s) => hidden.has(s.name) && !pinned.has(s.name)).length;
  const any = () => stacks().length > 0 || !!props.workspace?.joined;

  const start = async (name: string) => {
    setStarting(name);
    try {
      await invoke("compose_up", { name });
      showToast(`${name} is starting`, "success");
    } catch (e) {
      showToast(`Could not start ${name}: ${e}`, "error");
    }
    setStarting(null);
  };

  const card = (a: App) => {
    const s = a.stack;
    const urls = () => stackUrls(s, props.routes);
    const stopped = () => s.status === "Stopped" || s.status === "Empty";
    return (
      <div class="app-card" classList={{ stopped: stopped(), "is-hidden": hidden.has(s.name) }}
        onClick={() => props.onNavigate?.(`stack:${s.name}`)} title={a.sub ? `${a.sub} · ${s.name}` : s.name}>
        <div class="app-card-head">
          <AppIcon src={iconSrc(a.icon) || stackIcon(s, props.routes)} name={a.title} size={26} />
          <b>{a.title}</b>
          <span class={`app-dot ${s.status.toLowerCase()}`} />
          <span class="app-card-count">{running(s)}/{s.services.length}</span>
          <span class="app-card-actions">
            <button class="app-card-act" classList={{ on: pinned.has(s.name) }}
              title={pinned.has(s.name) ? "Unpin" : "Pin to the top"}
              onClick={(e) => { e.stopPropagation(); pinned.toggle(s.name); }}>{ICON.pin()}</button>
            <button class="app-card-act" classList={{ on: hidden.has(s.name) }}
              title={hidden.has(s.name) ? "Show on the dashboard" : "Hide from the dashboard"}
              onClick={(e) => { e.stopPropagation(); hidden.toggle(s.name); }}>{ICON.hide()}</button>
          </span>
        </div>
        <div class="app-card-urls">
          <Show when={!stopped()} fallback={
            <button class="btn btn-sm btn-primary" disabled={starting() === s.name}
              onClick={(e) => { e.stopPropagation(); void start(s.name); }}>
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
  };

  const sharedRow = (sh: NonNullable<Group["shared"]>) => (
    <div class="apps-shared" onClick={() => sh.stack && props.onNavigate?.(`stack:${sh.stack.name}`)}>
      <span class={`app-dot ${sh.running === 0 ? "stopped" : sh.running < sh.total ? "partial" : "running"}`} />
      <b>Shared services</b>
      <span class="app-card-count">{sh.total ? `${sh.running}/${sh.total} running` : "not running"}</span>
      <span class="apps-shared-links">
        <For each={sh.urls.slice(0, 8)}>
          {(u) => (
            <button class="app-url app-url-icon" title={`Open ${u.url}`} onClick={(e) => { e.stopPropagation(); void openUrl(u.url); }}>
              <Show when={iconSrc(u.icon)}>{(src) => <img src={src()} alt="" />}</Show>
              {u.title}
            </button>
          )}
        </For>
        <Show when={sh.urls.length > 8}><span class="app-card-none">+{sh.urls.length - 8}</span></Show>
      </span>
    </div>
  );

  return (
    <Show when={props.loaded}>
      <Show when={any()} fallback={
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
            <Show when={hiddenCount() > 0}>
              <button class="apps-hidden-toggle" onClick={() => setShowHidden(!showHidden())}>
                {showHidden() ? "Leave out hidden apps" : `${hiddenCount()} hidden`}
              </button>
            </Show>
          </div>
          <For each={groups()}>
            {(g) => (
              <div class="apps-group">
                <Show when={g.title && groups().length > 1}>
                  <button class="apps-group-head" onClick={() => folded.toggle(g.key)}>
                    <span class="apps-group-chevron" classList={{ folded: folded.has(g.key) }}>{ICON.chevron()}</span>
                    <b>{g.title}</b>
                    <Show when={g.sub}><span class="apps-group-sub">{g.sub}</span></Show>
                    <span class="apps-group-count">
                      {g.apps.filter((a) => a.stack.status === "Running" || a.stack.status === "Partial").length}/{g.apps.length} running
                    </span>
                  </button>
                </Show>
                <Show when={!folded.has(g.key) || groups().length === 1}>
                  <Show when={g.shared}>{(sh) => sharedRow(sh())}</Show>
                  <Show when={g.apps.length} fallback={
                    <Show when={g.key === "workspace"}>
                      <button class="apps-group-empty" onClick={() => props.onNavigate?.("workspace")}>
                        No projects running yet. Set one up on the Workspace page.
                      </button>
                    </Show>
                  }>
                    <div class="apps-grid">
                      <For each={g.apps}>{card}</For>
                    </div>
                  </Show>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </Show>
  );
}
