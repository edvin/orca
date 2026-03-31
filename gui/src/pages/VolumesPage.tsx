import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Volume } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { formatTimestamp, formatBytes } from "../lib/format";
import { showToast } from "../components/Toast";
import { confirmDanger } from "../components/ConfirmDialog";
import SortableHeader from "../components/SortableHeader";
import { useSort } from "../lib/useSort";
import { logError } from "../lib/activityStore";

interface VolumesPageProps {
  onNavigate?: (target: string) => void;
}

export default function VolumesPage(props: VolumesPageProps) {
  const [volumes, setVolumes] = createSignal<Volume[]>([]);
  const [volumeSizes, setVolumeSizes] = createSignal<Record<string, number>>({});
  const [showCreate, setShowCreate] = createSignal(false);
  const [createName, setCreateName] = createSignal("");
  const [createDriver, setCreateDriver] = createSignal("local");
  const [createLabels, setCreateLabels] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const { sortField, sortDir, toggleSort, sortFn } = useSort<Volume>("name");

  const refresh = async () => {
    try {
      const [result, sizesResult] = await Promise.all([
        invoke("list_volumes") as Promise<Volume[]>,
        invoke("volume_sizes") as Promise<{ sizes: Record<string, number> }>,
      ]);
      setVolumes(result || []);
      setVolumeSizes(sizesResult?.sizes || {});
    } catch {
    }
  };

  useRefresh(refresh);

  onMount(refresh);

  const sorted = () => {
    const sizes = volumeSizes();
    return sortFn(volumes(), (item, field) => {
      switch (field) {
        case "name": return item.name;
        case "driver": return item.driver;
        case "size": return sizes[item.name] ?? -1;
        case "created": return item.created_at;
        default: return "";
      }
    });
  };

  const removeVolume = async (name: string, e: MouseEvent) => {
    e.stopPropagation();
    if (!await confirmDanger("Remove Volume", `Remove volume "${name}"? This will permanently delete the volume data.`)) return;
    try {
      await invoke("remove_volume", { name });
      showToast(`Volume "${name}" removed`, "success");
      await refresh();
    } catch (err) {
      logError(`Failed to remove volume: ${err}`, `Volume "${name}"`);
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
      logError(`Failed to create volume: ${err}`, `Volume "${name}"`);
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
          <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg></div>
          <p class="empty-title">No volumes</p>
          <p>Create a volume to persist data across container restarts, or run a container that creates volumes automatically.</p>
        </div>
      }>
        <table class="table">
          <thead>
            <tr>
              <SortableHeader label="Name" field="name" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <SortableHeader label="Driver" field="driver" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <SortableHeader label="Size" field="size" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <SortableHeader label="Created" field="created" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <th style={{ "text-align": "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={sorted()}>
              {(v) => (
                <tr onClick={() => props.onNavigate?.(`volume:${v.name}`)} style={{ cursor: "pointer" }}>
                  <td>
                    <div style={{ "font-weight": "500" }}>{v.name}</div>
                    <Show when={Object.keys(v.labels).length > 0}>
                      <div style={{ "font-size": "11px", color: "#8b949e", "margin-top": "2px" }}>
                        {Object.keys(v.labels).length} label{Object.keys(v.labels).length !== 1 ? "s" : ""}
                      </div>
                    </Show>
                  </td>
                  <td style={{ color: "#8b949e" }}>{v.driver}</td>
                  <td style={{ color: "#8b949e" }}>
                    {volumeSizes()[v.name] !== undefined ? formatBytes(volumeSizes()[v.name]) : "-"}
                  </td>
                  <td style={{ color: "#8b949e" }}>{formatTimestamp(v.created_at)}</td>
                  <td style={{ "text-align": "right" }}>
                    <button class="action-icon action-icon-delete" title="Remove volume" onClick={(e) => removeVolume(v.name, e)}>
                      {"\uD83D\uDDD1"}
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>

      <Show when={showCreate()}>
        <div class="modal-overlay" onMouseDown={(e) => { (e.currentTarget as any).__mdOverlay = (e.target as HTMLElement).classList.contains("modal-overlay"); }} onClick={(e) => { if ((e.currentTarget as any).__mdOverlay && (e.target as HTMLElement).classList.contains("modal-overlay")) setShowCreate(false); (e.currentTarget as any).__mdOverlay = false; }}>
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
