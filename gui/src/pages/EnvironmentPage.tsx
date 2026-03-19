import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { EnvironmentStatus, HealthCheck } from "../lib/types";
import { showToast } from "../components/Toast";

export default function EnvironmentPage() {
  const [status, setStatus] = createSignal<EnvironmentStatus | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [fixingAction, setFixingAction] = createSignal<string | null>(null);
  const [fixLog, setFixLog] = createSignal<string | null>(null);

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

  const runFix = async (action: string) => {
    setFixingAction(action);
    setFixLog(`Running: ${action}...`);
    try {
      const result = (await invoke("env_fix", { action })) as { output: string };
      const output = result.output || "(no output)";
      setFixLog(`✅ ${action} completed:\n\n${output}`);
      showToast("Fix completed — check the log below", "success");
      await refresh();
    } catch (e) {
      const error = String(e);
      setFixLog(`❌ ${action} failed:\n\n${error}`);
      showToast(`Fix failed: ${error}`, "error");
    } finally {
      setFixingAction(null);
    }
  };

  onMount(refresh);

  const statusColor = (check: HealthCheck) => {
    switch (check.status) {
      case "Pass":
        return "#3fb950";
      case "Warning":
        return "#d29922";
      case "Fail":
        return "#f85149";
    }
  };

  const statusIcon = (check: HealthCheck) => {
    switch (check.status) {
      case "Pass":
        return "\u2713";
      case "Warning":
        return "\u26A0";
      case "Fail":
        return "\u2717";
    }
  };

  const platformLabel = (p: string) => {
    switch (p) {
      case "linux":
        return "Linux";
      case "macos":
        return "macOS";
      case "windows":
        return "Windows";
      default:
        return p;
    }
  };

  const hasDockerDesktop = () => {
    const s = status();
    return s?.checks.some(
      (c) => c.name === "Docker Desktop" && c.status === "Pass"
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
                <div
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "12px",
                  }}
                >
                  <span
                    style={{
                      "font-size": "28px",
                      color: "#3fb950",
                      "line-height": "1",
                    }}
                  >
                    {"\u2713"}
                  </span>
                  <div>
                    <div
                      style={{
                        "font-size": "18px",
                        "font-weight": "600",
                        color: "#3fb950",
                      }}
                    >
                      Environment Ready
                    </div>
                    <div
                      style={{
                        "font-size": "13px",
                        color: "var(--text-muted)",
                        "margin-top": "2px",
                      }}
                    >
                      Platform: {platformLabel(s().platform)} {"\u2014"} Suggested runtime: {s().suggested_runtime}
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
                <div style={{
                  "font-size": "24px",
                  "font-weight": "700",
                  "margin-bottom": "8px",
                  color: "var(--text-primary)",
                }}>
                  Welcome to Orca
                </div>
                <div style={{
                  "font-size": "14px",
                  color: "var(--text-muted)",
                  "margin-bottom": "24px",
                  "line-height": "1.5",
                }}>
                  {s().platform === "macos"
                    ? "Orca needs a container runtime to manage your containers. We'll help you set up Docker via Lima or Docker Desktop on macOS."
                    : s().platform === "windows"
                    ? "Orca needs Docker running inside WSL2 to manage containers on Windows. Let's get that set up."
                    : "Orca needs a container runtime to get started. We can install Docker or Podman for you."}
                </div>

                {/* Setup steps */}
                <div style={{
                  display: "flex",
                  "flex-direction": "column",
                  gap: "12px",
                }}>
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
                        {/* Step number / check indicator */}
                        <div style={{
                          width: "28px",
                          height: "28px",
                          "border-radius": "50%",
                          display: "flex",
                          "align-items": "center",
                          "justify-content": "center",
                          "font-size": "13px",
                          "font-weight": "600",
                          "flex-shrink": "0",
                          background: check.status === "Pass" ? "#3fb950" : "rgba(255, 255, 255, 0.08)",
                          color: check.status === "Pass" ? "#fff" : "var(--text-muted)",
                        }}>
                          {check.status === "Pass" ? "\u2713" : i() + 1}
                        </div>

                        {/* Step description */}
                        <div style={{ flex: "1", "min-width": "0" }}>
                          <div style={{
                            "font-weight": "600",
                            "font-size": "14px",
                            color: check.status === "Pass" ? "#3fb950" : "var(--text-primary)",
                          }}>
                            {check.name}
                          </div>
                          <div style={{
                            "font-size": "12px",
                            color: "var(--text-muted)",
                            "margin-top": "2px",
                          }}>
                            {check.status === "Pass" ? check.details || check.description : check.description}
                          </div>
                        </div>

                        {/* Action button */}
                        <Show when={check.fix_action && check.status !== "Pass"}>
                          <button
                            class="btn btn-primary"
                            disabled={fixingAction() === check.fix_action}
                            onClick={() => runFix(check.fix_action!)}
                            style={{ "flex-shrink": "0" }}
                          >
                            {fixingAction() === check.fix_action
                              ? "Installing..."
                              : `Install`}
                          </button>
                        </Show>
                        <Show when={check.status === "Pass"}>
                          <span style={{ color: "#3fb950", "font-size": "12px", "font-weight": "600", "flex-shrink": "0" }}>
                            Done
                          </span>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>

                {/* Manual install fallback */}
                <Show when={s().checks.filter(c => c.fix_action && c.status !== "Pass").length === 0 && !s().ready}>
                  <div style={{
                    "margin-top": "16px",
                    "font-size": "13px",
                    color: "var(--text-muted)",
                    "text-align": "center",
                  }}>
                    Or install <a href="https://www.docker.com/products/docker-desktop/" target="_blank" style={{ color: "#58a6ff" }}>Docker Desktop</a> manually, then click Re-check.
                  </div>
                </Show>
              </div>
            </Show>

            {/* Docker Desktop note */}
            <Show when={hasDockerDesktop()}>
              <div
                class="card"
                style={{
                  "border-left": "4px solid #58a6ff",
                  "margin-bottom": "20px",
                  "font-size": "13px",
                  color: "var(--text-muted)",
                }}
              >
                <span style={{ color: "#58a6ff", "margin-right": "8px" }}>
                  i
                </span>
                Docker Desktop detected — Orca can work alongside it using the
                same Docker daemon.
              </div>
            </Show>

            {/* Health Checks — shown only when environment is ready */}
            <Show when={s().ready}>
              <div
                style={{
                  display: "flex",
                  "flex-direction": "column",
                  gap: "8px",
                }}
              >
                <For each={s().checks}>
                  {(check) => (
                    <div
                      class="card"
                      style={{
                        "border-left": `4px solid ${statusColor(check)}`,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          "align-items": "flex-start",
                          "justify-content": "space-between",
                          gap: "12px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            "align-items": "flex-start",
                            gap: "10px",
                            flex: "1",
                          }}
                        >
                          <span
                            style={{
                              color: statusColor(check),
                              "font-size": "16px",
                              "line-height": "1.4",
                              "flex-shrink": "0",
                            }}
                          >
                            {statusIcon(check)}
                          </span>
                          <div>
                            <div
                              style={{
                                "font-weight": "600",
                                "font-size": "14px",
                              }}
                            >
                              {check.name}
                            </div>
                            <div
                              style={{
                                "font-size": "12px",
                                color: "var(--text-muted)",
                                "margin-top": "2px",
                              }}
                            >
                              {check.description}
                            </div>
                            <Show when={check.details}>
                              <div
                                style={{
                                  "font-size": "12px",
                                  color: "var(--text-muted)",
                                  "margin-top": "4px",
                                  "font-family": "monospace",
                                  opacity: "0.8",
                                }}
                              >
                                {check.details}
                              </div>
                            </Show>
                          </div>
                        </div>

                        <Show
                          when={
                            check.fix_action && check.status !== "Pass"
                          }
                        >
                          <button
                            class="btn btn-sm"
                            disabled={fixingAction() === check.fix_action}
                            onClick={() => runFix(check.fix_action!)}
                            style={{ "flex-shrink": "0" }}
                          >
                            {fixingAction() === check.fix_action
                              ? "Installing..."
                              : "Install"}
                          </button>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            {/* Fix action log */}
            <Show when={fixLog()}>
              <div style={{
                "margin-top": "16px",
                background: "#0d1117",
                border: "1px solid #21262d",
                "border-radius": "8px",
                overflow: "hidden",
              }}>
                <div style={{
                  display: "flex",
                  "justify-content": "space-between",
                  "align-items": "center",
                  padding: "8px 12px",
                  background: "#161b22",
                  "border-bottom": "1px solid #21262d",
                  "font-size": "12px",
                  "font-weight": "600",
                }}>
                  <span>Action Log</span>
                  <button
                    class="action-icon"
                    title="Clear log"
                    onClick={() => setFixLog(null)}
                    style={{ "font-size": "12px" }}
                  >✕</button>
                </div>
                <pre style={{
                  padding: "12px",
                  margin: 0,
                  "font-family": "'JetBrains Mono NF', monospace",
                  "font-size": "12px",
                  "line-height": "1.5",
                  color: "#c9d1d9",
                  "white-space": "pre-wrap",
                  "word-break": "break-all",
                  "max-height": "300px",
                  overflow: "auto",
                }}>{fixLog()}</pre>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
