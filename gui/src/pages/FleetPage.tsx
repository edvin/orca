import { createSignal, createMemo, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useRefresh } from "../lib/useRefresh";
import { formatBytes } from "../lib/format";
import { confirmDanger } from "../components/ConfirmDialog";
import { showToast } from "../components/Toast";
import type { RemoteHost, HostStatus } from "../lib/types";

// Module-level signal — persists across navigation
const [lastSeen, setLastSeen] = createSignal<Record<string, number>>({});

// Tag color palette (cycling through category-style colors)
const TAG_COLORS = [
  { bg: "rgba(88, 166, 255, 0.1)", color: "#58a6ff", border: "rgba(88, 166, 255, 0.15)" },
  { bg: "rgba(63, 185, 80, 0.1)", color: "#3fb950", border: "rgba(63, 185, 80, 0.15)" },
  { bg: "rgba(210, 169, 34, 0.1)", color: "#d29922", border: "rgba(210, 169, 34, 0.15)" },
  { bg: "rgba(163, 113, 247, 0.1)", color: "#a371f7", border: "rgba(163, 113, 247, 0.15)" },
  { bg: "rgba(248, 81, 73, 0.1)", color: "#f85149", border: "rgba(248, 81, 73, 0.15)" },
  { bg: "rgba(121, 192, 255, 0.1)", color: "#79c0ff", border: "rgba(121, 192, 255, 0.15)" },
  { bg: "rgba(139, 148, 158, 0.1)", color: "#8b949e", border: "rgba(139, 148, 158, 0.15)" },
];

