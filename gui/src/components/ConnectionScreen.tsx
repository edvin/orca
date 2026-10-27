import { createSignal, createEffect, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import EngineHelp from "./EngineHelp";

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

  // "Port 9477 is in use by <name> (PID <pid>)": what holds the port.
  const holder = () => {
    const m = error()?.match(/Port \d+ is in use by (.+) \(PID (\d+)\)/);
    return m ? { name: m[1], pid: Number(m[2]) } : null;
  };

  const quitHolder = async (pid: number) => {
    setStarting(true);
    try {
      await invoke("quit_port_holder", { pid });
    } catch (e) {
      setError(String(e));
      setStarting(false);
      return;
    }
    await startDaemon();
  };

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
            <Show when={/not found|no such file|cannot find|os error 2\b/i.test(error() ?? "")} fallback={
              <Show when={holder()} fallback={
                <div style={{ "margin-top": "8px", "line-height": "1.7", "font-size": "12px" }}>
                  <p>Click <strong>Retry connection</strong>. If it keeps failing, quit Orca completely and open it again.</p>
                </div>
              }>
                {(h) => (
                  <div style={{ "margin-top": "8px", "line-height": "1.7", "font-size": "12px" }}>
                    <p style={{ "margin-bottom": "8px" }}>
                      Orca needs port 9477. Quit <strong>{h().name}</strong> to free it, and Orca starts its daemon again.
                      If you don't recognise it, look it up in Activity Monitor (or Task Manager) by its PID first.
                    </p>
                    <button class="btn btn-sm" disabled={starting()} onClick={() => void quitHolder(h().pid)}>
                      {starting() ? "Quitting…" : `Quit ${h().name}`}
                    </button>
                  </div>
                )}
              </Show>
            }>
              <div style={{ "margin-top": "8px", "line-height": "1.7", "font-size": "12px" }}>
                <p style={{ "margin-bottom": "6px" }}>Orca's daemon (<code>orca-daemon</code>) is missing from this installation. To fix it:</p>
                <ol style={{ margin: "0", "padding-left": "18px" }}>
                  <li>Download Orca again from <a href="https://orca-desktop.com/download/" target="_blank" rel="noopener noreferrer" style={{ color: "#58a6ff" }}>orca-desktop.com/download</a> and reinstall it.</li>
                  <li>Then click <strong>Retry connection</strong>.</li>
                </ol>
              </div>
            </Show>
          </div>
        </Show>

        <div class="connection-actions">
          <button
            class="btn btn-primary"
            onClick={startDaemon}
            disabled={starting()}
          >
            {starting() ? "Starting..." : "Start daemon"}
          </button>
          <button class="btn" onClick={() => props.onRetry()}>
            Retry connection
          </button>
        </div>

        <Show when={error()}>
          {(e) => (
            <div style={{ width: "100%", "max-width": "640px" }}>
              <EngineHelp problem={`Orca's daemon doesn't start: ${e()}`} />
            </div>
          )}
        </Show>

        <Show when={daemonPath()}>
          <div class="connection-hint">
            Looking for daemon at: <code>{daemonPath()}</code>
          </div>
        </Show>
      </Show>
    </div>
  );
}
