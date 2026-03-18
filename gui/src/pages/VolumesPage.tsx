import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Volume } from "../lib/types";
import { formatTimestamp } from "../lib/format";
import { showToast } from "../components/Toast";

export default function VolumesPage() {
  const [volumes, setVolumes] = createSignal<Volume[]>([]);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [showCreate, setShowCreate] = createSignal(false);
  const [createName, setCreateName] = createSignal("");
  const [createDriver, setCreateDriver] = createSignal("local");
  const [createLabels, setCreateLabels] = createSignal("");
  const [creating, setCreating] = createSignal(false);

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
    if (!window.confirm(`Remove volume "${name}"? This will permanently delete the volume data.`)) {
      return;
    }
    try {
      await invoke("remove_volume", { name });
      showToast(`Volume "${name}" removed`, "success");
      await refresh();
    } catch (e) {
      showToast(`Failed to remove volume: ${e}`, "error");
    }
  };

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    const name = createName().trim();
    if (!name) return;

    setCreating(true);
    try {
      const labelLines = createLabels()
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && l.includes("="));

      await invoke("create_volume", {
        name,
        driver: createDriver().trim() || null,
        labels: labelLines.length > 0 ? labelLines : null,
      });
      showToast(`Volume "${name}" created`, "success");
      setCreateName("");
      setCreateDriver("local");
      setCreateLabels("");
      setShowCreate(false);
      await refresh();
    } catch (err) {
      showToast(`Failed to create volume: ${err}`, "error");
    }
    setCreating(false);
  };

  const handleOverlayClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains("modal-overlay")) {
      setShowCreate(false);
    }
  };

  const toggleSelect = (name: string) => {
    setSelected(selected() === name ? null : name);
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
        <div class="page-actions">
          <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
            Create
          </button>
          <button class="btn" onClick={refresh}>Refresh</button>
        </div>
      </div>

      <Show
        when={volumes().length > 0}
        fallback={
          <div class="empty">
            <div class="empty-icon">{"💾"}</div>
            <p class="empty-title">No volumes</p>
            <p>Volumes are created when containers need persistent storage</p>
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
                <>
                  <tr
                    onClick={() => toggleSelect(v.name)}
                    style={{ cursor: "pointer" }}
                  >
                    <td style={{ "font-weight": "500" }}>{v.name}</td>
                    <td>{v.driver}</td>
                    <td class="mono" style={{ color: "#8b949e", "font-size": "12px" }}>
                      {v.mountpoint}
                    </td>
                    <td style={{ color: "#8b949e" }}>{formatTimestamp(v.created_at)}</td>
                    <td style={{ "text-align": "right" }}>
                      <button
                        class="btn btn-sm btn-danger"
                        onClick={(e) => { e.stopPropagation(); removeVolume(v.name); }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                  <Show when={selected() === v.name}>
                    <tr>
                      <td colspan="5" style={{ padding: 0 }}>
                        <div class="detail-body">
                          <div class="card-grid">
                            <div class="card-label">Name</div>
                            <div class="card-value">{v.name}</div>

                            <div class="card-label">Driver</div>
                            <div class="card-value">{v.driver}</div>

                            <div class="card-label">Mount Point</div>
                            <div class="card-value mono" style={{ "font-size": "12px" }}>{v.mountpoint}</div>

                            <div class="card-label">Created</div>
                            <div class="card-value">{formatTimestamp(v.created_at)}</div>

                            <div class="card-label">Labels</div>
                            <div class="card-value">
                              <Show when={Object.keys(v.labels).length > 0} fallback={<span style={{ color: "#8b949e" }}>None</span>}>
                                <For each={Object.entries(v.labels)}>
                                  {([k, val]) => (
                                    <div class="mono" style={{ "line-height": "1.6", "font-size": "11px" }}>
                                      <span style={{ color: "#58a6ff" }}>{k}</span>=<span>{val}</span>
                                    </div>
                                  )}
                                </For>
                              </Show>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  </Show>
                </>
              )}
            </For>
          </tbody>
        </table>
      </Show>

      {/* Create Volume Dialog */}
      <Show when={showCreate()}>
        <div class="modal-overlay" onClick={handleOverlayClick}>
          <div class="modal-dialog">
            <div class="modal-header">
              <h2 class="modal-title">Create Volume</h2>
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
                    placeholder="my-volume"
                    value={createName()}
                    onInput={(e) => setCreateName(e.currentTarget.value)}
                    autofocus
                  />
                </div>

                <div class="form-group">
                  <label class="form-label">Driver</label>
                  <input
                    class="form-input"
                    type="text"
                    placeholder="local"
                    value={createDriver()}
                    onInput={(e) => setCreateDriver(e.currentTarget.value)}
                  />
                </div>

                <div class="form-group">
                  <label class="form-label">Labels</label>
                  <textarea
                    class="form-textarea mono"
                    placeholder={"key=value\nenvironment=production"}
                    value={createLabels()}
                    onInput={(e) => setCreateLabels(e.currentTarget.value)}
                    rows={3}
                  />
                  <span class="form-hint">key=value, one per line</span>
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
