import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Network } from "../lib/types";
import { showToast } from "../components/Toast";
import SortableHeader from "../components/SortableHeader";
import { useSort } from "../lib/useSort";

const DEFAULT_NETWORKS = ["bridge", "host", "none"];

export default function NetworksPage() {
  const [networks, setNetworks] = createSignal<Network[]>([]);
  const [showCreate, setShowCreate] = createSignal(false);
  const [createName, setCreateName] = createSignal("");
  const [createDriver, setCreateDriver] = createSignal("bridge");
  const [creating, setCreating] = createSignal(false);
  const [expandedNetwork, setExpandedNetwork] = createSignal<string | null>(null);
  const { sortField, sortDir, toggleSort, sortFn } = useSort<Network>("name");

  const refresh = async () => {
    try {
      const result = (await invoke("list_networks")) as Network[];
      setNetworks(result);
    } catch (e) {
      console.error("Failed to list networks:", e);
    }
  };

  onMount(refresh);

  const removeNetwork = async (name: string, e: MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Remove network "${name}"?`)) return;
    try {
      await invoke("remove_network", { name });
      showToast(`Network "${name}" removed`, "success");
      await refresh();
    } catch (err) {
      showToast(`Failed to remove network: ${err}`, "error");
    }
  };

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    const name = createName().trim();
    if (!name) return;

    setCreating(true);
    try {
      await invoke("create_network", {
        name,
        driver: createDriver().trim() || null,
      });
      showToast(`Network "${name}" created`, "success");
      setCreateName("");
      setCreateDriver("bridge");
      setShowCreate(false);
      await refresh();
    } catch (err) {
      showToast(`Failed to create network: ${err}`, "error");
    }
    setCreating(false);
  };

  let mouseDownOnOverlay = false;
  const handleOverlayMouseDown = (e: MouseEvent) => {
    mouseDownOnOverlay = (e.target as HTMLElement).classList.contains("modal-overlay");
  };
  const handleOverlayClick = (e: MouseEvent) => {
    if (mouseDownOnOverlay && (e.target as HTMLElement).classList.contains("modal-overlay")) {
      setShowCreate(false);
    }
    mouseDownOnOverlay = false;
  };

  const isDefaultNetwork = (name: string) => DEFAULT_NETWORKS.includes(name);

  const sorted = () => {
    return sortFn(networks(), (item, field) => {
      switch (field) {
        case "name": return item.name;
        case "driver": return item.driver;
        case "subnet": return item.subnet || "";
        default: return "";
      }
    });
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">
          Networks
          <span style={{ "font-size": "13px", color: "#8b949e", "font-weight": "400", "margin-left": "8px" }}>
            {networks().length}
          </span>
        </h1>
        <div class="page-actions">
          <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
            Create
          </button>
          <button class="btn" onClick={refresh}>Refresh</button>
        </div>
      </div>

      <Show
        when={networks().length > 0}
        fallback={
          <div class="empty">
            <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><line x1="12" y1="7" x2="12" y2="12"/><path d="M12 12L5 17"/><path d="M12 12l7 5"/></svg></div>
            <p class="empty-title">No custom networks</p>
            <p>The default bridge, host, and none networks are managed by Docker</p>
          </div>
        }
      >
        <table class="table">
          <thead>
            <tr>
              <SortableHeader label="Name" field="name" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <th>ID</th>
              <SortableHeader label="Driver" field="driver" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <SortableHeader label="Subnet" field="subnet" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <th>Gateway</th>
              <th style={{ "text-align": "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={sorted()}>
              {(n) => (<>
                <tr
                  onClick={() => setExpandedNetwork(expandedNetwork() === n.id ? null : n.id)}
                  style={{ cursor: "pointer" }}
                >
                  <td style={{ "font-weight": "500" }}>
                    <span class={`expand-arrow ${expandedNetwork() === n.id ? "expanded" : ""}`} style={{ "margin-right": "6px", "font-size": "10px" }}>
                      {"\u25B6"}
                    </span>
                    {n.name}
                  </td>
                  <td class="mono" style={{ color: "#8b949e" }}>{n.id.substring(0, 12)}</td>
                  <td>{n.driver}</td>
                  <td class="mono">{n.subnet || "-"}</td>
                  <td class="mono">{n.gateway || "-"}</td>
                  <td style={{ "text-align": "right" }}>
                    <Show when={!isDefaultNetwork(n.name)}>
                      <button
                        class="action-icon action-icon-delete"
                        title="Remove network"
                        onClick={(e) => removeNetwork(n.name, e)}
                      >{"\u2715"}</button>
                    </Show>
                  </td>
                </tr>
                <Show when={expandedNetwork() === n.id}>
                  <tr>
                    <td colspan="6" style={{ padding: "12px 16px 12px 36px", background: "#161b22", "border-top": "none" }}>
                      <div style={{ display: "grid", "grid-template-columns": "repeat(3, 1fr)", gap: "12px", "font-size": "13px" }}>
                        <div>
                          <span style={{ color: "#8b949e" }}>Full ID</span>
                          <div class="mono" style={{ "word-break": "break-all", "margin-top": "2px" }}>{n.id}</div>
                        </div>
                        <div>
                          <span style={{ color: "#8b949e" }}>Subnet</span>
                          <div class="mono" style={{ "margin-top": "2px" }}>{n.subnet || "None"}</div>
                        </div>
                        <div>
                          <span style={{ color: "#8b949e" }}>Gateway</span>
                          <div class="mono" style={{ "margin-top": "2px" }}>{n.gateway || "None"}</div>
                        </div>
                        <div>
                          <span style={{ color: "#8b949e" }}>Driver</span>
                          <div style={{ "margin-top": "2px" }}>{n.driver}</div>
                        </div>
                        <div>
                          <span style={{ color: "#8b949e" }}>Scope</span>
                          <div style={{ "margin-top": "2px" }}>{isDefaultNetwork(n.name) ? "Default" : "Custom"}</div>
                        </div>
                        <div>
                          <span style={{ color: "#8b949e" }}>Labels</span>
                          <div class="mono" style={{ "margin-top": "2px" }}>
                            {Object.keys(n.labels).length > 0
                              ? Object.entries(n.labels).map(([k, v]) => `${k}=${v}`).join(", ")
                              : "None"}
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                </Show>
              </>)}
            </For>
          </tbody>
        </table>
      </Show>

      {/* Create Network Dialog */}
      <Show when={showCreate()}>
        <div class="modal-overlay" onMouseDown={handleOverlayMouseDown} onClick={handleOverlayClick}>
          <div class="modal-dialog">
            <div class="modal-header">
              <h2 class="modal-title">Create Network</h2>
              <button class="modal-close" onClick={() => setShowCreate(false)}>
                {"\u00d7"}
              </button>
            </div>
            <form onSubmit={handleCreate}>
              <div class="modal-body">
                <div class="form-group">
                  <label class="form-label">
                    Name <span style={{ color: "#f85149" }}>*</span>
                  </label>
                  <input
                    class="form-input"
                    type="text"
                    placeholder="my-network"
                    value={createName()}
                    onInput={(e) => setCreateName(e.currentTarget.value)}
                    autofocus
                  />
                </div>

                <div class="form-group">
                  <label class="form-label">Driver</label>
                  <select
                    class="form-select"
                    value={createDriver()}
                    onChange={(e) => setCreateDriver(e.currentTarget.value)}
                  >
                    <option value="bridge">bridge</option>
                    <option value="host">host</option>
                    <option value="macvlan">macvlan</option>
                    <option value="ipvlan">ipvlan</option>
                    <option value="none">none</option>
                  </select>
                </div>
              </div>

              <div class="modal-footer">
                <button type="button" class="btn" onClick={() => setShowCreate(false)} disabled={creating()}>
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn-primary"
                  disabled={creating() || !createName().trim()}
                >
                  {creating() ? "Creating..." : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </Show>
    </div>
  );
}
