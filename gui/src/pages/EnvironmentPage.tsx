import { createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EnvironmentStatus, HealthCheck, MachineInfo, SystemHealth, DockerDesktopStatus } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { formatBytes } from "../lib/format";
import { showToast } from "../components/Toast";
import { logError } from "../lib/activityStore";

export default function EnvironmentPage() {
  const [status, setStatus] = createSignal<EnvironmentStatus | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [machine, setMachine] = createSignal<MachineInfo | null>(null);
  const [health, setHealth] = createSignal<SystemHealth | null>(null);

  // Docker Desktop migration state
  const [ddStatus, setDdStatus] = createSignal<DockerDesktopStatus | null>(null);
  const [migrating, setMigrating] = createSignal(false);
  const [stopDdChecked, setStopDdChecked] = createSignal(false);
  const [migrationDismissed, setMigrationDismissed] = createSignal(false);

  const isMacOS = () => navigator.platform.includes("Mac");

  // Action dialog state
  const [actionDialogOpen, setActionDialogOpen] = createSignal(false);
  const [actionName, setActionName] = createSignal("");
  const [actionRunning, setActionRunning] = createSignal(false);
  const [actionLog, setActionLog] = createSignal("");
  const [actionSuccess, setActionSuccess] = createSignal<boolean | null>(null);
  let mouseDownOnOverlay = false;
  let logRef: HTMLPreElement | undefined;

  // Tauri listener handles for env-fix streaming. Kept at component scope so
  // a fast unmount or a subsequent runFix invocation can tear them down
  // synchronously — preventing leaked listeners.
  let unlistenFixLine: UnlistenFn | null = null;
  let unlistenFixDone: UnlistenFn | null = null;
  const teardownFixListeners = () => {
    try { unlistenFixLine?.(); } catch {}
    try { unlistenFixDone?.(); } catch {}
    unlistenFixLine = null;
    unlistenFixDone = null;
  };
  onCleanup(teardownFixListeners);

  createEffect(() => {
    actionLog();
    if (logRef) logRef.scrollTop = logRef.scrollHeight;
  });

  const refresh = async () => {
    setLoading(true);
    try {
      const [envRes, machineRes, healthRes, ddRes] = await Promise.allSettled([
        invoke("env_status"),
        invoke("get_machine_info"),
        invoke("system_health"),
        isMacOS() ? invoke("docker_desktop_status") : Promise.resolve(null),
      ]);
      if (envRes.status === "fulfilled") setStatus(envRes.value as EnvironmentStatus);
      if (machineRes.status === "fulfilled") setMachine(machineRes.value as MachineInfo);
      if (healthRes.status === "fulfilled") setHealth(healthRes.value as SystemHealth);
      if (ddRes.status === "fulfilled" && ddRes.value) setDdStatus(ddRes.value as DockerDesktopStatus);
      // If all three failed, show a fallback state so the page isn't stuck on loading
      if (envRes.status === "rejected" && machineRes.status === "rejected" && healthRes.status === "rejected") {
        setHealth({ docker_connected: false, docker_version: null, disk_usage: null, system_resources: null, warnings: ["Could not reach Docker. The setup wizard below will help you get started."] } as SystemHealth);
      }
    } catch {
      // Don't show toast for expected failures during first setup
    } finally {
      setLoading(false);
    }
  };

  useRefresh(refresh);

  const runFix = async (action: string, checkName: string) => {
    // Tear down any listeners from a previous runFix to avoid accumulation
    // on re-entry.
    teardownFixListeners();

    setActionName(checkName);
    setActionLog("");
    setActionRunning(true);
    setActionSuccess(null);
    setActionDialogOpen(true);

    // Resolver for the done promise, captured so we can synchronously
    // register both listeners up front (matching XTerminal.tsx's pattern).
    let resolveDone: (success: boolean) => void = () => {};
    const donePromise = new Promise<boolean>((resolve) => { resolveDone = resolve; });

    try {
      // Await both subscriptions BEFORE kicking off the streaming invoke.
      // Store unlisten handles in component-scoped lets so onCleanup can
      // reach them even if we never return from the awaits below.
      unlistenFixLine = await listen<string>("env-fix-line", (event) => {
        setActionLog((prev) => prev + event.payload + "\n");
      });
      unlistenFixDone = await listen<string>("env-fix-done", (event) => {
        resolveDone(event.payload === "success");
      });

      // Start the streaming fix (returns immediately, events stream in)
      await invoke("env_fix_stream", { action });

      // Wait for completion (events arrive as each step runs)
      const success = await Promise.race([
        donePromise,
        new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("timeout")), 600000)),
      ]);

      setActionSuccess(success);
    } catch (e) {
      // Streaming failed — fall back to non-streaming invoke
      logError(`Environment fix stream error for ${checkName}: ${e}`);
      try {
        setActionLog((prev) => prev || "");
        setActionLog((prev) => prev + (prev ? "\nFalling back to direct method...\n\n" : "Setting up...\n\n"));
        const result = (await invoke("env_fix", { action })) as { output: string };
        setActionLog((prev) => prev + (result.output || "Setup completed.\n"));
        setActionSuccess(true);
      } catch (e2) {
        logError(`Environment fix failed for ${checkName}: ${e2}`);
        setActionLog((prev) => prev + `\nError: ${e2}\n`);
        setActionSuccess(false);
      }
    } finally {
      teardownFixListeners();
      setActionRunning(false);
      // Auto-restart daemon after successful fix (Docker may have been restarted)
      if (actionSuccess()) {
        setActionLog((prev) => prev + "\n>>> Restarting Orca daemon...\n");
        try {
          await invoke("stop_daemon");
          await new Promise(r => setTimeout(r, 2000));
          await invoke("start_daemon");
          await new Promise(r => setTimeout(r, 3000));
          setActionLog((prev) => prev + ">>> Daemon restarted successfully.\n");
        } catch {
          setActionLog((prev) => prev + ">>> Daemon restart failed. Close and reopen Orca Desktop.\n");
        }
        await refresh();
      }
    }
  };

  const closeActionDialog = async () => {
    setActionDialogOpen(false);
    if (actionSuccess()) {
      showToast("Restarting Orca daemon to reconnect to Docker...", "info");
      try {
        await invoke("stop_daemon");
        await new Promise(r => setTimeout(r, 2000));
        await invoke("start_daemon");
        await new Promise(r => setTimeout(r, 3000));
      } catch {}
      showToast("Daemon restarted", "success");
    }
    await refresh();
  };

  const handleOverlayMouseDown = (e: MouseEvent) => {
    mouseDownOnOverlay = (e.target as HTMLElement).classList.contains("modal-overlay");
  };

  const handleOverlayClick = (e: MouseEvent) => {
    if (mouseDownOnOverlay && (e.target as HTMLElement).classList.contains("modal-overlay") && !actionRunning()) closeActionDialog();
    mouseDownOnOverlay = false;
  };

  onMount(refresh);

  const statusColor = (check: HealthCheck) => {
    switch (check.status) {
      case "Pass": return "#3fb950";
      case "Warning": return "#d29922";
      case "Fail": return "#f85149";
    }
  };

  const platformLabel = (p: string) => {
    switch (p) {
      case "linux": return "Linux";
      case "macos": return "macOS";
      case "windows": return "Windows";
      default: return p;
    }
  };

  const hasDockerDesktop = () => status()?.checks.some(
    (c) => c.name === "Docker Desktop" && c.status === "Pass" && c.details
  );

  const passCount = () => status()?.checks.filter(c => c.status === "Pass").length || 0;
  const totalCount = () => status()?.checks.length || 0;

  // Diagnose dialog
  const [diagnoseOpen, setDiagnoseOpen] = createSignal(false);
  const [diagnoseLog, setDiagnoseLog] = createSignal("");
  const [diagnoseRunning, setDiagnoseRunning] = createSignal(false);
  const [diagnoseResult, setDiagnoseResult] = createSignal<boolean | null>(null);

  const [restartingOrca, setRestartingOrca] = createSignal(false);
  const [restartingDocker, setRestartingDocker] = createSignal(false);

  const _restartOrcaDaemon = async () => {
    setRestartingOrca(true);
    try {
      showToast("Restarting Orca daemon...", "info");
      await invoke("stop_daemon");
      await new Promise(r => setTimeout(r, 1500));
      await invoke("start_daemon");
      await new Promise(r => setTimeout(r, 2000));
      showToast("Orca daemon restarted", "success");
      await refresh();
    } catch (e) {
      logError(`Failed to restart Orca daemon: ${e}`);
      showToast(`Restart failed: ${e}`, "error");
    } finally {
      setRestartingOrca(false);
    }
  };

  const restartDocker = async () => {
    setRestartingDocker(true);
    try {
      showToast("Restarting Docker and Orca daemon...", "info");

      // Stop the Orca daemon first
      try { await invoke("stop_daemon"); } catch {}
      await new Promise(r => setTimeout(r, 1000));

      // Restart Docker (uses the env_fix "start_docker" action which configures TCP on Windows)
      try { await invoke("env_fix", { action: "start_docker" }); } catch {}
      await new Promise(r => setTimeout(r, 3000));

      // Start the Orca daemon (it will connect to the fresh Docker)
      try { await invoke("start_daemon"); } catch {}
      await new Promise(r => setTimeout(r, 3000));

      showToast("Docker and Orca daemon restarted", "success");
      await refresh();
    } catch (e) {
      logError(`Failed to restart Docker: ${e}`);
      showToast(`Docker restart failed: ${e}`, "error");
    } finally {
      setRestartingDocker(false);
    }
  };

  const runMigration = async () => {
    setMigrating(true);
    try {
      // Step 1: If Orca runtime isn't available, the user needs to set up Docker first
      const dd = ddStatus();
      if (dd && !dd.orca_runtime_available) {
        showToast("Setting up Orca runtime first...", "info");
        runFix("setup_docker_macos", "Docker Setup");
        return;
      }

      // Step 2: Switch Docker context to lima-orca
      showToast("Switching to Orca runtime...", "info");
      const result = await invoke("switch_to_orca_runtime") as { message: string };

      // Step 3: Optionally stop Docker Desktop
      if (stopDdChecked()) {
        showToast("Stopping Docker Desktop...", "info");
        try {
          await invoke("stop_docker_desktop");
        } catch (e) {
          logError(`Failed to stop Docker Desktop: ${e}`);
        }
      }

      // Step 4: Restart daemon to pick up new context
      showToast("Restarting Orca daemon...", "info");
      try {
        await invoke("stop_daemon");
        await new Promise(r => setTimeout(r, 2000));
        await invoke("start_daemon");
        await new Promise(r => setTimeout(r, 3000));
      } catch {
        // Daemon restart can fail if already stopped
      }

      showToast(result.message, "success");
      await refresh();
    } catch (e) {
      logError(`Migration failed: ${e}`);
      showToast(`Migration failed: ${e}`, "error");
    } finally {
      setMigrating(false);
    }
  };

  const runDiagnose = async () => {
    setDiagnoseLog("Testing connection methods...\n\n");
    setDiagnoseRunning(true);
    setDiagnoseResult(null);
    setDiagnoseOpen(true);
    try {
      const result = (await invoke("reconnect_runtime")) as {
        connected: boolean;
        method?: string;
        version?: string;
        log: string[];
      };
      setDiagnoseLog(result.log.join("\n"));
      setDiagnoseResult(result.connected);

      // If Docker was found, the daemon hot-swapped the connection — just refresh
      if (result.connected) {
        await refresh();
      }
    } catch (e) {
      logError(`Connection diagnostics failed: ${e}`);
      setDiagnoseLog(`Failed to run diagnostics: ${e}`);
      setDiagnoseResult(false);
    } finally {
      setDiagnoseRunning(false);
    }
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">System Health</h1>
        <div class="page-actions">
          <Show when={!health()?.docker_connected}>
            <button class="btn btn-primary" disabled={actionRunning()} onClick={() => {
              const action = navigator.platform.includes("Mac") ? "setup_docker_macos"
                : navigator.platform.includes("Win") ? "install_docker"
                : "install_docker_linux";
              runFix(action, "Docker Setup");
            }}>
              Set up Docker
            </button>
          </Show>
          <button class="btn" onClick={restartDocker} disabled={restartingDocker() || restartingOrca()}>
            {restartingDocker() ? "Restarting..." : "Restart Docker & Orca"}
          </button>
          <button class="btn" onClick={runDiagnose}>
            Diagnose
          </button>
          <button class="btn" onClick={refresh} disabled={loading()}>
            {loading() ? "Checking..." : "Re-check"}
          </button>
        </div>
      </div>

      <Show
        when={status()}
        fallback={
          <div style={{ display: "flex", "flex-direction": "column", gap: "16px", "max-width": "800px" }}>
            <div class="skeleton-card" style={{ height: "120px" }}><div class="skeleton-line skeleton-line-short" /><div class="skeleton-line" /><div class="skeleton-line skeleton-line-medium" /></div>
            <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "12px" }}>
              <div class="skeleton-card" style={{ height: "80px" }}><div class="skeleton-line skeleton-line-short" /><div class="skeleton-line skeleton-line-medium" /></div>
              <div class="skeleton-card" style={{ height: "80px" }}><div class="skeleton-line skeleton-line-short" /><div class="skeleton-line skeleton-line-medium" /></div>
            </div>
          </div>
        }
      >
        {(s) => (
          <div>
            {/* === READY STATE — only show when daemon can actually reach Docker === */}
            <Show when={health()?.docker_connected === true}>
              {/* Hero status card */}
              <div style={{
                background: "linear-gradient(135deg, rgba(63, 185, 80, 0.06) 0%, rgba(88, 166, 255, 0.04) 100%)",
                border: "1px solid rgba(63, 185, 80, 0.15)",
                "border-radius": "12px",
                padding: "32px",
                "margin-bottom": "24px",
                display: "flex",
                "align-items": "center",
                gap: "24px",
              }}>
                {/* Animated checkmark circle */}
                <div style={{
                  width: "56px", height: "56px", "border-radius": "50%",
                  background: "rgba(63, 185, 80, 0.12)",
                  display: "flex", "align-items": "center", "justify-content": "center",
                  "flex-shrink": "0",
                }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <div style={{ flex: "1" }}>
                  <div style={{ "font-size": "20px", "font-weight": "700", color: "#e6edf3", "margin-bottom": "4px" }}>
                    All Systems Operational
                  </div>
                  <div style={{ "font-size": "14px", color: "#8b949e", "line-height": "1.5" }}>
                    {platformLabel(s().platform)} {"\u2022"} Runtime: {
                      isMacOS() && ddStatus()?.active
                        ? "Docker Desktop"
                        : isMacOS() && !ddStatus()?.active && ddStatus()?.orca_runtime_available
                        ? "Orca (Lima)"
                        : s().platform === "linux"
                        ? "Native Docker"
                        : s().suggested_runtime
                    } {isMacOS() && !ddStatus()?.active && ddStatus()?.orca_runtime_available ? " \u2713" : ""} {"\u2022"} {passCount()}/{totalCount()} checks passed
                  </div>
                </div>
              </div>

              {/* Docker Desktop migration card (macOS only) */}
              <Show when={isMacOS() && ddStatus()?.installed && ddStatus()?.active && !migrationDismissed()}>
                <div style={{
                  "margin-bottom": "24px",
                  background: "linear-gradient(135deg, rgba(88, 166, 255, 0.08) 0%, rgba(139, 92, 246, 0.06) 100%)",
                  border: "1px solid rgba(88, 166, 255, 0.2)",
                  "border-radius": "12px",
                  padding: "28px 32px",
                }}>
                  <div style={{ "font-size": "16px", "font-weight": "700", color: "#e6edf3", "margin-bottom": "8px" }}>
                    Switch to Orca Runtime
                  </div>
                  <div style={{ "font-size": "13px", color: "#8b949e", "line-height": "1.6", "margin-bottom": "20px" }}>
                    You're currently using Docker Desktop's daemon. Orca can run Docker with its own lightweight runtime — less memory, no license required, zero telemetry.
                  </div>

                  {/* Comparison columns */}
                  <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "12px", "margin-bottom": "20px", "max-width": "420px" }}>
                    <div style={{
                      background: "rgba(248, 81, 73, 0.06)",
                      border: "1px solid rgba(248, 81, 73, 0.15)",
                      "border-radius": "8px", padding: "14px 16px",
                    }}>
                      <div style={{ "font-weight": "600", "font-size": "13px", color: "#e6edf3", "margin-bottom": "10px" }}>Docker Desktop</div>
                      <div style={{ "font-size": "12px", color: "#8b949e", "line-height": "1.8" }}>
                        ~2 GB RAM<br/>License required<br/>Closed source<br/>Telemetry
                      </div>
                    </div>
                    <div style={{
                      background: "rgba(63, 185, 80, 0.06)",
                      border: "1px solid rgba(63, 185, 80, 0.15)",
                      "border-radius": "8px", padding: "14px 16px",
                    }}>
                      <div style={{ "font-weight": "600", "font-size": "13px", color: "#e6edf3", "margin-bottom": "10px" }}>Orca Runtime</div>
                      <div style={{ "font-size": "12px", color: "#3fb950", "line-height": "1.8" }}>
                        ~200 MB RAM<br/>Free forever<br/>Open source<br/>Zero telemetry
                      </div>
                    </div>
                  </div>

                  <div style={{ "font-size": "12px", color: "#6e7681", "margin-bottom": "16px" }}>
                    Your containers and images will still be available.
                  </div>

                  {/* Stop Docker Desktop checkbox */}
                  <label style={{
                    display: "flex", "align-items": "center", gap: "8px",
                    "font-size": "13px", color: "#8b949e", cursor: "pointer",
                    "margin-bottom": "16px",
                  }}>
                    <input
                      type="checkbox"
                      checked={stopDdChecked()}
                      onChange={(e) => setStopDdChecked(e.currentTarget.checked)}
                      style={{ "accent-color": "#58a6ff" }}
                    />
                    Also stop Docker Desktop to free resources
                  </label>

                  <div style={{ display: "flex", gap: "10px" }}>
                    <button
                      class="btn btn-primary"
                      disabled={migrating()}
                      onClick={runMigration}
                    >
                      {migrating() ? "Switching..." : "Switch to Orca Runtime"}
                    </button>
                    <button class="btn" onClick={() => setMigrationDismissed(true)}>
                      Maybe Later
                    </button>
                  </div>
                </div>
              </Show>

              {/* Docker Desktop note — show only when DD is installed but NOT active (already on Orca) */}
              <Show when={hasDockerDesktop() && !(isMacOS() && ddStatus()?.active)}>
                <div style={{
                  padding: "12px 16px", "margin-bottom": "20px",
                  background: "rgba(63, 185, 80, 0.06)",
                  border: "1px solid rgba(63, 185, 80, 0.12)",
                  "border-radius": "8px",
                  "font-size": "13px", color: "#8b949e",
                  display: "flex", "align-items": "center", gap: "8px",
                }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  Using Orca runtime — Docker Desktop is installed but not the active context.
                </div>
              </Show>

              {/* Health check grid — filter out irrelevant items */}
              <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fill, minmax(320px, 1fr))", gap: "12px" }}>
                <For each={s().checks.filter(c => {
                  if (c.name.includes("Docker Desktop") && c.status === "Pass" && !c.details) return false;
                  if (c.description?.includes("Not installed") && !c.fix_action) return false;
                  return true;
                })}>
                  {(check) => (
                    <div style={{
                      background: "#161b22",
                      border: `1px solid ${check.status === "Pass" ? "#21262d" : check.status === "Warning" ? "rgba(210, 153, 34, 0.3)" : "rgba(248, 81, 73, 0.3)"}`,
                      "border-radius": "10px",
                      padding: "16px 18px",
                      display: "flex",
                      "align-items": "flex-start",
                      gap: "12px",
                    }}>
                      {/* Status indicator */}
                      <div style={{
                        width: "8px", height: "8px", "border-radius": "50%",
                        background: statusColor(check),
                        "margin-top": "6px", "flex-shrink": "0",
                        "box-shadow": `0 0 8px ${statusColor(check)}40`,
                      }} />
                      <div style={{ flex: "1", "min-width": "0" }}>
                        <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px" }}>
                          <div style={{ "font-weight": "600", "font-size": "13px", color: "#e6edf3" }}>{check.name}</div>
                          <Show when={check.fix_action && check.status !== "Pass"}>
                            <button class="btn btn-sm" style={{ "font-size": "11px", padding: "2px 8px" }}
                              disabled={actionRunning()}
                              onClick={() => runFix(check.fix_action!, check.name)}
                            >Fix</button>
                          </Show>
                        </div>
                        <div style={{ "font-size": "12px", color: "#8b949e", "margin-top": "3px", "line-height": "1.4" }}>
                          {check.description}
                        </div>
                        <Show when={check.details}>
                          <div style={{
                            "font-size": "11px", color: "#58a6ff", "margin-top": "4px",
                            "font-family": "'JetBrains Mono NF', monospace", opacity: "0.8",
                          }}>
                            {check.details}
                          </div>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            {/* Warnings banner */}
            <Show when={health()?.warnings && health()!.warnings.length > 0}>
              <div style={{ "margin-top": "20px" }}>
                <For each={health()!.warnings}>
                  {(warning) => (
                    <div style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "10px",
                      padding: "12px 16px",
                      background: "rgba(210, 153, 34, 0.08)",
                      border: "1px solid rgba(210, 153, 34, 0.25)",
                      "border-radius": "10px",
                      "margin-bottom": "8px",
                      "font-size": "13px",
                      color: "#d29922",
                    }}>
                      <span style={{ "font-size": "16px" }}>{"\u26A0"}</span>
                      <span>{warning}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            {/* System Info — shown when ready */}
            <Show when={s().ready && (machine() || health())}>
              <div style={{ "margin-top": "24px" }}>
                <div style={{ "font-size": "13px", "font-weight": "600", color: "#8b949e", "text-transform": "uppercase", "letter-spacing": "0.5px", "margin-bottom": "12px" }}>
                  System Info
                </div>
                <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fill, minmax(320px, 1fr))", gap: "12px" }}>
                  <Show when={machine()}>
                    {(m) => (
                      <div style={{ background: "rgba(22, 27, 34, 0.5)", border: "1px solid rgba(255,255,255,0.06)", "border-radius": "10px", padding: "16px 18px" }}>
                        <div style={{ "font-weight": "600", "font-size": "13px", "margin-bottom": "10px" }}>Runtime</div>
                        <div class="card-grid" style={{ "font-size": "12px" }}>
                          <span class="card-label">Backend</span>
                          <span class="card-value">{m().backend} · {m().config.runtime}</span>
                          <span class="card-label">State</span>
                          <span class={`state-badge ${m().state === "Running" ? "state-running" : "state-stopped"}`}>{m().state}</span>
                          <span class="card-label">CPUs</span>
                          <span class="card-value">{m().config.cpus}</span>
                          <span class="card-label">Memory</span>
                          <span class="card-value">{formatBytes(m().config.memory_mb * 1024 * 1024)}</span>
                        </div>
                      </div>
                    )}
                  </Show>
                  <Show when={health()?.system_resources}>
                    {(res) => (
                      <div style={{ background: "rgba(22, 27, 34, 0.5)", border: "1px solid rgba(255,255,255,0.06)", "border-radius": "10px", padding: "16px 18px" }}>
                        <div style={{ "font-weight": "600", "font-size": "13px", "margin-bottom": "10px" }}>Resources</div>
                        <div class="card-grid" style={{ "font-size": "12px" }}>
                          <span class="card-label">Memory</span>
                          <span class="card-value">
                            {formatBytes(res().memory_total_bytes - res().memory_available_bytes)} / {formatBytes(res().memory_total_bytes)}
                          </span>
                          <span class="card-label">Disk</span>
                          <span class="card-value">
                            {formatBytes(res().disk_total_bytes - res().disk_free_bytes)} / {formatBytes(res().disk_total_bytes)}
                            <span style={{ color: "#6e7681", "margin-left": "4px" }}>({res().disk_usage_percent.toFixed(0)}%)</span>
                          </span>
                        </div>
                      </div>
                    )}
                  </Show>
                </div>
              </div>
            </Show>

            {/* === SETUP / RECONNECT STATE — show when daemon can't reach Docker === */}
            <Show when={health()?.docker_connected !== true}>
              <div style={{
                "margin-bottom": "24px",
                background: s().ready
                  ? "linear-gradient(135deg, rgba(210, 169, 34, 0.08) 0%, rgba(248, 81, 73, 0.05) 100%)"
                  : "linear-gradient(135deg, rgba(88, 166, 255, 0.08) 0%, rgba(139, 92, 246, 0.08) 100%)",
                border: s().ready
                  ? "1px solid rgba(210, 169, 34, 0.2)"
                  : "1px solid rgba(88, 166, 255, 0.2)",
                "border-radius": "12px",
                padding: "32px",
              }}>
                <div style={{ "font-size": "24px", "font-weight": "700", "margin-bottom": "8px", color: "var(--text-primary)" }}>
                  {s().ready ? "Docker Connection Issue" : "Container Runtime Setup"}
                </div>
                <div style={{ "font-size": "14px", color: "var(--text-muted)", "margin-bottom": "24px", "line-height": "1.5" }}>
                  {s().ready
                    ? "Docker is installed but Orca can't connect to it. Try restarting the Orca daemon or Docker service."
                    : s().platform === "macos"
                    ? "Set up a container runtime to get started. Orca uses a lightweight Linux VM via Lima on macOS."
                    : s().platform === "windows"
                    ? "Set up Docker in WSL2 to get started. Orca manages containers via the Windows Subsystem for Linux."
                    : "Set up a container runtime to get started. Install Docker or Podman on your system."}
                </div>

                <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
                  <For each={s().checks.filter(c => {
                    // Hide irrelevant checks: "Not installed" items with no fix action
                    if (c.name.includes("Docker Desktop") && c.status === "Pass" && !c.details) return false;
                    if (c.description?.includes("Not installed") && !c.fix_action) return false;
                    return true;
                  })}>
                    {(check, i) => (
                      <div style={{
                        display: "flex", "align-items": "center", gap: "14px",
                        padding: "14px 16px",
                        background: "rgba(0, 0, 0, 0.2)", "border-radius": "8px",
                        border: `1px solid ${check.status === "Pass" ? "rgba(63, 185, 80, 0.3)" : "rgba(255, 255, 255, 0.06)"}`,
                      }}>
                        <div style={{
                          width: "28px", height: "28px", "border-radius": "50%",
                          display: "flex", "align-items": "center", "justify-content": "center",
                          "font-size": "13px", "font-weight": "600", "flex-shrink": "0",
                          background: check.status === "Pass" ? "#3fb950" : "rgba(255, 255, 255, 0.08)",
                          color: check.status === "Pass" ? "#fff" : "var(--text-muted)",
                        }}>
                          {check.status === "Pass" ? "\u2713" : i() + 1}
                        </div>
                        <div style={{ flex: "1", "min-width": "0" }}>
                          <div style={{ "font-weight": "600", "font-size": "14px", color: check.status === "Pass" ? "#3fb950" : "var(--text-primary)" }}>
                            {check.name}
                          </div>
                          <div style={{ "font-size": "12px", color: "var(--text-muted)", "margin-top": "2px" }}>
                            {check.status === "Pass" ? check.details || check.description : check.description}
                          </div>
                        </div>
                        <Show when={check.fix_action && check.status !== "Pass"}>
                          <button class="btn btn-primary" disabled={actionRunning()} onClick={() => runFix(check.fix_action!, check.name)} style={{ "flex-shrink": "0" }}>Install</button>
                        </Show>
                        <Show when={check.status === "Pass"}>
                          <span style={{ color: "#3fb950", "font-size": "12px", "font-weight": "600", "flex-shrink": "0" }}>Done</span>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>

                <Show when={s().checks.filter(c => c.fix_action && c.status !== "Pass").length === 0 && !s().ready}>
                  <div style={{ "margin-top": "16px", "font-size": "13px", color: "var(--text-muted)", "text-align": "center" }}>
                    Or install Docker manually, then click Re-check.
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </Show>

      {/* Diagnose Connection Dialog */}
      <Show when={diagnoseOpen()}>
        <div class="modal-overlay"
          onMouseDown={handleOverlayMouseDown}
          onClick={(e) => { if (mouseDownOnOverlay && (e.target as HTMLElement).classList.contains("modal-overlay") && !diagnoseRunning()) setDiagnoseOpen(false); mouseDownOnOverlay = false; }}
        >
          <div class="modal-dialog" style={{ "max-width": "680px" }}>
            <div class="modal-header">
              <span class="modal-title">
                <Show when={diagnoseRunning()} fallback={
                  <Show when={diagnoseResult()} fallback={
                    <Show when={diagnoseResult() === false} fallback={<span>Connection Diagnostics</span>}>
                      <span style={{ color: "#f85149" }}>Connection failed</span>
                    </Show>
                  }>
                    <span style={{ color: "#3fb950" }}>Connection available</span>
                  </Show>
                }>
                  <span>Testing connections...</span>
                </Show>
              </span>
              <Show when={!diagnoseRunning()}>
                <button class="modal-close" onClick={() => setDiagnoseOpen(false)}>{"\u00d7"}</button>
              </Show>
            </div>
            <div style={{ padding: "0" }}>
              <Show when={diagnoseRunning()}>
                <div style={{ height: "3px", background: "#21262d", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: "30%", background: "#58a6ff", animation: "progress-slide 1.5s ease-in-out infinite", "border-radius": "2px" }} />
                </div>
              </Show>
              <pre style={{
                padding: "16px", margin: 0,
                "font-family": "'JetBrains Mono NF', monospace",
                "font-size": "12px", "line-height": "1.6",
                color: "#c9d1d9", "white-space": "pre-wrap",
                "word-break": "break-all", "max-height": "450px",
                "min-height": "120px", overflow: "auto",
                background: "#0d1117",
              }}>{diagnoseLog()}</pre>
            </div>
            <div class="modal-footer">
              <Show when={!diagnoseRunning()}>
                <button class="btn" onClick={() => setDiagnoseOpen(false)}>Close</button>
                <button class="btn btn-primary" onClick={runDiagnose}>Retry</button>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      {/* Action Progress Dialog */}
      <Show when={actionDialogOpen()}>
        <div class="modal-overlay" onMouseDown={handleOverlayMouseDown} onClick={handleOverlayClick}>
          <div class="modal-dialog" style={{ "max-width": "900px", width: "90vw" }}>
            <div class="modal-header">
              <span class="modal-title">
                <Show when={actionRunning()} fallback={
                  <Show when={actionSuccess()} fallback={
                    <span style={{ color: "#f85149" }}>{"\u2717"} {actionName()} failed</span>
                  }>
                    <span style={{ color: "#3fb950" }}>{"\u2713"} {actionName()} complete</span>
                  </Show>
                }>
                  <span>Installing {actionName()}...</span>
                </Show>
              </span>
              <Show when={!actionRunning()}>
                <button class="modal-close" onClick={closeActionDialog}>{"\u00d7"}</button>
              </Show>
            </div>
            <div style={{ padding: "0" }}>
              <Show when={actionRunning()}>
                <div style={{ height: "3px", background: "#21262d", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: "30%", background: "#58a6ff", animation: "progress-slide 1.5s ease-in-out infinite", "border-radius": "2px" }} />
                </div>
              </Show>
              <pre style={{
                padding: "16px", margin: 0,
                "font-family": "'JetBrains Mono NF', monospace",
                "font-size": "12px", "line-height": "1.6",
                color: "#c9d1d9", "white-space": "pre-wrap",
                "word-break": "break-all", "max-height": "500px",
                "min-height": "150px", overflow: "auto",
                background: "#0d1117",
              }} ref={logRef}>{actionLog()}</pre>
            </div>
            <div class="modal-footer">
              <Show when={!actionRunning()}>
                <button class="btn btn-primary" onClick={closeActionDialog}>Close</button>
              </Show>
              <Show when={actionRunning()}>
                <span style={{ "font-size": "12px", color: "var(--text-muted)" }}>This may take several minutes...</span>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <style>{`
        @keyframes progress-slide {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(233%); }
          100% { transform: translateX(-100%); }
        }
      `}</style>
    </div>
  );
}
