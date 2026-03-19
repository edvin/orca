import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { EnvironmentStatus, HealthCheck } from "../lib/types";
import { showToast } from "../components/Toast";

export default function EnvironmentPage() {
  const [status, setStatus] = createSignal<EnvironmentStatus | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [fixingAction, setFixingAction] = createSignal<string | null>(null);

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
    try {
      const result = (await invoke("env_fix", { action })) as { output: string };
      showToast(result.output || "Fix applied successfully", "success");
      // Re-check after fix
      await refresh();
    } catch (e) {
      showToast(`Fix failed: ${e}`, "error");
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
        <h1 class="page-title">Environment</h1>
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
            {/* Status Banner */}
            <div
              class="card"
              style={{
                "border-left": `4px solid ${s().ready ? "#3fb950" : "#f85149"}`,
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
                    color: s().ready ? "#3fb950" : "#f85149",
                    "line-height": "1",
                  }}
                >
                  {s().ready ? "\u2713" : "\u26A0"}
                </span>
                <div>
                  <div
                    style={{
                      "font-size": "18px",
                      "font-weight": "600",
                      color: s().ready ? "#3fb950" : "#f85149",
                    }}
                  >
                    {s().ready ? "Environment Ready" : "Setup Required"}
                  </div>
                  <div
                    style={{
                      "font-size": "13px",
                      color: "var(--text-muted)",
                      "margin-top": "2px",
                    }}
                  >
                    Platform: {platformLabel(s().platform)}
                    {s().ready
                      ? ` \u2014 Suggested runtime: ${s().suggested_runtime}`
                      : " \u2014 Install a container runtime to get started"}
                  </div>
                </div>
              </div>
            </div>

            {/* Quick action for non-ready state */}
            <Show when={!s().ready}>
              <div class="card" style={{
                "border-left": "4px solid #58a6ff",
                "margin-bottom": "20px",
                padding: "20px",
              }}>
                <div style={{ "font-weight": "600", "margin-bottom": "8px" }}>
                  Get started
                </div>
                <div style={{ "font-size": "13px", color: "#8b949e", "margin-bottom": "16px" }}>
                  {s().platform === "macos"
                    ? "Orca needs Docker Desktop or Docker via Lima to manage containers on macOS."
                    : s().platform === "windows"
                    ? "Orca needs WSL2 with Docker installed to manage containers on Windows."
                    : "Orca needs Docker or Podman to manage containers."}
                </div>
                <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                  <For each={s().checks.filter(c => c.fix_action && c.status !== "Pass")}>
                    {(check) => (
                      <button
                        class="btn btn-primary"
                        disabled={fixingAction() === check.fix_action}
                        onClick={() => runFix(check.fix_action!)}
                      >
                        {fixingAction() === check.fix_action
                          ? "Installing..."
                          : `Install ${check.name}`}
                      </button>
                    )}
                  </For>
                  <Show when={s().checks.filter(c => c.fix_action && c.status !== "Pass").length === 0}>
                    <div style={{ "font-size": "13px", color: "#8b949e" }}>
                      Install <a href="https://www.docker.com/products/docker-desktop/" target="_blank" style={{ color: "#58a6ff" }}>Docker Desktop</a> or a container runtime manually, then click Re-check.
                    </div>
                  </Show>
                </div>
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

            {/* Health Checks */}
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
                            ? "Fixing..."
                            : "Fix"}
                        </button>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
