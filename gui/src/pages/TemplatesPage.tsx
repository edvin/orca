import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { AppTemplate } from "../lib/types";
import { showToast } from "../components/Toast";

const CATEGORIES = ["All", "Database", "Web Server", "Monitoring", "Storage", "Tools"];

interface EnvEntry { key: string; value: string }
interface VolumeEntry { source: string; target: string }
interface PortEntry { host: string; container: string }

export default function TemplatesPage() {
  const [templates, setTemplates] = createSignal<AppTemplate[]>([]);
  const [category, setCategory] = createSignal("All");
  const [deploying, setDeploying] = createSignal(false);
  const [deployTarget, setDeployTarget] = createSignal<AppTemplate | null>(null);

  // Deploy dialog state
  const [deployName, setDeployName] = createSignal("");
  const [deployPorts, setDeployPorts] = createSignal<PortEntry[]>([]);
  const [deployEnv, setDeployEnv] = createSignal<EnvEntry[]>([]);
  const [deployVolumes, setDeployVolumes] = createSignal<VolumeEntry[]>([]);

  // Track mousedown origin to prevent drag-to-close
  let mouseDownOnOverlay = false;

  onMount(async () => {
    try {
      const result = (await invoke("list_templates")) as AppTemplate[];
      setTemplates(result);
    } catch {
      showToast("Failed to load templates", "error");
    }
  });

  const filtered = () => {
    const cat = category();
    if (cat === "All") return templates();
    return templates().filter((t) => t.category === cat);
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

  const openDeploy = (template: AppTemplate) => {
    setDeployTarget(template);
    setDeployName(`orca-${template.id}`);
    setDeployPorts(template.default_ports.map(parsePort));
    setDeployEnv(template.default_env.map(parseEnv));
    setDeployVolumes(template.default_volumes.map(parseVolume));
  };

  const closeDeploy = () => {
    setDeployTarget(null);
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

  // --- Env helpers ---
  const updateEnv = (index: number, field: "key" | "value", val: string) => {
    setDeployEnv((prev) => prev.map((e, i) => i === index ? { ...e, [field]: val } : e));
  };
  const addEnv = () => setDeployEnv((prev) => [...prev, { key: "", value: "" }]);
  const removeEnv = (index: number) => setDeployEnv((prev) => prev.filter((_, i) => i !== index));

  // --- Volume helpers ---
  const updateVolume = (index: number, field: "source" | "target", val: string) => {
    setDeployVolumes((prev) => prev.map((v, i) => i === index ? { ...v, [field]: val } : v));
  };
  const addVolume = () => setDeployVolumes((prev) => [...prev, { source: "", target: "" }]);
  const removeVolume = (index: number) => setDeployVolumes((prev) => prev.filter((_, i) => i !== index));

  // --- Port helpers ---
  const updatePort = (index: number, field: "host" | "container", val: string) => {
    setDeployPorts((prev) => prev.map((p, i) => i === index ? { ...p, [field]: val } : p));
  };
  const addPort = () => setDeployPorts((prev) => [...prev, { host: "", container: "" }]);
  const removePort = (index: number) => setDeployPorts((prev) => prev.filter((_, i) => i !== index));

  const doDeploy = async () => {
    const template = deployTarget();
    if (!template) return;

    setDeploying(true);
    try {
      const ports = deployPorts()
        .filter((p) => p.host || p.container)
        .map((p) => `${p.host}:${p.container}`);
      const env = deployEnv()
        .filter((e) => e.key)
        .map((e) => `${e.key}=${e.value}`);
      const volumes = deployVolumes()
        .filter((v) => v.source || v.target)
        .map((v) => `${v.source}:${v.target}`);

      const result = (await invoke("deploy_template", {
        id: template.id,
        name: deployName() || null,
        ports: ports.length > 0 ? ports : null,
        env: env.length > 0 ? env : null,
        volumes: volumes.length > 0 ? volumes : null,
      })) as any;

      closeDeploy();
      const notes = result?.notes || template.notes;
      showToast(`${template.name} deployed successfully! ${notes}`, "success");
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

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">App Templates</h1>
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

      {/* Template grid grouped by category */}
      <Show when={category() === "All"} fallback={
        <div class="template-grid">
          <For each={filtered()}>
            {(template) => (
              <div class="template-card" onClick={() => openDeploy(template)}>
                <div class="template-icon">{template.icon}</div>
                <div class="template-name">{template.name}</div>
                <div class="template-desc">{template.description}</div>
                <button
                  class="btn btn-primary btn-sm template-deploy-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    openDeploy(template);
                  }}
                >
                  Deploy
                </button>
              </div>
            )}
          </For>
        </div>
      }>
        <For each={Object.entries(groupedByCategory())}>
          {([cat, items]) => (
            <div>
              <div class="template-category-header">{cat}</div>
              <div class="template-grid">
                <For each={items}>
                  {(template) => (
                    <div class="template-card" onClick={() => openDeploy(template)}>
                      <div class="template-icon">{template.icon}</div>
                      <div class="template-name">{template.name}</div>
                      <div class="template-desc">{template.description}</div>
                      <button
                        class="btn btn-primary btn-sm template-deploy-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDeploy(template);
                        }}
                      >
                        Deploy
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </Show>

      {/* Deploy Dialog */}
      <Show when={deployTarget()}>
        {(template) => (
          <div
            class="modal-overlay"
            onMouseDown={handleOverlayMouseDown}
            onClick={handleOverlayClick}
          >
            <div class="modal-dialog" style={{ "max-width": "620px" }}>
              <div class="modal-header">
                <span class="modal-title">
                  {template().icon} Deploy {template().name}
                </span>
                <button class="modal-close" onClick={() => closeDeploy()}>
                  {"\u00d7"}
                </button>
              </div>
              <div class="modal-body">
                <div class="form-group">
                  <label class="form-label">Container Name</label>
                  <input
                    class="form-input"
                    value={deployName()}
                    onInput={(e) => setDeployName(e.currentTarget.value)}
                    placeholder="Container name"
                  />
                </div>

                <div class="form-group">
                  <label class="form-label">Image</label>
                  <input
                    class="form-input"
                    value={template().image}
                    disabled
                    style="opacity: 0.7"
                  />
                </div>

                {/* Port Mappings — structured editor */}
                <div class="form-group">
                  <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "6px" }}>
                    <label class="form-label" style={{ margin: 0 }}>Port Mappings</label>
                    <button class="btn btn-sm" onClick={addPort} style={{ "font-size": "11px", padding: "2px 8px" }}>+ Add</button>
                  </div>
                  <Show when={deployPorts().length > 0} fallback={
                    <div style={{ "font-size": "12px", color: "#484f58", padding: "8px 0" }}>No port mappings configured</div>
                  }>
                    <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                      <div style={{ display: "flex", gap: "8px", "font-size": "11px", color: "#484f58", "padding-left": "2px" }}>
                        <span style={{ flex: "1" }}>Host Port</span>
                        <span style={{ flex: "1" }}>Container Port</span>
                        <span style={{ width: "28px" }} />
                      </div>
                      <For each={deployPorts()}>
                        {(port, i) => (
                          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                            <input
                              class="form-input"
                              style={{ flex: "1" }}
                              value={port.host}
                              onInput={(e) => updatePort(i(), "host", e.currentTarget.value)}
                              placeholder="8080"
                            />
                            <span style={{ color: "#484f58" }}>:</span>
                            <input
                              class="form-input"
                              style={{ flex: "1" }}
                              value={port.container}
                              onInput={(e) => updatePort(i(), "container", e.currentTarget.value)}
                              placeholder="80"
                            />
                            <button
                              class="action-icon"
                              onClick={() => removePort(i())}
                              title="Remove"
                              style={{ "font-size": "14px", width: "28px", height: "28px", "flex-shrink": "0" }}
                            >
                              {"\u2715"}
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>

                {/* Environment Variables — key/value editor */}
                <div class="form-group">
                  <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "6px" }}>
                    <label class="form-label" style={{ margin: 0 }}>Environment Variables</label>
                    <button class="btn btn-sm" onClick={addEnv} style={{ "font-size": "11px", padding: "2px 8px" }}>+ Add</button>
                  </div>
                  <Show when={deployEnv().length > 0} fallback={
                    <div style={{ "font-size": "12px", color: "#484f58", padding: "8px 0" }}>No environment variables configured</div>
                  }>
                    <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                      <div style={{ display: "flex", gap: "8px", "font-size": "11px", color: "#484f58", "padding-left": "2px" }}>
                        <span style={{ flex: "2" }}>Variable</span>
                        <span style={{ flex: "3" }}>Value</span>
                        <span style={{ width: "28px" }} />
                      </div>
                      <For each={deployEnv()}>
                        {(entry, i) => (
                          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                            <input
                              class="form-input"
                              style={{ flex: "2", "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px" }}
                              value={entry.key}
                              onInput={(e) => updateEnv(i(), "key", e.currentTarget.value)}
                              placeholder="KEY"
                            />
                            <span style={{ color: "#484f58" }}>=</span>
                            <input
                              class="form-input"
                              style={{ flex: "3", "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px" }}
                              type={entry.key.toLowerCase().includes("password") || entry.key.toLowerCase().includes("secret") ? "password" : "text"}
                              value={entry.value}
                              onInput={(e) => updateEnv(i(), "value", e.currentTarget.value)}
                              placeholder="value"
                            />
                            <button
                              class="action-icon"
                              onClick={() => removeEnv(i())}
                              title="Remove"
                              style={{ "font-size": "14px", width: "28px", height: "28px", "flex-shrink": "0" }}
                            >
                              {"\u2715"}
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={hasPasswordEnv()}>
                    <span class="form-hint" style="color: #d29922; margin-top: 6px; display: block">
                      {"\u26a0"} Contains default passwords — change before production use!
                    </span>
                  </Show>
                </div>

                {/* Volumes — structured editor */}
                <div class="form-group">
                  <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "6px" }}>
                    <label class="form-label" style={{ margin: 0 }}>Volumes</label>
                    <button class="btn btn-sm" onClick={addVolume} style={{ "font-size": "11px", padding: "2px 8px" }}>+ Add</button>
                  </div>
                  <Show when={deployVolumes().length > 0} fallback={
                    <div style={{ "font-size": "12px", color: "#484f58", padding: "8px 0" }}>No volumes configured</div>
                  }>
                    <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                      <div style={{ display: "flex", gap: "8px", "font-size": "11px", color: "#484f58", "padding-left": "2px" }}>
                        <span style={{ flex: "1" }}>Host Path / Volume</span>
                        <span style={{ flex: "1" }}>Container Path</span>
                        <span style={{ width: "28px" }} />
                      </div>
                      <For each={deployVolumes()}>
                        {(vol, i) => (
                          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                            <input
                              class="form-input"
                              style={{ flex: "1", "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px" }}
                              value={vol.source}
                              onInput={(e) => updateVolume(i(), "source", e.currentTarget.value)}
                              placeholder="volume-name"
                            />
                            <span style={{ color: "#484f58" }}>:</span>
                            <input
                              class="form-input"
                              style={{ flex: "1", "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px" }}
                              value={vol.target}
                              onInput={(e) => updateVolume(i(), "target", e.currentTarget.value)}
                              placeholder="/data"
                            />
                            <button
                              class="action-icon"
                              onClick={() => removeVolume(i())}
                              title="Remove"
                              style={{ "font-size": "14px", width: "28px", height: "28px", "flex-shrink": "0" }}
                            >
                              {"\u2715"}
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>

                <Show when={template().notes}>
                  <div class="form-group">
                    <label class="form-label">Notes</label>
                    <div
                      style="font-size: 12px; color: #8b949e; background: #0d1117; padding: 10px; border-radius: 6px; border: 1px solid #21262d"
                    >
                      {template().notes}
                    </div>
                  </div>
                </Show>
              </div>
              <div class="modal-footer">
                <button class="btn" onClick={() => closeDeploy()}>
                  Cancel
                </button>
                <button
                  class="btn btn-primary"
                  onClick={() => doDeploy()}
                  disabled={deploying()}
                >
                  {deploying() ? "Deploying..." : "Deploy"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
