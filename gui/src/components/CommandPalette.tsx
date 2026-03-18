import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import type { Page } from "../App";

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
  onNavigate: (page: Page) => void;
}

export default function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  const commands: Command[] = [
    { id: "nav-dashboard", name: "Go to Dashboard", icon: "\u25a4", category: "Navigate", shortcut: "", action: () => { props.onNavigate("dashboard"); props.onClose(); } },
    { id: "nav-containers", name: "Go to Containers", icon: "\u25a3", category: "Navigate", action: () => { props.onNavigate("containers"); props.onClose(); } },
    { id: "nav-images", name: "Go to Images", icon: "\u25ce", category: "Navigate", action: () => { props.onNavigate("images"); props.onClose(); } },
    { id: "nav-stacks", name: "Go to Stacks", icon: "\u25a6", category: "Navigate", action: () => { props.onNavigate("stacks"); props.onClose(); } },
    { id: "nav-volumes", name: "Go to Volumes", icon: "\u25c8", category: "Navigate", action: () => { props.onNavigate("volumes"); props.onClose(); } },
    { id: "nav-networks", name: "Go to Networks", icon: "\u25cc", category: "Navigate", action: () => { props.onNavigate("networks"); props.onClose(); } },
    { id: "nav-kubernetes", name: "Go to Kubernetes", icon: "\u2388", category: "Navigate", action: () => { props.onNavigate("kubernetes"); props.onClose(); } },
    { id: "nav-machine", name: "Go to Machine", icon: "\u2318", category: "Navigate", action: () => { props.onNavigate("machine"); props.onClose(); } },
    { id: "nav-activity", name: "Go to Activity", icon: "\u29d7", category: "Navigate", action: () => { props.onNavigate("activity"); props.onClose(); } },
    { id: "nav-settings", name: "Go to Settings", icon: "\u2699", category: "Navigate", action: () => { props.onNavigate("settings"); props.onClose(); } },
    { id: "nav-environment", name: "Go to Environment", icon: "\u2661", category: "Navigate", action: () => { props.onNavigate("environment"); props.onClose(); } },
    { id: "act-run", name: "Run Container...", icon: "\u25b6", category: "Action", action: () => { props.onNavigate("containers"); props.onClose(); } },
    { id: "act-pull", name: "Pull Image...", icon: "\u2913", category: "Action", action: () => { props.onNavigate("images"); props.onClose(); } },
    { id: "act-prune", name: "Prune Images", icon: "\u2718", category: "Action", action: () => { props.onNavigate("images"); props.onClose(); } },
    { id: "act-k8s", name: "Enable Kubernetes", icon: "\u2388", category: "Action", action: () => { props.onNavigate("kubernetes"); props.onClose(); } },
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

  const handleKeyDown = (e: KeyboardEvent) => {
    const items = filtered();
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

  onMount(() => {
    inputRef?.focus();
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  return (
    <div class="command-palette-overlay" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
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
          <For each={filtered()}>
            {(cmd, i) => (
              <div
                class={`command-item ${i() === selectedIndex() ? "selected" : ""}`}
                onClick={() => cmd.action()}
                onMouseEnter={() => setSelectedIndex(i())}
              >
                <span class="command-item-icon">{cmd.icon}</span>
                <span class="command-item-name">{cmd.name}</span>
                <span class="command-item-category">{cmd.category}</span>
                <Show when={cmd.shortcut}>
                  <span class="command-item-shortcut">{cmd.shortcut}</span>
                </Show>
              </div>
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
