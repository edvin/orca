import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useRefresh } from "../lib/useRefresh";
import { formatBytes } from "../lib/format";
import type { RemoteHost, HostStatus } from "../lib/types";

// Module-level signal — persists across navigation
const [lastSeen, setLastSeen] = createSignal<Record<string, number>>({});

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

export default function FleetPage(props: FleetPageProps) {
  const [hosts, setHosts] = createSignal<HostStatus[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [lastUpdated, setLastUpdated] = createSignal<Date | null>(null);

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
      online: false,
      checking: true,
    }));
    return [localHost, ...remoteHosts];
  };

  const probeAll = async () => {
    const hostList = await buildHostList();
    // Show the checking state immediately
    setHosts(hostList);
    setLoading(false);

    // Probe all hosts in parallel
    const results = await Promise.allSettled(
      hostList.map(async (host) => {
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
          } as HostStatus;
        } catch (e) {
          return {
            ...host,
            checking: false,
            online: false,
            error: String(e),
          } as HostStatus;
        }
      })
    );

    const updated = results.map((r) =>
      r.status === "fulfilled" ? r.value : { ...hostList[0], checking: false, online: false, error: "Probe failed" }
    );
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
  };

  useRefresh(probeAll);

  onMount(() => {
    probeAll();
    const interval = setInterval(probeAll, 30000);
    onCleanup(() => clearInterval(interval));
  });

  const handleCardClick = async (host: HostStatus) => {
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
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "24px" }}>
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
        <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
          <Show when={lastUpdated()}>
            <span style={{ color: "#484f58", "font-size": "12px" }}>
              Updated {lastUpdated()!.toLocaleTimeString()}
            </span>
          </Show>
          <button
            class="btn-secondary"
            onClick={probeAll}
            style={{ padding: "6px 14px", "font-size": "13px", "border-radius": "6px", background: "#21262d", border: "1px solid #30363d", color: "#e6edf3", cursor: "pointer" }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Version mismatch warning */}
      <Show when={versionMismatch()}>
        <div style={{ padding: "8px 16px", background: "rgba(210, 169, 34, 0.1)", border: "1px solid rgba(210, 169, 34, 0.2)", "border-radius": "6px", "font-size": "12px", color: "#d29922", "margin-bottom": "12px" }}>
          Version mismatch detected — hosts are running different daemon versions. Update all hosts to the same version for best compatibility.
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
        <For each={hosts()}>
          {(host) => (
            <div
              class="fleet-card"
              onClick={() => handleCardClick(host)}
              style={{
                background: "#161b22",
                border: `1px solid ${host.online ? "#1a7f37" : host.checking ? "#30363d" : "#da3633"}`,
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
              <div style={{ color: "#484f58", "font-size": "12px", "margin-bottom": "14px", "font-family": "monospace" }}>
                {host.url}
              </div>

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
                  <div style={{ color: "#8b949e", "font-size": "13px", "margin-bottom": "10px" }}>
                    Orca {host.version}
                    <Show when={host.docker_connected === false}>
                      <span style={{ color: "#d29922", "margin-left": "8px" }}>(Docker disconnected)</span>
                    </Show>
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
