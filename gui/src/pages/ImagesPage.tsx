import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Image, ImageSearchResult } from "../lib/types";
import { formatBytes, formatTimestamp, shortId } from "../lib/format";
import { showToast } from "../components/Toast";
import RunContainerDialog from "../components/RunContainerDialog";
import CopyButton from "../components/CopyButton";
import Spinner from "../components/Spinner";
import LastUpdated from "../components/LastUpdated";
import SortableHeader from "../components/SortableHeader";
import { useSort } from "../lib/useSort";

export default function ImagesPage() {
  const [images, setImages] = createSignal<Image[]>([]);
  const [search, setSearch] = createSignal("");
  const [pullRef, setPullRef] = createSignal("");
  const [pulling, setPulling] = createSignal(false);
  const [pullStatus, setPullStatus] = createSignal("");
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [showPull, setShowPull] = createSignal(false);
  const [showPruneConfirm, setShowPruneConfirm] = createSignal(false);
  const [pruning, setPruning] = createSignal(false);
  let pullInputRef: HTMLInputElement | undefined;
  const [showBuild, setShowBuild] = createSignal(false);
  const [buildPath, setBuildPath] = createSignal("");
  const [buildDockerfile, setBuildDockerfile] = createSignal("");
  const [buildTag, setBuildTag] = createSignal("");
  const [building, setBuilding] = createSignal(false);
  const [buildLog, setBuildLog] = createSignal<string[]>([]);
  const [showAuth, setShowAuth] = createSignal(false);
  const [authUsername, setAuthUsername] = createSignal("");
  const [authPassword, setAuthPassword] = createSignal("");
  const [runImage, setRunImage] = createSignal<string | null>(null);
  const [inspecting, setInspecting] = createSignal<string | null>(null);
  const [inspectData, setInspectData] = createSignal<any>(null);
  const [searchResults, setSearchResults] = createSignal<ImageSearchResult[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [showSearchDropdown, setShowSearchDropdown] = createSignal(false);
  const [lastUpdated, setLastUpdated] = createSignal<Date | null>(null);
  const { sortField, sortDir, toggleSort, sortFn } = useSort<Image>("tag");
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  const refresh = async () => {
    try {
      const result = (await invoke("list_images")) as Image[];
      setImages(result);
      setLastUpdated(new Date());
    } catch (e) {
      console.error("Failed to list images:", e);
    }
  };

  onMount(refresh);
  onCleanup(() => { if (searchTimer) clearTimeout(searchTimer); });

  const doSearch = async (q: string) => {
    if (q.length < 2) {
      setSearchResults([]);
      setShowSearchDropdown(false);
      return;
    }
    setSearching(true);
    setShowSearchDropdown(true);
    try {
      const results = (await invoke("search_images", { query: q })) as ImageSearchResult[];
      setSearchResults(results);
    } catch (e) {
      console.error("Search failed:", e);
      setSearchResults([]);
    }
    setSearching(false);
  };

  const onPullInput = (value: string) => {
    setPullRef(value);
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(value.trim()), 500);
  };

  const selectSearchResult = (name: string) => {
    setPullRef(name);
    setShowSearchDropdown(false);
    setSearchResults([]);
  };

  const filtered = () => {
    const q = search().toLowerCase();
    let list = images();
    if (q) {
      list = list.filter(
        (img) =>
          img.repo_tags.some((t) => t.toLowerCase().includes(q)) ||
          img.id.includes(q)
      );
    }
    return sortFn(list, (item, field) => {
      switch (field) {
        case "tag": return item.repo_tags[0] || "";
        case "size": return item.size_bytes;
        case "created": return item.created_at;
        default: return "";
      }
    });
  };

  const toggleSelect = (id: string, e: MouseEvent) => {
    e.stopPropagation();
    const next = new Set(selected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const selectAll = () => {
    if (selected().size === filtered().length) {
      setSelected(new Set<string>());
    } else {
      setSelected(new Set<string>(filtered().map((i) => i.id)));
    }
  };

  const removeImage = async (id: string, tag: string, e: MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Remove image '${tag}'?`)) return;
    try {
      await invoke("remove_image", { id });
      showToast("Image removed", "success");
      await refresh();
    } catch (e) {
      showToast(`Failed to remove: ${e}`, "error");
    }
  };

  const batchDelete = async () => {
    const ids = Array.from(selected());
    if (ids.length === 0) return;
    try {
      const result = (await invoke("batch_delete_images", {
        ids,
        force: true,
      })) as any;
      const deleted = result.deleted?.length || 0;
      const errors = result.errors?.length || 0;
      showToast(
        `Deleted ${deleted} image${deleted !== 1 ? "s" : ""}${errors ? `, ${errors} failed` : ""}`,
        errors ? "error" : "success"
      );
      setSelected(new Set<string>());
      await refresh();
    } catch (e) {
      showToast(`Batch delete failed: ${e}`, "error");
    }
  };

  const pruneUnused = async () => {
    setPruning(true);
    try {
      const result = (await invoke("prune_images")) as any;
      const count = result.images_deleted?.length || 0;
      const space = formatBytes(result.space_reclaimed || 0);
      showToast(`Pruned ${count} image${count !== 1 ? "s" : ""}, freed ${space}`, "success");
      await refresh();
    } catch (e) {
      showToast(`Prune failed: ${e}`, "error");
    } finally {
      setPruning(false);
      setShowPruneConfirm(false);
    }
  };

  const doPull = async () => {
    const ref_ = pullRef().trim();
    if (!ref_) return;
    setPulling(true);
    setPullStatus(`Pulling ${ref_}...`);
    try {
      const pullArgs: Record<string, any> = { reference: ref_ };
      if (showAuth() && authUsername().trim() && authPassword().trim()) {
        pullArgs.username = authUsername().trim();
        pullArgs.password = authPassword().trim();
      }
      await invoke("pull_image", pullArgs);
      setPullStatus("");
      setPullRef("");
      setAuthUsername("");
      setAuthPassword("");
      showToast(`Pulled ${ref_}`, "success");
      await refresh();
    } catch (e) {
      setPullStatus("");
      showToast(`Pull failed: ${e}`, "error");
    }
    setPulling(false);
  };

  const doBuild = async () => {
    const path = buildPath().trim();
    if (!path) return;
    setBuilding(true);
    setBuildLog([]);
    try {
      const result = (await invoke("build_image", {
        contextPath: path,
        dockerfile: buildDockerfile().trim() || null,
        tag: buildTag().trim() || null,
      })) as any;
      setBuildLog(result.logs || []);
      if (result.success) {
        showToast("Image built successfully", "success");
        await refresh();
      } else {
        showToast("Build failed -- check build log", "error");
      }
    } catch (e) {
      showToast(`Build error: ${e}`, "error");
    }
    setBuilding(false);
  };

  const handlePullKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !pulling()) doPull();
  };

  const totalSize = () =>
    filtered().reduce((sum, img) => sum + img.size_bytes, 0);

  const toggleInspect = async (id: string) => {
    if (inspecting() === id) {
      setInspecting(null);
      setInspectData(null);
      return;
    }
    setInspecting(id);
    setInspectData(null);
    try {
      const data = await invoke("inspect_image", { id });
      setInspectData(data);
    } catch (e) {
      console.error("Failed to inspect image:", e);
    }
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">
          Images
          <span style={{ "font-size": "13px", color: "#8b949e", "font-weight": "400", "margin-left": "8px" }}>
            {filtered().length} &middot; {formatBytes(totalSize())}
          </span>
          <LastUpdated timestamp={lastUpdated()} />
        </h1>
        <div class="page-actions">
          <input
            class="search-input"
            type="text"
            placeholder="Filter images..."
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
          <button class="btn" onClick={() => {
            const opening = !showPull();
            setShowPull(opening);
            if (opening) setTimeout(() => pullInputRef?.focus(), 50);
          }}>
            Pull
          </button>
          <button class="btn" onClick={() => setShowBuild(!showBuild())}>
            Build
          </button>
          <button class="btn" onClick={() => setShowPruneConfirm(true)}>
            Prune
          </button>
          <button class="btn" onClick={refresh}>
            Refresh
          </button>
        </div>
      </div>

      {/* Pull bar (collapsible) */}
      <Show when={showPull()}>
      <div style={{ "margin-bottom": "16px" }}>
        <div class="pull-bar">
          <div style={{ position: "relative", flex: 1 }}>
            <div style={{ position: "relative" }}>
              <svg
                style={{
                  position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)",
                  width: "14px", height: "14px", color: "#8b949e", "pointer-events": "none",
                }}
                viewBox="0 0 16 16" fill="currentColor"
              >
                <path fill-rule="evenodd" d="M11.5 7a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06l-3.04-3.04z" />
              </svg>
              <input
                ref={pullInputRef}
                class="pull-input"
                type="text"
                placeholder="Search Docker Hub and pull an image (e.g. nginx, postgres:16)"
                value={pullRef()}
                onInput={(e) => onPullInput(e.currentTarget.value)}
                onKeyDown={handlePullKeyDown}
                onFocus={() => { if (searchResults().length > 0) setShowSearchDropdown(true); }}
                onBlur={() => { setTimeout(() => setShowSearchDropdown(false), 200); }}
                disabled={pulling()}
                style={{ "padding-left": "32px" }}
              />
            </div>
            <Show when={showSearchDropdown()}>
              <div style={{
                position: "absolute", top: "100%", left: 0, right: 0,
                background: "#161b22", border: "1px solid #30363d", "border-radius": "0 0 8px 8px",
                "max-height": "320px", "overflow-y": "auto", "z-index": "100",
                "box-shadow": "0 8px 24px rgba(0,0,0,0.4)",
              }}>
                <Show when={searching()}>
                  <div style={{ padding: "10px 14px", color: "#8b949e", "font-size": "13px" }}>
                    <Spinner size={12} />{" "}Searching...
                  </div>
                </Show>
                <Show when={!searching() && searchResults().length === 0 && pullRef().trim().length >= 2}>
                  <div style={{ padding: "10px 14px", color: "#8b949e", "font-size": "13px" }}>
                    No results found
                  </div>
                </Show>
                <For each={searchResults()}>
                  {(result) => (
                    <div
                      style={{
                        padding: "8px 14px", cursor: "pointer", "border-bottom": "1px solid #21262d",
                        display: "flex", "align-items": "center", gap: "8px",
                      }}
                      onMouseDown={() => selectSearchResult(result.name)}
                    >
                      <div style={{ flex: 1, "min-width": 0 }}>
                        <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                          <span class="mono" style={{ "font-weight": "600", "font-size": "13px" }}>
                            {result.name}
                          </span>
                          <Show when={result.official}>
                            <span style={{
                              background: "#1f6feb", color: "#fff", "font-size": "10px",
                              padding: "1px 6px", "border-radius": "4px", "font-weight": "600",
                            }}>
                              OFFICIAL
                            </span>
                          </Show>
                        </div>
                        <div style={{
                          color: "#8b949e", "font-size": "12px",
                          "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis",
                        }}>
                          {result.description || "No description"}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: "12px", "font-size": "11px", color: "#8b949e", "flex-shrink": 0 }}>
                        <Show when={result.pulls}>
                          <span title="Downloads">{result.pulls}</span>
                        </Show>
                        <span title="Stars">{"\u2605"} {result.stars}</span>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <button
            class="btn btn-primary"
            onClick={doPull}
            disabled={pulling() || !pullRef().trim()}
          >
            {pulling() ? (<><Spinner size={12} />{" Pulling..."}</>) : "Pull"}
          </button>
          <button
            class="btn"
            onClick={() => setShowAuth(!showAuth())}
            style={{ "min-width": "60px" }}
          >
            {showAuth() ? "Auth \u25B2" : "Auth \u25BC"}
          </button>
        </div>
        <Show when={showAuth()}>
          <div style={{ display: "flex", gap: "8px", "margin-top": "8px" }}>
            <input
              class="form-input"
              type="text"
              placeholder="Username"
              value={authUsername()}
              onInput={(e) => setAuthUsername(e.currentTarget.value)}
              style={{ flex: 1 }}
            />
            <input
              class="form-input"
              type="password"
              placeholder="Password"
              value={authPassword()}
              onInput={(e) => setAuthPassword(e.currentTarget.value)}
              style={{ flex: 1 }}
            />
          </div>
        </Show>
        <Show when={pullStatus()}>
          <div class="pull-status"><Spinner size={12} />{" "}{pullStatus()}</div>
        </Show>
      </div>
      </Show>

      {/* Build panel */}
      <Show when={showBuild()}>
        <div class="card" style={{ "margin-bottom": "16px" }}>
          <div style={{ "font-weight": "600", "margin-bottom": "12px" }}>Build Image</div>
          <div style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
            <div class="form-group">
              <label class="form-label">Context path (directory with Dockerfile)</label>
              <input
                class="form-input"
                type="text"
                placeholder="/path/to/project"
                value={buildPath()}
                onInput={(e) => setBuildPath(e.currentTarget.value)}
              />
            </div>
            <div class="form-row">
              <div class="form-group" style={{ flex: 1 }}>
                <label class="form-label">Dockerfile (optional)</label>
                <input
                  class="form-input"
                  type="text"
                  placeholder="Dockerfile"
                  value={buildDockerfile()}
                  onInput={(e) => setBuildDockerfile(e.currentTarget.value)}
                />
              </div>
              <div class="form-group" style={{ flex: 1 }}>
                <label class="form-label">Tag (optional)</label>
                <input
                  class="form-input"
                  type="text"
                  placeholder="myapp:latest"
                  value={buildTag()}
                  onInput={(e) => setBuildTag(e.currentTarget.value)}
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
              <button
                class="btn btn-primary"
                onClick={doBuild}
                disabled={building() || !buildPath().trim()}
              >
                {building() ? (<><Spinner size={12} />{" Building..."}</>) : "Build"}
              </button>
              <button class="btn" onClick={() => setShowBuild(false)}>
                Cancel
              </button>
            </div>
            <Show when={buildLog().length > 0}>
              <pre class="log-content" style={{
                "max-height": "200px",
                background: "#0d1117",
                border: "1px solid #21262d",
                "border-radius": "6px",
                padding: "8px",
                "font-size": "11px",
              }}>
                {buildLog().join("")}
              </pre>
            </Show>
          </div>
        </div>
      </Show>

      {/* Batch action bar */}
      <Show when={selected().size > 0}>
        <div style={{
          display: "flex",
          "align-items": "center",
          gap: "12px",
          padding: "10px 14px",
          background: "#161b22",
          border: "1px solid #21262d",
          "border-radius": "8px",
          "margin-bottom": "12px",
        }}>
          <span style={{ "font-size": "13px" }}>
            {selected().size} image{selected().size !== 1 ? "s" : ""} selected
          </span>
          <button class="btn btn-sm" onClick={batchDelete}>
            Delete Selected
          </button>
          <button class="btn btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      </Show>

      <Show
        when={filtered().length > 0}
        fallback={
          <div class="empty">
            <p class="empty-title">No images found</p>
            <p>Pull an image to get started.</p>
          </div>
        }
      >
        <table class="table">
          <thead>
            <tr>
              <th style={{ width: "36px" }}>
                <input
                  type="checkbox"
                  checked={selected().size === filtered().length && filtered().length > 0}
                  onChange={selectAll}
                  style={{ cursor: "pointer", "accent-color": "#58a6ff" }}
                />
              </th>
              <SortableHeader label="Repository / Tag" field="tag" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <th>ID</th>
              <SortableHeader label="Size" field="size" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <SortableHeader label="Created" field="created" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
              <th style={{ "text-align": "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={filtered()}>
              {(img) => (
                <>
                  <tr
                    onClick={() => toggleInspect(img.id)}
                    style={{
                      cursor: "pointer",
                      background: selected().has(img.id) ? "#1f6feb11" : undefined,
                    }}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={selected().has(img.id)}
                        onChange={(e) => toggleSelect(img.id, e as any)}
                        onClick={(e) => e.stopPropagation()}
                        style={{ cursor: "pointer", "accent-color": "#58a6ff" }}
                      />
                    </td>
                    <td>
                      <Show
                        when={img.repo_tags.length > 0}
                        fallback={
                          <span style={{ color: "#8b949e" }}>&lt;untagged&gt;</span>
                        }
                      >
                        <For each={img.repo_tags}>
                          {(tag) => (
                            <div class="mono" style={{ "line-height": "1.6", display: "flex", "align-items": "center", gap: "4px" }}>
                              {tag}
                              <CopyButton text={tag} label="Copy image tag" />
                            </div>
                          )}
                        </For>
                      </Show>
                    </td>
                    <td class="mono" style={{ color: "#8b949e" }}>
                      <span style={{ display: "inline-flex", "align-items": "center", gap: "4px" }}>
                        {shortId(img.id)}
                        <CopyButton text={img.id} label="Copy image ID" />
                      </span>
                    </td>
                    <td>{formatBytes(img.size_bytes)}</td>
                    <td style={{ color: "#8b949e" }}>
                      {formatTimestamp(img.created_at)}
                    </td>
                    <td style={{ "text-align": "right" }}>
                      <div class="action-icons" style={{ "justify-content": "flex-end" }}>
                        <Show when={img.repo_tags.length > 0}>
                          <button
                            class="action-icon action-icon-start"
                            title="Run container from this image"
                            onClick={(e) => { e.stopPropagation(); setRunImage(img.repo_tags[0]); }}
                          >▶</button>
                        </Show>
                        <button
                          class="action-icon action-icon-delete"
                          title="Remove image"
                          onClick={(e) => removeImage(img.id, img.repo_tags[0] || img.id, e)}
                        >🗑</button>
                      </div>
                    </td>
                  </tr>
                  <Show when={inspecting() === img.id}>
                    <tr>
                      <td colspan="6" style={{ padding: 0 }}>
                        <div class="detail-body">
                          <Show
                            when={inspectData()}
                            fallback={
                              <span style={{ color: "#8b949e" }}><Spinner size={12} />{" "}Loading image details...</span>
                            }
                          >
                            {(data) => {
                              const d = data();
                              const tags = d?.repo_tags || d?.RepoTags || img.repo_tags || [];
                              const imageId = d?.id || d?.Id || img.id;
                              const created = d?.created_at || d?.Created || img.created_at;
                              const size = d?.size_bytes || d?.Size || img.size_bytes;
                              const layers = d?.rootfs?.Layers || d?.rootfs?.layers || d?.layers || [];
                              return (
                                <div class="card-grid">
                                  <div class="card-label">Image ID</div>
                                  <div class="card-value mono" style={{ "font-size": "11px", display: "flex", "align-items": "center", gap: "6px" }}>
                                    {imageId}
                                    <CopyButton text={imageId} label="Copy image ID" />
                                  </div>

                                  <div class="card-label">Tags</div>
                                  <div class="card-value">
                                    <Show when={tags.length > 0} fallback={<span style={{ color: "#8b949e" }}>None</span>}>
                                      <For each={tags}>
                                        {(tag: string) => (
                                          <div class="mono" style={{ "line-height": "1.6", display: "flex", "align-items": "center", gap: "4px" }}>
                                            {tag}
                                            <CopyButton text={tag} label="Copy tag" />
                                          </div>
                                        )}
                                      </For>
                                    </Show>
                                  </div>

                                  <div class="card-label">Size</div>
                                  <div class="card-value">{formatBytes(typeof size === "number" ? size : 0)}</div>

                                  <div class="card-label">Created</div>
                                  <div class="card-value">{formatTimestamp(created)}</div>

                                  <div class="card-label">Layers</div>
                                  <div class="card-value">
                                    {Array.isArray(layers) ? layers.length : 0} layer{Array.isArray(layers) && layers.length !== 1 ? "s" : ""}
                                  </div>
                                </div>
                              );
                            }}
                          </Show>
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

      <Show when={runImage()}>
        <RunContainerDialog
          initialImage={runImage()!}
          onClose={() => setRunImage(null)}
          onCreated={refresh}
        />
      </Show>

      {/* Prune Confirmation Dialog */}
      <Show when={showPruneConfirm()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdOverlay = (e.target as HTMLElement).classList.contains("modal-overlay"); }}
          onClick={(e) => { if ((e.currentTarget as any).__mdOverlay && (e.target as HTMLElement).classList.contains("modal-overlay") && !pruning()) setShowPruneConfirm(false); (e.currentTarget as any).__mdOverlay = false; }}
        >
          <div class="modal-dialog" style={{ "max-width": "460px" }}>
            <div class="modal-header">
              <span class="modal-title">Prune Unused Images</span>
              <button class="modal-close" onClick={() => setShowPruneConfirm(false)}>{"\u00d7"}</button>
            </div>
            <div class="modal-body">
              <p style={{ "margin-bottom": "12px", "line-height": "1.5" }}>
                This will remove all images that are not referenced by any container.
              </p>
              <p style={{ "font-size": "13px", color: "#8b949e", "line-height": "1.5" }}>
                Dangling images (untagged layers) and unused images will be deleted.
                Images in use by running or stopped containers are kept.
                This action cannot be undone.
              </p>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setShowPruneConfirm(false)} disabled={pruning()}>Cancel</button>
              <button class="btn" style={{ background: "#da3633", color: "#fff" }} onClick={pruneUnused} disabled={pruning()}>
                {pruning() ? "Pruning..." : "Prune Images"}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
