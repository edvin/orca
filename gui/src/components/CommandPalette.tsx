// ⌘K: find anything (stacks, containers, images, projects, URLs) and run
// actions. Typing searches everything; with no query it shows the actions.

import { createSignal, onMount, onCleanup, For, Show, createMemo, createResource } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { showToast } from "./Toast";
import { confirmDanger } from "./ConfirmDialog";
import { containersStore, imagesStore, stacksStore } from "../lib/dockerStore";
import { devApi } from "../lib/dev";
import { openFolderDialog } from "../lib/openFolder";
import { requestIntent } from "../lib/pageIntent";
import { openContainerOn } from "../lib/containerTab";
import type { GatewayRoute } from "../lib/types";

interface Command {
  id: string;
  name: string;
  /** Shown dimmed after the name: a path, image, state. */
  hint?: string;
  icon: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  onClose: () => void;
  onNavigate: (page: string) => void;
  onOpenComposeWizard?: () => void;
  onShowShortcuts?: () => void;
}

const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";

/** 3: starts with the query, 2: a word starts with it, 1: contains it, 0.5: fuzzy, 0: no match. */
function score(text: string, q: string): number {
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 3;
  if (t.split(/[\s\-_/.:]+/).some((w) => w.startsWith(q))) return 2;
  if (t.includes(q)) return 1;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 0.5 : 0;
}

