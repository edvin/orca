import { createSignal, createEffect, on, onMount, onCleanup, For, Show, JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Page } from "../App";
import type { RemoteHost } from "../lib/types";
import { containersStore, imagesStore } from "../lib/dockerStore";

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
  // GitBranch (worktree projects)
  // Workspace (a house: the team's home base)
  workspace: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
    </svg>
  ),
  projects: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  ),
  // Globe (fleet/multi-host)
  fleet: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  ),
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
  // Key (build/wrench)
  builds: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z"/><circle cx="16.5" cy="7.5" r=".5"/></svg>
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
  // Globe with arrows (gateway reverse proxy)
  gateway: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
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

/** The sidebar in groups; a group's title shows when the sidebar is wide. */
const navGroups: { title: string | null; items: { id: Page; label: string }[] }[] = [
  { title: null, items: [{ id: "dashboard", label: "Dashboard" }] },
  {
    title: "Develop",
    items: [
      { id: "workspace", label: "Workspace" },
      { id: "projects", label: "Worktrees" },
      { id: "containers", label: "Containers" },
      { id: "gateway", label: "Gateway" },
      { id: "templates", label: "App Catalog" },
    ],
  },
  {
    title: "Resources",
    items: [
      { id: "images", label: "Images" },
      { id: "builds", label: "Builds" },
      { id: "volumes", label: "Volumes" },
      { id: "networks", label: "Networks" },
    ],
  },
  { title: "Platform", items: [{ id: "kubernetes", label: "Kubernetes" }] },
  {
    title: "System",
    items: [
      { id: "environment", label: "System Health" },
      { id: "activity", label: "Activity" },
    ],
  },
];

// Persist collapsed state across navigations
const [collapsed, setCollapsed] = createSignal(
  localStorage.getItem("sidebar-collapsed") === "true"
);

export default function Sidebar(props: SidebarProps) {
  // Counts come from the shared lists; this component doesn't poll them itself.
  const containerList = containersStore.use().list;
  const imageList = imagesStore.use().list;
  const containerCount = () => containerList().length;
  const imageCount = () => imageList().length;
  const [hasRemoteHosts, setHasRemoteHosts] = createSignal(false);
  const [k8sOff, setK8sOff] = createSignal(false);

  // Remote hosts only change in Settings or on the Fleet page: re-read them
  // on navigation and refresh instead of polling.
  const loadRemoteHosts = async () => {
    try {
      const remotes = (await invoke("list_remote_hosts")) as RemoteHost[];
      setHasRemoteHosts(remotes.length > 0);
    } catch { /* ignore */ }
  };
  createEffect(on(() => props.currentPage, loadRemoteHosts));

  // Whether Kubernetes is on changes rarely: check now, on host switches and
  // once a minute. A check that fails or times out says nothing either way,
  // and only the newest answer counts.
  let k8sCheck = 0;
  const loadK8s = async () => {
    const mine = ++k8sCheck;
    try {
      const k = (await invoke("k8s_status")) as { enabled?: boolean; error?: string | null };
      if (mine === k8sCheck && !k.error) setK8sOff(k.enabled === false);
    } catch { /* ignore */ }
  };

  onMount(() => {
    void loadK8s();
    const timer = setInterval(() => { if (!document.hidden) void loadK8s(); }, 60_000);
    const onHost = () => { void loadRemoteHosts(); void loadK8s(); };
    document.addEventListener("orca-host-switch", onHost);
    document.addEventListener("orca-refresh", loadRemoteHosts);
    onCleanup(() => {
      clearInterval(timer);
      document.removeEventListener("orca-host-switch", onHost);
      document.removeEventListener("orca-refresh", loadRemoteHosts);
    });
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
        <For each={navGroups}>
          {(group) => (
            <div class="nav-group">
              <Show when={group.title}>
                <div class="nav-group-title">{group.title}</div>
              </Show>
              <For each={group.items}>
                {(item) => (
                  <button
                    class={`nav-item ${props.currentPage === item.id ? "active" : ""}`}
                    classList={{ "nav-item-off": item.id === "kubernetes" && k8sOff() }}
                    onClick={() => props.onNavigate(item.id)}
                    title={collapsed() ? item.label : item.id === "kubernetes" && k8sOff() ? "Kubernetes is off. Turn it on from this page." : undefined}
                  >
                    <span class="nav-icon">{icons[item.id]?.()}</span>
                    <span class="nav-label">{item.label}</span>
                    <Show when={!collapsed() && item.id === "kubernetes" && k8sOff()}>
                      <span class="nav-off">off</span>
                    </Show>
                    <Show when={!collapsed() && badgeFor(item.id)}>
                      {(count) => <span class="nav-badge">{count()}</span>}
                    </Show>
                  </button>
                )}
              </For>
              {/* Remote hosts live with the platform pieces, once there are any. */}
              <Show when={group.title === "Platform" && hasRemoteHosts()}>
                <button
                  class={`nav-item ${props.currentPage === "fleet" ? "active" : ""}`}
                  onClick={() => props.onNavigate("fleet" as Page)}
                  title={collapsed() ? "Fleet" : undefined}
                >
                  <span class="nav-icon">{icons.fleet()}</span>
                  <span class="nav-label">Fleet</span>
                </button>
              </Show>
            </div>
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
