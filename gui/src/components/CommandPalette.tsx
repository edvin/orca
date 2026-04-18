import { createSignal, onMount, onCleanup, For, Show, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./Toast";
import { confirmDanger } from "./ConfirmDialog";

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

  const commands: Command[] = [
    // Navigation
    { id: "nav-dashboard", name: "Go to Dashboard", icon: "\u25A4", category: "Navigation", shortcut: "", action: () => { props.onNavigate("dashboard"); props.onClose(); } },
    { id: "nav-containers", name: "Go to Containers", icon: "\u25A3", category: "Navigation", action: () => { props.onNavigate("containers"); props.onClose(); } },
    { id: "nav-images", name: "Go to Images", icon: "\u25A8", category: "Navigation", action: () => { props.onNavigate("images"); props.onClose(); } },
    { id: "nav-volumes", name: "Go to Volumes", icon: "\u25CE", category: "Navigation", action: () => { props.onNavigate("volumes"); props.onClose(); } },
    { id: "nav-networks", name: "Go to Networks", icon: "\u25C8", category: "Navigation", action: () => { props.onNavigate("networks"); props.onClose(); } },
    { id: "nav-kubernetes", name: "Go to Kubernetes", icon: "\u2388", category: "Navigation", action: () => { props.onNavigate("kubernetes"); props.onClose(); } },
    { id: "nav-templates", name: "Go to App Catalog", icon: "\u2637", category: "Navigation", action: () => { props.onNavigate("templates"); props.onClose(); } },
    { id: "nav-activity", name: "Go to Activity", icon: "\u29D7", category: "Navigation", action: () => { props.onNavigate("activity"); props.onClose(); } },
    { id: "nav-settings", name: "Go to Settings", icon: "\u2699", category: "Navigation", action: () => { props.onNavigate("settings"); props.onClose(); } },
    { id: "nav-health", name: "Go to System Health", icon: "\u2661", category: "Navigation", action: () => { props.onNavigate("environment"); props.onClose(); } },
    { id: "nav-gateway", name: "Go to Gateway", icon: "\u21C4", category: "Navigation", action: () => { props.onNavigate("gateway"); props.onClose(); } },
    { id: "nav-builds", name: "Go to Builds", icon: "\u2692", category: "Navigation", action: () => { props.onNavigate("builds"); props.onClose(); } },

    // Gateway
    { id: "gw-start", name: "Gateway: Start", icon: "\u25B6", category: "Gateway", action: async () => {
      props.onClose();
      try {
        await invoke("gateway_start");
        showToast("Gateway started", "success");
      } catch (e) {
        showToast(`Failed to start gateway: ${e}`, "error");
      }
    }},
    { id: "gw-stop", name: "Gateway: Stop", icon: "\u25A0", category: "Gateway", action: async () => {
      props.onClose();
      const ok = await confirmDanger({
        title: "Stop gateway?",
        message: "All routed traffic will be interrupted until the gateway is started again.",
        confirmLabel: "Stop gateway",
      });
      if (!ok) return;
      try {
        await invoke("gateway_stop");
        showToast("Gateway stopped", "success");
      } catch (e) {
        showToast(`Failed to stop gateway: ${e}`, "error");
      }
    }},
    { id: "gw-add-route", name: "Gateway: Add Route", icon: "\u2795", category: "Gateway", action: () => { props.onNavigate("gateway"); props.onClose(); } },

    // Containers
    { id: "ct-run", name: "Container: Run", icon: "\u25B6", category: "Containers", action: () => { props.onNavigate("containers"); props.onClose(); } },
    { id: "ct-stop-all", name: "Container: Stop All", icon: "\u25A0", category: "Containers", action: async () => {
      props.onClose();
      let running: Array<{ id: string; state: string; name: string }> = [];
      try {
        const containers = await invoke("list_containers") as Array<{ id: string; state: string; name: string }>;
        running = containers.filter((c) => c.state === "Running");
      } catch (e) {
        showToast(`Failed to list containers: ${e}`, "error");
        return;
      }
      if (running.length === 0) {
        showToast("No running containers", "info");
        return;
      }
      const ok = await confirmDanger({
        title: `Stop ${running.length} running container${running.length !== 1 ? "s" : ""}?`,
        message:
          "This will signal every running container on the active host to stop. Work in progress may be lost.",
        confirmLabel: "Stop all",
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
      showToast(`Stopped ${stopped} container${stopped !== 1 ? "s" : ""}`, "success");
    }},

    // Images
    { id: "img-pull", name: "Image: Pull", icon: "\u2913", category: "Images", action: () => { props.onNavigate("images:pull"); props.onClose(); } },
    { id: "img-build", name: "Image: Build", icon: "\u2692", category: "Images", action: () => { props.onNavigate("builds"); props.onClose(); } },

    // Compose
    { id: "compose-create", name: "Compose: Create New Stack", icon: "\u2630", category: "Compose", action: () => { props.onOpenComposeWizard?.(); props.onClose(); } },

    // Templates
    { id: "tpl-deploy", name: "Template: Deploy", icon: "\u2637", category: "Templates", action: () => { props.onNavigate("templates"); props.onClose(); } },

    // Kubernetes
    { id: "k8s-enable", name: "K8s: Enable", icon: "\u2388", category: "Kubernetes", action: () => { props.onNavigate("kubernetes"); props.onClose(); } },

    // Settings
    { id: "set-ai", name: "Settings: AI", icon: "\u2699", category: "Settings", action: () => { props.onNavigate("settings:ai"); props.onClose(); } },
    { id: "set-certs", name: "Settings: Certificates", icon: "\u2699", category: "Settings", action: () => { props.onNavigate("settings:certificates"); props.onClose(); } },
    { id: "set-remote", name: "Settings: Remote Hosts", icon: "\u2699", category: "Settings", action: () => { props.onNavigate("settings:remote-hosts"); props.onClose(); } },

    // Builds
    { id: "builds-view", name: "Builds: View", icon: "\u2692", category: "Builds", action: () => { props.onNavigate("builds"); props.onClose(); } },
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
          placeholder="Type a command..."
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
              No matching commands
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
