import { createSignal, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { MachineInfo } from "../lib/types";

export default function SettingsPage() {
  const [machine, setMachine] = createSignal<MachineInfo | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const refresh = async () => {
    try {
      const info = (await invoke("get_machine_info")) as MachineInfo;
      setMachine(info);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  onMount(refresh);

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">Settings</h1>
      </div>

      <Show when={error()}>
        <div class="card" style={{ "border-color": "#da3633", "margin-bottom": "16px" }}>
          <span style={{ color: "#f85149" }}>{error()}</span>
        </div>
      </Show>

      <div style={{ "max-width": "640px", display: "flex", "flex-direction": "column", gap: "20px" }}>
        {/* General Section */}
        <div class="settings-section">
          <h2 class="settings-section-title">General</h2>
          <div class="card">
            <div class="settings-row">
              <div class="settings-row-left">
                <span class="settings-label">Start on Login</span>
                <span class="settings-description">Automatically launch Orca when you log in</span>
              </div>
              <div class="settings-toggle disabled">
                <div class="toggle-track">
                  <div class="toggle-thumb" />
                </div>
              </div>
            </div>
            <div class="settings-divider" />
            <div class="settings-row">
              <div class="settings-row-left">
                <span class="settings-label">Show Tray Icon</span>
                <span class="settings-description">Display Orca in the system tray</span>
              </div>
              <div class="settings-toggle disabled">
                <div class="toggle-track toggle-on">
                  <div class="toggle-thumb" />
                </div>
              </div>
            </div>
          </div>
          <p class="settings-note">
            These settings are read-only for now. Edit the config file directly to change them.
          </p>
        </div>

        {/* Runtime Section */}
        <div class="settings-section">
          <h2 class="settings-section-title">Container Runtime</h2>
          <div class="card">
            <Show when={machine()} fallback={
              <div style={{ padding: "8px 0", color: "#8b949e" }}>Loading runtime info...</div>
            }>
              {(m) => (
                <div class="card-grid">
                  <span class="card-label">Runtime</span>
                  <span class="card-value">{m().config.runtime}</span>

                  <span class="card-label">Backend</span>
                  <span class="card-value">{m().backend}</span>

                  <span class="card-label">State</span>
                  <span class={`state-badge ${m().state === "Running" ? "state-running" : "state-stopped"}`}>
                    {m().state}
                  </span>

                  <span class="card-label">Socket Path</span>
                  <span class="card-value mono">
                    {m().config.runtime === "Docker"
                      ? "/var/run/docker.sock"
                      : `/run/user/${1000}/podman/podman.sock`}
                  </span>

                  <span class="card-label">CPUs</span>
                  <span class="card-value">{m().config.cpus}</span>

                  <span class="card-label">Memory</span>
                  <span class="card-value">
                    {(m().config.memory_mb / 1024).toFixed(1)} GB
                  </span>
                </div>
              )}
            </Show>
          </div>
        </div>

        {/* Config Location */}
        <div class="settings-section">
          <h2 class="settings-section-title">Configuration</h2>
          <div class="card">
            <div class="card-grid">
              <span class="card-label">Config File</span>
              <span class="card-value mono">~/.config/orca/config.toml</span>

              <span class="card-label">Data Directory</span>
              <span class="card-value mono">~/.local/share/orca/</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