function tagColor(tag: string) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? "s" : ""} ago`;
}

interface FleetPageProps {
  onNavigate: (page: string) => void;
}

const BATCH_SIZE = 3;

export default function FleetPage(props: FleetPageProps) {
  const [hosts, setHosts] = createSignal<HostStatus[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [lastUpdated, setLastUpdated] = createSignal<Date | null>(null);
  const [activeTag, setActiveTag] = createSignal<string | null>(null);
  const [selectMode, setSelectMode] = createSignal(false);
  const [selectedHosts, setSelectedHosts] = createSignal<Set<string | null>>(new Set());
  const [probeProgress, setProbeProgress] = createSignal<{ current: number; total: number } | null>(null);

  // All unique tags across all hosts
  const allTags = createMemo(() => {
    const tags = new Set<string>();
    for (const host of hosts()) {
      for (const tag of (host.tags || [])) {
        tags.add(tag);
      }
    }
    return [...tags].sort();
  });

  // Filtered hosts based on active tag
  const filteredHosts = createMemo(() => {
    const tag = activeTag();
    if (!tag) return hosts();
    return hosts().filter(h => (h.tags || []).includes(tag));
  });

  const buildHostList = async (): Promise<HostStatus[]> => {
    const remotes = (await invoke("list_remote_hosts")) as RemoteHost[];
    const localHost: HostStatus = {
      id: null,
      name: "Local",
      url: "127.0.0.1:9477",
      online: false,
      checking: true,
    };
    const remoteHosts: HostStatus[] = remotes.map((h) => ({
      id: h.id,
      name: h.name,
      url: h.url.replace(/^https?:\/\//, "").replace(/\/api\/v1\/?$/, ""),
      tags: h.tags || [],
      online: false,
      checking: true,
    }));
    return [localHost, ...remoteHosts];
  };

  const probeHost = async (host: HostStatus): Promise<HostStatus> => {
    try {
      const data = (await invoke("probe_host", {
        hostId: host.id,
      })) as any;
      return {
        ...host,
        checking: false,
        online: data.online === true,
        version: data.version || undefined,
        docker_connected: data.docker_connected ?? undefined,
        cpu_count: data.cpu_count ?? undefined,
        memory_total: data.memory_total ?? undefined,
        memory_available: data.memory_available ?? undefined,
        disk_usage_percent: data.disk_usage_percent ?? undefined,
        containers_running: data.containers_running ?? undefined,
        containers_total: data.containers_total ?? undefined,
        images_total: data.images_total ?? undefined,
        os: data.os ?? undefined,
        arch: data.arch ?? undefined,
      } as HostStatus;
    } catch (e) {
      return {
        ...host,
        checking: false,
        online: false,
        error: String(e),
      } as HostStatus;
    }
  };

  const probeAll = async () => {
    const hostList = await buildHostList();
    // Show the checking state immediately
    setHosts(hostList);
    setLoading(false);
    setProbeProgress({ current: 0, total: hostList.length });

    // Staggered batch probing for better UX with large fleets
    const updated = [...hostList];
    for (let i = 0; i < hostList.length; i += BATCH_SIZE) {
      const batch = hostList.slice(i, i + BATCH_SIZE);
      setProbeProgress({ current: i, total: hostList.length });

      const results = await Promise.allSettled(
        batch.map(host => probeHost(host))
      );

      // Update each host incrementally
      for (let j = 0; j < batch.length; j++) {
        const idx = i + j;
        const result = results[j];
        updated[idx] = result.status === "fulfilled"
          ? result.value
          : { ...hostList[idx], checking: false, online: false, error: "Probe failed" };
      }
      setHosts([...updated]);
    }

    // Track last-seen timestamps for online hosts
    const now = Date.now();
    const seen = { ...lastSeen() };
    for (const host of updated) {
      const key = host.id || "__local__";
      if (host.online) {
        seen[key] = now;
      }
    }
    setLastSeen(seen);
    setHosts(updated);
    setLastUpdated(new Date());
    setProbeProgress(null);
  };

  const probeSelected = async () => {
    const selected = selectedHosts();
    if (selected.size === 0) return;
    const current = hosts();
    const toProbe = current.filter(h => selected.has(h.id));

    // Mark selected as checking
    setHosts(current.map(h => selected.has(h.id) ? { ...h, checking: true } : h));

    for (let i = 0; i < toProbe.length; i += BATCH_SIZE) {
      const batch = toProbe.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(host => probeHost(host))
      );
      setHosts(prev => {
        const updated = [...prev];
        for (let j = 0; j < batch.length; j++) {
          const result = results[j];
          const probed = result.status === "fulfilled" ? result.value : { ...batch[j], checking: false, online: false, error: "Probe failed" };
          const idx = updated.findIndex(h => h.id === batch[j].id);
          if (idx >= 0) updated[idx] = probed;
        }
        return updated;
      });
    }

    // Update last-seen
    const now = Date.now();
    const seen = { ...lastSeen() };
    for (const host of hosts()) {
      const key = host.id || "__local__";
      if (host.online) seen[key] = now;
    }
    setLastSeen(seen);
    setLastUpdated(new Date());
  };

  const removeSelected = async () => {
    const selected = selectedHosts();
    const toRemove = hosts().filter(h => selected.has(h.id) && h.id !== null);
    if (toRemove.length === 0) {
      showToast("Cannot remove local host", "error");
      return;
    }
    const ok = await confirmDanger(
      "Remove Selected Hosts",
      `Remove ${toRemove.length} host${toRemove.length !== 1 ? "s" : ""} from fleet? This only removes the configuration — it does not stop remote daemons.`
    );
    if (!ok) return;

    for (const host of toRemove) {
      try {
        await invoke("remove_remote_host", { id: host.id });
      } catch (e) {
        showToast(`Failed to remove ${host.name}: ${e}`, "error");
      }
    }
    setSelectedHosts(new Set<string | null>());
    setSelectMode(false);
    showToast(`Removed ${toRemove.length} host${toRemove.length !== 1 ? "s" : ""}`, "success");
    await probeAll();
  };

  const toggleSelect = (hostId: string | null) => {
    const current = new Set<string | null>(selectedHosts());
    if (current.has(hostId)) {
      current.delete(hostId);
    } else {
      current.add(hostId);
    }
    setSelectedHosts(current);
  };

  const selectAll = () => {
    setSelectedHosts(new Set<string | null>(filteredHosts().map(h => h.id)));
  };

  const deselectAll = () => {
    setSelectedHosts(new Set<string | null>());
  };

  useRefresh(probeAll);

  onMount(() => {
    probeAll();
    const interval = setInterval(probeAll, 30000);
    onCleanup(() => clearInterval(interval));
  });

  const handleCardClick = async (host: HostStatus, e: MouseEvent) => {
    if (selectMode()) {
      e.preventDefault();
      e.stopPropagation();
      toggleSelect(host.id);
      return;
    }
    try {
      await invoke("switch_host", { id: host.id });
      props.onNavigate("dashboard");
    } catch (e) {
      console.error("Failed to switch host:", e);
    }
  };

  const totalRunning = () =>
    hosts().reduce((sum, h) => sum + (h.containers_running || 0), 0);
  const totalContainers = () =>
    hosts().reduce((sum, h) => sum + (h.containers_total || 0), 0);
  const onlineCount = () => hosts().filter((h) => h.online).length;

  const versionMismatch = () => {
    const onlineHosts = hosts().filter((h) => h.online && h.version);
    if (onlineHosts.length < 2) return false;
    const versions = new Set(onlineHosts.map((h) => h.version));
    return versions.size > 1;
  };

  return (
    <div class="fleet-page" style={{ padding: "28px 32px", "overflow-y": "auto", height: "100%" }}>
      {/* Header */}
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "16px" }}>
        <div>
          <h1 style={{ margin: "0 0 4px 0", "font-size": "22px", "font-weight": "600", color: "#e6edf3" }}>
            Fleet
          </h1>
          <span style={{ color: "#8b949e", "font-size": "13px" }}>
            {onlineCount()} of {hosts().length} hosts online
            <Show when={totalRunning() > 0}>
              {" "}&middot; {totalRunning()} containers running across fleet
            </Show>
          </span>
        </div>
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <Show when={probeProgress()}>
            <span style={{ color: "#8b949e", "font-size": "12px" }}>
              Checking {Math.min(probeProgress()!.current + BATCH_SIZE, probeProgress()!.total)}/{probeProgress()!.total} hosts...
            </span>
          </Show>
          <Show when={!probeProgress() && lastUpdated()}>
            <span style={{ color: "#484f58", "font-size": "12px" }}>
              Updated {lastUpdated()!.toLocaleTimeString()}
            </span>
          </Show>
          <button
            onClick={() => {
              if (selectMode()) {
                setSelectMode(false);
                setSelectedHosts(new Set<string | null>());
              } else {
                setSelectMode(true);
              }
            }}
            style={{
              padding: "6px 14px", "font-size": "13px", "border-radius": "6px",
              background: selectMode() ? "#1f6feb" : "#21262d",
              border: `1px solid ${selectMode() ? "#1f6feb" : "#30363d"}`,
              color: "#e6edf3", cursor: "pointer",
            }}
          >
            {selectMode() ? "Cancel Select" : "Select"}
          </button>
          <button
            onClick={probeAll}
            disabled={!!probeProgress()}
            style={{
              padding: "6px 14px", "font-size": "13px", "border-radius": "6px",
              background: "#21262d", border: "1px solid #30363d",
              color: "#e6edf3", cursor: probeProgress() ? "not-allowed" : "pointer",
              opacity: probeProgress() ? "0.5" : "1",
            }}
          >
            Test All
          </button>
        </div>
      </div>

      {/* Bulk action bar */}
      <Show when={selectMode()}>
        <div style={{
          display: "flex", "align-items": "center", gap: "8px",
          padding: "8px 12px", background: "#161b22", border: "1px solid #30363d",
          "border-radius": "8px", "margin-bottom": "12px",
        }}>
          <span style={{ color: "#8b949e", "font-size": "13px", "margin-right": "4px" }}>
            {selectedHosts().size} selected
          </span>
          <button
            onClick={selectAll}
            style={{
              padding: "4px 10px", "font-size": "12px", "border-radius": "6px",
              background: "#21262d", border: "1px solid #30363d",
              color: "#e6edf3", cursor: "pointer",
            }}
          >
            Select All
          </button>
          <button
            onClick={deselectAll}
            style={{
              padding: "4px 10px", "font-size": "12px", "border-radius": "6px",
              background: "#21262d", border: "1px solid #30363d",
              color: "#e6edf3", cursor: "pointer",
            }}
          >
            Deselect All
          </button>
          <div style={{ flex: "1" }} />
          <button
            onClick={probeSelected}
            disabled={selectedHosts().size === 0}
            style={{
              padding: "4px 10px", "font-size": "12px", "border-radius": "6px",
              background: "#21262d", border: "1px solid #30363d",
              color: "#58a6ff", cursor: selectedHosts().size === 0 ? "not-allowed" : "pointer",
              opacity: selectedHosts().size === 0 ? "0.5" : "1",
            }}
          >
            Test Selected
          </button>
          <button
            onClick={removeSelected}
            disabled={selectedHosts().size === 0}
            style={{
              padding: "4px 10px", "font-size": "12px", "border-radius": "6px",
              background: "rgba(248, 81, 73, 0.1)", border: "1px solid rgba(248, 81, 73, 0.2)",
              color: "#f85149", cursor: selectedHosts().size === 0 ? "not-allowed" : "pointer",
              opacity: selectedHosts().size === 0 ? "0.5" : "1",
            }}
          >
            Remove Selected
          </button>
        </div>
      </Show>

      {/* Tag filter pills */}
      <Show when={allTags().length > 0}>
        <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px", "margin-bottom": "16px" }}>
          <button
            onClick={() => setActiveTag(null)}
            style={{
              padding: "3px 12px", "border-radius": "14px", "font-size": "12px",
              "font-weight": "500", cursor: "pointer", border: "1px solid",
              background: activeTag() === null ? "rgba(139, 148, 158, 0.2)" : "transparent",
              color: activeTag() === null ? "#e6edf3" : "#8b949e",
              "border-color": activeTag() === null ? "#8b949e" : "#30363d",
            }}
          >
            All
          </button>
          <For each={allTags()}>
            {(tag) => {
              const c = tagColor(tag);
              const isActive = () => activeTag() === tag;
              return (
                <button
                  onClick={() => setActiveTag(isActive() ? null : tag)}
                  style={{
                    padding: "3px 12px", "border-radius": "14px", "font-size": "12px",
                    "font-weight": "500", cursor: "pointer",
                    background: isActive() ? c.bg : "transparent",
                    color: isActive() ? c.color : "#8b949e",
                    border: `1px solid ${isActive() ? c.border : "#30363d"}`,
                  }}
                >
                  {tag}
                </button>
              );
            }}
          </For>
        </div>
      </Show>

      {/* Version mismatch warning */}
      <Show when={versionMismatch()}>
        <div style={{ padding: "10px 16px", background: "rgba(210, 169, 34, 0.1)", border: "1px solid rgba(210, 169, 34, 0.2)", "border-radius": "8px", "font-size": "12px", color: "#d29922", "margin-bottom": "12px" }}>
          <div style={{ "font-weight": 600, "margin-bottom": "4px" }}>Version mismatch detected</div>
          <div style={{ color: "#8b949e" }}>
            Some hosts are running different daemon versions. To upgrade, SSH into each host and run:
          </div>
          <code style={{ display: "block", "margin-top": "6px", padding: "6px 10px", background: "#0d1117", "border-radius": "4px", color: "#e6edf3", "font-size": "12px" }}>
            sudo apt update && sudo apt upgrade orca-daemon
          </code>
        </div>
      </Show>

      {/* Grid */}
      <div
        style={{
          display: "grid",
          "grid-template-columns": "repeat(auto-fill, minmax(320px, 1fr))",
          gap: "16px",
        }}
      >
        <For each={filteredHosts()}>
          {(host) => (
            <div
              class="fleet-card"
              onClick={(e) => handleCardClick(host, e)}
              style={{
                background: "#161b22",
                border: `1px solid ${selectedHosts().has(host.id) ? "#1f6feb" : host.online ? "#1a7f37" : host.checking ? "#30363d" : "#da3633"}`,
                "border-radius": "10px",
                padding: "20px",
                cursor: "pointer",
                transition: "all 0.2s ease",
                opacity: host.online || host.checking ? "1" : "0.65",
                position: "relative",
                overflow: "hidden",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
                (e.currentTarget as HTMLElement).style.boxShadow = host.online
                  ? "0 4px 20px rgba(26, 127, 55, 0.15)"
                  : "0 4px 20px rgba(0,0,0,0.3)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.transform = "none";
                (e.currentTarget as HTMLElement).style.boxShadow = "none";
              }}
            >
              {/* Select checkbox in select mode */}
              <Show when={selectMode()}>
                <div
                  style={{
                    position: "absolute", top: "10px", right: "10px",
                    width: "20px", height: "20px", "border-radius": "4px",
                    border: `2px solid ${selectedHosts().has(host.id) ? "#1f6feb" : "#484f58"}`,
                    background: selectedHosts().has(host.id) ? "#1f6feb" : "transparent",
                    display: "flex", "align-items": "center", "justify-content": "center",
                    "z-index": "1",
                  }}
                >
                  <Show when={selectedHosts().has(host.id)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </Show>
                </div>
              </Show>

              {/* Header row: status dot + name */}
              <div style={{ display: "flex", "align-items": "center", gap: "10px", "margin-bottom": "4px" }}>
                <Show when={host.checking}>
                  <span
                    style={{
                      width: "10px",
                      height: "10px",
                      "border-radius": "50%",
                      background: "#484f58",
                      display: "inline-block",
                      "flex-shrink": "0",
                      animation: "pulse 1.5s infinite",
                    }}
                  />
                </Show>
                <Show when={!host.checking}>
                  <span
                    style={{
                      width: "10px",
                      height: "10px",
                      "border-radius": "50%",
                      background: host.online ? "#3fb950" : "#f85149",
                      "box-shadow": host.online ? "0 0 8px rgba(63, 185, 80, 0.4)" : "0 0 8px rgba(248, 81, 73, 0.4)",
                      display: "inline-block",
                      "flex-shrink": "0",
                    }}
                  />
                </Show>
                <span style={{ "font-size": "16px", "font-weight": "600", color: "#e6edf3" }}>
                  {host.name}
                </span>
                <Show when={host.id === null}>
                  <span
                    style={{
                      "font-size": "10px",
                      "font-weight": "600",
                      padding: "1px 6px",
                      "border-radius": "4px",
                      background: "#1f6feb22",
                      color: "#58a6ff",
                      "text-transform": "uppercase",
                      "letter-spacing": "0.5px",
                    }}
                  >
                    Local
                  </span>
                </Show>
              </div>

              {/* URL */}
              <div style={{ color: "#484f58", "font-size": "12px", "margin-bottom": "6px", "font-family": "monospace" }}>
                {host.url}
              </div>

              {/* Tags */}
              <Show when={(host.tags || []).length > 0}>
                <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px", "margin-bottom": "10px" }}>
                  <For each={host.tags || []}>
                    {(tag) => {
                      const c = tagColor(tag);
                      return (
                        <span style={{
                          padding: "1px 7px",
                          "border-radius": "10px",
                          "font-size": "10px",
                          "font-weight": "500",
                          background: c.bg,
                          color: c.color,
                          border: `1px solid ${c.border}`,
                        }}>
                          {tag}
                        </span>
                      );
                    }}
                  </For>
                </div>
              </Show>

              {/* Checking state */}
              <Show when={host.checking}>
                <div style={{ color: "#8b949e", "font-size": "13px", "font-style": "italic" }}>
                  Checking...
                </div>
              </Show>

              {/* Offline error */}
              <Show when={!host.checking && !host.online}>
                <div style={{ color: "#f85149", "font-size": "13px" }}>
                  Offline
                  <Show when={host.error}>
                    <span style={{ color: "#8b949e", "font-size": "12px", display: "block", "margin-top": "4px", "word-break": "break-all" }}>
                      {host.error}
                    </span>
                  </Show>
                  {(() => {
                    const key = host.id || "__local__";
                    const ts = lastSeen()[key];
                    return ts ? (
                      <span style={{ color: "#8b949e", "font-size": "12px", display: "block", "margin-top": "4px" }}>
                        Last seen {relativeTime(ts)}
                      </span>
                    ) : null;
                  })()}
                </div>
              </Show>

              {/* Online details */}
              <Show when={!host.checking && host.online}>
                {/* Version */}
                <Show when={host.version}>
                  <div style={{ color: "#8b949e", "font-size": "13px", "margin-bottom": "4px" }}>
                    Orca {host.version}
                    <Show when={host.docker_connected === false}>
                      <span style={{ color: "#d29922", "margin-left": "8px" }}>(Docker disconnected)</span>
                    </Show>
                  </div>
                </Show>

                {/* OS / Architecture */}
                <Show when={host.os || host.arch}>
                  <div style={{ color: "#484f58", "font-size": "12px", "margin-bottom": "10px" }}>
                    {[host.os, host.arch].filter(Boolean).join(" \u00B7 ")}
                  </div>
                </Show>

                {/* Resources row */}
                <Show when={host.cpu_count != null || host.memory_total != null}>
                  <div style={{ display: "flex", gap: "16px", "margin-bottom": "8px", color: "#c9d1d9", "font-size": "13px" }}>
                    <Show when={host.cpu_count != null}>
                      <span>{host.cpu_count} CPU</span>
                    </Show>
                    <Show when={host.memory_total != null}>
                      <span>{formatBytes(host.memory_total!)} RAM</span>
                    </Show>
                  </div>
                </Show>

                {/* Disk usage */}
                <Show when={host.disk_usage_percent != null}>
                  <div style={{ "margin-bottom": "10px" }}>
                    <div style={{ display: "flex", "justify-content": "space-between", "font-size": "12px", color: "#8b949e", "margin-bottom": "4px" }}>
                      <span>Disk</span>
                      <span>{host.disk_usage_percent!.toFixed(1)}%</span>
                    </div>
                    <div style={{ height: "4px", background: "#21262d", "border-radius": "2px", overflow: "hidden" }}>
                      <div
                        style={{
                          height: "100%",
                          width: `${Math.min(host.disk_usage_percent!, 100)}%`,
                          background: host.disk_usage_percent! > 90 ? "#f85149" : host.disk_usage_percent! > 75 ? "#d29922" : "#3fb950",
                          "border-radius": "2px",
                          transition: "width 0.3s ease",
                        }}
                      />
                    </div>
                  </div>
                </Show>

                {/* Containers + Images */}
                <div style={{ display: "flex", gap: "16px", "font-size": "13px" }}>
                  <Show when={host.containers_total != null}>
                    <span style={{ color: "#c9d1d9" }}>
                      <span style={{ color: "#3fb950", "font-weight": "600" }}>
                        {host.containers_running ?? 0}
                      </span>
                      <span style={{ color: "#8b949e" }}>
                        {" "}/ {host.containers_total} containers
                      </span>
                    </span>
                  </Show>
                  <Show when={host.images_total != null}>
                    <span style={{ color: "#8b949e" }}>
                      {host.images_total} images
                    </span>
                  </Show>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>

      {/* Pulse animation for checking state */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .fleet-card:active {
          transform: scale(0.98) !important;
        }
      `}</style>
    </div>
  );
}
