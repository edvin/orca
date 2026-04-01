import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { GatewayStatus, GatewayRoute, Container, StackLinkGroup } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { showToast } from "../components/Toast";
import { confirmDanger } from "../components/ConfirmDialog";
import { logError } from "../lib/activityStore";
import Dropdown from "../components/Dropdown";

interface GatewayPageProps {
  onNavigate?: (target: string) => void;
}

/** Map common Docker / Caddy errors to user-friendly messages. */
function friendlyStartError(raw: string): string {
  if (raw.includes("port is already allocated")) {
    const port = raw.match(/port\s+(\d+)/i)?.[1] ?? "";
    return `Port ${port} is already in use. Change the port in the Configuration section below or stop the conflicting service.`;
  }
  if (raw.includes("No such image") || raw.includes("not found") || raw.includes("pull")) {
    return "Could not download caddy:2-alpine. Check your internet connection.";
  }
  if (raw.includes("admin API") || raw.includes("not responding")) {
    return "Gateway started but Caddy is not responding. Check Settings > About > Daemon Log.";
  }
  return raw;
}

export default function GatewayPage(props: GatewayPageProps) {
  const [status, setStatus] = createSignal<GatewayStatus | null>(null);
  const [routes, setRoutes] = createSignal<GatewayRoute[]>([]);
  const [showAdd, setShowAdd] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  const [startError, setStartError] = createSignal<string | null>(null);

  // Add route form
  const [addHostname, setAddHostname] = createSignal("");
  const [addPath, setAddPath] = createSignal("");
  const [addContainer, setAddContainer] = createSignal("");
  const [addPort, setAddPort] = createSignal("80");
  const [containers, setContainers] = createSignal<Container[]>([]);
  const [adding, setAdding] = createSignal(false);

  // Environment links
  const [stackLinks, setStackLinks] = createSignal<StackLinkGroup[]>([]);
  const [selectedEnv, setSelectedEnv] = createSignal("local");
  const [collapsedGroups, setCollapsedGroups] = createSignal<Record<string, boolean>>({});


  // Configuration
  const [cfgDomain, setCfgDomain] = createSignal("localhost");
  const [cfgHttpPort, setCfgHttpPort] = createSignal("80");
  const [cfgHttpsPort, setCfgHttpsPort] = createSignal("443");
  const [cfgTlsMode, setCfgTlsMode] = createSignal<"orca_ca" | "custom">("orca_ca");
  const [cfgCustomCert, setCfgCustomCert] = createSignal("");
  const [cfgCustomKey, setCfgCustomKey] = createSignal("");
  const [cfgSaving, setCfgSaving] = createSignal(false);
  const [cfgLoaded, setCfgLoaded] = createSignal(false);
  const [portConflicts, setPortConflicts] = createSignal<string[]>([]);
  const [checkingPorts, setCheckingPorts] = createSignal(false);

  const loadConfig = async () => {
    try {
      const config = (await invoke("gateway_get_config")) as any;
      setCfgDomain(config.domain || "localhost");
      setCfgHttpPort(String(config.http_port || 80));
      setCfgHttpsPort(String(config.https_port || 443));
      setCfgTlsMode(config.tls_mode === "custom" ? "custom" : "orca_ca");
      setCfgCustomCert(config.custom_cert || "");
      setCfgCustomKey(config.custom_key || "");
      setCfgLoaded(true);
    } catch { setCfgLoaded(true); }
  };

  const saveConfig = async () => {
    setCfgSaving(true);
    try {
      await invoke("gateway_update_config", {
        domain: cfgDomain(),
        httpPort: parseInt(cfgHttpPort(), 10) || 80,
        httpsPort: parseInt(cfgHttpsPort(), 10) || 443,
        tlsMode: cfgTlsMode(),
        customCert: cfgCustomCert() || null,
        customKey: cfgCustomKey() || null,
      });
      showToast("Gateway configuration saved", "success");
    } catch (e) {
      showToast(`Failed to save: ${e}`, "error");
    }
    setCfgSaving(false);
  };

  const checkPorts = async () => {
    setCheckingPorts(true);
    try {
      const httpP = parseInt(cfgHttpPort(), 10) || 80;
      const httpsP = parseInt(cfgHttpsPort(), 10) || 443;
      const result = (await invoke("gateway_check_ports", { httpPort: httpP, httpsPort: httpsP })) as { conflicts: string[] };
      setPortConflicts(result.conflicts || []);
      if (result.conflicts.length === 0) showToast("Ports are available", "success");
    } catch {}
    setCheckingPorts(false);
  };

  const httpConflict = () => portConflicts().find((c) => c.includes("HTTP"));
  const httpsConflict = () => portConflicts().find((c) => c.includes("HTTPS"));

  const fetchStatus = async () => {
    try {
      const s = (await invoke("gateway_status")) as GatewayStatus;
      setStatus(s);
    } catch (e) {
      logError(`Failed to fetch gateway status: ${e}`);
    }
  };

  const fetchRoutes = async () => {
    try {
      const r = (await invoke("gateway_list_routes")) as GatewayRoute[];
      setRoutes(r);
    } catch (e) {
      logError(`Failed to fetch gateway routes: ${e}`);
    }
  };

  const fetchLinks = async () => {
    try {
      const links = (await invoke("gateway_get_links")) as StackLinkGroup[];
      setStackLinks(links || []);
    } catch {
      // Links may not be available yet
    }
  };

  const fetchContainers = async () => {
    try {
      const c = (await invoke("list_containers")) as Container[];
      setContainers(c.filter((x) => x.name !== "orca-gateway"));
    } catch {}
  };


  const refresh = () => {
    fetchStatus();
    fetchRoutes();
    fetchLinks();
  };

  useRefresh(refresh);
  onMount(() => { refresh(); loadConfig(); });

  const handleStart = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await invoke("gateway_start");
      showToast("Gateway started", "success");
      await refresh();
    } catch (e) {
      const raw = String(e);
      const friendly = friendlyStartError(raw);
      logError(`Failed to start gateway: ${raw}`);
      showToast(`Failed to start gateway: ${friendly}`, "error");
      setStartError(friendly);
    }
    setStarting(false);
  };

  const handleStop = async () => {
    try {
      await invoke("gateway_stop");
      showToast("Gateway stopped", "success");
      setStartError(null);
      await refresh();
    } catch (e) {
      logError(`Failed to stop gateway: ${e}`);
      showToast(`Failed to stop gateway: ${e}`, "error");
    }
  };

  const openAddDialog = () => {
    setAddHostname("");
    setAddPath("");
    setAddContainer("");
    setAddPort("80");
    fetchContainers();
    setShowAdd(true);
  };

  const handleAddRoute = async (e: Event) => {
    e.preventDefault();
    const hostname = addHostname().trim();
    const containerName = addContainer();
    const port = parseInt(addPort(), 10);
    if (!hostname || !containerName || isNaN(port)) return;

    const s = status();
    const domain = s?.domain || "localhost";
    const fullHostname = hostname.includes(".") ? hostname : `${hostname}.${domain}`;

    setAdding(true);
    try {
      await invoke("gateway_add_route", {
        hostname: fullHostname,
        containerName,
        port,
        path: addPath().trim() || null,
      });
      showToast(`Route added: ${fullHostname}`, "success");
      setShowAdd(false);
      await refresh();
    } catch (e) {
      logError(`Failed to add route: ${e}`);
      showToast(`Failed to add route: ${e}`, "error");
    }
    setAdding(false);
  };

  const handleRemoveRoute = async (hostname: string) => {
    if (!(await confirmDanger("Remove Route", `Remove route for "${hostname}"?`))) return;
    try {
      await invoke("gateway_remove_route", { hostname });
      showToast(`Route "${hostname}" removed`, "success");
      await refresh();
    } catch (e) {
      logError(`Failed to remove route: ${e}`);
      showToast(`Failed to remove route: ${e}`, "error");
    }
  };

  const handleToggleRoute = async (route: GatewayRoute) => {
    try {
      await invoke("gateway_update_route", {
        hostname: route.hostname,
        containerName: route.container_name,
        port: route.port,
        enabled: !route.enabled,
      });
      await refresh();
    } catch (e) {
      logError(`Failed to toggle route: ${e}`);
      showToast(`Failed to toggle route: ${e}`, "error");
    }
  };

  const openUrl = (url: string) => {
    shellOpen(url).catch(() => {
      window.open(url, "_blank");
    });
  };

  const landingUrl = () => {
    const s = status();
    if (!s) return "";
    const port = s.https_port;
    return port === 443 ? `https://${s.domain}` : `https://${s.domain}:${port}`;
  };

  // Derive all unique environment names across all links
  const allEnvNames = () => {
    const envs = new Set<string>();
    for (const group of stackLinks()) {
      for (const link of group.links) {
        for (const env of Object.keys(link.urls)) {
          envs.add(env);
        }
      }
    }
    // Put "local" first, then sort the rest
    const sorted = Array.from(envs).filter((e) => e !== "local").sort();
    if (envs.has("local")) sorted.unshift("local");
    return sorted;
  };

  // Resolve a link URL for display. "local" values that are plain hostnames
  // get expanded to full gateway URLs.
  const resolveUrl = (env: string, value: string) => {
    if (env === "local" && !value.includes("://")) {
      const s = status();
      const domain = s?.domain || "localhost";
      const port = s?.https_port || 443;
      const hostname = value.includes(".") ? value : `${value}.${domain}`;
      return port === 443 ? `https://${hostname}` : `https://${hostname}:${port}`;
    }
    return value;
  };

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  let mouseDownOnOverlay = false;
  const handleOverlayMouseDown = (e: MouseEvent) => {
    mouseDownOnOverlay = (e.target as HTMLElement).classList.contains("modal-overlay");
  };
  const handleOverlayClick = (e: MouseEvent) => {
    if (mouseDownOnOverlay && (e.target as HTMLElement).classList.contains("modal-overlay")) {
      setShowAdd(false);
    }
    mouseDownOnOverlay = false;
  };

  const previewUrl = () => {
    const hostname = addHostname().trim();
    if (!hostname) return "";
    const s = status();
    const domain = s?.domain || "localhost";
    const full = hostname.includes(".") ? hostname : `${hostname}.${domain}`;
    const port = s?.https_port || 443;
    const pathPart = addPath().trim();
    const base = port === 443 ? `https://${full}` : `https://${full}:${port}`;
    return pathPart ? `${base}${pathPart}` : base;
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">Gateway</h1>
        <div class="page-actions">
          <Show when={status()?.running}>
            <button class="btn" onClick={() => openUrl(landingUrl())} title="Open gateway landing page in browser">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "margin-right": "4px", "vertical-align": "-2px" }}>
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
              </svg>
              Open Gateway
            </button>
            <button class="btn" onClick={openAddDialog}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "margin-right": "4px", "vertical-align": "-2px" }}>
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add Route
            </button>
          </Show>
          <Show
            when={status()?.running}
            fallback={
              <button class="btn btn-primary" onClick={handleStart} disabled={starting()}>
                {starting() ? "Starting..." : "Start Gateway"}
              </button>
            }
          >
            <button class="btn" onClick={handleStop} style={{ color: "#f85149", "border-color": "#f85149" }}>
              Stop Gateway
            </button>
          </Show>
          <button class="btn" onClick={refresh}>Refresh</button>
        </div>
      </div>

      {/* Port conflict warnings */}
      <Show when={(status()?.port_conflicts?.length ?? 0) > 0}>
        <div style={{
          background: "rgba(210, 153, 34, 0.1)",
          border: "1px solid rgba(210, 153, 34, 0.3)",
          "border-radius": "8px",
          padding: "12px 16px",
          "margin-bottom": "16px",
          display: "flex",
          "align-items": "flex-start",
          gap: "10px",
          "font-size": "13px",
          color: "#d29922",
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "flex-shrink": "0", "margin-top": "1px" }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div>
            <div style={{ "font-weight": "600", "margin-bottom": "4px" }}>Port Conflict Detected</div>
            <For each={status()?.port_conflicts ?? []}>
              {(conflict) => <div>{conflict}</div>}
            </For>
            <div style={{ "margin-top": "4px", "font-size": "12px", color: "#8b949e" }}>
              Change the ports in{" "}
              Change the port in the Configuration section below or stop the conflicting service.
            </div>
          </div>
        </div>
      </Show>

      {/* Start error banner */}
      <Show when={startError()}>
        <div style={{
          background: "rgba(248, 81, 73, 0.1)",
          border: "1px solid rgba(248, 81, 73, 0.3)",
          "border-radius": "8px",
          padding: "12px 16px",
          "margin-bottom": "16px",
          display: "flex",
          "align-items": "flex-start",
          gap: "10px",
          "font-size": "13px",
          color: "#f85149",
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "flex-shrink": "0", "margin-top": "1px" }}>
            <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <div>
            <div style={{ "font-weight": "600", "margin-bottom": "4px" }}>Failed to Start Gateway</div>
            <div style={{ color: "#e6edf3" }}>{startError()}</div>
          </div>
          <button
            style={{ "margin-left": "auto", background: "none", border: "none", cursor: "pointer", color: "#8b949e", "flex-shrink": "0" }}
            onClick={() => setStartError(null)}
            title="Dismiss"
          >
            {"\u00d7"}
          </button>
        </div>
      </Show>

      {/* Status Card (when running) */}
      <Show when={status()?.running ? status() : undefined}>
        {(s) => (
          <div class="card" style={{ "margin-bottom": "20px" }}>
            <div style={{ display: "grid", "grid-template-columns": "repeat(4, 1fr)", gap: "16px 24px", "font-size": "13px" }}>
              <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                <span class="card-label">Status</span>
                <span class="card-value" style={{ display: "inline-flex", "align-items": "center", gap: "6px" }}>
                  <span style={{
                    display: "inline-block",
                    width: "8px",
                    height: "8px",
                    "border-radius": "50%",
                    background: "#3fb950",
                  }} />
                  Running
                </span>
              </div>
              <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                <span class="card-label">Domain</span>
                <span class="card-value">*.{s().domain}</span>
              </div>
              <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                <span class="card-label">TLS</span>
                <span class="card-value">{s().tls_mode === "orca_ca" ? "Orca CA" : "Custom"}</span>
              </div>
              <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                <span class="card-label">Routes</span>
                <span class="card-value">{s().routes_active} active</span>
              </div>
              <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                <span class="card-label">HTTP Port</span>
                <span class="card-value mono">:{s().http_port}</span>
              </div>
              <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                <span class="card-label">HTTPS Port</span>
                <span class="card-value mono">:{s().https_port}</span>
              </div>
              <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                <span class="card-label">Landing Page</span>
                <span class="card-value">
                  <button
                    class="btn-link"
                    style={{ color: "#58a6ff", background: "none", border: "none", cursor: "pointer", "font-size": "13px", padding: "0" }}
                    onClick={() => openUrl(landingUrl())}
                  >
                    {landingUrl()}
                  </button>
                </span>
              </div>
              <Show when={s().container_id}>
                <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                  <span class="card-label">Container ID</span>
                  <span class="card-value mono" style={{ "font-size": "11px" }}>{s().container_id?.substring(0, 12)}</span>
                </div>
              </Show>
            </div>
          </div>
        )}
      </Show>

      {/* Routes Table or Onboarding */}
      <Show
        when={status()?.running}
        fallback={
          <div>
            {/* Orca Gateway */}
            <div class="card" style={{ "margin-bottom": "16px" }}>
              <div style={{ "margin-bottom": "16px" }}>
                <div style={{ display: "flex", "align-items": "center", gap: "10px", "margin-bottom": "12px" }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                  <h2 style={{ color: "#e6edf3", "font-size": "16px", "font-weight": "600", margin: "0" }}>Orca Gateway</h2>
                </div>
                <p style={{ color: "#8b949e", "font-size": "13px", "line-height": "1.6", margin: "0 0 16px 0" }}>
                  Orca Gateway is a managed reverse proxy that gives your containers clean hostnames with automatic TLS.
                </p>
                <div style={{
                  background: "#161b22",
                  "border-radius": "8px",
                  padding: "12px 16px",
                  "margin-bottom": "16px",
                  "font-family": "'SF Mono', 'Fira Code', monospace",
                  "font-size": "13px",
                  "line-height": "1.8",
                }}>
                  <div style={{ color: "#8b949e" }}>Instead of: <span style={{ color: "#f85149" }}>http://localhost:8095</span></div>
                  <div style={{ color: "#8b949e" }}>Access at: <span style={{ color: "#3fb950" }}>https://webmail.localhost</span></div>
                </div>
                <div style={{ display: "flex", "flex-direction": "column", gap: "8px", color: "#c9d1d9", "font-size": "13px" }}>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <span style={{ color: "#3fb950" }}>&#x2022;</span> Automatic HTTPS via the Orca Certificate Authority
                  </div>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <span style={{ color: "#3fb950" }}>&#x2022;</span> .localhost domains work in all browsers
                  </div>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <span style={{ color: "#3fb950" }}>&#x2022;</span> Custom domains for teams (*.local.company.dev)
                  </div>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <span style={{ color: "#3fb950" }}>&#x2022;</span> WebSocket, SSE, HTTP/2 proxied transparently
                  </div>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <span style={{ color: "#3fb950" }}>&#x2022;</span> orca.yaml in your repo auto-registers routes
                  </div>
                </div>
                <div style={{ display: "flex", gap: "8px", "margin-top": "20px" }}>
                  <button class="btn btn-primary" onClick={handleStart} disabled={starting()}>
                    {starting() ? "Starting..." : "Start Gateway"}
                  </button>
                </div>
              </div>
            </div>

            {/* Prerequisites */}
            <div class="card">
              <h3 style={{ color: "#e6edf3", "font-size": "14px", "font-weight": "600", margin: "0 0 12px 0" }}>Prerequisites</h3>
              <div style={{ display: "flex", "flex-direction": "column", gap: "10px", color: "#c9d1d9", "font-size": "13px" }}>
                <div style={{ display: "flex", gap: "10px" }}>
                  <span style={{ color: "#58a6ff", "font-weight": "600", "flex-shrink": "0" }}>1.</span>
                  <span>
                    Install the Orca CA certificate for trusted TLS.{" "}
                    <button
                      class="btn-link"
                      style={{ color: "#58a6ff", background: "none", border: "none", cursor: "pointer", "font-size": "13px", padding: "0" }}
                      onClick={() => props.onNavigate?.("settings:certificates")}
                    >
                      Settings &rarr; Certificates &rarr; Download CA
                    </button>
                  </span>
                </div>
                <div style={{ display: "flex", gap: "10px" }}>
                  <span style={{ color: "#58a6ff", "font-weight": "600", "flex-shrink": "0" }}>2.</span>
                  <span>Start the Gateway (pulls caddy:2-alpine, ~40MB)</span>
                </div>
                <div style={{ display: "flex", gap: "10px" }}>
                  <span style={{ color: "#58a6ff", "font-weight": "600", "flex-shrink": "0" }}>3.</span>
                  <span>Expose containers via the container detail page or here</span>
                </div>
              </div>
            </div>
          </div>
        }
      >
        <Show
          when={routes().length > 0}
          fallback={
            <div class="empty">
              <div class="empty-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              </div>
              <p class="empty-title">No routes configured</p>
              <p>Add a route to map a hostname to a running container.</p>
              <button class="btn btn-primary" onClick={openAddDialog} style={{ "margin-top": "12px" }}>
                Add Route
              </button>
            </div>
          }
        >
          <table class="table">
            <thead>
              <tr>
                <th>Hostname</th>
                <th>Container</th>
                <th>Port</th>
                <th>Status</th>
                <th style={{ "text-align": "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              <For each={routes()}>
                {(route) => (
                  <tr>
                    <td>
                      <button
                        class="btn-link"
                        style={{ color: "#58a6ff", cursor: "pointer", background: "none", border: "none", "font-size": "13px", padding: "0" }}
                        onClick={() => route.url && openUrl(route.url)}
                        title={route.url}
                      >
                        {route.hostname}{route.path || ""}
                      </button>
                    </td>
                    <td class="mono" style={{ color: "#c9d1d9" }}>{route.container_name}</td>
                    <td class="mono">{route.port}</td>
                    <td>
                      <span style={{
                        display: "inline-flex",
                        "align-items": "center",
                        gap: "6px",
                        color: route.enabled ? "#3fb950" : "#8b949e",
                        "font-size": "12px",
                      }}>
                        <span style={{
                          display: "inline-block",
                          width: "6px",
                          height: "6px",
                          "border-radius": "50%",
                          background: route.enabled ? "#3fb950" : "#8b949e",
                        }} />
                        {route.enabled ? "Active" : "Disabled"}
                      </span>
                    </td>
                    <td style={{ "text-align": "right" }}>
                      <button
                        class="action-icon"
                        title={route.enabled ? "Disable" : "Enable"}
                        onClick={() => handleToggleRoute(route)}
                        style={{ "margin-right": "4px" }}
                      >
                        <Show when={route.enabled} fallback={
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        }>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                        </Show>
                      </button>
                      <button
                        class="action-icon action-icon-delete"
                        title="Remove route"
                        onClick={() => handleRemoveRoute(route.hostname)}
                        style={{ color: "#f85149" }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </Show>

      {/* CA Trust Note */}
      <Show when={status()?.running && status()?.tls_mode === "orca_ca"}>
        <div class="card" style={{ "margin-top": "16px", background: "#161b22", "border-color": "#30363d" }}>
          <div style={{ display: "flex", "align-items": "center", gap: "10px", "font-size": "12px", color: "#8b949e" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span>
              Install the Orca CA certificate to trust HTTPS connections.{" "}
              <button
                class="btn-link"
                style={{ color: "#58a6ff", background: "none", border: "none", cursor: "pointer", "font-size": "12px", padding: "0" }}
                onClick={() => props.onNavigate?.("settings:certificates")}
              >
                Settings &rarr; Certificates
              </button>
            </span>
          </div>
        </div>
      </Show>

      {/* Environment Links (read-only) */}
      <Show when={status()?.running && stackLinks().length > 0}>
        <div style={{ "margin-top": "24px" }}>
          <h3 style={{ color: "#e6edf3", "font-size": "14px", "font-weight": "600", "margin-bottom": "12px" }}>Environment Links</h3>

          {/* Environment tabs */}
          <Show when={allEnvNames().length > 1}>
            <div style={{ display: "flex", gap: "4px", "margin-bottom": "16px", "flex-wrap": "wrap" }}>
              <For each={allEnvNames()}>
                {(env) => (
                  <button
                    class="btn"
                    style={{
                      "font-size": "12px",
                      padding: "4px 12px",
                      "text-transform": "capitalize",
                      ...(selectedEnv() === env
                        ? { background: "#1f6feb", color: "#fff", "border-color": "#1f6feb" }
                        : {}),
                    }}
                    onClick={() => setSelectedEnv(env)}
                  >
                    {env}
                  </button>
                )}
              </For>
            </div>
          </Show>

          {/* Link groups */}
          <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
            <For each={stackLinks()}>
              {(group) => {
                const groupKey = () => `${group.stack}:${group.group}`;
                const isCollapsed = () => collapsedGroups()[groupKey()] ?? false;
                return (
                  <div style={{
                    background: "rgba(22, 27, 34, 0.6)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    "border-radius": "12px",
                    overflow: "hidden",
                  }}>
                    {/* Group header */}
                    <div style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "8px",
                      padding: "10px 16px",
                      "border-bottom": isCollapsed() ? "none" : "1px solid rgba(255,255,255,0.06)",
                    }}>
                      <button
                        onClick={() => toggleGroup(groupKey())}
                        style={{
                          background: "none",
                          border: "none",
                          color: "#e6edf3",
                          cursor: "pointer",
                          padding: "0",
                          display: "flex",
                          "align-items": "center",
                        }}
                      >
                        <svg
                          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                          style={{ transform: isCollapsed() ? "none" : "rotate(90deg)", transition: "transform 0.15s" }}
                        >
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </button>

                      <span style={{ color: "#6e7681", "font-size": "12px", "flex-shrink": "0" }}>{group.stack}</span>
                      <span style={{ color: "#484f58" }}>/</span>
                      <span style={{ color: "#e6edf3", "font-size": "13px", "font-weight": "600", flex: "1", "min-width": "0" }}>
                        {group.group}
                      </span>
                    </div>

                    {/* Links (read-only) */}
                    <Show when={!isCollapsed()}>
                      <div>
                        <For each={group.links}>
                          {(link) => {
                            const rawUrl = () => link.urls[selectedEnv()] || "";
                            const resolved = () => rawUrl() ? resolveUrl(selectedEnv(), rawUrl()) : "";

                            return (
                              <div style={{
                                display: "flex",
                                "align-items": "center",
                                padding: "8px 16px",
                                "border-bottom": "1px solid rgba(255,255,255,0.04)",
                                gap: "8px",
                              }}>
                                <span style={{
                                  color: "#c9d1d9",
                                  "font-size": "13px",
                                  width: "160px",
                                  "flex-shrink": "0",
                                  overflow: "hidden",
                                  "text-overflow": "ellipsis",
                                  "white-space": "nowrap",
                                }}>
                                  {link.name}
                                </span>

                                <Show
                                  when={resolved()}
                                  fallback={
                                    <span class="mono" style={{ color: "#484f58", "font-size": "12px", flex: "1", "font-style": "italic" }}>
                                      no {selectedEnv()} URL
                                    </span>
                                  }
                                >
                                  <button
                                    class="btn-link mono"
                                    style={{
                                      color: "#58a6ff",
                                      "font-size": "12px",
                                      flex: "1",
                                      "min-width": "0",
                                      overflow: "hidden",
                                      "text-overflow": "ellipsis",
                                      "white-space": "nowrap",
                                      background: "none",
                                      border: "none",
                                      cursor: "pointer",
                                      padding: "0",
                                      "text-align": "left",
                                    }}
                                    onClick={() => openUrl(resolved())}
                                    title={resolved()}
                                  >
                                    {resolved()}
                                  </button>
                                </Show>

                                {/* Open in browser */}
                                <Show when={resolved()}>
                                  <button
                                    class="action-icon"
                                    title="Open in browser"
                                    onClick={() => openUrl(resolved())}
                                    style={{ "flex-shrink": "0" }}
                                  >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                                      <polyline points="15 3 21 3 21 9" />
                                      <line x1="10" y1="14" x2="21" y2="3" />
                                    </svg>
                                  </button>
                                </Show>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>

          <p style={{ "font-size": "11px", color: "#6e7681", "margin-top": "10px" }}>
            Environment links are configured in your project's <code style={{ background: "#161b22", padding: "2px 6px", "border-radius": "4px", "font-size": "11px" }}>orca.yaml</code>
          </p>
        </div>
      </Show>

      {/* Add Route Dialog */}
      <Show when={showAdd()}>
        <div class="modal-overlay" onMouseDown={handleOverlayMouseDown} onClick={handleOverlayClick}>
          <div class="modal-dialog">
            <div class="modal-header">
              <h2 class="modal-title">Add Route</h2>
              <button class="modal-close" onClick={() => setShowAdd(false)}>
                {"\u00d7"}
              </button>
            </div>
            <form onSubmit={handleAddRoute}>
              <div class="modal-body">
                <p style={{ "font-size": "12px", color: "#8b949e", "margin-bottom": "16px", "line-height": "1.6" }}>
                  Map a hostname to a container's internal port. The Gateway serves it over HTTPS on ports {status()?.http_port || 80}/{status()?.https_port || 443}.
                </p>
                <div class="form-group">
                  <label class="form-label">
                    Hostname <span style={{ color: "#f85149" }}>*</span>
                  </label>
                  <div style={{ display: "flex", "align-items": "center", gap: "4px" }}>
                    <input
                      class="form-input"
                      type="text"
                      placeholder="myapp"
                      value={addHostname()}
                      onInput={(e) => setAddHostname(e.currentTarget.value)}
                      autofocus
                      style={{ flex: "1" }}
                    />
                    <span style={{ color: "#8b949e", "font-size": "13px", "white-space": "nowrap" }}>
                      .{status()?.domain || "localhost"}
                    </span>
                  </div>
                </div>

                <div class="form-group">
                  <label class="form-label">Path (optional)</label>
                  <input
                    class="form-input"
                    type="text"
                    placeholder="/api/*"
                    value={addPath()}
                    onInput={(e) => setAddPath(e.currentTarget.value)}
                  />
                  <p style={{ "font-size": "11px", color: "#6e7681", "margin-top": "4px" }}>
                    Optional. Route a specific path to this container (e.g., /api/*, /ws/*)
                  </p>
                </div>

                <div class="form-group">
                  <label class="form-label">
                    Container <span style={{ color: "#f85149" }}>*</span>
                  </label>
                  <Dropdown
                    value={addContainer()}
                    options={containers().map((c) => ({ value: c.name, label: `${c.name} (${c.state})` }))}
                    onChange={(v) => setAddContainer(v)}
                    placeholder="Select container..."
                  />
                </div>

                <div class="form-group">
                  <label class="form-label">
                    Container Port <span style={{ color: "#f85149" }}>*</span>
                  </label>
                  <input
                    class="form-input"
                    type="number"
                    placeholder="80"
                    value={addPort()}
                    onInput={(e) => setAddPort(e.currentTarget.value)}
                    min="1"
                    max="65535"
                  />
                  <p style={{ "font-size": "11px", color: "#6e7681", "margin-top": "4px" }}>
                    The port your app listens on inside the container (e.g., 8080, 3000)
                  </p>
                </div>

                <Show when={previewUrl()}>
                  <div style={{ background: "#161b22", "border-radius": "6px", padding: "10px 14px", "margin-top": "12px", "font-size": "12px", "line-height": "1.6" }}>
                    <span style={{ color: "#8b949e" }}>Routing: </span>
                    <span class="mono" style={{ color: "#58a6ff" }}>{previewUrl()}</span>
                    <Show when={addContainer() && addPort()}>
                      <span style={{ color: "#6e7681" }}>{" \u2192 "}</span>
                      <span class="mono" style={{ color: "#3fb950" }}>{addContainer()}:{addPort()}</span>
                    </Show>
                  </div>
                </Show>
              </div>

              <div class="modal-footer">
                <button type="button" class="btn" onClick={() => setShowAdd(false)} disabled={adding()}>
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn-primary"
                  disabled={adding() || !addHostname().trim() || !addContainer()}
                >
                  {adding() ? "Adding..." : "Add Route"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </Show>

      {/* Configuration Section */}
      <Show when={cfgLoaded()}>
        <div style={{ "margin-top": "24px" }}>
          <h3 style={{ "font-size": "14px", "font-weight": "600", color: "#e6edf3", "margin-bottom": "16px" }}>Configuration</h3>
          <div class="card" style={{ padding: "20px" }}>
            <div class="form-group">
              <label class="form-label">Domain</label>
              <input class="form-input" type="text" value={cfgDomain()} onInput={(e) => setCfgDomain(e.currentTarget.value)} placeholder="localhost" />
              <p style={{ "font-size": "11px", color: "#6e7681", "margin-top": "4px" }}>Routes will be created as subdomains (e.g., myapp.{cfgDomain()})</p>
            </div>

            <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "12px" }}>
                <div class="form-group">
                  <label class="form-label">HTTP Port</label>
                  <input class="form-input" type="number" value={cfgHttpPort()} onInput={(e) => setCfgHttpPort(e.currentTarget.value)} min="1" max="65535" style={httpConflict() ? { "border-color": "#d29922" } : undefined} />
                  <Show when={httpConflict()}><p style={{ "font-size": "11px", color: "#d29922", "margin-top": "4px" }}>{httpConflict()}</p></Show>
                </div>
                <div class="form-group">
                  <label class="form-label">HTTPS Port</label>
                  <input class="form-input" type="number" value={cfgHttpsPort()} onInput={(e) => setCfgHttpsPort(e.currentTarget.value)} min="1" max="65535" style={httpsConflict() ? { "border-color": "#d29922" } : undefined} />
                  <Show when={httpsConflict()}><p style={{ "font-size": "11px", color: "#d29922", "margin-top": "4px" }}>{httpsConflict()}</p></Show>
                </div>
              </div>

              <div style={{ "margin-top": "12px", "margin-bottom": "12px" }}>
                <button class="btn" onClick={checkPorts} disabled={checkingPorts()} style={{ "font-size": "12px" }}>
                  {checkingPorts() ? "Checking..." : "Check Ports"}
                </button>
              </div>

              <div class="form-group">
                <label class="form-label">TLS Mode</label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button class="btn" style={{ background: cfgTlsMode() === "orca_ca" ? "#1f6feb" : undefined, color: cfgTlsMode() === "orca_ca" ? "#fff" : undefined, "border-color": cfgTlsMode() === "orca_ca" ? "#1f6feb" : undefined }} onClick={() => setCfgTlsMode("orca_ca")}>Orca CA (automatic)</button>
                  <button class="btn" style={{ background: cfgTlsMode() === "custom" ? "#1f6feb" : undefined, color: cfgTlsMode() === "custom" ? "#fff" : undefined, "border-color": cfgTlsMode() === "custom" ? "#1f6feb" : undefined }} onClick={() => setCfgTlsMode("custom")}>Custom Certificate</button>
                </div>
              </div>

              <Show when={cfgTlsMode() === "orca_ca"}>
                <div style={{ background: "#161b22", "border-radius": "6px", padding: "10px 14px", "margin-bottom": "12px", display: "flex", "align-items": "center", gap: "8px", "font-size": "12px", color: "#8b949e" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                  Install the Orca CA certificate for trusted HTTPS. <a style={{ color: "#58a6ff", "margin-left": "4px", cursor: "pointer" }} onClick={() => props.onNavigate?.("settings:certificates")}>Go to Certificates</a>
                </div>
              </Show>

              <Show when={cfgTlsMode() === "custom"}>
                <div class="form-group">
                  <label class="form-label">Certificate PEM</label>
                  <textarea class="form-input" rows={4} value={cfgCustomCert()} onInput={(e) => setCfgCustomCert(e.currentTarget.value)} placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"} style={{ "font-family": "monospace", "font-size": "11px" }} />
                </div>
                <div class="form-group">
                  <label class="form-label">Private Key PEM</label>
                  <textarea class="form-input" rows={4} value={cfgCustomKey()} onInput={(e) => setCfgCustomKey(e.currentTarget.value)} placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"} style={{ "font-family": "monospace", "font-size": "11px" }} />
                </div>
              </Show>

              <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-top": "16px" }}>
                <button class="btn btn-primary" onClick={saveConfig} disabled={cfgSaving()}>
                  {cfgSaving() ? "Saving..." : "Save Configuration"}
                </button>
                <span style={{ "font-size": "11px", color: "#6e7681" }}>Changes may require restarting the gateway</span>
              </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