export default function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  const containers = containersStore.use().list;
  const stacks = stacksStore.use().list;
  const images = imagesStore.use().list;
  const [projects] = createResource(() => devApi.listProjects().catch(() => []));
  const [routes] = createResource(() => invoke<GatewayRoute[]>("gateway_list_routes").catch(() => [] as GatewayRoute[]));

  const run = (fn: () => void) => () => { props.onClose(); fn(); };
  const go = (target: string) => run(() => props.onNavigate(target));
  const intent = (page: string, action: string) => run(() => { requestIntent(page, action); props.onNavigate(page); });

  const actions: Command[] = [
    { id: "open-folder", name: "Open a project folder…", icon: "▤", category: "Actions", action: run(() => openFolderDialog()) },
    { id: "add-project", name: "Add a git repository for worktrees", icon: "⑂", category: "Actions", action: go("projects") },
    { id: "run", name: "Run a container…", icon: "▶", category: "Actions", action: intent("containers", "run") },
    { id: "pull", name: "Pull an image…", icon: "⤓", category: "Actions", action: go("images:pull") },
    { id: "build", name: "Build an image…", icon: "⚒", category: "Actions", action: intent("images", "build") },
    { id: "add-route", name: "Add a gateway route…", icon: "+", category: "Actions", action: intent("gateway", "add-route") },
    { id: "new-stack", name: "Create a stack from scratch…", icon: "☰", category: "Actions", action: run(() => props.onOpenComposeWizard?.()) },
    { id: "connect-ai", name: "Connect Claude or another AI tool", icon: "✦", category: "Actions", action: go("settings:ai") },
    { id: "gw-start", name: "Start the gateway", icon: "▶", category: "Actions", action: run(async () => {
      try {
        await invoke("gateway_start");
        showToast("Gateway started", "success");
      } catch (e) {
        showToast(`Failed to start gateway: ${e}`, "error");
      }
    }) },
    { id: "gw-stop", name: "Stop the gateway", icon: "■", category: "Actions", action: run(async () => {
      const ok = await confirmDanger({
        title: "Stop the gateway?",
        message: "Every https://*.localhost URL stops working until the gateway is started again.",
        confirmLabel: "Stop gateway",
      });
      if (!ok) return;
      try {
        await invoke("gateway_stop");
        showToast("Gateway stopped", "success");
      } catch (e) {
        showToast(`Failed to stop gateway: ${e}`, "error");
      }
    }) },
    { id: "stop-all", name: "Stop all containers", icon: "■", category: "Actions", action: run(async () => {
      const running = containers().filter((c) => c.state === "Running");
      if (running.length === 0) return showToast("No running containers", "info");
      const ok = await confirmDanger({
        title: `Stop ${running.length} running container${running.length !== 1 ? "s" : ""}?`,
        message: "Every running container on the active host is stopped. Work in progress may be lost.",
        confirmLabel: "Stop all",
      });
      if (!ok) return;
      let stopped = 0;
      for (const c of running) {
        try {
          await invoke("stop_container", { id: c.id });
          stopped++;
        } catch {
          // continue with the others
        }
      }
      showToast(`Stopped ${stopped} container${stopped !== 1 ? "s" : ""}`, "success");
    }) },
    { id: "shortcuts", name: "Keyboard shortcuts", icon: "⌨", category: "Actions", shortcut: "?", action: run(() => props.onShowShortcuts?.()) },
  ];

  const pages: Command[] = (
    [
      ["dashboard", "Dashboard"], ["projects", "Projects"], ["containers", "Containers"], ["images", "Images"],
      ["builds", "Builds"], ["volumes", "Volumes"], ["networks", "Networks"], ["gateway", "Gateway"],
      ["kubernetes", "Kubernetes"], ["templates", "App Catalog"], ["fleet", "Fleet (remote hosts)"],
      ["environment", "System Health"], ["activity", "Activity"], ["settings", "Settings"],
      ["settings:ai", "Settings → AI & agents"], ["settings:certificates", "Settings → Certificates"],
      ["settings:remote-hosts", "Settings → Remote hosts"], ["settings:schedules", "Settings → Schedules"],
      ["settings:auto-deploy", "Settings → Auto-deploy"],
    ] as const
  ).map(([target, label]) => ({ id: `go-${target}`, name: label, icon: "→", category: "Go to", action: go(target) }));

  // Things on this machine, searched as you type.
  const resources = createMemo<Command[]>(() => [
    ...stacks().map((s) => ({
      id: `stack-${s.name}`, name: s.name, hint: `stack · ${s.status.toLowerCase()}`, icon: "◫", category: "Stacks",
      action: go(`stack:${s.name}`),
    })),
    ...(routes() ?? []).filter((r) => r.enabled).map((r) => {
      const url = `https://${r.hostname}${(r.path ?? "").replace(/\*$/, "")}`;
      return {
        id: `url-${url}`, name: url.replace(/^https:\/\//, ""), hint: `open · ${r.container_name}`, icon: "↗", category: "URLs",
        action: run(() => void shellOpen(url).catch(() => window.open(url, "_blank", "noopener,noreferrer"))),
      };
    }),
    ...(projects() ?? []).map((p) => ({
      id: `project-${p.id}`, name: p.id, hint: `project · ${p.instances.length} worktree${p.instances.length === 1 ? "" : "s"}`, icon: "⑂",
      category: "Projects", action: go("projects"),
    })),
    ...containers().flatMap((c) => [
      { id: `ct-${c.id}`, name: c.name, hint: `${c.state.toLowerCase()} · ${c.image}`, icon: "▣", category: "Containers", action: go(`container:${c.id}`) },
      ...(c.state === "Running"
        ? [{ id: `sh-${c.id}`, name: `Shell in ${c.name}`, icon: ">_", category: "Containers", action: run(() => { openContainerOn("terminal"); props.onNavigate(`container:${c.id}`); }) }]
        : []),
    ]),
    ...images().flatMap((i) => i.repo_tags.filter((t) => t !== "<none>:<none>").map((t) => ({
      id: `img-${i.id}-${t}`, name: t, hint: "image", icon: "▨", category: "Images", action: go("images"),
    }))),
  ]);

  const filtered = createMemo<Command[]>(() => {
    const q = query().trim().toLowerCase();
    if (!q) return [...actions, ...pages];
    const ranked = (list: Command[], limit: number) =>
      list
        .map((c) => ({ c, s: Math.max(score(c.name, q), score(c.hint ?? "", q) * 0.6) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map((x) => x.c);
    // Each kind of resource gets a few rows, so one kind can't crowd out the rest.
    const found: Command[] = [];
    for (const cat of ["Stacks", "URLs", "Projects", "Containers", "Images"]) {
      found.push(...ranked(resources().filter((r) => r.category === cat), 5));
    }
    return [...ranked(actions, 6), ...found, ...ranked(pages, 5)];
  });

  // Grouped by category, in the order they come in.
  const groupedCommands = createMemo(() => {
    const groups: { category: string; commands: Command[] }[] = [];
    for (const cmd of filtered()) {
      let g = groups.find((x) => x.category === cmd.category);
      if (!g) groups.push((g = { category: cmd.category, commands: [] }));
      g.commands.push(cmd);
    }
    return groups;
  });
  // Keyboard order follows the groups as shown.
  const flat = () => groupedCommands().flatMap((g) => g.commands);
  const indexOf = (cmd: Command) => flat().indexOf(cmd);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    const items = flat();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[selectedIndex()]?.action();
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };

  onMount(() => {
    inputRef?.focus();
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  return (
    <div class="command-palette-overlay" data-own-escape onMouseDown={(e) => { (e.currentTarget as any).__mdOverlay = e.target === e.currentTarget; }} onClick={(e) => { if ((e.currentTarget as any).__mdOverlay && e.target === e.currentTarget) props.onClose(); (e.currentTarget as any).__mdOverlay = false; }}>
      <div class="command-palette">
        <input
          ref={inputRef}
          class="command-palette-input"
          type="text"
          placeholder="Search stacks, containers, images, URLs, or type a command…"
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setSelectedIndex(0);
          }}
        />
        <div class="command-palette-results">
          <For each={groupedCommands()}>
            {(group) => (
              <>
                <div class="command-group-header">{group.category}</div>
                <For each={group.commands}>
                  {(cmd) => (
                    <div
                      class={`command-item ${indexOf(cmd) === selectedIndex() ? "selected" : ""}`}
                      onClick={() => cmd.action()}
                      onMouseEnter={() => setSelectedIndex(indexOf(cmd))}
                    >
                      <span class="command-item-icon">{cmd.icon}</span>
                      <span class="command-item-name">{cmd.name}</span>
                      <Show when={cmd.hint}><span class="command-item-hint">{cmd.hint}</span></Show>
                      <Show when={cmd.shortcut}>
                        <span class="command-item-shortcut">{cmd.shortcut}</span>
                      </Show>
                    </div>
                  )}
                </For>
              </>
            )}
          </For>
          <Show when={filtered().length === 0}>
            <div class="command-palette-empty">Nothing matches “{query()}”</div>
          </Show>
        </div>
        <div class="command-palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>↵</kbd> to open</span><span><kbd>esc</kbd> to close</span>
          <span class="command-palette-foot-right"><kbd>{mod}K</kbd> anywhere</span>
        </div>
      </div>
    </div>
  );
}
