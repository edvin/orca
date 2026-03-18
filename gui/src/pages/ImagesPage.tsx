import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Image } from "../lib/types";
import { formatBytes, formatTimestamp, shortId } from "../lib/format";
import { showToast } from "../components/Toast";
import RunContainerDialog from "../components/RunContainerDialog";

export default function ImagesPage() {
  const [images, setImages] = createSignal<Image[]>([]);
  const [search, setSearch] = createSignal("");
  const [pullRef, setPullRef] = createSignal("");
  const [pulling, setPulling] = createSignal(false);
  const [pullStatus, setPullStatus] = createSignal("");
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [showBuild, setShowBuild] = createSignal(false);
  const [buildPath, setBuildPath] = createSignal("");
  const [buildDockerfile, setBuildDockerfile] = createSignal("");
  const [buildTag, setBuildTag] = createSignal("");
  const [building, setBuilding] = createSignal(false);
  const [buildLog, setBuildLog] = createSignal<string[]>([]);
  const [runImage, setRunImage] = createSignal<string | null>(null);

  const refresh = async () => {
    try {
      const result = (await invoke("list_images")) as Image[];
      setImages(result);
    } catch (e) {
      console.error("Failed to list images:", e);
    }
  };

  onMount(refresh);

  const filtered = () => {
    const q = search().toLowerCase();
    if (!q) return images();
    return images().filter(
      (img) =>
        img.repo_tags.some((t) => t.toLowerCase().includes(q)) ||
        img.id.includes(q)
    );
  };

  const toggleSelect = (id: string) => {
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

  const removeImage = async (id: string) => {
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
    try {
      const result = (await invoke("prune_images")) as any;
      const count = result.images_deleted?.length || 0;
      const space = formatBytes(result.space_reclaimed || 0);
      showToast(`Pruned ${count} image${count !== 1 ? "s" : ""}, freed ${space}`, "success");
      await refresh();
    } catch (e) {
      showToast(`Prune failed: ${e}`, "error");
    }
  };

  const doPull = async () => {
    const ref_ = pullRef().trim();
    if (!ref_) return;
    setPulling(true);
    setPullStatus(`Pulling ${ref_}...`);
    try {
      await invoke("pull_image", { reference: ref_ });
      setPullStatus("");
      setPullRef("");
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
        showToast("Build failed — check build log", "error");
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

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">
          Images
          <span style={{ "font-size": "13px", color: "#8b949e", "font-weight": "400", "margin-left": "8px" }}>
            {filtered().length} &middot; {formatBytes(totalSize())}
          </span>
        </h1>
        <div class="page-actions">
          <input
            class="search-input"
            type="text"
            placeholder="Filter images..."
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
          <button class="btn" onClick={() => setShowBuild(!showBuild())}>
            Build
          </button>
          <button class="btn btn-danger" onClick={pruneUnused}>
            Prune
          </button>
          <button class="btn" onClick={refresh}>
            Refresh
          </button>
        </div>
      </div>

      {/* Pull bar */}
      <div style={{ "margin-bottom": "16px" }}>
        <div class="pull-bar">
          <input
            class="pull-input"
            type="text"
            placeholder="Pull image (e.g. nginx:latest, postgres:16-alpine)"
            value={pullRef()}
            onInput={(e) => setPullRef(e.currentTarget.value)}
            onKeyDown={handlePullKeyDown}
            disabled={pulling()}
          />
          <button
            class="btn btn-primary"
            onClick={doPull}
            disabled={pulling() || !pullRef().trim()}
          >
            {pulling() ? "Pulling..." : "Pull"}
          </button>
        </div>
        <Show when={pullStatus()}>
          <div class="pull-status">{pullStatus()}</div>
        </Show>
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
                {building() ? "Building..." : "Build"}
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
          <button class="btn btn-sm btn-danger" onClick={batchDelete}>
            Delete Selected
          </button>
          <button class="btn btn-sm" onClick={() => setSelected(new Set())}>
            Clear Selection
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
              <th>Repository / Tag</th>
              <th>ID</th>
              <th>Size</th>
              <th>Created</th>
              <th style={{ "text-align": "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={filtered()}>
              {(img) => (
                <tr style={{
                  background: selected().has(img.id) ? "#1f6feb11" : undefined,
                }}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected().has(img.id)}
                      onChange={() => toggleSelect(img.id)}
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
                          <div class="mono" style={{ "line-height": "1.6" }}>
                            {tag}
                          </div>
                        )}
                      </For>
                    </Show>
                  </td>
                  <td class="mono" style={{ color: "#8b949e" }}>
                    {shortId(img.id)}
                  </td>
                  <td>{formatBytes(img.size_bytes)}</td>
                  <td style={{ color: "#8b949e" }}>
                    {formatTimestamp(img.created_at)}
                  </td>
                  <td style={{ "text-align": "right" }}>
                    <div class="btn-group" style={{ "justify-content": "flex-end" }}>
                      <Show when={img.repo_tags.length > 0}>
                        <button
                          class="btn btn-sm btn-primary"
                          onClick={() => setRunImage(img.repo_tags[0])}
                        >
                          Run
                        </button>
                      </Show>
                      <button
                        class="btn btn-sm btn-danger"
                        onClick={() => removeImage(img.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
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
    </div>
  );
}
