import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Volume } from "../lib/types";
import { formatTimestamp } from "../lib/format";

export default function VolumesPage() {
  const [volumes, setVolumes] = createSignal<Volume[]>([]);

  const refresh = async () => {
    try {
      const result = (await invoke("list_volumes")) as Volume[];
      setVolumes(result);
    } catch (e) {
      console.error("Failed to list volumes:", e);
    }
  };

  onMount(refresh);

  const removeVolume = async (name: string) => {
    try {
      await invoke("remove_volume", { name });
      await refresh();
    } catch (e) {
      console.error("Failed to remove volume:", e);
    }
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">
          Volumes
          <span style={{ "font-size": "13px", color: "#8b949e", "font-weight": "400", "margin-left": "8px" }}>
            {volumes().length}
          </span>
        </h1>
        <button class="btn" onClick={refresh}>Refresh</button>
      </div>

      <Show
        when={volumes().length > 0}
        fallback={
          <div class="empty">
            <p class="empty-title">No volumes</p>
            <p>Volumes will appear here when containers create them.</p>
          </div>
        }
      >
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Driver</th>
              <th>Mount Point</th>
              <th>Created</th>
              <th style={{ "text-align": "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={volumes()}>
              {(v) => (
                <tr>
                  <td style={{ "font-weight": "500" }}>{v.name}</td>
                  <td>{v.driver}</td>
                  <td class="mono" style={{ color: "#8b949e", "font-size": "12px" }}>
                    {v.mountpoint}
                  </td>
                  <td style={{ color: "#8b949e" }}>{formatTimestamp(v.created_at)}</td>
                  <td style={{ "text-align": "right" }}>
                    <button
                      class="btn btn-sm btn-danger"
                      onClick={() => removeVolume(v.name)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}
