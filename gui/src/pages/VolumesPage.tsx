import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Volume } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { formatTimestamp, formatBytes } from "../lib/format";
import { showToast } from "../components/Toast";
import { confirmDanger } from "../components/ConfirmDialog";
import { containersStore } from "../lib/dockerStore";
import { isAnonymous, shortContainer, volumeStack, volumeTitle, volumeUsers } from "../lib/volumes";
import { logError } from "../lib/activityStore";
import Spinner from "../components/Spinner";
import HelpLink from "../components/HelpLink";

interface VolumesPageProps {
  onNavigate?: (target: string) => void;
}

const STACK_COLORS = ["#58a6ff", "#3fb950", "#bc8cff", "#f0883e", "#39c5cf", "#f778ba", "#e3b341"];
const stackColor = (s: string) => STACK_COLORS[[...s].reduce((n, c) => n + c.charCodeAt(0), 0) % STACK_COLORS.length];

export default function VolumesPage(props: VolumesPageProps) {
  const [volumes, setVolumes] = createSignal<Volume[]>([]);
  const [volumeSizes, setVolumeSizes] = createSignal<Record<string, number>>({});
  const [showCreate, setShowCreate] = createSignal(false);
  const [createName, setCreateName] = createSignal("");
  const [createDriver, setCreateDriver] = createSignal("local");
  const [createLabels, setCreateLabels] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);
  const [deletingName, setDeletingName] = createSignal<string | null>(null);
  const [filter, setFilter] = createSignal<"all" | "used" | "unused">("all");
  const [query, setQuery] = createSignal("");

  // Sizes take a `system df` walk (seconds on a busy engine) unless the
  // daemon has them cached, so the list doesn't wait for them.
  const loadSizes = (recompute = false) =>
    (invoke("volume_sizes", { refresh: recompute }) as Promise<{ sizes: Record<string, number> }>)
      .then((r) => setVolumeSizes(r?.sizes || {}))
      .catch(() => {});

  const refresh = async (recompute = false) => {
    void loadSizes(recompute);
    try {
      const result = (await invoke("list_volumes")) as Volume[];
      setVolumes(result || []);
    } catch {
    }
    setLoaded(true);
  };

  // A manual refresh (Ctrl+R) measures the sizes again.
  useRefresh(() => refresh(true));

  onMount(() => refresh());

  const removeVolume = async (name: string, e: MouseEvent) => {
    e.stopPropagation();
    if (!await confirmDanger("Remove volume", `Remove volume "${name}"? This will permanently delete the volume data.`)) return;
    setDeletingName(name);
    try {
      await invoke("remove_volume", { name });
      showToast(`Volume "${name}" removed`, "success");
      await refresh();
    } catch (err) {
      logError(`Failed to remove volume: ${err}`, `Volume "${name}"`);
      showToast(`Failed to remove volume: ${err}`, "error");
    } finally {
      setDeletingName(null);
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

  const containers = containersStore.use();
  const users = () => volumeUsers(containers.list());
  const usersOf = (name: string) => users().get(name) ?? [];
  const sizeOf = (name: string) => volumeSizes()[name];
  const unused = () => volumes().filter((v) => usersOf(v.name).length === 0);
  const sumSizes = (vs: Volume[]) => {
    const sizes = volumeSizes();
    return vs.reduce((n, v) => n + (sizes[v.name] ?? 0), 0);
  };
  const haveSizes = () => Object.keys(volumeSizes()).length > 0;

  const matches = (v: Volume) => {
    const q = query().trim().toLowerCase();
    if (!q) return true;
    return [v.name, volumeTitle(v), volumeStack(v) ?? "", ...usersOf(v.name).flatMap((u) => [u.container.name, u.destination, u.container.image])]
      .some((t) => t.toLowerCase().includes(q));
  };
  // In use first, by stack; then unused, biggest first.
  const shown = () =>
    volumes()
      .filter((v) => (filter() === "all" ? true : filter() === "used" ? usersOf(v.name).length > 0 : usersOf(v.name).length === 0))
      .filter(matches)
      .map((v) => ({ v, used: usersOf(v.name).length > 0, stack: volumeStack(v) ?? "\uffff", size: sizeOf(v.name) ?? 0 }))
      .sort((a, b) =>
        Number(b.used) - Number(a.used) ||
        a.stack.localeCompare(b.stack) ||
        b.size - a.size ||
        volumeTitle(a.v).localeCompare(volumeTitle(b.v)))
      .map((x) => x.v);

  return (
    <div>
      <div class="page-header">
        <div>
          <h1 class="page-title">Volumes</h1>
          <div class="page-subtitle">Data that outlives its container: databases, uploads, caches. <HelpLink path="/docs/containers/#volumes" /></div>
        </div>
        <div class="page-actions">
          <button class="btn" title="Refresh, and measure the sizes again" aria-label="Refresh" onClick={() => refresh(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "vertical-align": "-2px" }}><path d="M20 12a8 8 0 1 1-3-6.2M20 4v5h-5"/></svg>
          </button>
          <button class="btn btn-primary btn-iconed" onClick={() => setShowCreate(true)}>
            <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Create volume
          </button>
        </div>
      </div>

      <Show when={volumes().length > 0} fallback={
        <Show when={loaded()} fallback={
          <div class="nl"><For each={[0, 1, 2, 3]}>{() => <div class="nl-row nl-skeleton" />}</For></div>
        }>
          <div class="empty">
            <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg></div>
            <p class="empty-title">No volumes yet</p>
            <p>Volumes keep a container's data across restarts and recreates; compose projects create their own. <HelpLink path="/docs/containers/#volumes" /></p>
            <div class="empty-actions">
              <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
                Create volume
              </button>
            </div>
          </div>
        </Show>
      }>
        <div class="nl-summary">
          <div><span class="nl-k">Volumes</span><b>{volumes().length}</b></div>
          <div><span class="nl-k">In use</span><b>{volumes().length - unused().length}</b></div>
          <div><span class="nl-k">Unused</span><b class={unused().length ? "vl-warn" : ""}>{unused().length}</b>
            <Show when={haveSizes() && unused().length}><span class="vl-sub">{formatBytes(sumSizes(unused()))}</span></Show>
          </div>
          <div><span class="nl-k">Total size</span><b>{haveSizes() ? formatBytes(sumSizes(volumes())) : "–"}</b></div>
        </div>

        <div class="vl-toolbar">
          <div class="segmented" role="tablist">
            <button class={filter() === "all" ? "active" : ""} onClick={() => setFilter("all")}>All</button>
            <button class={filter() === "used" ? "active" : ""} onClick={() => setFilter("used")}>In use</button>
            <button class={filter() === "unused" ? "active" : ""} onClick={() => setFilter("unused")}>Unused</button>
          </div>
          <input class="form-input vl-search" type="search" placeholder="Find a volume, container or path"
            value={query()} onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }} />
        </div>

        <Show when={shown().length > 0} fallback={<div class="nl-hint" style={{ padding: "24px 4px" }}>No volumes match.</div>}>
          <div class="nl">
            <For each={shown()}>
              {(v) => {
                const us = () => usersOf(v.name);
                const stack = () => volumeStack(v);
                const used = () => us().length > 0;
                return (
                  <div class="nl-row vl-row" classList={{ "nl-empty": !used() }} style={{ "--net": stack() ? stackColor(stack()!) : used() ? "#58a6ff" : "#6e7681" }}>
                    <div class="vl-main" role="button" tabindex="0"
                      onClick={() => props.onNavigate?.(`volume:${v.name}`)}
                      onKeyDown={(e) => { if (e.key === "Enter") props.onNavigate?.(`volume:${v.name}`); }}>
                      <span class="nl-icon">
                        <svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>
                      </span>
                      <div class="nl-title">
                        <div class="nl-name">
                          {volumeTitle(v)}
                          <Show when={stack()}><span class="nl-tag nl-tag-compose">{stack()}</span></Show>
                          <Show when={isAnonymous(v.name)}><span class="nl-tag mono">{v.name.slice(0, 12)}</span></Show>
                          <Show when={!used()}><span class="nl-tag vl-tag-unused">Unused</span></Show>
                        </div>
                        <div class="nl-meta">
                          <Show when={used()} fallback={<span>Not mounted by any container{v.driver !== "local" ? ` · ${v.driver}` : ""}</span>}>
                            <For each={us().slice(0, 2)}>
                              {(u, i) => (
                                <span>
                                  {i() > 0 ? " · " : ""}
                                  <span class="mono vl-path">{u.destination}</span>
                                  {" in "}
                                  <button class="vl-ctr" onClick={(e) => { e.stopPropagation(); props.onNavigate?.(`container:${u.container.id}`); }}>
                                    {shortContainer(u.container.name, stack())}
                                  </button>
                                  <Show when={!u.rw}><span class="vl-ro"> read-only</span></Show>
                                </span>
                              )}
                            </For>
                            <Show when={us().length > 2}><span> · +{us().length - 2} more</span></Show>
                          </Show>
                        </div>
                      </div>
                      <div class="vl-size">
                        <b>{sizeOf(v.name) !== undefined ? formatBytes(sizeOf(v.name)!) : "–"}</b>
                        <span>{formatTimestamp(v.created_at)}</span>
                      </div>
                      <span class="nl-actions">
                        <Show when={!used()}>
                          <Show when={deletingName() === v.name} fallback={
                            <button class="action-icon action-icon-delete" title="Remove volume" disabled={deletingName() !== null} onClick={(e) => removeVolume(v.name, e)}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                            </button>
                          }>
                            <Spinner size={12} />
                          </Show>
                        </Show>
                        <svg class="nl-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
                      </span>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={showCreate()}>
        <div class="modal-overlay" onMouseDown={(e) => { (e.currentTarget as any).__mdOverlay = (e.target as HTMLElement).classList.contains("modal-overlay"); }} onClick={(e) => { if ((e.currentTarget as any).__mdOverlay && (e.target as HTMLElement).classList.contains("modal-overlay")) setShowCreate(false); (e.currentTarget as any).__mdOverlay = false; }}>
          <div class="modal-dialog" style={{ width: "600px", "max-width": "92vw" }}>
            <div class="modal-header">
              <div class="modal-head-main">
                <span class="modal-icon"><svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg></span>
                <div>
                  <h2 class="modal-title">Create volume</h2>
                  <div class="modal-subtitle">Mount it in a container to keep that container's data.</div>
                </div>
              </div>
              <button class="modal-close" onClick={() => setShowCreate(false)}>{"\u00d7"}</button>
            </div>
            <form onSubmit={handleCreate}>
              <div class="modal-body">
                <div class="form-row">
                  <div class="form-group" style={{ flex: 2 }}>
                    <label class="form-label">Name</label>
                    <input class="form-input mono" type="text" placeholder="my-volume" value={createName()} onInput={(e) => setCreateName(e.currentTarget.value)} autofocus />
                  </div>
                  <div class="form-group" style={{ flex: 1 }}>
                    <label class="form-label">Driver <span class="form-label-note">usually local</span></label>
                    <input class="form-input mono" type="text" placeholder="local" value={createDriver()} onInput={(e) => setCreateDriver(e.currentTarget.value)} />
                  </div>
                </div>
                <div class="form-group">
                  <label class="form-label">Labels <span class="form-label-note">optional</span></label>
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
