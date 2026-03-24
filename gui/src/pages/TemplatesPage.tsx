import { createSignal, onMount, For, Index, Show } from "solid-js";
import Spinner from "../components/Spinner";
import Dropdown from "../components/Dropdown";
import { invoke } from "@tauri-apps/api/core";
import { useRefresh } from "../lib/useRefresh";
import type { AppTemplate, ImageSearchResult, RemoteHost, ActiveHost } from "../lib/types";
import { showToast } from "../components/Toast";
import { logError, logInfo } from "../lib/activityStore";

const CATEGORIES = ["All", "Database", "Web Server", "AI", "Monitoring", "Storage", "Tools", "Development", "Message Queue", "Search"];

interface EnvEntry { key: string; value: string }
interface VolumeEntry { source: string; target: string }
interface PortEntry { host: string; container: string }

interface TemplatesPageProps {
  onNavigate?: (target: string) => void;
}

export default function TemplatesPage(props: TemplatesPageProps) {
  const [templates, setTemplates] = createSignal<AppTemplate[]>([]);
  const [category, setCategory] = createSignal("All");
  const [search, setSearch] = createSignal("");
  const [deploying, setDeploying] = createSignal(false);
  const [deployStatus, setDeployStatus] = createSignal("");
  const [deployTarget, setDeployTarget] = createSignal<AppTemplate | null>(null);

  // Deploy dialog state
  const [deployName, setDeployName] = createSignal("");
  const [nameConflict, setNameConflict] = createSignal(false);
  const [deployPorts, setDeployPorts] = createSignal<PortEntry[]>([]);
  const [deployEnv, setDeployEnv] = createSignal<EnvEntry[]>([]);
  const [deployVolumes, setDeployVolumes] = createSignal<VolumeEntry[]>([]);
  const [existingNames, setExistingNames] = createSignal<Set<string>>(new Set());

  // Target host for deploy (fleet management)
  const [deployHostId, setDeployHostId] = createSignal<string | null>(null); // null = current active host
  const [hostOptions, setHostOptions] = createSignal<Array<{ value: string; label: string }>>([]);

  // Editor dialog state (create/edit user template)
  const [editorOpen, setEditorOpen] = createSignal(false);
  const [editorId, setEditorId] = createSignal("");
  const [editorName, setEditorName] = createSignal("");
  const [editorDesc, setEditorDesc] = createSignal("");
  const [editorIcon, setEditorIcon] = createSignal("");
  const [editorCategory, setEditorCategory] = createSignal("Tools");
  const [editorImage, setEditorImage] = createSignal("");
  const [editorNotes, setEditorNotes] = createSignal("");
  const [editorPorts, setEditorPorts] = createSignal<PortEntry[]>([]);
  const [editorEnv, setEditorEnv] = createSignal<EnvEntry[]>([]);
  const [editorVolumes, setEditorVolumes] = createSignal<VolumeEntry[]>([]);
  const [editorSaving, setEditorSaving] = createSignal(false);
  const [editorIsNew, setEditorIsNew] = createSignal(true);

  // Tab state
  const [activeTab, setActiveTab] = createSignal<"curated" | "dockerhub">("curated");

  // Docker Hub search state
  const [hubQuery, setHubQuery] = createSignal("");
  const [hubResults, setHubResults] = createSignal<ImageSearchResult[]>([]);
  const [hubLoading, setHubLoading] = createSignal(false);
  const [hubSearched, setHubSearched] = createSignal(false);
  const [hubPulling, setHubPulling] = createSignal<Set<string>>(new Set());

  const searchDockerHub = async (query?: string) => {
    const q = query ?? hubQuery();
    setHubLoading(true);
    setHubSearched(true);
    try {
      const results = (await invoke("search_images", { query: q, limit: 50 })) as ImageSearchResult[];
      setHubResults(results);
    } catch (e: any) {
      showToast(`Docker Hub search failed: ${e}`, "error");
    } finally {
      setHubLoading(false);
    }
  };

  const pullHubImage = async (name: string) => {
    setHubPulling((prev) => new Set([...prev, name]));
    try {
      await invoke("pull_image", { reference: name });
      showToast(`Pulled ${name} successfully`, "success");
    } catch (e: any) {
      showToast(`Failed to pull ${name}: ${e}`, "error");
    } finally {
      setHubPulling((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  };

  const formatPulls = (pulls: string | null): string => {
    if (!pulls) return "";
    const n = parseInt(pulls, 10);
    if (isNaN(n)) return pulls;
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  let mouseDownOnOverlay = false;

  const refreshTemplates = async () => {
    try {
      const result = (await invoke("list_templates")) as AppTemplate[];
      setTemplates(result);
    } catch {
      showToast("Failed to load templates", "error");
    }
  };

  useRefresh(refreshTemplates);

  onMount(refreshTemplates);

  const filtered = () => {
    const cat = category();
    const q = search().toLowerCase().trim();
    let items = cat === "All" ? templates() : templates().filter((t) => t.category === cat);
    if (q) {
      items = items.filter((t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.image.toLowerCase().includes(q)
      );
    }
    return items;
  };

  const groupedByCategory = () => {
    const items = filtered();
    const groups: Record<string, AppTemplate[]> = {};
    for (const t of items) {
      if (!groups[t.category]) groups[t.category] = [];
      groups[t.category].push(t);
    }
    return groups;
  };

  const parsePort = (s: string): PortEntry => {
    const [host, container] = s.split(":");
    return { host: host || "", container: container || "" };
  };

  const parseEnv = (s: string): EnvEntry => {
    const idx = s.indexOf("=");
    if (idx === -1) return { key: s, value: "" };
    return { key: s.substring(0, idx), value: s.substring(idx + 1) };
  };

  const parseVolume = (s: string): VolumeEntry => {
    const idx = s.indexOf(":");
    if (idx === -1) return { source: s, target: "" };
    return { source: s.substring(0, idx), target: s.substring(idx + 1) };
  };

  // --- Deploy dialog ---
  const openDeploy = async (template: AppTemplate) => {
    setDeployTarget(template);
    setDeployName(template.id);
    setDeployPorts(template.default_ports.map(parsePort));
    setDeployEnv(template.default_env.map(parseEnv));
    setDeployVolumes(template.default_volumes.map(parseVolume));
    // Fetch existing container names for validation
    try {
      const containers = (await invoke("list_containers")) as { name: string }[];
      const names = new Set(containers.map((c) => c.name.replace(/^\//, "")));
      setExistingNames(names);
      setNameConflict(names.has(template.id));
    } catch { setExistingNames(new Set<string>()); }

    // Load host options for target host selector
    try {
      const activeHost = (await invoke("get_active_host")) as ActiveHost;
      const remoteHosts = (await invoke("list_remote_hosts")) as RemoteHost[];
      const options: Array<{ value: string; label: string }> = [
        { value: "__local__", label: "Local" },
        ...remoteHosts.map((h) => ({ value: h.id, label: h.name })),
      ];
      setHostOptions(options);
      // Default to current active host
      setDeployHostId(activeHost.is_remote && activeHost.id ? activeHost.id : "__local__");
    } catch {
      setHostOptions([{ value: "__local__", label: "Local" }]);
      setDeployHostId("__local__");
    }
  };

  const closeDeploy = () => setDeployTarget(null);

  /** Build a registry URL and label for an image reference. */
  const imageRegistryLink = (image: string): { url: string; label: string } | null => {
    const name = image.split(":")[0]; // strip tag
    if (name.startsWith("ghcr.io/")) {
      // GitHub Container Registry: ghcr.io/owner/repo → github.com/owner/repo
      const parts = name.replace("ghcr.io/", "").split("/");
      if (parts.length >= 2) {
        return { url: `https://github.com/${parts[0]}/${parts[1]}`, label: "View on GitHub" };
      }
    }
    if (name.includes(".")) return null; // other custom registries
    if (name.includes("/")) {
      return { url: `https://hub.docker.com/r/${name}`, label: "View on Docker Hub" };
    }
    return { url: `https://hub.docker.com/_/${name}`, label: "View on Docker Hub" };
  };

  const handleOverlayMouseDown = (e: MouseEvent) => {
    mouseDownOnOverlay = (e.target as HTMLElement).classList.contains("modal-overlay");
  };

  const handleOverlayClick = (e: MouseEvent) => {
    if (mouseDownOnOverlay && (e.target as HTMLElement).classList.contains("modal-overlay")) {
      closeDeploy();
    }
    mouseDownOnOverlay = false;
  };

  const handleEditorOverlayClick = (e: MouseEvent) => {
    if (mouseDownOnOverlay && (e.target as HTMLElement).classList.contains("modal-overlay")) {
      setEditorOpen(false);
    }
    mouseDownOnOverlay = false;
  };

  // Deploy env/port/volume helpers
  // Mutate in-place to avoid SolidJS For re-rendering (which steals focus)
  const updateEnv = (index: number, field: "key" | "value", val: string) => {
    const arr = deployEnv().slice();
    (arr[index] as any)[field] = val;
    setDeployEnv(arr);
  };
  const addEnv = () => setDeployEnv([...deployEnv(), { key: "", value: "" }]);
  const removeEnv = (index: number) => setDeployEnv(deployEnv().filter((_, i) => i !== index));

  const updateVolume = (index: number, field: "source" | "target", val: string) => {
    const arr = deployVolumes().slice();
    (arr[index] as any)[field] = val;
    setDeployVolumes(arr);
  };
  const addVolume = () => setDeployVolumes([...deployVolumes(), { source: "", target: "" }]);
  const removeVolume = (index: number) => setDeployVolumes(deployVolumes().filter((_, i) => i !== index));

  const updatePort = (index: number, field: "host" | "container", val: string) => {
    const arr = deployPorts().slice();
    (arr[index] as any)[field] = val;
    setDeployPorts(arr);
  };
  const addPort = () => setDeployPorts([...deployPorts(), { host: "", container: "" }]);
  const removePort = (index: number) => setDeployPorts(deployPorts().filter((_, i) => i !== index));

  // Editor env/port/volume helpers
  const updateEditorEnv = (index: number, field: "key" | "value", val: string) => {
    setEditorEnv((prev) => prev.map((e, i) => i === index ? { ...e, [field]: val } : e));
  };
  const addEditorEnv = () => setEditorEnv((prev) => [...prev, { key: "", value: "" }]);
  const removeEditorEnv = (index: number) => setEditorEnv((prev) => prev.filter((_, i) => i !== index));

  const updateEditorVolume = (index: number, field: "source" | "target", val: string) => {
    setEditorVolumes((prev) => prev.map((v, i) => i === index ? { ...v, [field]: val } : v));
  };
  const addEditorVolume = () => setEditorVolumes((prev) => [...prev, { source: "", target: "" }]);
  const removeEditorVolume = (index: number) => setEditorVolumes((prev) => prev.filter((_, i) => i !== index));

  const updateEditorPort = (index: number, field: "host" | "container", val: string) => {
    setEditorPorts((prev) => prev.map((p, i) => i === index ? { ...p, [field]: val } : p));
  };
  const addEditorPort = () => setEditorPorts((prev) => [...prev, { host: "", container: "" }]);
  const removeEditorPort = (index: number) => setEditorPorts((prev) => prev.filter((_, i) => i !== index));

  const doDeploy = async () => {
    const template = deployTarget();
    if (!template) return;

    setDeploying(true);

    // Determine if we need to switch hosts for deployment
    const targetHostId = deployHostId();
    const targetHostLabel = hostOptions().find((o) => o.value === targetHostId)?.label || "Local";
    let originalHost: ActiveHost | null = null;
    let switchedHost = false;

    try {
      // If deploying to a different host, switch first
      originalHost = (await invoke("get_active_host")) as ActiveHost;
      const currentHostKey = originalHost.is_remote && originalHost.id ? originalHost.id : "__local__";
      if (targetHostId && targetHostId !== currentHostKey) {
        setDeployStatus(`Switching to ${targetHostLabel}...`);
        await invoke("switch_host", { id: targetHostId === "__local__" ? null : targetHostId });
        switchedHost = true;
      }

      const ports = deployPorts().filter((p) => p.host || p.container).map((p) => `${p.host}:${p.container}`);
      const env = deployEnv().filter((e) => e.key).map((e) => `${e.key}=${e.value}`);
      const volumes = deployVolumes().filter((v) => v.source || v.target).map((v) => `${v.source}:${v.target}`);

      // Pre-check: verify host ports are available
      const hostPorts = deployPorts().filter((p) => p.host).map((p) => parseInt(p.host)).filter((p) => !isNaN(p));
      if (hostPorts.length > 0) {
        try {
          const result = await invoke("check_ports", { ports: hostPorts }) as { conflicts: number[] };
          if (result.conflicts && result.conflicts.length > 0) {
            showToast(`Port${result.conflicts.length > 1 ? "s" : ""} ${result.conflicts.join(", ")} already in use. Change the port mappings and try again.`, "error");
            return; // finally block will handle host switch-back and setDeploying(false)
          }
        } catch { /* port check failed, proceed anyway */ }
      }

      // Step 1: Pull image with progress
      setDeployStatus(`Pulling ${template.image}...`);
      try {
        await invoke("pull_image", { reference: template.image });
      } catch (pullErr) {
        // Pull may fail if image is already local or name is wrong — try deploy anyway
        setDeployStatus("Image pull completed, creating container...");
      }

      // Step 2: Deploy (image should now be local)
      setDeployStatus("Creating and starting container...");
      const result = (await invoke("deploy_template", {
        id: template.id,
        name: deployName() || null,
        ports: ports.length > 0 ? ports : null,
        env: env.length > 0 ? env : null,
        volumes: volumes.length > 0 ? volumes : null,
      })) as any;

      closeDeploy();
      const containerId = result?.id;
      const containerName = result?.name;
      const notes = result?.notes || template.notes;
      const hostSuffix = switchedHost ? ` on ${targetHostLabel}` : "";
      showToast(`${template.name} deployed${hostSuffix}!${notes ? " " + notes : ""}`, "success");
      logInfo("Template deployed", `${template.name} → container ${containerName || containerId || "unknown"}${hostSuffix}`);
      // Navigate to the container detail page (only if deployed on current host)
      if (!switchedHost) {
        if (containerId && props.onNavigate) {
          props.onNavigate(`container:${containerId}`);
        } else {
          props.onNavigate?.("containers");
        }
      }
    } catch (e: any) {
      const err = String(e);
      const isNameConflict = err.includes("is already in use") || err.includes("Conflict");
      const isPortConflict = err.includes("port is already allocated") || err.includes("address already in use") || err.includes("Bind for");
      const displayMsg = isNameConflict
        ? `A container named "${deployName() || template.id}" already exists. Remove or rename it first.`
        : isPortConflict
        ? `Port conflict — one of the ports is already in use. Edit the port mappings above and try again.`
        : err;
      logError(`Deploy failed: ${displayMsg}`, `Template "${template.name}" (${template.image})`);
      showToast(displayMsg, "error");
    } finally {
      // Always switch back to original host
      if (switchedHost && originalHost) {
        try {
          await invoke("switch_host", { id: originalHost.is_remote && originalHost.id ? originalHost.id : null });
        } catch { /* best effort switch-back */ }
      }
      setDeploying(false);
    }
  };

  const hasPasswordEnv = () =>
    deployEnv().some((e) => {
      const k = e.key.toLowerCase();
      return k.includes("password") || k.includes("secret");
    });

  // --- Template Editor ---
  const openCreateTemplate = () => {
    setEditorIsNew(true);
    setEditorId("");
    setEditorName("");
    setEditorDesc("");
    setEditorIcon("\u25A3");
    setEditorCategory("Tools");
    setEditorImage("");
    setEditorNotes("");
    setEditorPorts([]);
    setEditorEnv([]);
    setEditorVolumes([]);
    setEditorOpen(true);
  };

  const openEditTemplate = (template: AppTemplate) => {
    setEditorIsNew(false);
    setEditorId(template.id);
    setEditorName(template.name);
    setEditorDesc(template.description);
    setEditorIcon(template.icon);
    setEditorCategory(template.category);
    setEditorImage(template.image);
    setEditorNotes(template.notes);
    setEditorPorts(template.default_ports.map(parsePort));
    setEditorEnv(template.default_env.map(parseEnv));
    setEditorVolumes(template.default_volumes.map(parseVolume));
    setEditorOpen(true);
  };

  const saveTemplate = async () => {
    if (!editorName() || !editorImage()) {
      showToast("Name and image are required", "error");
      return;
    }
    setEditorSaving(true);
    try {
      const id = editorId() || editorName().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const template: AppTemplate = {
        id,
        name: editorName(),
        description: editorDesc(),
        icon: editorIcon(),
        category: editorCategory(),
        image: editorImage(),
        default_ports: editorPorts().filter((p) => p.host || p.container).map((p) => `${p.host}:${p.container}`),
        default_env: editorEnv().filter((e) => e.key).map((e) => `${e.key}=${e.value}`),
        default_volumes: editorVolumes().filter((v) => v.source || v.target).map((v) => `${v.source}:${v.target}`),
        restart_policy: "unless-stopped",
        notes: editorNotes(),
        is_builtin: false,
      };
      await invoke("save_user_template", { template });
      setEditorOpen(false);
      await refreshTemplates();
      showToast(`Template "${template.name}" saved`, "success");
    } catch (e: any) {
      logError(`Failed to save template: ${e}`, `Template "${editorName()}"`);
      showToast(`Failed to save template: ${e}`, "error");
    } finally {
      setEditorSaving(false);
    }
  };

  const deleteTemplate = async (template: AppTemplate) => {
    try {
      await invoke("delete_user_template", { id: template.id });
      await refreshTemplates();
      showToast(`Template "${template.name}" deleted`, "success");
    } catch (e: any) {
      logError(`Failed to delete template: ${e}`, `Template "${template.name}"`);
      showToast(`Failed to delete: ${e}`, "error");
    }
  };

  // Reusable row editor components
  const PortEditor = (props: { ports: () => PortEntry[]; update: typeof updatePort; add: typeof addPort; remove: typeof removePort }) => (
    <div class="form-group">
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "6px" }}>
        <label class="form-label" style={{ margin: 0 }}>Port Mappings</label>
        <button class="btn btn-sm" onClick={props.add} style={{ "font-size": "11px", padding: "2px 8px" }}>+ Add</button>
      </div>
      <Show when={props.ports().length > 0} fallback={
        <div style={{ "font-size": "12px", color: "#484f58", padding: "8px 0" }}>No port mappings configured</div>
      }>
        <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
          <div style={{ display: "flex", gap: "8px", "font-size": "11px", color: "#484f58", "padding-left": "2px" }}>
            <span style={{ flex: "1" }}>Host Port</span>
            <span style={{ flex: "1" }}>Container Port</span>
            <span style={{ width: "28px" }} />
          </div>
          <Index each={props.ports()}>
            {(port, i) => (
              <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                <input class="form-input" style={{ flex: "1" }} value={port().host} onInput={(e) => props.update(i, "host", e.currentTarget.value)} placeholder="8080" />
                <span style={{ color: "#484f58" }}>:</span>
                <input class="form-input" style={{ flex: "1" }} value={port().container} onInput={(e) => props.update(i, "container", e.currentTarget.value)} placeholder="80" />
                <button class="action-icon" onClick={() => props.remove(i)} title="Remove" style={{ width: "28px", height: "28px", "flex-shrink": "0", color: "#f85149" }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
              </div>
            )}
          </Index>
        </div>
      </Show>
    </div>
  );

  const EnvEditor = (props: { env: () => EnvEntry[]; update: typeof updateEnv; add: typeof addEnv; remove: typeof removeEnv; showWarning?: boolean }) => (
    <div class="form-group">
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "6px" }}>
        <label class="form-label" style={{ margin: 0 }}>Environment Variables</label>
        <button class="btn btn-sm" onClick={props.add} style={{ "font-size": "11px", padding: "2px 8px" }}>+ Add</button>
      </div>
      <Show when={props.env().length > 0} fallback={
        <div style={{ "font-size": "12px", color: "#484f58", padding: "8px 0" }}>No environment variables configured</div>
      }>
        <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
          <div style={{ display: "flex", gap: "8px", "font-size": "11px", color: "#484f58", "padding-left": "2px" }}>
            <span style={{ flex: "2" }}>Variable</span>
            <span style={{ flex: "3" }}>Value</span>
            <span style={{ width: "28px" }} />
          </div>
          <Index each={props.env()}>
            {(entry, i) => (
              <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                <input class="form-input" style={{ flex: "2", "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px" }} value={entry().key} onInput={(e) => props.update(i, "key", e.currentTarget.value)} placeholder="KEY" />
                <span style={{ color: "#484f58" }}>=</span>
                <input class="form-input" style={{ flex: "3", "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px" }} type={entry().key.toLowerCase().includes("password") || entry().key.toLowerCase().includes("secret") ? "password" : "text"} value={entry().value} onInput={(e) => props.update(i, "value", e.currentTarget.value)} placeholder="value" />
                <button class="action-icon" onClick={() => props.remove(i)} title="Remove" style={{ width: "28px", height: "28px", "flex-shrink": "0", color: "#f85149" }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
              </div>
            )}
          </Index>
        </div>
      </Show>
      <Show when={props.showWarning}>
        <span class="form-hint" style="color: #d29922; margin-top: 6px; display: block">
          {"\u26a0"} Contains default passwords — change before production use!
        </span>
      </Show>
    </div>
  );

  const VolumeEditor = (props: { volumes: () => VolumeEntry[]; update: typeof updateVolume; add: typeof addVolume; remove: typeof removeVolume }) => (
    <div class="form-group">
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "6px" }}>
        <label class="form-label" style={{ margin: 0 }}>Volumes</label>
        <button class="btn btn-sm" onClick={props.add} style={{ "font-size": "11px", padding: "2px 8px" }}>+ Add</button>
      </div>
      <Show when={props.volumes().length > 0} fallback={
        <div style={{ "font-size": "12px", color: "#484f58", padding: "8px 0" }}>No volumes configured</div>
      }>
        <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
          <div style={{ display: "flex", gap: "8px", "font-size": "11px", color: "#484f58", "padding-left": "2px" }}>
            <span style={{ flex: "1" }}>Host Path / Volume</span>
            <span style={{ flex: "1" }}>Container Path</span>
            <span style={{ width: "28px" }} />
          </div>
          <Index each={props.volumes()}>
            {(vol, i) => (
              <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                <input class="form-input" style={{ flex: "1", "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px" }} value={vol().source} onInput={(e) => props.update(i, "source", e.currentTarget.value)} placeholder="volume-name" />
                <span style={{ color: "#484f58" }}>:</span>
                <input class="form-input" style={{ flex: "1", "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px" }} value={vol().target} onInput={(e) => props.update(i, "target", e.currentTarget.value)} placeholder="/data" />
                <button class="action-icon" onClick={() => props.remove(i)} title="Remove" style={{ width: "28px", height: "28px", "flex-shrink": "0", color: "#f85149" }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
              </div>
            )}
          </Index>
        </div>
      </Show>
    </div>
  );

  const categoryColors: Record<string, { bg: string; color: string; border: string }> = {
    "Database": { bg: "rgba(88, 166, 255, 0.1)", color: "#58a6ff", border: "rgba(88, 166, 255, 0.15)" },
    "Web Server": { bg: "rgba(63, 185, 80, 0.1)", color: "#3fb950", border: "rgba(63, 185, 80, 0.15)" },
    "Monitoring": { bg: "rgba(210, 169, 34, 0.1)", color: "#d29922", border: "rgba(210, 169, 34, 0.15)" },
    "Storage": { bg: "rgba(163, 113, 247, 0.1)", color: "#a371f7", border: "rgba(163, 113, 247, 0.15)" },
    "Tools": { bg: "rgba(139, 148, 158, 0.1)", color: "#8b949e", border: "rgba(139, 148, 158, 0.15)" },
    "Development": { bg: "rgba(248, 81, 73, 0.1)", color: "#f85149", border: "rgba(248, 81, 73, 0.15)" },
    "Message Queue": { bg: "rgba(210, 169, 34, 0.1)", color: "#d29922", border: "rgba(210, 169, 34, 0.15)" },
    "Search": { bg: "rgba(121, 192, 255, 0.1)", color: "#79c0ff", border: "rgba(121, 192, 255, 0.15)" },
    "AI": { bg: "rgba(163, 113, 247, 0.1)", color: "#a371f7", border: "rgba(163, 113, 247, 0.15)" },
  };

  const TemplateCard = (props: { template: AppTemplate }) => {
    const colors = () => categoryColors[props.template.category] || categoryColors["Tools"];
    return (
    <div class="template-card" onClick={() => openDeploy(props.template)} style={{ position: "relative" }}>
      <div class="template-icon" style={{ background: colors().bg, color: colors().color, "border-color": colors().border }} innerHTML={props.template.icon} />
      <div class="template-name">{props.template.name}</div>
      <div class="template-desc">{props.template.description}</div>
      <Show when={!props.template.is_builtin}>
        <div style={{ position: "absolute", top: "8px", right: "8px", display: "flex", gap: "4px" }}>
          <button class="action-icon" title="Edit" onClick={(e) => { e.stopPropagation(); openEditTemplate(props.template); }} style={{ "font-size": "12px", width: "24px", height: "24px" }}>{"\u270E"}</button>
          <button class="action-icon" title="Delete" onClick={(e) => { e.stopPropagation(); deleteTemplate(props.template); }} style={{ width: "24px", height: "24px", color: "#f85149" }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
        </div>
      </Show>
    </div>
    );
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">App Catalog</h1>
        <Show when={activeTab() === "curated"}>
          <div class="page-actions">
            <input
              class="search-input"
              type="text"
              placeholder="Search templates..."
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
            <button class="btn btn-primary" onClick={openCreateTemplate}>Create Template</button>
          </div>
        </Show>
      </div>

      {/* Source pills */}
      <div class="filter-pills" style={{ "margin-bottom": "20px" }}>
        <button
          class={`filter-pill ${activeTab() === "curated" ? "active" : ""}`}
          onClick={() => setActiveTab("curated")}
        >
          Curated
        </button>
        <button
          class={`filter-pill ${activeTab() === "dockerhub" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("dockerhub");
            if (!hubSearched()) searchDockerHub("");
          }}
        >
          Docker Hub
        </button>
      </div>

      {/* Curated tab content */}
      <Show when={activeTab() === "curated"}>
        {/* Category filter tabs */}
        <div class="tab-bar" style="margin-bottom: 24px">
          <For each={CATEGORIES}>
            {(cat) => (
              <button
                class={`tab-item ${category() === cat ? "active" : ""}`}
                onClick={() => setCategory(cat)}
              >
                {cat}
              </button>
            )}
          </For>
        </div>

        {/* Template grid */}
        <Show when={category() === "All"} fallback={
          <div class="template-grid">
            <For each={filtered()}>
              {(template) => <TemplateCard template={template} />}
            </For>
          </div>
        }>
          <For each={Object.entries(groupedByCategory())}>
            {([cat, items], i) => (
              <div style={i() > 0 ? { "margin-top": "48px" } : {}}>
                <div class="template-category-header">{cat}</div>
                <div class="template-grid">
                  <For each={items}>
                    {(template) => <TemplateCard template={template} />}
                  </For>
                </div>
              </div>
            )}
          </For>
        </Show>
      </Show>

      {/* Docker Hub tab content */}
      <Show when={activeTab() === "dockerhub"}>
        <div style={{ display: "flex", gap: "8px", "margin-bottom": "20px" }}>
          <input
            class="search-input"
            type="text"
            placeholder="Search Docker Hub..."
            value={hubQuery()}
            onInput={(e) => setHubQuery(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") searchDockerHub(); }}
            style={{ flex: "1" }}
          />
          <button class="btn btn-primary" onClick={() => searchDockerHub()} disabled={hubLoading()}>
            {hubLoading() ? "Searching..." : "Search"}
          </button>
        </div>

        <Show when={hubLoading() && hubResults().length === 0}>
          <div style={{ "text-align": "center", padding: "48px 0", color: "#8b949e" }}>
            <Spinner size={24} />
            <div style={{ "margin-top": "12px" }}>Searching Docker Hub...</div>
          </div>
        </Show>

        <Show when={!hubLoading() && hubSearched() && hubResults().length === 0}>
          <div style={{ "text-align": "center", padding: "48px 0", color: "#8b949e" }}>
            No results found
          </div>
        </Show>

        <div class="template-grid">
          <For each={hubResults()}>
            {(result) => {
              const hubUrl = result.official
                ? `https://hub.docker.com/_/${result.name}`
                : `https://hub.docker.com/r/${result.name}`;
              const isPulling = () => hubPulling().has(result.name);
              return (
                <div class="template-card" style={{ display: "flex", "flex-direction": "column", position: "relative" }}>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "6px" }}>
                    <div style={{ "font-weight": "600", color: "#e6edf3", "font-size": "14px", flex: "1", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                      {result.name}
                    </div>
                    <Show when={result.official}>
                      <span style={{ background: "#1f6feb", color: "#fff", "font-size": "10px", padding: "1px 6px", "border-radius": "4px", "flex-shrink": "0", "font-weight": "600" }}>Official</span>
                    </Show>
                  </div>
                  <div style={{ "font-size": "12px", color: "#8b949e", "margin-bottom": "10px", flex: "1", overflow: "hidden", display: "-webkit-box", "-webkit-line-clamp": "3", "-webkit-box-orient": "vertical" }}>
                    {result.description || "No description"}
                  </div>
                  <div style={{ display: "flex", "align-items": "center", gap: "12px", "font-size": "11px", color: "#8b949e", "margin-bottom": "10px" }}>
                    <span title="Stars" style={{ display: "flex", "align-items": "center", gap: "3px" }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                      {result.stars.toLocaleString()}
                    </span>
                    <Show when={result.pulls}>
                      <span title="Pulls" style={{ display: "flex", "align-items": "center", gap: "3px" }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        {formatPulls(result.pulls)}
                      </span>
                    </Show>
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      class="btn btn-primary btn-sm"
                      style={{ flex: "1" }}
                      disabled={isPulling()}
                      onClick={() => pullHubImage(result.name)}
                    >
                      {isPulling() ? <><Spinner size={12} />{" "}Pulling...</> : "Pull"}
                    </button>
                    <a
                      href={hubUrl}
                      target="_blank"
                      class="btn btn-sm"
                      style={{ "text-decoration": "none", "text-align": "center" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      Hub {"\u2197"}
                    </a>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      {/* Deploy Dialog */}
      <Show when={deployTarget()}>
        {(template) => (
          <div class="modal-overlay" onMouseDown={handleOverlayMouseDown} onClick={handleOverlayClick}>
            <div class="modal-dialog" style={{ "max-width": "620px" }}>
              <div class="modal-header">
                <span class="modal-title">Deploy {template().name}</span>
                <button class="modal-close" onClick={() => closeDeploy()}>{"\u00d7"}</button>
              </div>
              <div class="modal-body">
                <Show when={hostOptions().length > 1}>
                  <div class="form-group">
                    <label class="form-label">Target Host</label>
                    <Dropdown
                      value={deployHostId() || "__local__"}
                      options={hostOptions()}
                      onChange={(v) => setDeployHostId(v)}
                    />
                  </div>
                </Show>
                <div class="form-group">
                  <label class="form-label">Container Name</label>
                  <input
                    class="form-input"
                    value={deployName()}
                    onInput={(e) => {
                      const name = e.currentTarget.value;
                      setDeployName(name);
                      setNameConflict(existingNames().has(name));
                    }}
                    placeholder="Container name"
                    style={{ "border-color": nameConflict() ? "#f85149" : undefined }}
                  />
                  <Show when={nameConflict()}>
                    <span class="form-hint" style={{ color: "#f85149" }}>
                      A container named "{deployName()}" already exists
                    </span>
                  </Show>
                </div>
                <div class="form-group">
                  <label class="form-label">
                    Image
                    <Show when={imageRegistryLink(template().image)}>
                      {(link) => (
                        <a href={link().url} target="_blank" style={{ "font-size": "11px", "margin-left": "8px", color: "#58a6ff", "font-weight": "400" }}>
                          {link().label} {"\u2197"}
                        </a>
                      )}
                    </Show>
                  </label>
                  <input class="form-input" value={template().image} disabled style="opacity: 0.7" />
                </div>
                <PortEditor ports={deployPorts} update={updatePort} add={addPort} remove={removePort} />
                <EnvEditor env={deployEnv} update={updateEnv} add={addEnv} remove={removeEnv} showWarning={hasPasswordEnv()} />
                <VolumeEditor volumes={deployVolumes} update={updateVolume} add={addVolume} remove={removeVolume} />
                <Show when={template().notes}>
                  <div class="form-group">
                    <label class="form-label">Notes</label>
                    <div style="font-size: 12px; color: #8b949e; background: #0d1117; padding: 10px; border-radius: 6px; border: 1px solid #21262d">
                      {template().notes}
                    </div>
                  </div>
                </Show>
              </div>
              <div class="modal-footer">
                <Show when={deploying() && deployStatus()}>
                  <span style={{ "font-size": "12px", color: "#8b949e", "margin-right": "auto" }}>
                    <Spinner size={12} />{" "}{deployStatus()}
                  </span>
                </Show>
                <button class="btn" onClick={() => closeDeploy()} disabled={deploying()}>Cancel</button>
                <button class="btn btn-primary" onClick={() => doDeploy()} disabled={deploying()}>
                  {deploying() ? "Deploying..." : "Deploy"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      {/* Template Editor Dialog (Create / Edit) */}
      <Show when={editorOpen()}>
        <div class="modal-overlay" onMouseDown={handleOverlayMouseDown} onClick={handleEditorOverlayClick}>
          <div class="modal-dialog" style={{ "max-width": "620px" }}>
            <div class="modal-header">
              <span class="modal-title">{editorIsNew() ? "Create Template" : `Edit ${editorName()}`}</span>
              <button class="modal-close" onClick={() => setEditorOpen(false)}>{"\u00d7"}</button>
            </div>
            <div class="modal-body">
              <div style={{ display: "flex", gap: "12px" }}>
                <div class="form-group" style={{ width: "60px", "flex-shrink": "0" }}>
                  <label class="form-label">Icon</label>
                  <input class="form-input" value={editorIcon()} onInput={(e) => setEditorIcon(e.currentTarget.value)} style={{ "text-align": "center", "font-size": "20px", padding: "4px" }} />
                </div>
                <div class="form-group" style={{ flex: "1" }}>
                  <label class="form-label">Name <span style={{ color: "#f85149" }}>*</span></label>
                  <input class="form-input" value={editorName()} onInput={(e) => setEditorName(e.currentTarget.value)} placeholder="My Template" />
                </div>
                <div class="form-group" style={{ width: "150px", "flex-shrink": "0" }}>
                  <label class="form-label">Category</label>
                  <Dropdown
                    value={editorCategory()}
                    options={CATEGORIES.filter((c) => c !== "All").map((cat) => ({ value: cat, label: cat }))}
                    onChange={(v) => setEditorCategory(v)}
                  />
                </div>
              </div>

              <div class="form-group">
                <label class="form-label">Description</label>
                <input class="form-input" value={editorDesc()} onInput={(e) => setEditorDesc(e.currentTarget.value)} placeholder="Short description" />
              </div>

              <div class="form-group">
                <label class="form-label">Docker Image <span style={{ color: "#f85149" }}>*</span></label>
                <input class="form-input" value={editorImage()} onInput={(e) => setEditorImage(e.currentTarget.value)} placeholder="nginx:alpine" style={{ "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px" }} />
              </div>

              <PortEditor ports={editorPorts} update={updateEditorPort} add={addEditorPort} remove={removeEditorPort} />
              <EnvEditor env={editorEnv} update={updateEditorEnv} add={addEditorEnv} remove={removeEditorEnv} />
              <VolumeEditor volumes={editorVolumes} update={updateEditorVolume} add={addEditorVolume} remove={removeEditorVolume} />

              <div class="form-group">
                <label class="form-label">Notes</label>
                <textarea class="form-textarea" value={editorNotes()} onInput={(e) => setEditorNotes(e.currentTarget.value)} placeholder="Connection info, setup tips..." rows={2} />
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setEditorOpen(false)}>Cancel</button>
              <button class="btn btn-primary" onClick={saveTemplate} disabled={editorSaving()}>
                {editorSaving() ? "Saving..." : editorIsNew() ? "Create" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
