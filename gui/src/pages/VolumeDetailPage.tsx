import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Volume } from "../lib/types";
import { containersStore } from "../lib/dockerStore";
import { isAnonymous, volumeStack, volumeTitle, volumeUsers } from "../lib/volumes";
import { useRefresh } from "../lib/useRefresh";
import { formatBytes, formatTimestamp } from "../lib/format";
import { showToast } from "../components/Toast";
import { confirmDanger } from "../components/ConfirmDialog";
import CopyButton from "../components/CopyButton";
import Breadcrumb from "../components/Breadcrumb";
import Spinner from "../components/Spinner";
import { logError } from "../lib/activityStore";

interface VolumeDetailPageProps {
  volumeName: string;
  onBack: () => void;
  onNavigate?: (target: string) => void;
}

type DetailTab = "overview" | "files";

interface FileEntry {
  name: string;
  size: string;
  permissions: string;
  modified: string;
  is_dir: boolean;
}

export default function VolumeDetailPage(props: VolumeDetailPageProps) {
  const [volume, setVolume] = createSignal<Volume | null>(null);
  const [activeTab, setActiveTab] = createSignal<DetailTab>("overview");
  const [_loading, setLoading] = createSignal(false);
  const allContainers = containersStore.use();
  const users = () => volumeUsers(allContainers.list()).get(props.volumeName) ?? [];
  const [size, setSize] = createSignal<number | undefined>(undefined);

  // File browser state
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = createSignal(false);
  const [fileError, setFileError] = createSignal<string | null>(null);
  const [fileBrowsingStarted, setFileBrowsingStarted] = createSignal(false);
  const [currentPath, setCurrentPath] = createSignal("");
  const [fileContent, setFileContent] = createSignal<string | null>(null);
  const [fileContentPath, setFileContentPath] = createSignal<string | null>(null);
  const [fileContentLoading, setFileContentLoading] = createSignal(false);

  const fetchVolume = async () => {
    try {
      const vols = (await invoke("list_volumes")) as Volume[];
      const v = vols.find((x) => x.name === props.volumeName);
      if (v) setVolume(v);
    } catch {
    }
  };

  useRefresh(fetchVolume);

  const fetchFiles = async (path?: string) => {
    setFilesLoading(true);
    setFileContent(null);
    setFileContentPath(null);
    setFileError(null);
    try {
      const result = (await invoke("volume_list_files", {
        name: props.volumeName,
        path: path || null,
      })) as { entries: FileEntry[]; path: string };
      setFiles(result.entries);
      setCurrentPath(result.path || "");
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as any)?.message || String(e);
      logError(`Failed to browse volume files: ${msg}`, `Volume "${props.volumeName}", path "${path || "/"}"`);

      setFileError(msg);
      setFiles([]);
    }
    setFilesLoading(false);
  };

  const readFile = async (path: string) => {
    setFileContentLoading(true);
    try {
      const result = (await invoke("volume_read_file", {
        name: props.volumeName,
        path,
      })) as { content: string };
      setFileContent(result.content);
      setFileContentPath(path);
    } catch (e) {
      logError(`Failed to read volume file: ${e}`, `Volume "${props.volumeName}", path "${path}"`);
      showToast(`Failed to read file: ${e}`, "error");
    }
    setFileContentLoading(false);
  };

  onMount(async () => {
    setLoading(true);
    await fetchVolume();
    setLoading(false);
    try {
      const r = (await invoke("volume_sizes", { refresh: false })) as { sizes: Record<string, number> };
      setSize(r?.sizes?.[props.volumeName]);
    } catch { /* sizes are optional */ }
  });

  const switchTab = (tab: DetailTab) => {
    setActiveTab(tab);
    if (tab === "files" && !fileBrowsingStarted()) startBrowsing();
  };

  const [removing, setRemoving] = createSignal(false);
  const doRemove = async () => {
    if (removing()) return;
    if (!await confirmDanger("Remove volume", `Remove volume "${props.volumeName}"? This will permanently delete the volume data.`)) return;
    setRemoving(true);
    try {
      await invoke("remove_volume", { name: props.volumeName });
      showToast(`Volume "${props.volumeName}" removed`, "success");
      props.onBack();
    } catch (err) {
      logError(`Failed to remove volume: ${err}`, `Volume "${props.volumeName}"`);
      showToast(`Failed to remove volume: ${err}`, "error");
      setRemoving(false);
    }
  };

  const startBrowsing = () => {
    setFileBrowsingStarted(true);
    fetchFiles();
  };

  const navigateToDir = (dirName: string) => {
    const newPath = currentPath() ? `${currentPath()}/${dirName}` : dirName;
    fetchFiles(newPath);
  };

  const navigateUp = () => {
    const parts = currentPath().split("/").filter(Boolean);
    parts.pop();
    const newPath = parts.join("/");
    fetchFiles(newPath || undefined);
  };

  const navigateToPathSegment = (index: number) => {
    const parts = currentPath().split("/").filter(Boolean);
    const newPath = parts.slice(0, index + 1).join("/");
    fetchFiles(newPath);
  };

  const pathSegments = () => currentPath().split("/").filter(Boolean);

  const exportFileListing = async () => {
    try {
      // Fetch root-level files if not already loaded
      let entries = files();
      if (!fileBrowsingStarted() || entries.length === 0) {
        const result = (await invoke("volume_list_files", {
          name: props.volumeName,
          path: null,
        })) as { entries: FileEntry[]; path: string };
        entries = result.entries;
      }
      // Format as text
      const lines = [`Volume: ${props.volumeName}`, `Path: /${currentPath() || ""}`, ""];
      lines.push("Name".padEnd(40) + "Size".padEnd(12) + "Permissions".padEnd(14) + "Modified");
      lines.push("-".repeat(90));
      for (const f of entries) {
        const prefix = f.is_dir ? "[DIR] " : "      ";
        lines.push(`${prefix}${f.name}`.padEnd(40) + f.size.padEnd(12) + f.permissions.padEnd(14) + f.modified);
      }
      // Download as text file
      const blob = new Blob([lines.join("\n")], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `volume-${props.volumeName}-listing.txt`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("File listing exported", "success");
    } catch (e) {
      showToast(`Failed to export listing: ${e}`, "error");
    }
  };



  return (
    <div class="detail-page">
      {/* Breadcrumb */}
      <Breadcrumb
        items={[
          { label: "Volumes", onClick: () => props.onBack() },
          { label: volume() ? volumeTitle(volume()!) : props.volumeName.slice(0, 24) },
        ]}
      />

      {/* Header bar */}
      <div class="detail-page-header">
        <Show when={volume()} fallback={
          <div class="detail-page-info">
            <div class="detail-page-name">Loading...</div>
          </div>
        }>
          {(v) => (
            <>
              <div class="detail-page-info">
                <div class="detail-page-name">
                  {volumeTitle(v())}
                  <Show when={volumeStack(v())}><span class="nl-tag nl-tag-compose">{volumeStack(v())}</span></Show>
                  <span class={`state-badge detail-state ${users().length ? "state-running" : "vl-tag-unused"}`}>
                    {users().length ? `In use by ${users().length}` : "Unused"}
                  </span>
                </div>
                <div class="detail-page-image selectable">{v().name}</div>
              </div>
              <div class="detail-page-actions">
                <button class="btn btn-sm btn-iconed" onClick={() => switchTab("files")}>
                  <svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v10H3z" /></svg>Browse files
                </button>
                <button class="btn btn-sm btn-iconed" onClick={exportFileListing} title="Save a list of the volume's files as text">
                  <svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M4 21h16" /></svg>Export listing
                </button>
                <button
                  class="btn btn-sm btn-danger-outline btn-iconed"
                  onClick={doRemove}
                  disabled={removing() || users().length > 0}
                  title={users().length ? "Containers use this volume; remove them first" : "Delete the volume and its data"}
                >
                  <Show when={removing()} fallback={<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>}><Spinner size={12} /></Show>
                  {removing() ? "Removing..." : "Remove"}
                </button>
              </div>
            </>
          )}
        </Show>
      </div>

      {/* Tab bar */}
      <div class="detail-tab-bar">
        <button
          class={`detail-tab-item ${activeTab() === "overview" ? "active" : ""}`}
          onClick={() => switchTab("overview")}
        >
          Overview
        </button>
        <button
          class={`detail-tab-item ${activeTab() === "files" ? "active" : ""}`}
          onClick={() => switchTab("files")}
        >
          Files
        </button>
      </div>

      {/* Tab content */}
      <div class="detail-tab-content">
        {/* Overview Tab */}
        <Show when={activeTab() === "overview"}>
          <Show when={volume()} fallback={<Spinner />}>
            {(v) => (
              <div class="cov">
                <div class="cov-ctx">
                  <div class="cov-ctx-cell">
                    <div class="cov-badge" style={{ "--accent": volumeStack(v()) ? "#bc8cff" : "#58a6ff" }}>
                      <svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>
                    </div>
                    <div class="cov-min">
                      <div class="cov-lbl">{volumeStack(v()) ? "Stack" : "Volume"}</div>
                      <Show when={volumeStack(v())} fallback={
                        <div class="cov-big">{isAnonymous(v().name) ? "Anonymous" : "Named volume"}</div>
                      }>
                        <button class="cov-big cov-link" onClick={() => props.onNavigate?.(`stack:${volumeStack(v())}`)}>{volumeStack(v())}</button>
                      </Show>
                      <div class="cov-sub">
                        {volumeStack(v())
                          ? `Compose volume "${v().labels["com.docker.compose.volume"] ?? volumeTitle(v())}"`
                          : isAnonymous(v().name) ? "Made by Docker for a container's VOLUME" : `Driver ${v().driver}`}
                      </div>
                    </div>
                  </div>
                  <div class="cov-ctx-cell">
                    <div class="cov-min">
                      <div class="cov-lbl">Mount point <span class="cov-lbl-note">inside Docker's VM</span></div>
                      <div class="cov-row" style={{ gap: "6px" }}>
                        <span class="cov-big mono selectable cov-ellipsis" title={v().mountpoint}>{v().mountpoint}</span>
                        <CopyButton text={v().mountpoint} />
                      </div>
                      <div class="cov-sub">Driver {v().driver}</div>
                    </div>
                  </div>
                  <div class="cov-ctx-cell">
                    <div class="cov-min">
                      <div class="cov-lbl">Size</div>
                      <div class="cov-big">{size() !== undefined ? formatBytes(size()!) : "–"}</div>
                      <div class="cov-sub">Created {formatTimestamp(v().created_at)}</div>
                    </div>
                  </div>
                </div>

                <div class="vd-body">
                  <div class="cov-row cov-between" style={{ "margin-bottom": "10px" }}>
                    <span class="cov-lbl">Used by</span>
                    <Show when={users().length}><span class="cov-sub">{users().length} {users().length === 1 ? "container" : "containers"}</span></Show>
                  </div>
                  <Show when={users().length > 0} fallback={
                    <div class="vd-empty">
                      <b>No container mounts this volume.</b>
                      <span>Its data stays until you remove it. Browse its files to see what it holds.</span>
                      <button class="btn btn-sm" onClick={() => switchTab("files")}>Browse files</button>
                    </div>
                  }>
                    <div class="vd-users">
                      <For each={users()}>
                        {(u) => (
                          <button class="vd-user" onClick={() => props.onNavigate?.(`container:${u.container.id}`)}>
                            <span class={`vd-dot ${u.container.state === "Running" ? "on" : ""}`} title={u.container.state} />
                            <span class="cov-min">
                              <span class="vd-user-name">{u.container.name}</span>
                              <span class="vd-user-image mono">{u.container.image}</span>
                            </span>
                            <span class="vd-user-path">
                              <span class="mono">{u.destination}</span>
                              <span class={u.rw ? "vd-rw" : "vd-ro"}>{u.rw ? "read-write" : "read-only"}</span>
                            </span>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>

                  <Show when={Object.keys(v().labels).length > 0}>
                    <div class="cov-lbl" style={{ margin: "18px 0 8px" }}>Labels</div>
                    <div class="nl-labels" style={{ "margin-top": "0" }}>
                      <For each={Object.entries(v().labels)}>{([k, val]) => <span class="nl-label mono selectable">{k}={val}</span>}</For>
                    </div>
                  </Show>
                </div>
              </div>
            )}
          </Show>
        </Show>

        {/* Files Tab */}
        <Show when={activeTab() === "files"}>
          <div class="detail-section">
            <Show when={!fileBrowsingStarted()}>
              <div class="empty" style={{ padding: "40px 0" }}>
                <p class="empty-title">Browse volume files</p>
                <p style={{ "margin-bottom": "16px" }}>File browsing uses a temporary Alpine container to read volume contents</p>
                <button class="btn btn-primary" onClick={startBrowsing}>
                  Browse files
                </button>
              </div>
            </Show>
            <Show when={fileBrowsingStarted()}>
              {/* File path breadcrumb */}
              <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "12px" }}>
                <button
                  class="btn btn-sm"
                  onClick={() => { setFileContent(null); setFileContentPath(null); fetchFiles(); }}
                  title="Root"
                >
                  /
                </button>
                <Show when={currentPath() && !fileContent()}>
                  <button class="btn btn-sm" onClick={navigateUp} title="Go up">
                    ..
                  </button>
                </Show>
                <Show when={fileContent()}>
                  <button class="btn btn-sm" onClick={() => { setFileContent(null); setFileContentPath(null); }} title="Back to listing">
                    Back
                  </button>
                </Show>
                <div style={{ display: "flex", "align-items": "center", gap: "2px", color: "#8b949e", "font-size": "13px", "flex-wrap": "wrap" }}>
                  <span
                    style={{ cursor: "pointer", color: currentPath() ? "#58a6ff" : "#e6edf3", padding: "2px 4px" }}
                    onClick={() => fetchFiles()}
                    title="Root"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "vertical-align": "middle" }}><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
                  </span>
                  <For each={pathSegments()}>
                    {(seg, i) => (
                      <>
                        <span style={{ color: "#484f58", "font-size": "10px" }}>{"\u203A"}</span>
                        <span
                          style={{
                            cursor: "pointer",
                            color: i() === pathSegments().length - 1 ? "#e6edf3" : "#58a6ff",
                            "font-weight": i() === pathSegments().length - 1 ? "600" : "400",
                            padding: "2px 4px",
                          }}
                          onClick={() => navigateToPathSegment(i())}
                        >
                          {seg}
                        </span>
                      </>
                    )}
                  </For>
                  <Show when={fileContentPath()}>
                    <span style={{ color: "#484f58", "font-size": "10px" }}>{"\u203A"}</span>
                    <span style={{ color: "#e6edf3", "font-weight": "600", padding: "2px 4px" }}>{fileContentPath()!.split("/").pop()}</span>
                  </Show>
                </div>
              </div>

              {/* File content viewer */}
              <Show when={fileContent() !== null}>
                <Show when={fileContentLoading()}>
                  <Spinner />
                </Show>
                <Show when={!fileContentLoading()}>
                  <pre class="mono" style={{
                    background: "#0d1117",
                    border: "1px solid #30363d",
                    "border-radius": "8px",
                    padding: "16px",
                    "font-size": "12px",
                    "line-height": "1.5",
                    overflow: "auto",
                    "max-height": "500px",
                    color: "#e6edf3",
                    "white-space": "pre-wrap",
                    "word-break": "break-all",
                  }}>
                    {fileContent()}
                  </pre>
                </Show>
              </Show>

              {/* File listing */}
              <Show when={fileContent() === null}>
                <Show when={filesLoading()}>
                  <Spinner />
                </Show>
                <Show when={!filesLoading()}>
                  <Show when={files().length > 0} fallback={
                    <Show when={fileError()} fallback={
                      <div class="empty" style={{ padding: "20px 0" }}>
                        <p>Empty directory</p>
                      </div>
                    }>
                      <div style={{ padding: "16px 20px", color: "#f85149", background: "rgba(248, 81, 73, 0.1)", "border-radius": "6px", margin: "12px 0", "font-size": "13px" }}>
                        <strong>Error:</strong> {fileError()}
                      </div>
                    </Show>
                  }>
                    <div style={{
                      background: "#0d1117",
                      border: "1px solid #30363d",
                      "border-radius": "8px",
                      overflow: "hidden",
                    }}>
                      <For each={files()}>
                        {(f) => (
                          <div
                            onClick={() => {
                              if (f.is_dir) {
                                navigateToDir(f.name);
                              } else {
                                const fullPath = currentPath() ? `${currentPath()}/${f.name}` : f.name;
                                readFile(fullPath);
                              }
                            }}
                            style={{
                              display: "flex",
                              "align-items": "center",
                              padding: "8px 16px",
                              "border-bottom": "1px solid #21262d",
                              cursor: "pointer",
                              "font-size": "13px",
                            }}
                            class="file-entry"
                          >
                            <span style={{ width: "24px", "text-align": "center", "flex-shrink": "0" }}>
                              {f.is_dir ? "\uD83D\uDCC1" : "\uD83D\uDCC4"}
                            </span>
                            <span style={{
                              flex: "1",
                              "font-weight": f.is_dir ? "500" : "400",
                              color: f.is_dir ? "#58a6ff" : "#e6edf3",
                              "margin-left": "8px",
                            }}>
                              {f.name}{f.is_dir ? "/" : ""}
                            </span>
                            <span class="mono" style={{ color: "#8b949e", "font-size": "12px", width: "80px", "text-align": "right" }}>
                              {f.size}
                            </span>
                            <span style={{ color: "#484f58", "font-size": "12px", width: "140px", "text-align": "right" }}>
                              {f.modified}
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </Show>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
