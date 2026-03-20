import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { AppTemplate } from "../lib/types";
import { showToast } from "../components/Toast";

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
  const [deployTarget, setDeployTarget] = createSignal<AppTemplate | null>(null);

  // Deploy dialog state
  const [deployName, setDeployName] = createSignal("");
  const [deployPorts, setDeployPorts] = createSignal<PortEntry[]>([]);
  const [deployEnv, setDeployEnv] = createSignal<EnvEntry[]>([]);
  const [deployVolumes, setDeployVolumes] = createSignal<VolumeEntry[]>([]);

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

  let mouseDownOnOverlay = false;

  const refreshTemplates = async () => {
    try {
      const result = (await invoke("list_templates")) as AppTemplate[];
      setTemplates(result);
    } catch {
      showToast("Failed to load templates", "error");
    }
  };

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
  const openDeploy = (template: AppTemplate) => {
    setDeployTarget(template);
    setDeployName(`orca-${template.id}`);
    setDeployPorts(template.default_ports.map(parsePort));
    setDeployEnv(template.default_env.map(parseEnv));
    setDeployVolumes(template.default_volumes.map(parseVolume));
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
  const updateEnv = (index: number, field: "key" | "value", val: string) => {
    setDeployEnv((prev) => prev.map((e, i) => i === index ? { ...e, [field]: val } : e));
  };
  const addEnv = () => setDeployEnv((prev) => [...prev, { key: "", value: "" }]);
  const removeEnv = (index: number) => setDeployEnv((prev) => prev.filter((_, i) => i !== index));

  const updateVolume = (index: number, field: "source" | "target", val: string) => {
    setDeployVolumes((prev) => prev.map((v, i) => i === index ? { ...v, [field]: val } : v));
  };
  const addVolume = () => setDeployVolumes((prev) => [...prev, { source: "", target: "" }]);
  const removeVolume = (index: number) => setDeployVolumes((prev) => prev.filter((_, i) => i !== index));

  const updatePort = (index: number, field: "host" | "container", val: string) => {
    setDeployPorts((prev) => prev.map((p, i) => i === index ? { ...p, [field]: val } : p));
  };
  const addPort = () => setDeployPorts((prev) => [...prev, { host: "", container: "" }]);
  const removePort = (index: number) => setDeployPorts((prev) => prev.filter((_, i) => i !== index));

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
    try {
      const ports = deployPorts().filter((p) => p.host || p.container).map((p) => `${p.host}:${p.container}`);
      const env = deployEnv().filter((e) => e.key).map((e) => `${e.key}=${e.value}`);
      const volumes = deployVolumes().filter((v) => v.source || v.target).map((v) => `${v.source}:${v.target}`);

      const result = (await invoke("deploy_template", {
        id: template.id,
        name: deployName() || null,
        ports: ports.length > 0 ? ports : null,
        env: env.length > 0 ? env : null,
        volumes: volumes.length > 0 ? volumes : null,
      })) as any;

      closeDeploy();
      const containerId = result?.id;
      const notes = result?.notes || template.notes;
      showToast(`${template.name} deployed successfully! ${notes}`, "success");
      // Navigate to the container detail page
      if (containerId && props.onNavigate) {
        props.onNavigate(`container:${containerId}`);
      }
    } catch (e: any) {
      showToast(`Deploy failed: ${e}`, "error");
    } finally {
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
          <For each={props.ports()}>
            {(port, i) => (
              <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                <input class="form-input" style={{ flex: "1" }} value={port.host} onInput={(e) => props.update(i(), "host", e.currentTarget.value)} placeholder="8080" />
                <span style={{ color: "#484f58" }}>:</span>
                <input class="form-input" style={{ flex: "1" }} value={port.container} onInput={(e) => props.update(i(), "container", e.currentTarget.value)} placeholder="80" />
                <button class="action-icon" onClick={() => props.remove(i())} title="Remove" style={{ "font-size": "14px", width: "28px", height: "28px", "flex-shrink": "0" }}>{"\u2715"}</button>
              </div>
            )}
          </For>
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
          <For each={props.env()}>
            {(entry, i) => (
              <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                <input class="form-input" style={{ flex: "2", "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px" }} value={entry.key} onInput={(e) => props.update(i(), "key", e.currentTarget.value)} placeholder="KEY" />
                <span style={{ color: "#484f58" }}>=</span>
                <input class="form-input" style={{ flex: "3", "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px" }} type={entry.key.toLowerCase().includes("password") || entry.key.toLowerCase().includes("secret") ? "password" : "text"} value={entry.value} onInput={(e) => props.update(i(), "value", e.currentTarget.value)} placeholder="value" />
                <button class="action-icon" onClick={() => props.remove(i())} title="Remove" style={{ "font-size": "14px", width: "28px", height: "28px", "flex-shrink": "0" }}>{"\u2715"}</button>
              </div>
            )}
          </For>
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
          <For each={props.volumes()}>
            {(vol, i) => (
              <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                <input class="form-input" style={{ flex: "1", "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px" }} value={vol.source} onInput={(e) => props.update(i(), "source", e.currentTarget.value)} placeholder="volume-name" />
                <span style={{ color: "#484f58" }}>:</span>
                <input class="form-input" style={{ flex: "1", "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px" }} value={vol.target} onInput={(e) => props.update(i(), "target", e.currentTarget.value)} placeholder="/data" />
                <button class="action-icon" onClick={() => props.remove(i())} title="Remove" style={{ "font-size": "14px", width: "28px", height: "28px", "flex-shrink": "0" }}>{"\u2715"}</button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );

  const TemplateCard = (props: { template: AppTemplate }) => (
    <div class="template-card" onClick={() => openDeploy(props.template)} style={{ position: "relative" }}>
      <div class="template-icon">{props.template.icon}</div>
      <div class="template-name">{props.template.name}</div>
      <div class="template-desc">{props.template.description}</div>
      <Show when={!props.template.is_builtin}>
        <div style={{ position: "absolute", top: "8px", right: "8px", display: "flex", gap: "4px" }}>
          <button class="action-icon" title="Edit" onClick={(e) => { e.stopPropagation(); openEditTemplate(props.template); }} style={{ "font-size": "12px", width: "24px", height: "24px" }}>{"\u270E"}</button>
          <button class="action-icon" title="Delete" onClick={(e) => { e.stopPropagation(); deleteTemplate(props.template); }} style={{ "font-size": "12px", width: "24px", height: "24px", color: "#f85149" }}>{"\u2715"}</button>
        </div>
      </Show>
    </div>
  );

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">App Templates</h1>
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
      </div>

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
          {([cat, items]) => (
            <div>
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

      {/* Deploy Dialog */}
      <Show when={deployTarget()}>
        {(template) => (
          <div class="modal-overlay" onMouseDown={handleOverlayMouseDown} onClick={handleOverlayClick}>
            <div class="modal-dialog" style={{ "max-width": "620px" }}>
              <div class="modal-header">
                <span class="modal-title">{template().icon} Deploy {template().name}</span>
                <button class="modal-close" onClick={() => closeDeploy()}>{"\u00d7"}</button>
              </div>
              <div class="modal-body">
                <div class="form-group">
                  <label class="form-label">Container Name</label>
                  <input class="form-input" value={deployName()} onInput={(e) => setDeployName(e.currentTarget.value)} placeholder="Container name" />
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
                <button class="btn" onClick={() => closeDeploy()}>Cancel</button>
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
                  <select class="form-input" value={editorCategory()} onChange={(e) => setEditorCategory(e.currentTarget.value)}>
                    <For each={CATEGORIES.filter((c) => c !== "All")}>
                      {(cat) => <option value={cat}>{cat}</option>}
                    </For>
                  </select>
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
