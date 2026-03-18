import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Network } from "../lib/types";

export default function NetworksPage() {
  const [networks, setNetworks] = createSignal<Network[]>([]);

  const refresh = async () => {
    try {
      const result = (await invoke("list_networks")) as Network[];
      setNetworks(result);
    } catch (e) {
      console.error("Failed to list networks:", e);
    }
  };

  onMount(refresh);

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">
          Networks
          <span style={{ "font-size": "13px", color: "#8b949e", "font-weight": "400", "margin-left": "8px" }}>
            {networks().length}
          </span>
        </h1>
        <button class="btn" onClick={refresh}>Refresh</button>
      </div>

      <Show
        when={networks().length > 0}
        fallback={
          <div class="empty">
            <p class="empty-title">No networks</p>
          </div>
        }
      >
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>ID</th>
              <th>Driver</th>
              <th>Subnet</th>
              <th>Gateway</th>
            </tr>
          </thead>
          <tbody>
            <For each={networks()}>
              {(n) => (
                <tr>
                  <td style={{ "font-weight": "500" }}>{n.name}</td>
                  <td class="mono" style={{ color: "#8b949e" }}>{n.id.substring(0, 12)}</td>
                  <td>{n.driver}</td>
                  <td class="mono">{n.subnet || "-"}</td>
                  <td class="mono">{n.gateway || "-"}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}
