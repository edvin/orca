import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Volume, Container } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { formatTimestamp } from "../lib/format";
import { showToast } from "../components/Toast";
import { confirmDanger } from "../components/ConfirmDialog";
import CopyButton from "../components/CopyButton";
import Breadcrumb from "../components/Breadcrumb";
import Spinner from "../components/Spinner";
import { logError } from "../lib/activityStore";
import { t } from "../i18n";

interface VolumeDetailPageProps {
  volumeName: string;
  onBack: () => void;
  onNavigate?: (target: string) => void;
}

type DetailTab = "overview" | "containers" | "files";

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
  const [containers, setContainers] = createSignal<Container[]>([]);
  const [containersLoading, setContainersLoading] = createSignal(false);

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

  const fetchContainers = async () => {
    setContainersLoading(true);
    try {
      const result = (await invoke("volume_containers", { name: props.volumeName })) as Container[];
      setContainers(result);
    } catch {
    }
    setContainersLoading(false);
  };

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
  });

  const switchTab = (tab: DetailTab) => {
    setActiveTab(tab);
    if (tab === "containers") {
      fetchContainers();
    }
  };

  const [removing, setRemoving] = createSignal(false);
  const doRemove = async () => {
    if (removing()) return;
    if (!await confirmDanger(t("infra.volumeDetail.removeTitle"), t("infra.volumeDetail.removeConfirm", { name: props.volumeName }))) return;
    setRemoving(true);
    try {
      await invoke("remove_volume", { name: props.volumeName });
      showToast(t("infra.volumes.removed", { name: props.volumeName }), "success");
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
      showToast(t("infra.volumeDetail.exportFailed", { error: String(e) }), "error");
    }
  };

  const stateClass = (state: string) => {
    switch (state) {
      case "Running": return "state-running";
      case "Exited": return "state-exited";
      case "Created": return "state-created";
      case "Paused": return "state-paused";
      default: return "state-stopped";
    }
  };

  return (
    <div class="detail-page">
      {/* Breadcrumb */}
      <Breadcrumb
        items={[
          { label: "Volumes", onClick: () => props.onBack() },
          { label: props.volumeName },
        ]}
      />

      {/* Header bar */}
      <div class="detail-page-header">
        <Show when={volume()} fallback={
          <div class="detail-page-info">
            <div class="detail-page-name">{t("infra.common.loading")}</div>
          </div>
        }>
          {(v) => (
            <>
              <div class="detail-page-info">
                <div class="detail-page-name">{v().name}</div>
              </div>

              <span class="state-badge" style={{
                background: "rgba(88, 166, 255, 0.15)",
                color: "#58a6ff",
                border: "1px solid rgba(88, 166, 255, 0.3)",
              }}>
                {v().driver}
              </span>

              <div class="detail-page-actions">
                <button
                  class="btn btn-sm"
                  onClick={exportFileListing}
                  title={t("infra.volumeDetail.exportTitle")}
                >
                  {t("infra.volumeDetail.exportListing")}
                </button>
                <button
                  class="btn btn-sm btn-danger"
                  onClick={doRemove}
                  disabled={removing()}
                  style={{ display: "inline-flex", "align-items": "center", gap: "6px" }}
                >
                  <Show when={removing()}><Spinner size={12} /></Show>
                  {removing() ? t("infra.volumes.removing") : t("infra.volumeDetail.removeAction")}
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
          {t("infra.common.overview")}
        </button>
        <button
          class={`detail-tab-item ${activeTab() === "containers" ? "active" : ""}`}
          onClick={() => switchTab("containers")}
        >
          {t("infra.common.containers")}
        </button>
        <button
          class={`detail-tab-item ${activeTab() === "files" ? "active" : ""}`}
          onClick={() => switchTab("files")}
        >
          {t("infra.volumeDetail.files")}
        </button>
      </div>

      {/* Tab content */}
      <div class="detail-tab-content">
        {/* Overview Tab */}
        <Show when={activeTab() === "overview"}>
          <Show when={volume()} fallback={<Spinner />}>
            {(v) => (
              <div class="detail-section">
                <div class="card-grid">
                  <div class="card-label">{t("infra.common.name")}</div>
                  <div class="card-value">{v().name}</div>

                  <div class="card-label">{t("infra.common.driver")}</div>
                  <div class="card-value">{v().driver}</div>

                  <div class="card-label">{t("infra.volumeDetail.mountPoint")}</div>
                  <div class="card-value" style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                    <span class="mono" style={{ "font-size": "12px" }}>{v().mountpoint}</span>
                    <CopyButton text={v().mountpoint} />
                  </div>

                  <div class="card-label">{t("infra.common.created")}</div>
                  <div class="card-value">{formatTimestamp(v().created_at)}</div>

                  <Show when={Object.keys(v().labels).length > 0}>
                    <div class="card-label">{t("infra.common.labels")}</div>
                    <div class="card-value">
                      <For each={Object.entries(v().labels)}>
                        {([k, val]) => (
                          <div class="mono" style={{ "line-height": "1.6", "font-size": "11px" }}>
                            <span style={{ color: "#58a6ff" }}>{k}</span>
                            {val ? `=${val}` : <span style={{ color: "#484f58" }}> (empty)</span>}
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
            )}
          </Show>
        </Show>

        {/* Containers Tab */}
        <Show when={activeTab() === "containers"}>
          <div class="detail-section">
            <Show when={containersLoading()}>
              <Spinner />
            </Show>
            <Show when={!containersLoading()}>
              <Show when={containers().length > 0} fallback={
                <div class="empty" style={{ padding: "40px 0" }}>
                  <p class="empty-title">{t("infra.volumeDetail.noContainers")}</p>
                  <p>{t("infra.volumeDetail.notMounted")}</p>
                </div>
              }>
                <table class="table">
                  <thead>
                    <tr>
                      <th>{t("infra.common.name")}</th>
                      <th>{t("infra.common.image")}</th>
                      <th>{t("infra.common.state")}</th>
                      <th>{t("infra.volumeDetail.mountPath")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={containers()}>
                      {(c) => {
                        const mount = () => {
                          const mounts = (c as any).mounts || [];
                          const m = mounts.find((m: any) =>
                            m.source === props.volumeName ||
                            m.source?.endsWith?.(`/${props.volumeName}`)
                          );
                          return m?.destination || "-";
                        };
                        return (
                          <tr
                            onClick={() => props.onNavigate?.(`container:${c.id}`)}
                            style={{ cursor: "pointer" }}
                          >
                            <td style={{ "font-weight": "500" }}>{c.name}</td>
                            <td class="mono" style={{ "font-size": "12px", color: "#8b949e" }}>{c.image}</td>
                            <td>
                              <span class={`state-badge ${stateClass(c.state)}`}>{c.state}</span>
                            </td>
                            <td class="mono" style={{ "font-size": "12px", color: "#8b949e" }}>{mount()}</td>
                          </tr>
                        );
                      }}
                    </For>
                  </tbody>
                </table>
              </Show>
            </Show>
          </div>
        </Show>

        {/* Files Tab */}
        <Show when={activeTab() === "files"}>
          <div class="detail-section">
            <Show when={!fileBrowsingStarted()}>
              <div class="empty" style={{ padding: "40px 0" }}>
                <p class="empty-title">{t("infra.volumeDetail.browseTitle")}</p>
                <p style={{ "margin-bottom": "16px" }}>{t("infra.volumeDetail.browseDescription")}</p>
                <button class="btn btn-primary" onClick={startBrowsing}>
                  {t("infra.volumeDetail.browseFiles")}
                </button>
              </div>
            </Show>
            <Show when={fileBrowsingStarted()}>
              {/* File path breadcrumb */}
              <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "12px" }}>
                <button
                  class="btn btn-sm"
                  onClick={() => { setFileContent(null); setFileContentPath(null); fetchFiles(); }}
                  title={t("infra.volumeDetail.root")}
                >
                  /
                </button>
                <Show when={currentPath() && !fileContent()}>
                  <button class="btn btn-sm" onClick={navigateUp} title={t("infra.volumeDetail.goUp")}>
                    ..
                  </button>
                </Show>
                <Show when={fileContent()}>
                  <button class="btn btn-sm" onClick={() => { setFileContent(null); setFileContentPath(null); }} title={t("infra.volumeDetail.backToListing")}>
                    {t("infra.common.back")}
                  </button>
                </Show>
                <div style={{ display: "flex", "align-items": "center", gap: "2px", color: "#8b949e", "font-size": "13px", "flex-wrap": "wrap" }}>
                  <span
                    style={{ cursor: "pointer", color: currentPath() ? "#58a6ff" : "#e6edf3", padding: "2px 4px" }}
                    onClick={() => fetchFiles()}
                    title={t("infra.volumeDetail.root")}
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
                        <p>{t("infra.volumeDetail.emptyDirectory")}</p>
                      </div>
                    }>
                      <div style={{ padding: "16px 20px", color: "#f85149", background: "rgba(248, 81, 73, 0.1)", "border-radius": "6px", margin: "12px 0", "font-size": "13px" }}>
                        <strong>{t("infra.common.error")}:</strong> {fileError()}
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
