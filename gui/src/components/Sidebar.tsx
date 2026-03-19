import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Page } from "../App";

interface SidebarProps {
  currentPage: string;
  onNavigate: (page: Page) => void;
  daemonStatus: string;
}

const mainNavItems: { id: Page; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "\u{1F4CA}" },
  { id: "containers", label: "Containers", icon: "\u{1F4E6}" },
  { id: "images", label: "Images", icon: "\u{1F5BC}" },
  { id: "volumes", label: "Volumes", icon: "\u{1F4BE}" },
  { id: "networks", label: "Networks", icon: "\u{1F310}" },
  { id: "kubernetes", label: "Kubernetes", icon: "\u2388" },
  { id: "machine", label: "Machine", icon: "\u{1F5A5}" },
  { id: "templates", label: "Templates", icon: "\u{1F3AA}" },
  { id: "environment", label: "Environment", icon: "\u{1F6E0}" },
  { id: "activity", label: "Activity", icon: "\u{1F4AC}" },
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

  return (
    <aside class="sidebar">
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

      <div class="sidebar-version">
        v0.1.0
      </div>
    </aside>
  );
}
