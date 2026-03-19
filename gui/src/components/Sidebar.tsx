import { createSignal, onMount, onCleanup, For, Show, JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Page } from "../App";

interface SidebarProps {
  currentPage: string;
  onNavigate: (page: Page) => void;
  daemonStatus: string;
}

// Clean monochrome SVG icons — 18x18, stroke-based, consistent 1.5px weight
const icons: Record<string, () => JSX.Element> = {
  dashboard: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  ),
  containers: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
      <path d="M3.27 6.96L12 12.01l8.73-5.05" />
      <path d="M12 22.08V12" />
    </svg>
  ),
  images: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 7v10c0 1.1.9 2 2 2h12a2 2 0 002-2V7" />
      <path d="M7 4h10a2 2 0 012 2v1H5V6a2 2 0 012-2z" />
      <line x1="9" y1="11" x2="15" y2="11" />
      <line x1="9" y1="14" x2="13" y2="14" />
    </svg>
  ),
  volumes: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  networks: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <line x1="12" y1="7" x2="12" y2="12" />
      <path d="M12 12L5 17" />
      <path d="M12 12l7 5" />
    </svg>
  ),
  kubernetes: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M4.22 7.5l3.46 2" />
      <path d="M16.32 14.5l3.46 2" />
      <path d="M4.22 16.5l3.46-2" />
      <path d="M16.32 9.5l3.46-2" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  ),
  machine: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  templates: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="9" x2="9" y2="21" />
    </svg>
  ),
  environment: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
  activity: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  settings: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  ),
};

const mainNavItems: { id: Page; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "containers", label: "Containers" },
  { id: "images", label: "Images" },
  { id: "volumes", label: "Volumes" },
  { id: "networks", label: "Networks" },
  { id: "kubernetes", label: "Kubernetes" },
  { id: "machine", label: "Machine" },
  { id: "templates", label: "Templates" },
  { id: "environment", label: "System Health" },
  { id: "activity", label: "Activity" },
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
              <span class="nav-icon">{icons[item.id]?.()}</span>
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
          <span class="nav-icon">{icons.settings()}</span>
          <span class="nav-label">Settings</span>
        </button>
      </nav>

      <div class="sidebar-version">
        v0.1.0
      </div>
    </aside>
  );
}
