import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Image } from "../lib/types";
import { formatBytes, formatTimestamp, shortId } from "../lib/format";

export default function ImagesPage() {
  const [images, setImages] = createSignal<Image[]>([]);
  const [search, setSearch] = createSignal("");

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

  const removeImage = async (id: string) => {
    try {
      await invoke("remove_image", { id });
      await refresh();
    } catch (e) {
      console.error("Failed to remove image:", e);
    }
  };

  const totalSize = () =>
    filtered().reduce((sum, img) => sum + img.size_bytes, 0);

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">
          Images
          <span
            style={{
              "font-size": "13px",
              color: "#8b949e",
              "font-weight": "400",
              "margin-left": "8px",
            }}
          >
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
          <button class="btn" onClick={refresh}>
            Refresh
          </button>
        </div>
      </div>

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
                <tr>
                  <td>
                    <Show
                      when={img.repo_tags.length > 0}
                      fallback={
                        <span style={{ color: "#8b949e" }}>&lt;none&gt;</span>
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
                    <button
                      class="btn btn-sm btn-danger"
                      onClick={() => removeImage(img.id)}
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
