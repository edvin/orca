import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { AppTemplate } from "../lib/types";
import { showToast } from "../components/Toast";

const CATEGORIES = ["All", "Database", "Web Server", "Monitoring", "Storage", "Tools"];

export default function TemplatesPage() {
  const [templates, setTemplates] = createSignal<AppTemplate[]>([]);
  const [category, setCategory] = createSignal("All");
  const [deploying, setDeploying] = createSignal(false);
  const [deployTarget, setDeployTarget] = createSignal<AppTemplate | null>(null);

  // Deploy dialog state
  const [deployName, setDeployName] = createSignal("");
  const [deployPorts, setDeployPorts] = createSignal("");
  const [deployEnv, setDeployEnv] = createSignal("");
  const [deployVolumes, setDeployVolumes] = createSignal("");

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

  const openDeploy = (template: AppTemplate) => {
    setDeployTarget(template);
    setDeployName(`orca-${template.id}`);
    setDeployPorts(template.default_ports.join("\n"));
    setDeployEnv(template.default_env.join("\n"));
    setDeployVolumes(template.default_volumes.join("\n"));
  };

  const closeDeploy = () => {
    setDeployTarget(null);
  };

  const doDeploy = async () => {
    const template = deployTarget();
    if (!template) return;

    setDeploying(true);
    try {
      const ports = deployPorts()
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const env = deployEnv()
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const volumes = deployVolumes()
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

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

  const hasPasswordEnv = (envLine: string) => {
    const lower = envLine.toLowerCase();
    return lower.includes("password") || lower.includes("secret");
  };

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
          <div class="modal-overlay" onClick={() => closeDeploy()}>
            <div class="modal-dialog" onClick={(e) => e.stopPropagation()}>
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

                <div class="form-group">
                  <label class="form-label">Port Mappings</label>
                  <textarea
                    class="form-textarea"
                    value={deployPorts()}
                    onInput={(e) => setDeployPorts(e.currentTarget.value)}
                    placeholder="host:container (one per line)"
                    rows={3}
                  />
                  <span class="form-hint">Format: host_port:container_port, one per line</span>
                </div>

                <div class="form-group">
                  <label class="form-label">Environment Variables</label>
                  <textarea
                    class="form-textarea"
                    value={deployEnv()}
                    onInput={(e) => setDeployEnv(e.currentTarget.value)}
                    placeholder="KEY=value (one per line)"
                    rows={4}
                  />
                  <Show when={deployEnv().split("\n").some(hasPasswordEnv)}>
                    <span class="form-hint" style="color: #d29922">
                      {"\u26a0"} Contains default passwords -- change before production use!
                    </span>
                  </Show>
                </div>

                <div class="form-group">
                  <label class="form-label">Volumes</label>
                  <textarea
                    class="form-textarea"
                    value={deployVolumes()}
                    onInput={(e) => setDeployVolumes(e.currentTarget.value)}
                    placeholder="source:target (one per line)"
                    rows={3}
                  />
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
