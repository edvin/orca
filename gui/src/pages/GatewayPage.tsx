import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { GatewayStatus, GatewayRoute, Container } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { showToast } from "../components/Toast";
import { confirmDanger } from "../components/ConfirmDialog";
import { logError } from "../lib/activityStore";
import Dropdown from "../components/Dropdown";

interface GatewayPageProps {
  onNavigate?: (target: string) => void;
}

export default function GatewayPage(props: GatewayPageProps) {
  const [status, setStatus] = createSignal<GatewayStatus | null>(null);
  const [routes, setRoutes] = createSignal<GatewayRoute[]>([]);
  const [showAdd, setShowAdd] = createSignal(false);
  const [starting, setStarting] = createSignal(false);

  // Add route form
  const [addHostname, setAddHostname] = createSignal("");
  const [addContainer, setAddContainer] = createSignal("");
  const [addPort, setAddPort] = createSignal("80");
  const [containers, setContainers] = createSignal<Container[]>([]);
  const [adding, setAdding] = createSignal(false);

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

  const fetchContainers = async () => {
    try {
      const c = (await invoke("list_containers")) as Container[];
      setContainers(c.filter((x) => x.name !== "orca-gateway"));
    } catch {}
  };

  const refresh = () => {
    fetchStatus();
    fetchRoutes();
  };

  useRefresh(refresh);
  onMount(refresh);

  const handleStart = async () => {
    setStarting(true);
    try {
      await invoke("gateway_start");
      showToast("Gateway started", "success");
      await refresh();
    } catch (e) {
      logError(`Failed to start gateway: ${e}`);
      showToast(`Failed to start gateway: ${e}`, "error");
    }
    setStarting(false);
  };

  const handleStop = async () => {
    try {
      await invoke("gateway_stop");
      showToast("Gateway stopped", "success");
      await refresh();
    } catch (e) {
      logError(`Failed to stop gateway: ${e}`);
      showToast(`Failed to stop gateway: ${e}`, "error");
    }
  };

  const openAddDialog = () => {
    setAddHostname("");
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
    return port === 443 ? `https://${full}` : `https://${full}:${port}`;
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">Gateway</h1>
        <div class="page-actions">
          <Show when={status()?.running}>
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

      {/* Status Card */}
      <Show when={status()}>
        {(s) => (
          <div class="card" style={{ "margin-bottom": "20px" }}>
            <div class="card-grid" style={{ "grid-template-columns": "repeat(4, 1fr)" }}>
              <div>
                <span class="card-label">Status</span>
                <span class="card-value">
                  <span style={{
                    display: "inline-block",
                    width: "8px",
                    height: "8px",
                    "border-radius": "50%",
                    background: s().running ? "#3fb950" : "#8b949e",
                    "margin-right": "6px",
                    "vertical-align": "middle",
                  }} />
                  {s().running ? "Running" : "Stopped"}
                </span>
              </div>
              <div>
                <span class="card-label">Domain</span>
                <span class="card-value">*.{s().domain}</span>
              </div>
              <div>
                <span class="card-label">TLS</span>
                <span class="card-value">{s().tls_mode === "orca_ca" ? "Orca CA" : "Custom"}</span>
              </div>
              <div>
                <span class="card-label">Routes</span>
                <span class="card-value">{s().routes_active} active</span>
              </div>
              <div>
                <span class="card-label">HTTP Port</span>
                <span class="card-value mono">:{s().http_port}</span>
              </div>
              <div>
                <span class="card-label">HTTPS Port</span>
                <span class="card-value mono">:{s().https_port}</span>
              </div>
              <Show when={s().container_id}>
                <div>
                  <span class="card-label">Container ID</span>
                  <span class="card-value mono" style={{ "font-size": "11px" }}>{s().container_id?.substring(0, 12)}</span>
                </div>
              </Show>
            </div>
          </div>
        )}
      </Show>

      {/* Routes Table or CTA */}
      <Show
        when={status()?.running}
        fallback={
          <div class="empty">
            <div class="empty-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </div>
            <p class="empty-title">Gateway is not running</p>
            <p>Start the gateway to route hostnames to your containers with automatic TLS.</p>
            <button class="btn btn-primary" onClick={handleStart} disabled={starting()} style={{ "margin-top": "12px" }}>
              {starting() ? "Starting..." : "Enable Gateway"}
            </button>
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
                        {route.hostname}
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
                onClick={() => props.onNavigate?.("settings:privacy")}
              >
                Settings &rarr; Privacy &amp; Security
              </button>
            </span>
          </div>
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
                    Port <span style={{ color: "#f85149" }}>*</span>
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
                </div>

                <Show when={previewUrl()}>
                  <div style={{ "font-size": "12px", color: "#8b949e", "margin-top": "8px" }}>
                    URL: <span class="mono" style={{ color: "#58a6ff" }}>{previewUrl()}</span>
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
    </div>
  );
}
