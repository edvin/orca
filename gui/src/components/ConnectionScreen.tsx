import { createSignal, createEffect, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";

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
        <h2 class="connection-title">{t("components.connection.starting")}</h2>
        <p class="connection-subtitle">
          {t("components.connection.connecting")}
        </p>
      </Show>

      <Show when={props.status !== "connecting"}>
        <h2 class="connection-title">{t("components.connection.notRunning")}</h2>
        <p class="connection-subtitle">
          {t("components.connection.description")}
        </p>

        <Show when={error()}>
          <div class="connection-error">
            <div style={{ "font-weight": "600", "margin-bottom": "6px" }}>
              {t("components.connection.startFailed")}
            </div>
            <div style={{ "margin-bottom": "8px" }}>{error()}</div>
            <div style={{ "margin-top": "8px", "line-height": "1.8", "font-size": "12px" }}>
              <p style={{ "margin-bottom": "8px" }}>{t("components.connection.binaryMissing")}</p>
              <ol style={{ margin: "0", "padding-left": "18px" }}>
                <li>
                  <a href="https://github.com/edvin/orca/actions" target="_blank" rel="noopener noreferrer" style={{ color: "#58a6ff" }}>
                    {t("components.connection.download")}
                  </a>{" "}
                  {t("components.connection.fromArtifacts")}
                </li>
                <li>
                  {t("components.connection.placeBinary")}
                </li>
                <li>
                  {t("components.connection.clickRetry")}
                </li>
              </ol>
              <p style={{ "margin-top": "8px", color: "#8b949e" }}>
                {t("components.connection.manual")}
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
            {starting() ? t("components.connection.startingButton") : t("components.connection.startDaemon")}
          </button>
          <button class="btn" onClick={() => props.onRetry()}>
            {t("components.connection.retry")}
          </button>
        </div>

        <Show when={daemonPath()}>
          <div class="connection-hint">
            {t("components.connection.lookingAt", { path: daemonPath() })}
          </div>
        </Show>
      </Show>
    </div>
  );
}
