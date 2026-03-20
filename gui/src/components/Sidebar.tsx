import { createSignal, onMount, onCleanup, For, Show, JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Page } from "../App";

interface SidebarProps {
  currentPage: string;
  onNavigate: (page: Page) => void;
  daemonStatus: string;
}

// Lucide icons — all 24x24 viewBox, stroke-width 2, consistent visual weight
const Icon = (props: { d: string | string[]; children?: JSX.Element }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    {Array.isArray(props.d)
      ? props.d.map((p) => <path d={p} />)
      : <path d={props.d} />}
    {props.children}
  </svg>
);

const icons: Record<string, () => JSX.Element> = {
  // LayoutDashboard
  dashboard: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </svg>
  ),
  // Box (container/package)
  containers: () => (
    <Icon d={[
      "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
      "m3.3 7 8.7 5 8.7-5",
      "M12 22V12",
    ]} />
  ),
  // Layers (stacked image layers)
  images: () => (
    <Icon d={[
      "m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z",
      "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65",
      "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65",
    ]} />
  ),
  // Database (cylinder)
  volumes: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </svg>
  ),
  // Share2 (connected nodes — network topology)
  networks: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
      <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
    </svg>
  ),
  // Hexagon (Kubernetes logo shape)
  kubernetes: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  ),
  // Monitor (computer screen)
  machine: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  ),
  // LayoutTemplate (grid template)
  templates: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="18" height="7" x="3" y="3" rx="1" />
      <rect width="9" height="7" x="3" y="14" rx="1" />
      <rect width="5" height="7" x="16" y="14" rx="1" />
    </svg>
  ),
  // HeartPulse (system health)
  environment: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
      <path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" />
    </svg>
  ),
  // Activity (pulse line)
  activity: () => (
    <Icon d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
  ),
  // Settings (gear)
  settings: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
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
  { id: "templates", label: "Templates" },
  { id: "environment", label: "System Health" },
  { id: "activity", label: "Activity" },
];

// Persist collapsed state across navigations
const [collapsed, setCollapsed] = createSignal(
  localStorage.getItem("sidebar-collapsed") === "true"
);

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

  const toggleCollapsed = () => {
    const next = !collapsed();
    setCollapsed(next);
    localStorage.setItem("sidebar-collapsed", String(next));
  };

  const badgeFor = (id: Page) => {
    if (id === "containers" && containerCount() > 0) return containerCount();
    if (id === "images" && imageCount() > 0) return imageCount();
    return null;
  };

  return (
    <aside class={`sidebar ${collapsed() ? "sidebar-collapsed" : ""}`}>
      <nav class="sidebar-nav">
        <For each={mainNavItems}>
          {(item) => (
            <button
              class={`nav-item ${props.currentPage === item.id ? "active" : ""}`}
              onClick={() => props.onNavigate(item.id)}
              title={collapsed() ? item.label : undefined}
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
          title={collapsed() ? "Settings" : undefined}
        >
          <span class="nav-icon">{icons.settings()}</span>
          <span class="nav-label">Settings</span>
        </button>
      </nav>

      <button class="sidebar-toggle" onClick={toggleCollapsed} title={collapsed() ? "Expand sidebar" : "Collapse sidebar"}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          style={{ transform: collapsed() ? "rotate(180deg)" : "none", transition: "transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)" }}
        >
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
    </aside>
  );
}
