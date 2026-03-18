import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Page } from "../App";

interface SidebarProps {
  currentPage: string;
  onNavigate: (page: Page) => void;
  daemonStatus: string;
}

const mainNavItems: { id: Page; label: string; icon: string }[] = [
  { id: "stacks", label: "Stacks", icon: "\u25a6" },
  { id: "containers", label: "Containers", icon: "\u25a3" },
  { id: "images", label: "Images", icon: "\u25ce" },
  { id: "volumes", label: "Volumes", icon: "\u25c8" },
  { id: "networks", label: "Networks", icon: "\u25cc" },
  { id: "machine", label: "Machine", icon: "\u2318" },
];

export default function Sidebar(props: SidebarProps) {
  const [containerCount, setContainerCount] = createSignal(0);
  const [imageCount, setImageCount] = createSignal(0);

  const fetchCounts = async () => {
    try {
      const containers = (await invoke("list_containers")) as any[];
      setContainerCount(containers.length);
    } catch { /* ignore */ }
    try {
      const images = (await invoke("list_images")) as any[];
      setImageCount(images.length);
    } catch { /* ignore */ }
  };

  onMount(() => {
    fetchCounts();
    const interval = setInterval(fetchCounts, 5000);
    onCleanup(() => clearInterval(interval));
  });

  const badgeFor = (id: Page) => {
    if (id === "containers" && containerCount() > 0) return containerCount();
    if (id === "images" && imageCount() > 0) return imageCount();
    return null;
  };

  const statusColor = () => {
    switch (props.daemonStatus) {
      case "running":
        return "#3fb950";
      case "stopped":
        return "#f85149";
      default:
        return "#848d97";
    }
  };

  return (
    <aside class="sidebar">
      <div class="sidebar-brand">
        <span class="brand-icon">{"\u{1F433}"}</span>
        Orca
      </div>

      <nav class="sidebar-nav">
        <For each={mainNavItems}>
          {(item) => (
            <button
              class={`nav-item ${props.currentPage === item.id ? "active" : ""}`}
              onClick={() => props.onNavigate(item.id)}
            >
              <span class="nav-icon">{item.icon}</span>
              <span class="nav-label">{item.label}</span>
              <Show when={badgeFor(item.id)}>
                {(count) => <span class="nav-badge">{count()}</span>}
              </Show>
            </button>
          )}
        </For>

        <div class="nav-separator" />

        <button
          class={`nav-item ${props.currentPage === "settings" ? "active" : ""}`}
          onClick={() => props.onNavigate("settings")}
        >
          <span class="nav-icon">{"\u2699"}</span>
          <span class="nav-label">Settings</span>
        </button>
      </nav>

      <div class="sidebar-footer">
        <span
          class="status-dot"
          style={{ background: statusColor() }}
        />
        Engine: {props.daemonStatus}
      </div>
    </aside>
  );
}
