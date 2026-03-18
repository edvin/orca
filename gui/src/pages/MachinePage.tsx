import { createSignal, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { MachineInfo } from "../lib/types";
import { formatBytes } from "../lib/format";

export default function MachinePage() {
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
        <h1 class="page-title">Machine</h1>
        <button class="btn" onClick={refresh}>Refresh</button>
      </div>

      <Show when={error()}>
        <div class="card" style={{ "border-color": "#da3633", "margin-bottom": "16px" }}>
          <span style={{ color: "#f85149" }}>{error()}</span>
        </div>
      </Show>

      <Show when={machine()} fallback={
        <div class="empty">
          <p class="empty-title">Loading machine info...</p>
        </div>
      }>
        {(m) => (
          <div style={{ "max-width": "600px" }}>
            <div class="card">
              <div class="card-grid">
                <span class="card-label">Name</span>
                <span class="card-value">{m().name}</span>

                <span class="card-label">Backend</span>
                <span class="card-value">{m().backend}</span>

                <span class="card-label">State</span>
                <span class={`state-badge ${m().state === "Running" ? "state-running" : "state-stopped"}`}>
                  {m().state}
                </span>

                <span class="card-label">Runtime</span>
                <span class="card-value">{m().config.runtime}</span>

                <span class="card-label">CPUs</span>
                <span class="card-value">{m().config.cpus}</span>

                <span class="card-label">Memory</span>
                <span class="card-value">{formatBytes(m().config.memory_mb * 1024 * 1024)}</span>

                <Show when={m().config.disk_gb > 0}>
                  <span class="card-label">Disk</span>
                  <span class="card-value">{m().config.disk_gb} GB</span>
                </Show>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
