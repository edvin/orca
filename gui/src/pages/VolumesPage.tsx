import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Volume } from "../lib/types";
import { formatTimestamp } from "../lib/format";
import { showToast } from "../components/Toast";
import CopyButton from "../components/CopyButton";
import SortableHeader from "../components/SortableHeader";
import { useSort } from "../lib/useSort";

export default function VolumesPage() {
  const [volumes, setVolumes] = createSignal<Volume[]>([]);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [showCreate, setShowCreate] = createSignal(false);
  const [createName, setCreateName] = createSignal("");
  const [createDriver, setCreateDriver] = createSignal("local");
  const [createLabels, setCreateLabels] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const { sortField, sortDir, toggleSort, sortFn } = useSort<Volume>("name");

  const refresh = async () => {
    try {
      const result = (await invoke("list_volumes")) as Volume[];
      setVolumes(result);
    } catch (e) {
      console.error("Failed to list volumes:", e);
    }
  };

  onMount(refresh);

  const sorted = () => {
    return sortFn(volumes(), (item, field) => {
      switch (field) {
        case "name": return item.name;
        case "driver": return item.driver;
        case "created": return item.created_at;
        default: return "";
      }
    });
  };

  const removeVolume = async (name: string, e: MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Remove volume "${name}"? This will permanently delete the volume data.`)) return;
    try {
      await invoke("remove_volume", { name });
      showToast(`Volume "${name}" removed`, "success");
      await refresh();
    } catch (err) {
      showToast(`Failed to remove volume: ${err}`, "error");
    }
  };

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    const name = createName().trim();
    if (!name) return;
    setCreating(true);
    try {
      const labelLines = createLabels().split("\n").map(l => l.trim()).filter(l => l.includes("="));
      await invoke("create_volume", { name, driver: createDriver().trim() || null, labels: labelLines.length > 0 ? labelLines : null });
      showToast(`Volume "${name}" created`, "success");
      setCreateName(""); setCreateDriver("local"); setCreateLabels(""); setShowCreate(false);
      await refresh();
    } catch (err) {
      showToast(`Failed to create volume: ${err}`, "error");
    }
    setCreating(false);
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
          <button class="btn btn-primary" onClick={() => setShowCreate(true)}>Create</button>
          <button class="btn" onClick={refresh}>Refresh</button>
        </div>
      </div>

      <Show when={volumes().length > 0} fallback={
        <div class="empty">
          <div class="empty-icon">{"💾"}</div>
          <p class="empty-title">No volumes</p>
          <p>Volumes are created when containers need persistent storage</p>
        </div>
      }>
        <table class="table">
          <thead>
            <tr>
              <SortableHeader label="Name" field="name" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <SortableHeader label="Driver" field="driver" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <SortableHeader label="Created" field="created" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <th style={{ "text-align": "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={sorted()}>
              {(v) => (
                <>
                  <tr onClick={() => setSelected(selected() === v.name ? null : v.name)} style={{ cursor: "pointer" }}>
                    <td>
                      <div style={{ "font-weight": "500" }}>{v.name}</div>
                      <Show when={Object.keys(v.labels).length > 0}>
                        <div style={{ "font-size": "11px", color: "#8b949e", "margin-top": "2px" }}>
                          {Object.keys(v.labels).length} label{Object.keys(v.labels).length !== 1 ? "s" : ""}
                        </div>
                      </Show>
                    </td>
                    <td style={{ color: "#8b949e" }}>{v.driver}</td>
                    <td style={{ color: "#8b949e" }}>{formatTimestamp(v.created_at)}</td>
                    <td style={{ "text-align": "right" }}>
                      <button class="btn btn-sm btn-danger" onClick={(e) => removeVolume(v.name, e)}>Remove</button>
                    </td>
                  </tr>
                  <Show when={selected() === v.name}>
                    <tr>
                      <td colspan="4" style={{ padding: 0 }}>
                        <div class="detail-body">
                          <div class="card-grid">
                            <div class="card-label">Mount Point</div>
                            <div class="card-value" style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                              <span class="mono" style={{ "font-size": "12px" }}>{v.mountpoint}</span>
                              <CopyButton text={v.mountpoint} />
                            </div>
                            <Show when={Object.keys(v.labels).length > 0}>
                              <div class="card-label">Labels</div>
                              <div class="card-value">
                                <For each={Object.entries(v.labels)}>
                                  {([k, val]) => (
                                    <div class="mono" style={{ "line-height": "1.6", "font-size": "11px" }}>
                                      <span style={{ color: "#58a6ff" }}>{k}</span>=<span>{val}</span>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </Show>
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

      <Show when={showCreate()}>
        <div class="modal-overlay" onClick={(e) => { if ((e.target as HTMLElement).classList.contains("modal-overlay")) setShowCreate(false); }}>
          <div class="modal-dialog">
            <div class="modal-header">
              <h2 class="modal-title">Create Volume</h2>
              <button class="modal-close" onClick={() => setShowCreate(false)}>{"\u00d7"}</button>
            </div>
            <form onSubmit={handleCreate}>
              <div class="modal-body">
                <div class="form-group">
                  <label class="form-label">Name <span style={{ color: "#f85149" }}>*</span></label>
                  <input class="form-input" type="text" placeholder="my-volume" value={createName()} onInput={(e) => setCreateName(e.currentTarget.value)} autofocus />
                </div>
                <div class="form-group">
                  <label class="form-label">Driver</label>
                  <input class="form-input" type="text" placeholder="local" value={createDriver()} onInput={(e) => setCreateDriver(e.currentTarget.value)} />
                </div>
                <div class="form-group">
                  <label class="form-label">Labels</label>
                  <textarea class="form-textarea mono" placeholder={"key=value\nenvironment=production"} value={createLabels()} onInput={(e) => setCreateLabels(e.currentTarget.value)} rows={2} />
                  <span class="form-hint">key=value, one per line</span>
                </div>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn" onClick={() => setShowCreate(false)} disabled={creating()}>Cancel</button>
                <button type="submit" class="btn btn-primary" disabled={creating() || !createName().trim()}>
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
