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

  // Image file browser state
  interface FileEntry { name: string; size: string; permissions: string; modified: string; is_dir: boolean; link_target?: string }
  const [fileBrowserImage, setFileBrowserImage] = createSignal<string | null>(null);
  const [fileBrowserPath, setFileBrowserPath] = createSignal("/");
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = createSignal(false);
  const [fileContent, setFileContent] = createSignal<string | null>(null);
  const [fileContentPath, setFileContentPath] = createSignal("");

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

  // --- Image File Browser ---
  const openFileBrowser = (imageId: string) => {
    setFileBrowserImage(imageId);
    setFileBrowserPath("/");
    setFileContent(null);
    setFileContentPath("");
    fetchImageFiles(imageId, "/");
  };

  const closeFileBrowser = () => {
    setFileBrowserImage(null);
    setFiles([]);
    setFileContent(null);
  };

  const fetchImageFiles = async (imageId: string, path: string) => {
    setFilesLoading(true);
    setFileContent(null);
    try {
      const result = (await invoke("image_list_files", { id: imageId, path })) as { entries: FileEntry[]; path: string };
      setFiles(result.entries);
      setFileBrowserPath(path || "/");
    } catch (e) {
      showToast(`Failed to browse files: ${e}`, "error");
      setFiles([]);
    } finally {
      setFilesLoading(false);
    }
  };

  const navigateToDir = (dirName: string) => {
    const imageId = fileBrowserImage();
    if (!imageId) return;
    const current = fileBrowserPath();
    const newPath = current === "/" ? `/${dirName}` : `${current}/${dirName}`;
    fetchImageFiles(imageId, newPath);
  };

  const navigateUp = () => {
    const imageId = fileBrowserImage();
    if (!imageId) return;
    const current = fileBrowserPath();
    const parent = current.substring(0, current.lastIndexOf("/")) || "/";
    fetchImageFiles(imageId, parent);
  };

  const navigateToSegment = (index: number) => {
    const imageId = fileBrowserImage();
    if (!imageId) return;
    const segments = fileBrowserPath().split("/").filter(Boolean);
    const newPath = "/" + segments.slice(0, index + 1).join("/");
    fetchImageFiles(imageId, newPath);
  };

  const readImageFile = async (filePath: string) => {
    const imageId = fileBrowserImage();
    if (!imageId) return;
    const current = fileBrowserPath();
    const fullPath = current === "/" ? `/${filePath}` : `${current}/${filePath}`;
    try {
      const result = (await invoke("image_read_file", { id: imageId, path: fullPath })) as { content: string };
      setFileContent(result.content);
      setFileContentPath(filePath);
    } catch (e) {
      showToast(`Failed to read file: ${e}`, "error");
    }
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
          <button class="btn" onClick={() => setShowPull(true)}>
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
              <SortableHeader label="Size" field="size" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} style={{ "min-width": "90px" }} />
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
                              return (<>
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
                                <div style={{ "margin-top": "12px" }}>
                                  <button class="btn btn-sm" onClick={(e) => { e.stopPropagation(); openFileBrowser(img.id); }}>
                                    Browse Files
                                  </button>
                                </div>
                              </>);
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

      {/* Image File Browser Dialog */}
      <Show when={fileBrowserImage()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdOverlay = (e.target as HTMLElement).classList.contains("modal-overlay"); }}
          onClick={(e) => { if ((e.currentTarget as any).__mdOverlay && (e.target as HTMLElement).classList.contains("modal-overlay")) closeFileBrowser(); (e.currentTarget as any).__mdOverlay = false; }}
        >
          <div class="modal-dialog" style={{ "max-width": "800px", "max-height": "80vh", display: "flex", "flex-direction": "column" }}>
            <div class="modal-header">
              <span class="modal-title">
                Image Files
              </span>
              <button class="modal-close" onClick={closeFileBrowser}>{"\u00d7"}</button>
            </div>

            {/* Breadcrumb */}
            <div style={{ padding: "8px 16px", background: "#161b22", "border-bottom": "1px solid #21262d", "font-size": "12px", display: "flex", "align-items": "center", gap: "4px" }}>
              <button
                style={{ background: "none", border: "none", color: "#58a6ff", cursor: "pointer", padding: "2px 4px", "font-size": "12px" }}
                onClick={() => { const id = fileBrowserImage(); if (id) fetchImageFiles(id, "/"); }}
              >/</button>
              <For each={fileBrowserPath().split("/").filter(Boolean)}>
                {(segment, i) => (
                  <>
                    <span style={{ color: "#484f58" }}>/</span>
                    <button
                      style={{ background: "none", border: "none", color: "#58a6ff", cursor: "pointer", padding: "2px 4px", "font-size": "12px" }}
                      onClick={() => navigateToSegment(i())}
                    >{segment}</button>
                  </>
                )}
              </For>
            </div>

            <div style={{ flex: "1", overflow: "auto" }}>
              <Show when={fileContent() !== null} fallback={
                <Show when={!filesLoading()} fallback={
                  <div style={{ padding: "20px", "text-align": "center", color: "#8b949e" }}><Spinner size={14} /> Loading files...</div>
                }>
                  <Show when={files().length > 0} fallback={
                    <div style={{ padding: "20px", "text-align": "center", color: "#8b949e" }}>Empty directory</div>
                  }>
                    {/* Back button */}
                    <Show when={fileBrowserPath() !== "/"}>
                      <div
                        style={{ padding: "6px 16px", cursor: "pointer", "border-bottom": "1px solid #21262d", display: "flex", "align-items": "center", gap: "8px", "font-size": "13px", color: "#8b949e" }}
                        onClick={navigateUp}
                      >
                        <span style={{ "font-size": "10px" }}>{"\u25C0"}</span> ..
                      </div>
                    </Show>
                    <For each={files()}>
                      {(f) => (
                        <div
                          style={{
                            padding: "6px 16px",
                            cursor: "pointer",
                            "border-bottom": "1px solid #21262d",
                            display: "flex",
                            "align-items": "center",
                            gap: "10px",
                            "font-size": "13px",
                          }}
                          onClick={() => f.is_dir ? navigateToDir(f.name) : readImageFile(f.name)}
                        >
                          <span style={{ color: f.is_dir ? "#58a6ff" : "#8b949e", width: "16px", "text-align": "center", "flex-shrink": "0" }}>
                            {f.is_dir ? "\u{1F4C1}" : "\u{1F4C4}"}
                          </span>
                          <span style={{ flex: "1", color: f.is_dir ? "#58a6ff" : "#e6edf3", "min-width": "0", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                            {f.name}
                            <Show when={f.link_target}>
                              <span style={{ color: "#484f58", "margin-left": "6px" }}>{"\u2192"} {f.link_target}</span>
                            </Show>
                          </span>
                          <span class="mono" style={{ color: "#484f58", "font-size": "11px", "flex-shrink": "0" }}>{f.permissions}</span>
                          <span style={{ color: "#484f58", "font-size": "11px", "flex-shrink": "0", "min-width": "60px", "text-align": "right" }}>{f.size}</span>
                        </div>
                      )}
                    </For>
                  </Show>
                </Show>
              }>
                {/* File content viewer */}
                <div>
                  <div style={{ padding: "8px 16px", background: "#161b22", "border-bottom": "1px solid #21262d", display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                    <span style={{ "font-size": "12px", color: "#e6edf3" }}>{fileContentPath()}</span>
                    <button class="btn btn-sm" onClick={() => setFileContent(null)} style={{ "font-size": "11px", padding: "2px 8px" }}>Back</button>
                  </div>
                  <pre style={{
                    padding: "12px 16px",
                    margin: 0,
                    "font-family": "'JetBrains Mono NF', monospace",
                    "font-size": "12px",
                    "line-height": "1.5",
                    color: "#c9d1d9",
                    "white-space": "pre-wrap",
                    "word-break": "break-all",
                    overflow: "auto",
                    "max-height": "60vh",
                  }}>{fileContent()}</pre>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
