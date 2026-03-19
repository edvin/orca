import { createSignal, createEffect, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { EnvironmentStatus, HealthCheck } from "../lib/types";
import { showToast } from "../components/Toast";

export default function EnvironmentPage() {
  const [status, setStatus] = createSignal<EnvironmentStatus | null>(null);
  const [loading, setLoading] = createSignal(true);

  // Action dialog state
  const [actionDialogOpen, setActionDialogOpen] = createSignal(false);
  const [actionName, setActionName] = createSignal("");
  const [actionRunning, setActionRunning] = createSignal(false);
  const [actionLog, setActionLog] = createSignal("");
  const [actionSuccess, setActionSuccess] = createSignal<boolean | null>(null);
  let mouseDownOnOverlay = false;
  let logRef: HTMLPreElement | undefined;

  // Auto-scroll log to bottom when content changes
  createEffect(() => {
    actionLog(); // track dependency
    if (logRef) logRef.scrollTop = logRef.scrollHeight;
  });

  const refresh = async () => {
    setLoading(true);
    try {
      const result = (await invoke("env_status")) as EnvironmentStatus;
      setStatus(result);
    } catch (e) {
      showToast(`Failed to check environment: ${e}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const runFix = async (action: string, checkName: string) => {
    setActionName(checkName);
    setActionLog("");
    setActionRunning(true);
    setActionSuccess(null);
    setActionDialogOpen(true);

    try {
      // Get API token for auth
      let token = "";
      try { token = await invoke("get_api_token") as string; } catch { /* no token */ }

      // Use SSE streaming endpoint for real-time output
      const resp = await fetch("http://127.0.0.1:9477/api/v1/environment/fix-stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "Authorization": `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ action }),
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      }

      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        let done = false;
        let success = true;
        while (!done) {
          const { value, done: streamDone } = await reader.read();
          done = streamDone;
          if (value) {
            const text = decoder.decode(value, { stream: !done });
            // Parse SSE format: "data: ...\n\n"
            for (const line of text.split("\n")) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") {
                  done = true;
                } else if (data.startsWith("[ERROR]")) {
                  setActionLog((prev) => prev + "\n" + data.slice(8) + "\n");
                  success = false;
                  done = true;
                } else {
                  setActionLog((prev) => prev + data + "\n");
                }
              }
            }
          }
        }
        setActionSuccess(success);
      }
    } catch (e) {
      // Fallback to non-streaming endpoint
      try {
        const result = (await invoke("env_fix", { action })) as { output: string };
        setActionLog(result.output || "(no output)");
        setActionSuccess(true);
      } catch (e2) {
        setActionLog((prev) => prev + `\nError: ${e2}\n`);
        setActionSuccess(false);
      }
    } finally {
      setActionRunning(false);
    }
  };

  const closeActionDialog = async () => {
    setActionDialogOpen(false);
    if (actionSuccess()) {
      // Restart the daemon so it reconnects to the newly installed runtime
      try {
        await invoke("stop_daemon");
        // Brief pause for the process to fully exit
        await new Promise(r => setTimeout(r, 1000));
        await invoke("start_daemon");
        // Wait for it to become ready
        await new Promise(r => setTimeout(r, 2000));
      } catch { /* ignore — daemon may already be restarting */ }
    }
    await refresh();
  };

  const handleOverlayMouseDown = (e: MouseEvent) => {
    mouseDownOnOverlay = (e.target as HTMLElement).classList.contains("modal-overlay");
  };

  const handleOverlayClick = (e: MouseEvent) => {
    if (mouseDownOnOverlay && (e.target as HTMLElement).classList.contains("modal-overlay") && !actionRunning()) {
      closeActionDialog();
    }
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

  const statusIcon = (check: HealthCheck) => {
    switch (check.status) {
      case "Pass": return "\u2713";
      case "Warning": return "\u26A0";
      case "Fail": return "\u2717";
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

  const hasDockerDesktop = () => {
    const s = status();
    return s?.checks.some(
      (c) => c.name === "Docker Desktop" && c.status === "Pass" && c.details
    );
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">System Health</h1>
        <button class="btn" onClick={refresh} disabled={loading()}>
          {loading() ? "Checking..." : "Re-check"}
        </button>
      </div>

      <Show
        when={status()}
        fallback={
          <div class="empty">
            <p class="empty-title">Checking environment...</p>
          </div>
        }
      >
        {(s) => (
          <div style={{ "max-width": "720px" }}>
            {/* Ready banner */}
            <Show when={s().ready}>
              <div
                class="card"
                style={{
                  "border-left": "4px solid #3fb950",
                  "margin-bottom": "20px",
                }}
              >
                <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                  <span style={{ "font-size": "28px", color: "#3fb950", "line-height": "1" }}>{"\u2713"}</span>
                  <div>
                    <div style={{ "font-size": "18px", "font-weight": "600", color: "#3fb950" }}>
                      Environment Ready
                    </div>
                    <div style={{ "font-size": "13px", color: "var(--text-muted)", "margin-top": "2px" }}>
                      Platform: {platformLabel(s().platform)} {"\u2014"} Runtime: {s().suggested_runtime}
                    </div>
                  </div>
                </div>
              </div>
            </Show>

            {/* Welcome / Setup wizard for new users */}
            <Show when={!s().ready}>
              <div style={{
                "margin-bottom": "24px",
                background: "linear-gradient(135deg, rgba(88, 166, 255, 0.08) 0%, rgba(139, 92, 246, 0.08) 100%)",
                border: "1px solid rgba(88, 166, 255, 0.2)",
                "border-radius": "12px",
                padding: "32px",
              }}>
                <div style={{ "font-size": "24px", "font-weight": "700", "margin-bottom": "8px", color: "var(--text-primary)" }}>
                  Container Runtime Setup
                </div>
                <div style={{ "font-size": "14px", color: "var(--text-muted)", "margin-bottom": "24px", "line-height": "1.5" }}>
                  {s().platform === "macos"
                    ? "Orca needs a container runtime to manage your containers. Set up Docker via Lima or Docker Desktop on macOS."
                    : s().platform === "windows"
                    ? "Orca needs Docker running inside WSL2 to manage containers on Windows."
                    : "Orca needs a container runtime. Install Docker or Podman to get started."}
                </div>

                {/* Setup steps */}
                <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
                  <For each={s().checks}>
                    {(check, i) => (
                      <div style={{
                        display: "flex",
                        "align-items": "center",
                        gap: "14px",
                        padding: "14px 16px",
                        background: "rgba(0, 0, 0, 0.2)",
                        "border-radius": "8px",
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
                          <div style={{
                            "font-weight": "600", "font-size": "14px",
                            color: check.status === "Pass" ? "#3fb950" : "var(--text-primary)",
                          }}>
                            {check.name}
                          </div>
                          <div style={{ "font-size": "12px", color: "var(--text-muted)", "margin-top": "2px" }}>
                            {check.status === "Pass" ? check.details || check.description : check.description}
                          </div>
                        </div>

                        <Show when={check.fix_action && check.status !== "Pass"}>
                          <button
                            class="btn btn-primary"
                            disabled={actionRunning()}
                            onClick={() => runFix(check.fix_action!, check.name)}
                            style={{ "flex-shrink": "0" }}
                          >
                            Install
                          </button>
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
                    Or install <a href="https://www.docker.com/products/docker-desktop/" target="_blank" style={{ color: "#58a6ff" }}>Docker Desktop</a> manually, then click Re-check.
                  </div>
                </Show>
              </div>
            </Show>

            {/* Docker Desktop note */}
            <Show when={hasDockerDesktop()}>
              <div class="card" style={{ "border-left": "4px solid #58a6ff", "margin-bottom": "20px", "font-size": "13px", color: "var(--text-muted)" }}>
                <span style={{ color: "#58a6ff", "margin-right": "8px" }}>i</span>
                Docker Desktop detected — Orca can work alongside it using the same Docker daemon.
              </div>
            </Show>

            {/* Health Checks — shown only when environment is ready */}
            <Show when={s().ready}>
              <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                <For each={s().checks}>
                  {(check) => (
                    <div class="card" style={{ "border-left": `4px solid ${statusColor(check)}` }}>
                      <div style={{ display: "flex", "align-items": "flex-start", "justify-content": "space-between", gap: "12px" }}>
                        <div style={{ display: "flex", "align-items": "flex-start", gap: "10px", flex: "1" }}>
                          <span style={{ color: statusColor(check), "font-size": "16px", "line-height": "1.4", "flex-shrink": "0" }}>
                            {statusIcon(check)}
                          </span>
                          <div>
                            <div style={{ "font-weight": "600", "font-size": "14px" }}>{check.name}</div>
                            <div style={{ "font-size": "12px", color: "var(--text-muted)", "margin-top": "2px" }}>{check.description}</div>
                            <Show when={check.details}>
                              <div style={{ "font-size": "12px", color: "var(--text-muted)", "margin-top": "4px", "font-family": "monospace", opacity: "0.8" }}>
                                {check.details}
                              </div>
                            </Show>
                          </div>
                        </div>
                        <Show when={check.fix_action && check.status !== "Pass"}>
                          <button
                            class="btn btn-sm"
                            disabled={actionRunning()}
                            onClick={() => runFix(check.fix_action!, check.name)}
                            style={{ "flex-shrink": "0" }}
                          >
                            Install
                          </button>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </Show>

      {/* Action Progress Dialog */}
      <Show when={actionDialogOpen()}>
        <div class="modal-overlay" onMouseDown={handleOverlayMouseDown} onClick={handleOverlayClick}>
          <div class="modal-dialog" style={{ "max-width": "640px" }}>
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
              {/* Progress indicator */}
              <Show when={actionRunning()}>
                <div style={{
                  height: "3px",
                  background: "#21262d",
                  overflow: "hidden",
                }}>
                  <div style={{
                    height: "100%",
                    width: "30%",
                    background: "#58a6ff",
                    animation: "progress-slide 1.5s ease-in-out infinite",
                    "border-radius": "2px",
                  }} />
                </div>
              </Show>

              {/* Log output */}
              <pre style={{
                padding: "16px",
                margin: 0,
                "font-family": "'JetBrains Mono NF', monospace",
                "font-size": "12px",
                "line-height": "1.6",
                color: "#c9d1d9",
                "white-space": "pre-wrap",
                "word-break": "break-all",
                "max-height": "400px",
                "min-height": "120px",
                overflow: "auto",
                background: "#0d1117",
              }} ref={logRef}>{actionLog()}</pre>
            </div>
            <div class="modal-footer">
              <Show when={!actionRunning()}>
                <button class="btn btn-primary" onClick={closeActionDialog}>
                  Close
                </button>
              </Show>
              <Show when={actionRunning()}>
                <span style={{ "font-size": "12px", color: "var(--text-muted)" }}>
                  This may take several minutes...
                </span>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      {/* CSS for progress animation */}
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
