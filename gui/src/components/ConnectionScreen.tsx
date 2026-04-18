import { createSignal, createEffect, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

interface ConnectionScreenProps {
  status: string; // "connecting" | "disconnected" | "stopped"
  onRetry: () => void;
}

export default function ConnectionScreen(props: ConnectionScreenProps) {
  const [starting, setStarting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [daemonPath, setDaemonPath] = createSignal<string | null>(null);

  const fetchDaemonInfo = async () => {
    try {
      const info = (await invoke("get_daemon_info")) as {
        binary_path: string;
        port: number;
        config_path: string;
      };
      setDaemonPath(info.binary_path);
    } catch {
      // Command may not be available yet
    }
  };

  // Fetch daemon info when disconnected
  createEffect(() => {
    if (props.status !== "connecting") {
      fetchDaemonInfo();
    }
  });

  const startDaemon = async () => {
    setStarting(true);
    setError(null);
    try {
      await invoke("start_daemon");
      // Give it a moment then retry
      setTimeout(() => {
        props.onRetry();
        setStarting(false);
      }, 500);
    } catch (e) {
      setError(String(e));
      setStarting(false);
    }
  };

  return (
    <div class="connection-screen">
      <img src="/icon.png" class="connection-icon" alt="Orca" />

      <Show when={props.status === "connecting"}>
        <div class="connection-spinner" />
        <h2 class="connection-title">Starting Orca...</h2>
        <p class="connection-subtitle">
          Connecting to the Orca daemon and Docker runtime.
        </p>
      </Show>

      <Show when={props.status !== "connecting"}>
        <h2 class="connection-title">Orca daemon is not running</h2>
        <p class="connection-subtitle">
          The Orca daemon manages your containers and must be running for Orca Desktop to work.
        </p>

        <Show when={error()}>
          <div class="connection-error">
            <div style={{ "font-weight": "600", "margin-bottom": "6px" }}>
              Failed to start daemon
            </div>
            <div style={{ "margin-bottom": "8px" }}>{error()}</div>
            <div style={{ "margin-top": "8px", "line-height": "1.8", "font-size": "12px" }}>
              <p style={{ "margin-bottom": "8px" }}>The daemon binary (<code>orca-daemon</code>) was not found. To fix this:</p>
              <ol style={{ margin: "0", "padding-left": "18px" }}>
                <li>
                  <a href="https://github.com/edvin/orca/actions" target="_blank" rel="noopener noreferrer" style={{ color: "#58a6ff" }}>
                    Download orca-daemon
                  </a>{" "}
                  from GitHub Actions artifacts
                </li>
                <li>
                  Place it in your PATH or next to the Orca Desktop app
                </li>
                <li>
                  Click <strong>Retry Connection</strong> below
                </li>
              </ol>
              <p style={{ "margin-top": "8px", color: "#8b949e" }}>
                Or start it manually: <code>orca-daemon</code>
              </p>
            </div>
          </div>
        </Show>

        <div class="connection-actions">
          <button
            class="btn btn-primary"
            onClick={startDaemon}
            disabled={starting()}
          >
            {starting() ? "Starting..." : "Start Daemon"}
          </button>
          <button class="btn" onClick={() => props.onRetry()}>
            Retry Connection
          </button>
        </div>

        <Show when={daemonPath()}>
          <div class="connection-hint">
            Looking for daemon at: <code>{daemonPath()}</code>
          </div>
        </Show>
      </Show>
    </div>
  );
}
