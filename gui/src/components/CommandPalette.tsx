import { createSignal, onMount, onCleanup, For, Show, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./Toast";
import { confirmDanger } from "./ConfirmDialog";
import { t } from "../i18n";

interface Command {
  id: string;
  name: string;
  icon: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  onClose: () => void;
  onNavigate: (page: string) => void;
  onOpenComposeWizard?: () => void;
}

export default function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  const navCategory = t("components.command.navigation");
  const commands: Command[] = [
    // Navigation
    { id: "nav-dashboard", name: t("components.command.goTo", { page: t("components.sidebar.dashboard") }), icon: "\u25A4", category: navCategory, shortcut: "", action: () => { props.onNavigate("dashboard"); props.onClose(); } },
    { id: "nav-containers", name: t("components.command.goTo", { page: t("components.sidebar.containers") }), icon: "\u25A3", category: navCategory, action: () => { props.onNavigate("containers"); props.onClose(); } },
    { id: "nav-images", name: t("components.command.goTo", { page: t("components.sidebar.images") }), icon: "\u25A8", category: navCategory, action: () => { props.onNavigate("images"); props.onClose(); } },
    { id: "nav-volumes", name: t("components.command.goTo", { page: t("components.sidebar.volumes") }), icon: "\u25CE", category: navCategory, action: () => { props.onNavigate("volumes"); props.onClose(); } },
    { id: "nav-networks", name: t("components.command.goTo", { page: t("components.sidebar.networks") }), icon: "\u25C8", category: navCategory, action: () => { props.onNavigate("networks"); props.onClose(); } },
    { id: "nav-kubernetes", name: t("components.command.goTo", { page: t("components.sidebar.kubernetes") }), icon: "\u2388", category: navCategory, action: () => { props.onNavigate("kubernetes"); props.onClose(); } },
    { id: "nav-templates", name: t("components.command.goTo", { page: t("components.sidebar.appCatalog") }), icon: "\u2637", category: navCategory, action: () => { props.onNavigate("templates"); props.onClose(); } },
    { id: "nav-activity", name: t("components.command.goTo", { page: t("components.sidebar.activity") }), icon: "\u29D7", category: navCategory, action: () => { props.onNavigate("activity"); props.onClose(); } },
    { id: "nav-settings", name: t("components.command.goTo", { page: t("components.sidebar.settings") }), icon: "\u2699", category: navCategory, action: () => { props.onNavigate("settings"); props.onClose(); } },
    { id: "nav-health", name: t("components.command.goTo", { page: t("components.sidebar.systemHealth") }), icon: "\u2661", category: navCategory, action: () => { props.onNavigate("environment"); props.onClose(); } },
    { id: "nav-gateway", name: t("components.command.goTo", { page: t("components.sidebar.gateway") }), icon: "\u21C4", category: navCategory, action: () => { props.onNavigate("gateway"); props.onClose(); } },
    { id: "nav-builds", name: t("components.command.goTo", { page: t("components.sidebar.builds") }), icon: "\u2692", category: navCategory, action: () => { props.onNavigate("builds"); props.onClose(); } },

    // Gateway
    { id: "gw-start", name: t("components.command.gatewayStart"), icon: "\u25B6", category: t("components.sidebar.gateway"), action: async () => {
      props.onClose();
      try {
        await invoke("gateway_start");
        showToast(t("components.command.started"), "success");
      } catch (e) {
        showToast(t("components.command.startFailed", { error: e }), "error");
      }
    }},
    { id: "gw-stop", name: t("components.command.gatewayStop"), icon: "\u25A0", category: t("components.sidebar.gateway"), action: async () => {
      props.onClose();
      const ok = await confirmDanger({
        title: t("components.command.stopTitle"),
        message: t("components.command.stopMessage"),
        confirmLabel: t("components.command.stopGateway"),
      });
      if (!ok) return;
      try {
        await invoke("gateway_stop");
        showToast(t("components.command.stopped"), "success");
      } catch (e) {
        showToast(t("components.command.stopFailed", { error: e }), "error");
      }
    }},
    { id: "gw-add-route", name: t("components.command.gatewayAddRoute"), icon: "\u2795", category: t("components.sidebar.gateway"), action: () => { props.onNavigate("gateway"); props.onClose(); } },

    // Containers
    { id: "ct-run", name: t("components.command.containerRun"), icon: "\u25B6", category: t("components.sidebar.containers"), action: () => { props.onNavigate("containers"); props.onClose(); } },
    { id: "ct-stop-all", name: t("components.command.containerStopAll"), icon: "\u25A0", category: t("components.sidebar.containers"), action: async () => {
      props.onClose();
      let running: Array<{ id: string; state: string; name: string }> = [];
      try {
        const containers = await invoke("list_containers") as Array<{ id: string; state: string; name: string }>;
        running = containers.filter((c) => c.state === "Running");
      } catch (e) {
        showToast(t("components.command.listFailed", { error: e }), "error");
        return;
      }
      if (running.length === 0) {
        showToast(t("components.command.noRunning"), "info");
        return;
      }
      const ok = await confirmDanger({
        title: t("components.command.stopContainersTitle", { count: running.length }),
        message: t("components.command.stopContainersMessage"),
        confirmLabel: t("components.command.stopAll"),
      });
      if (!ok) return;
      let stopped = 0;
      for (const c of running) {
        try {
          await invoke("stop_container", { id: c.id });
          stopped++;
        } catch {
          // continue stopping others
        }
      }
      showToast(t("components.command.stoppedContainers", { count: stopped }), "success");
    }},

    // Images
    { id: "img-pull", name: t("components.command.imagePull"), icon: "\u2913", category: t("components.sidebar.images"), action: () => { props.onNavigate("images:pull"); props.onClose(); } },
    { id: "img-build", name: t("components.command.imageBuild"), icon: "\u2692", category: t("components.sidebar.images"), action: () => { props.onNavigate("builds"); props.onClose(); } },

    // Compose
    { id: "compose-create", name: t("components.command.composeCreate"), icon: "\u2630", category: "Compose", action: () => { props.onOpenComposeWizard?.(); props.onClose(); } },

    // Templates
    { id: "tpl-deploy", name: t("components.command.templateDeploy"), icon: "\u2637", category: t("components.sidebar.appCatalog"), action: () => { props.onNavigate("templates"); props.onClose(); } },

    // Kubernetes
    { id: "k8s-enable", name: t("components.command.k8sEnable"), icon: "\u2388", category: t("components.sidebar.kubernetes"), action: () => { props.onNavigate("kubernetes"); props.onClose(); } },

    // Settings
    { id: "set-ai", name: t("components.command.settingsAi"), icon: "\u2699", category: t("components.sidebar.settings"), action: () => { props.onNavigate("settings:ai"); props.onClose(); } },
    { id: "set-certs", name: t("components.command.settingsCertificates"), icon: "\u2699", category: t("components.sidebar.settings"), action: () => { props.onNavigate("settings:certificates"); props.onClose(); } },
    { id: "set-remote", name: t("components.command.settingsRemoteHosts"), icon: "\u2699", category: t("components.sidebar.settings"), action: () => { props.onNavigate("settings:remote-hosts"); props.onClose(); } },

    // Builds
    { id: "builds-view", name: t("components.command.buildsView"), icon: "\u2692", category: t("components.sidebar.builds"), action: () => { props.onNavigate("builds"); props.onClose(); } },
  ];

  const fuzzyMatch = (text: string, pattern: string): boolean => {
    const lower = text.toLowerCase();
    const p = pattern.toLowerCase();
    let pi = 0;
    for (let i = 0; i < lower.length && pi < p.length; i++) {
      if (lower[i] === p[pi]) pi++;
    }
    return pi === p.length;
  };

  const filtered = () => {
    const q = query().trim();
    if (!q) return commands;
    return commands.filter((cmd) => fuzzyMatch(cmd.name, q) || fuzzyMatch(cmd.category, q));
  };

  // Group filtered commands by category, preserving order
  const groupedCommands = createMemo(() => {
    const items = filtered();
    const groups: { category: string; commands: Command[] }[] = [];
    const seen = new Set<string>();
    for (const cmd of items) {
      if (!seen.has(cmd.category)) {
        seen.add(cmd.category);
        groups.push({ category: cmd.category, commands: [] });
      }
      groups.find((g) => g.category === cmd.category)!.commands.push(cmd);
    }
    return groups;
  });

  // Flat list for keyboard navigation
  const flatFiltered = () => filtered();

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    const items = flatFiltered();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[selectedIndex()];
      if (item) item.action();
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };

  // Track the global index for selection highlighting
  let globalIndex = 0;

  onMount(() => {
    inputRef?.focus();
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  return (
    <div class="command-palette-overlay" onMouseDown={(e) => { (e.currentTarget as any).__mdOverlay = e.target === e.currentTarget; }} onClick={(e) => { if ((e.currentTarget as any).__mdOverlay && e.target === e.currentTarget) props.onClose(); (e.currentTarget as any).__mdOverlay = false; }}>
      <div class="command-palette">
        <input
          ref={inputRef}
          class="command-palette-input"
          type="text"
          placeholder={t("components.command.placeholder")}
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setSelectedIndex(0);
          }}
        />
        <div class="command-palette-results">
          {(() => {
            globalIndex = 0;
            return null;
          })()}
          <For each={groupedCommands()}>
            {(group) => (
              <>
                <div class="command-group-header">{group.category}</div>
                <For each={group.commands}>
                  {(cmd) => {
                    const myIndex = globalIndex++;
                    return (
                      <div
                        class={`command-item ${myIndex === selectedIndex() ? "selected" : ""}`}
                        onClick={() => cmd.action()}
                        onMouseEnter={() => setSelectedIndex(myIndex)}
                      >
                        <span class="command-item-icon">{cmd.icon}</span>
                        <span class="command-item-name">{cmd.name}</span>
                        <span class="command-item-category">{cmd.category}</span>
                        <Show when={cmd.shortcut}>
                          <span class="command-item-shortcut">{cmd.shortcut}</span>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </>
            )}
          </For>
          <Show when={filtered().length === 0}>
            <div style={{ padding: "16px", "text-align": "center", color: "#484f58", "font-size": "13px" }}>
              {t("components.command.noMatches")}
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
