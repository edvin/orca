import { createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Image, ImageSearchResult, ScanResult, ScanVulnerability } from "../lib/types";
import { formatBytes, formatTimestamp, shortId } from "../lib/format";
import { showToast } from "../components/Toast";
import { confirmDanger } from "../components/ConfirmDialog";
import RunContainerDialog from "../components/RunContainerDialog";
import CopyButton from "../components/CopyButton";
import Spinner from "../components/Spinner";
import LastUpdated from "../components/LastUpdated";
import SortableHeader from "../components/SortableHeader";
import { useSort } from "../lib/useSort";
import { logError } from "../lib/activityStore";

interface ImagesPageProps {
  autoOpenPull?: boolean;
  onPullOpened?: () => void;
}

export default function ImagesPage(props: ImagesPageProps) {
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
  const [selectedResultIndex, setSelectedResultIndex] = createSignal(-1);
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
  const [fileError, setFileError] = createSignal<string | null>(null);
  const [fileContent, setFileContent] = createSignal<string | null>(null);
  const [fileContentPath, setFileContentPath] = createSignal("");

  // Vulnerability scanning state
  const [scanResult, setScanResult] = createSignal<ScanResult | null>(null);
  const [scanning, setScanning] = createSignal(false);
  const [scanImageId, setScanImageId] = createSignal<string | null>(null);

  const refresh = async () => {
    try {
      const result = (await invoke("list_images")) as Image[];
      setImages(result);
      setLastUpdated(new Date());
    } catch (e) {
    }
  };

  onMount(() => {
    refresh();
    // Auto-open pull dialog if requested (e.g. from Cmd+K → Pull Image)
    if (props.autoOpenPull) {
      setShowPull(true);
      props.onPullOpened?.();
    }
  });
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
      logError(`Failed to search images: ${e}`, `Query "${q}"`);
      setSearchResults([]);
    }
    setSearching(false);
  };

  const onPullInput = (value: string) => {
    setPullRef(value);
    setSelectedResultIndex(-1);
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(value.trim()), 500);
  };

  const selectSearchResult = (name: string) => {
    setPullRef(name);
    setShowSearchDropdown(false);
    setSearchResults([]);
    setSelectedResultIndex(-1);
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
    if (!await confirmDanger("Remove Image", `Remove image '${tag}'?`)) return;
    try {
      await invoke("remove_image", { id });
      showToast("Image removed", "success");
      await refresh();
    } catch (e) {
      logError(`Failed to remove image: ${e}`, `Image "${tag}"`);
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
      logError(`Failed to batch delete images: ${e}`, `${ids.length} images selected`);
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
      logError(`Failed to prune images: ${e}`);
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
      setShowPull(false);
      showToast(`Pulled ${ref_}`, "success");
      await refresh();
    } catch (e) {
      setPullStatus("");
      logError(`Failed to pull image: ${e}`, `Image "${ref_}"`);
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
      logError(`Failed to build image: ${e}`, `Context "${path}"${buildTag().trim() ? `, tag "${buildTag().trim()}"` : ""}`);
      showToast(`Build error: ${e}`, "error");
    }
    setBuilding(false);
  };

  const handlePullKeyDown = (e: KeyboardEvent) => {
    const results = searchResults();
    const idx = selectedResultIndex();

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length > 0) {
        setShowSearchDropdown(true);
        setSelectedResultIndex(Math.min(idx + 1, results.length - 1));
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (idx > 0) {
        setSelectedResultIndex(idx - 1);
      } else {
        setSelectedResultIndex(-1);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (idx >= 0 && idx < results.length) {
        // A result is selected — use it as the pull target and pull
        selectSearchResult(results[idx].name);
        doPull();
      } else if (results.length > 0 && showSearchDropdown()) {
        // No selection yet — highlight the first result
        setSelectedResultIndex(0);
      } else if (pullRef().trim() && !pulling()) {
        // No dropdown — pull whatever is typed
        doPull();
      }
    } else if (e.key === "Escape") {
      if (showSearchDropdown()) {
        setShowSearchDropdown(false);
        setSelectedResultIndex(-1);
      } else if (!pulling()) {
        setShowPull(false);
      }
    }
  };

  // --- Image File Browser ---
  const openFileBrowser = (imageId: string) => {
    setFileBrowserImage(imageId);
    setFileBrowserPath("/");
    setFileContent(null);
    setFileContentPath("");
    setFileError(null);
    fetchImageFiles(imageId, "/");
  };

  const closeFileBrowser = () => {
    setFileBrowserImage(null);
    setFiles([]);
    setFileContent(null);
    setFileError(null);
  };

  const fetchImageFiles = async (imageId: string, path: string) => {
    setFilesLoading(true);
    setFileContent(null);
    setFileError(null);
    try {
      const result = (await invoke("image_list_files", { id: imageId, path })) as { entries: FileEntry[]; path: string };
      setFiles(result.entries);
      setFileBrowserPath(path || "/");
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as any)?.message || String(e);
      logError(`Failed to browse image files: ${msg}`, `Image ${imageId}, path "${path}"`);
      setFileError(msg);
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
      logError(`Failed to read image file: ${e}`, `Image ${imageId}, path "${fullPath}"`);
      showToast(`Failed to read file: ${e}`, "error");
    }
  };

  const doScanImage = async (imageId: string) => {
    setScanning(true);
    setScanImageId(imageId);
    setScanResult(null);
    try {
      const result = (await invoke("scan_image", { id: imageId })) as ScanResult;
      setScanResult(result);
    } catch (e) {
      logError(`Failed to scan image: ${e}`, `Image ${imageId}`);
      showToast(`Scan failed: ${e}`, "error");
      setScanImageId(null);
    } finally {
      setScanning(false);
    }
  };

  const exportScanReport = (img: Image, scan: ScanResult) => {
    const imageName = img.repo_tags?.[0] || img.id.slice(0, 12);
    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const vulns = (scan.results || [])
      .flatMap((r) => (r.Vulnerabilities || []).map((v) => ({ ...v, _target: r.Target })))
      .sort((a, b) => {
        const order: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        return (order[a.Severity] ?? 4) - (order[b.Severity] ?? 4);
      });

    const severityColor = (s: string) => {
      switch (s) {
        case "CRITICAL": return { bg: "#da3633", fg: "#fff" };
        case "HIGH": return { bg: "#ea580c", fg: "#fff" };
        case "MEDIUM": return { bg: "#ca8a04", fg: "#fff" };
        case "LOW": return { bg: "#484f58", fg: "#fff" };
        default: return { bg: "#9ca3af", fg: "#000" };
      }
    };

    const vulnRows = vulns.map((v) => {
      const c = severityColor(v.Severity);
      return `<tr>
        <td><span class="badge" style="background:${c.bg};color:${c.fg}">${v.Severity}</span></td>
        <td>${v.PrimaryURL ? `<a href="${v.PrimaryURL}" target="_blank">${v.VulnerabilityID}</a>` : v.VulnerabilityID}</td>
        <td class="mono">${v.PkgName}</td>
        <td class="mono">${v.InstalledVersion}</td>
        <td class="mono ${v.FixedVersion ? "fixed" : "no-fix"}">${v.FixedVersion || "\u2014"}</td>
        <td class="desc">${v.Title || "\u2014"}</td>
      </tr>`;
    }).join("\n");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vulnerability Report — ${imageName}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, sans-serif; background: #0a0e14; color: #e6edf3; min-height: 100vh; }
  .container { max-width: 1200px; margin: 0 auto; padding: 48px 32px; }
  .header { margin-bottom: 40px; }
  .header h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 8px; }
  .header h1 span { color: #58a6ff; }
  .header .meta { font-size: 13px; color: #8b949e; display: flex; gap: 20px; margin-top: 8px; }
  .header .meta span { display: flex; align-items: center; gap: 4px; }
  .summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 32px; }
  .summary-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 20px; text-align: center; }
  .summary-card .number { font-size: 32px; font-weight: 700; letter-spacing: -1px; }
  .summary-card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #8b949e; margin-top: 4px; }
  .summary-card.critical .number { color: #f85149; }
  .summary-card.high .number { color: #ea580c; }
  .summary-card.medium .number { color: #d97706; }
  .summary-card.low .number { color: #8b949e; }
  .summary-card.total .number { color: #e6edf3; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead { position: sticky; top: 0; }
  th { padding: 12px 14px; text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #8b949e; background: #161b22; border-bottom: 1px solid #21262d; }
  td { padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: top; }
  tr:hover td { background: rgba(255,255,255,0.02); }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; letter-spacing: 0.3px; }
  .mono { font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  .fixed { color: #3fb950; }
  .no-fix { color: #484f58; }
  .desc { color: #8b949e; max-width: 320px; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .table-wrap { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; overflow: hidden; }
  .footer { margin-top: 40px; text-align: center; font-size: 11px; color: #484f58; padding: 20px; }
  .footer a { color: #58a6ff; }
  @media print { body { background: #fff; color: #1a1a1a; } th { background: #f0f0f0; color: #333; } td { border-color: #e0e0e0; } .badge { border: 1px solid currentColor; } .desc { color: #666; } .summary-card { border-color: #e0e0e0; } .footer { display: none; } }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>Vulnerability Report — <span>${imageName}</span></h1>
    <div class="meta">
      <span>Scanned: ${timestamp}</span>
      <span>Scanner: Trivy (via Orca Desktop)</span>
      <span>${vulns.length} vulnerabilities found</span>
    </div>
  </div>
  <div class="summary">
    <div class="summary-card total"><div class="number">${scan.total}</div><div class="label">Total</div></div>
    <div class="summary-card critical"><div class="number">${scan.critical}</div><div class="label">Critical</div></div>
    <div class="summary-card high"><div class="number">${scan.high}</div><div class="label">High</div></div>
    <div class="summary-card medium"><div class="number">${scan.medium}</div><div class="label">Medium</div></div>
    <div class="summary-card low"><div class="number">${scan.low}</div><div class="label">Low</div></div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Severity</th><th>CVE</th><th>Package</th><th>Installed</th><th>Fixed In</th><th>Title</th></tr></thead>
      <tbody>${vulnRows}</tbody>
    </table>
  </div>
  <div class="footer">Generated by <a href="https://orca-desktop.com">Orca Desktop</a> using Trivy</div>
</div>
</body>
</html>`;

    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeName = imageName.replace(/[^a-zA-Z0-9_-]/g, "_");
    a.download = `vulnerability-report-${safeName}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Report exported — open the HTML file in your browser", "success");
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
      logError(`Failed to inspect image: ${e}`, `Image ${id}`);
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
                        ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
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
                                <div style={{ "margin-top": "12px", display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
                                  <button class="btn btn-sm" onClick={(e) => { e.stopPropagation(); openFileBrowser(img.id); }}>
                                    Browse Files
                                  </button>
                                  <button
                                    class="btn btn-sm"
                                    disabled={scanning() && scanImageId() === img.id}
                                    onClick={(e) => { e.stopPropagation(); doScanImage(img.id); }}
                                  >
                                    {scanning() && scanImageId() === img.id
                                      ? (<><Spinner size={12} />{" Scanning..."}</>)
                                      : "Scan for Vulnerabilities"}
                                  </button>
                                </div>
                                <Show when={scanImageId() === img.id && scanResult()}>
                                  <div style={{ "margin-top": "12px" }}>
                                    {/* Scan error */}
                                    <Show when={scanResult()!.error}>
                                      <div style={{
                                        padding: "10px 14px",
                                        background: "rgba(248, 81, 73, 0.08)",
                                        border: "1px solid rgba(248, 81, 73, 0.2)",
                                        "border-radius": "8px",
                                        color: "#f85149",
                                        "font-size": "12px",
                                        "white-space": "pre-wrap",
                                        "word-break": "break-word",
                                        "line-height": "1.5",
                                        "max-height": "200px",
                                        overflow: "auto",
                                      }}>
                                        {scanResult()!.error}
                                      </div>
                                    </Show>
                                    <Show when={!scanResult()!.error}>
                                    <Show
                                      when={scanResult()!.total > 0}
                                      fallback={
                                        <div style={{
                                          padding: "8px 12px",
                                          background: "#0d1117",
                                          border: "1px solid #238636",
                                          "border-radius": "6px",
                                          color: "#3fb950",
                                          "font-size": "13px",
                                          "font-weight": "500",
                                        }}>
                                          No vulnerabilities found
                                        </div>
                                      }
                                    >
                                      <div style={{
                                        display: "flex",
                                        gap: "8px",
                                        "align-items": "center",
                                        "flex-wrap": "wrap",
                                      }}>
                                        <span style={{ "font-size": "13px", color: "#8b949e", "margin-right": "4px" }}>
                                          {scanResult()!.total} vulnerabilities:
                                        </span>
                                        <Show when={scanResult()!.critical > 0}>
                                          <span style={{
                                            background: "#da3633",
                                            color: "#fff",
                                            padding: "2px 8px",
                                            "border-radius": "10px",
                                            "font-size": "12px",
                                            "font-weight": "600",
                                          }}>
                                            {scanResult()!.critical} Critical
                                          </span>
                                        </Show>
                                        <Show when={scanResult()!.high > 0}>
                                          <span style={{
                                            background: "#ea580c",
                                            color: "#fff",
                                            padding: "2px 8px",
                                            "border-radius": "10px",
                                            "font-size": "12px",
                                            "font-weight": "600",
                                          }}>
                                            {scanResult()!.high} High
                                          </span>
                                        </Show>
                                        <Show when={scanResult()!.medium > 0}>
                                          <span style={{
                                            background: "#ca8a04",
                                            color: "#fff",
                                            padding: "2px 8px",
                                            "border-radius": "10px",
                                            "font-size": "12px",
                                            "font-weight": "600",
                                          }}>
                                            {scanResult()!.medium} Medium
                                          </span>
                                        </Show>
                                        <Show when={scanResult()!.low > 0}>
                                          <span style={{
                                            background: "#484f58",
                                            color: "#e6edf3",
                                            padding: "2px 8px",
                                            "border-radius": "10px",
                                            "font-size": "12px",
                                            "font-weight": "600",
                                          }}>
                                            {scanResult()!.low} Low
                                          </span>
                                        </Show>
                                        <button
                                          class="btn btn-sm"
                                          style={{ "margin-left": "auto" }}
                                          onClick={(e) => { e.stopPropagation(); exportScanReport(img, scanResult()!); }}
                                        >
                                          Export Report
                                        </button>
                                      </div>
                                      {/* Detailed vulnerability report */}
                                      <Show when={scanResult()!.results}>
                                        <div style={{
                                          "margin-top": "12px",
                                          "max-height": "400px",
                                          overflow: "auto",
                                          border: "1px solid rgba(255,255,255,0.06)",
                                          "border-radius": "8px",
                                        }}>
                                          <table class="table" style={{ "font-size": "12px", margin: 0 }}>
                                            <thead>
                                              <tr>
                                                <th style={{ position: "sticky", top: 0, background: "#161b22", "z-index": 1 }}>Severity</th>
                                                <th style={{ position: "sticky", top: 0, background: "#161b22", "z-index": 1 }}>CVE</th>
                                                <th style={{ position: "sticky", top: 0, background: "#161b22", "z-index": 1 }}>Package</th>
                                                <th style={{ position: "sticky", top: 0, background: "#161b22", "z-index": 1 }}>Installed</th>
                                                <th style={{ position: "sticky", top: 0, background: "#161b22", "z-index": 1 }}>Fixed In</th>
                                                <th style={{ position: "sticky", top: 0, background: "#161b22", "z-index": 1 }}>Title</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              <For each={
                                                scanResult()!.results!
                                                  .flatMap((r) => (r.Vulnerabilities || []).map((v) => ({ ...v, _target: r.Target })))
                                                  .sort((a, b) => {
                                                    const order: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
                                                    return (order[a.Severity] ?? 4) - (order[b.Severity] ?? 4);
                                                  })
                                              }>
                                                {(vuln) => (
                                                  <tr>
                                                    <td>
                                                      <span style={{
                                                        display: "inline-block",
                                                        padding: "1px 6px",
                                                        "border-radius": "4px",
                                                        "font-size": "11px",
                                                        "font-weight": "600",
                                                        color: "#fff",
                                                        background: vuln.Severity === "CRITICAL" ? "#da3633"
                                                          : vuln.Severity === "HIGH" ? "#ea580c"
                                                          : vuln.Severity === "MEDIUM" ? "#ca8a04"
                                                          : "#484f58",
                                                      }}>
                                                        {vuln.Severity}
                                                      </span>
                                                    </td>
                                                    <td>
                                                      <Show when={vuln.PrimaryURL} fallback={
                                                        <span class="mono">{vuln.VulnerabilityID}</span>
                                                      }>
                                                        <a
                                                          href={vuln.PrimaryURL}
                                                          target="_blank"
                                                          onClick={(e) => e.stopPropagation()}
                                                          style={{ color: "#58a6ff" }}
                                                        >
                                                          {vuln.VulnerabilityID}
                                                        </a>
                                                      </Show>
                                                    </td>
                                                    <td class="mono" style={{ color: "#e6edf3" }}>{vuln.PkgName}</td>
                                                    <td class="mono" style={{ color: "#8b949e" }}>{vuln.InstalledVersion}</td>
                                                    <td class="mono" style={{ color: vuln.FixedVersion ? "#3fb950" : "#484f58" }}>
                                                      {vuln.FixedVersion || "—"}
                                                    </td>
                                                    <td style={{ color: "#8b949e", "max-width": "300px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}
                                                      title={vuln.Title || vuln.Description || ""}
                                                    >
                                                      {vuln.Title || "—"}
                                                    </td>
                                                  </tr>
                                                )}
                                              </For>
                                            </tbody>
                                          </table>
                                        </div>
                                      </Show>
                                    </Show>
                                    </Show>
                                  </div>
                                </Show>
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

      {/* Pull Image Dialog */}
      <Show when={showPull()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdOverlay = (e.target as HTMLElement).classList.contains("modal-overlay"); }}
          onClick={(e) => { if ((e.currentTarget as any).__mdOverlay && (e.target as HTMLElement).classList.contains("modal-overlay") && !pulling()) setShowPull(false); (e.currentTarget as any).__mdOverlay = false; }}
        >
          <div class="modal-dialog" style={{ width: "700px", "max-width": "90vw", "min-height": "500px", display: "flex", "flex-direction": "column" }}>
            <div class="modal-header">
              <span class="modal-title">Pull Image</span>
              <button class="modal-close" onClick={() => { if (!pulling()) setShowPull(false); }}>{"\u00d7"}</button>
            </div>
            <div class="modal-body">
              <div style={{ position: "relative" }}>
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
                    ref={(el) => { pullInputRef = el; setTimeout(() => el.focus(), 50); }}
                    class="pull-input"
                    type="text"
                    placeholder="Search Docker Hub and pull an image (e.g. nginx, postgres:16)"
                    value={pullRef()}
                    onInput={(e) => onPullInput(e.currentTarget.value)}
                    onKeyDown={handlePullKeyDown}
                    onFocus={() => { if (searchResults().length > 0) setShowSearchDropdown(true); }}
                    disabled={pulling()}
                    style={{ "padding-left": "32px", width: "100%", "box-sizing": "border-box" }}
                  />
                </div>
                <Show when={showSearchDropdown()}>
                  <div style={{
                    background: "#161b22", border: "1px solid #30363d", "border-radius": "8px",
                    "max-height": "360px", "overflow-y": "auto", "margin-top": "8px",
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
                      {(result, i) => (
                        <div
                          style={{
                            padding: "8px 14px", cursor: "pointer", "border-bottom": "1px solid #21262d",
                            display: "flex", "align-items": "center", gap: "8px",
                            background: i() === selectedResultIndex() ? "rgba(31, 111, 235, 0.12)" : "transparent",
                            "border-left": i() === selectedResultIndex() ? "2px solid #58a6ff" : "2px solid transparent",
                          }}
                          onMouseDown={() => { selectSearchResult(result.name); doPull(); }}
                          onMouseEnter={() => setSelectedResultIndex(i())}
                        >
                          <div style={{ flex: 1, "min-width": 0 }}>
                            <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                              <span class="mono" style={{ "font-weight": "600", "font-size": "13px", color: i() === selectedResultIndex() ? "#58a6ff" : "#e6edf3" }}>
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
              <Show when={showAuth()}>
                <div style={{ display: "flex", gap: "8px", "margin-top": "12px" }}>
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
                <div class="pull-status" style={{ "margin-top": "12px" }}><Spinner size={12} />{" "}{pullStatus()}</div>
              </Show>
            </div>
            <div class="modal-footer">
              <button
                class="btn"
                onClick={() => setShowAuth(!showAuth())}
                style={{ "margin-right": "auto" }}
              >
                {showAuth() ? "Auth \u25B2" : "Auth \u25BC"}
              </button>
              <button class="btn" onClick={() => { if (!pulling()) setShowPull(false); }} disabled={pulling()}>Cancel</button>
              <button
                class="btn btn-primary"
                onClick={doPull}
                disabled={pulling() || !pullRef().trim()}
              >
                {pulling() ? (<><Spinner size={12} />{" Pulling..."}</>) : "Pull"}
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
          <div class="modal-dialog" style={{ width: "900px", "max-width": "90vw", height: "70vh", display: "flex", "flex-direction": "column" }}>
            <div class="modal-header">
              <span class="modal-title">
                Files — {images().find((i) => i.id === fileBrowserImage())?.repo_tags?.[0] || fileBrowserImage()?.slice(0, 12)}
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
                    <Show when={fileError()} fallback={
                      <div style={{ padding: "20px", "text-align": "center", color: "#8b949e" }}>Empty directory</div>
                    }>
                      <div style={{ padding: "16px 20px", color: "#f85149", background: "rgba(248, 81, 73, 0.1)", "border-radius": "6px", margin: "12px 16px", "font-size": "13px" }}>
                        <strong>Error:</strong> {fileError()}
                      </div>
                    </Show>
                  }>
                    {/* Back button */}
                    <Show when={fileBrowserPath() !== "/"}>
                      <div
                        class="file-browser-row"
                        style={{ color: "#8b949e" }}
                        onClick={navigateUp}
                      >
                        <span style={{ color: "#8b949e", width: "16px", "text-align": "center", "flex-shrink": "0", "font-size": "10px" }}>{"\u25C0"}</span>
                        <span>.. (parent)</span>
                      </div>
                    </Show>
                    <For each={files()}>
                      {(f) => (
                        <div
                          class="file-browser-row"
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
                <div style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
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
                    flex: "1",
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
