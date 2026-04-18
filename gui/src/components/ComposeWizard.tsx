import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./Toast";
import Dropdown from "./Dropdown";
import Spinner from "./Spinner";
import YamlEditor from "./YamlEditor";

interface PortMapping {
  host: string;
  container: string;
}

interface EnvVar {
  key: string;
  value: string;
}

interface VolumeMapping {
  source: string;
  target: string;
}

interface ServiceDef {
  id: string;
  name: string;
  image: string;
  ports: PortMapping[];
  env: EnvVar[];
  volumes: VolumeMapping[];
  dependsOn: string[];
  restart: string;
}

interface ComposeWizardProps {
  onClose: () => void;
  onDeployed?: () => void;
}

/**
 * Quote a scalar value for safe emission into YAML. Values that contain any
 * of the characters that YAML interprets specially (`:`, `#`, `-`, `!`,
 * `&`, `*`, `{`, `}`, `[`, `]`, `"`, `'`, newlines, leading/trailing
 * whitespace) are wrapped in double quotes with `\`, `"`, and control
 * characters escaped. Otherwise the value is emitted bare.
 */
function yamlQuote(value: string): string {
  if (value === "") return '""';
  const needsQuoting =
    /^(~|null|true|false|on|off|yes|no)$/i.test(value.trim()) ||
    /^[\s-]/.test(value) ||
    /[:#&*!|<>%@`\\'"\r\n\t]/.test(value) ||
    /^[-+]?\d/.test(value);
  if (!needsQuoting) return value;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function createEmptyService(): ServiceDef {
  return {
    id: crypto.randomUUID(),
    name: "",
    image: "",
    ports: [],
    env: [],
    volumes: [],
    dependsOn: [],
    restart: "unless-stopped",
  };
}

function generateYaml(_stackName: string, services: ServiceDef[]): string {
  const lines: string[] = [];
  const namedVolumes = new Set<string>();

  lines.push("services:");

  for (const svc of services) {
    if (!svc.name || !svc.image) continue;
    lines.push(`  ${svc.name}:`);
    lines.push(`    image: ${svc.image}`);

    if (svc.ports.length > 0) {
      const validPorts = svc.ports.filter((p) => p.host && p.container);
      if (validPorts.length > 0) {
        lines.push("    ports:");
        for (const p of validPorts) {
          lines.push(`      - "${p.host}:${p.container}"`);
        }
      }
    }

    if (svc.env.length > 0) {
      const validEnv = svc.env.filter((e) => e.key);
      if (validEnv.length > 0) {
        lines.push("    environment:");
        for (const e of validEnv) {
          lines.push(`      ${e.key}: ${yamlQuote(e.value)}`);
        }
      }
    }

    if (svc.volumes.length > 0) {
      const validVols = svc.volumes.filter((v) => v.source && v.target);
      if (validVols.length > 0) {
        lines.push("    volumes:");
        for (const v of validVols) {
          lines.push(`      - ${v.source}:${v.target}`);
          // Track named volumes (not paths)
          if (!v.source.startsWith("/") && !v.source.startsWith("./") && !v.source.startsWith("~")) {
            namedVolumes.add(v.source);
          }
        }
      }
    }

    if (svc.restart && svc.restart !== "no") {
      lines.push(`    restart: ${svc.restart}`);
    }

    if (svc.dependsOn.length > 0) {
      lines.push("    depends_on:");
      for (const dep of svc.dependsOn) {
        lines.push(`      - ${dep}`);
      }
    }
  }

  if (namedVolumes.size > 0) {
    lines.push("");
    lines.push("volumes:");
    for (const vol of namedVolumes) {
      lines.push(`  ${vol}:`);
    }
  }

  return lines.join("\n") + "\n";
}

export default function ComposeWizard(props: ComposeWizardProps) {
  const [step, setStep] = createSignal(1);
  const [stackName, setStackName] = createSignal("");
  const [services, setServices] = createSignal<ServiceDef[]>([createEmptyService()]);
  const [editingServiceId, setEditingServiceId] = createSignal<string | null>(null);
  const [generatedYaml, setGeneratedYaml] = createSignal("");
  const [deploying, setDeploying] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");

  // Image search
  const [imageResults, setImageResults] = createSignal<string[]>([]);
  const [activeImageField, setActiveImageField] = createSignal<string | null>(null);
  let searchTimeout: ReturnType<typeof setTimeout> | undefined;

  const searchImages = async (query: string) => {
    if (!query || query.length < 2) {
      setImageResults([]);
      return;
    }
    try {
      const results = (await invoke("search_images", { query, limit: 10 })) as Array<{ name: string }>;
      setImageResults(results.map((r) => r.name));
    } catch {
      setImageResults([]);
    }
  };

  const handleImageInput = (serviceId: string, value: string) => {
    updateService(serviceId, "image", value);
    setActiveImageField(serviceId);
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => searchImages(value), 300);
  };

  const selectImage = (serviceId: string, image: string) => {
    updateService(serviceId, "image", image);
    setActiveImageField(null);
    setImageResults([]);
  };

  const updateService = (id: string, field: keyof ServiceDef, value: unknown) => {
    setServices((prev) =>
      prev.map((s) => (s.id === id ? { ...s, [field]: value } : s))
    );
  };

  const addService = () => {
    // Generate the new service BEFORE enqueuing the update so we can read
    // its id synchronously — `services()` after `setServices(...)` may not
    // reflect the update yet due to Solid's batching.
    const newSvc = createEmptyService();
    setServices((prev) => [...prev, newSvc]);
    setEditingServiceId(newSvc.id);
  };

  const removeService = (id: string) => {
    const svc = services().find((s) => s.id === id);
    if (!svc) return;
    setServices((prev) => {
      const filtered = prev.filter((s) => s.id !== id);
      // Remove from dependsOn of other services
      return filtered.map((s) => ({
        ...s,
        dependsOn: s.dependsOn.filter((d) => d !== svc.name),
      }));
    });
    if (editingServiceId() === id) setEditingServiceId(null);
  };

  const addPort = (serviceId: string) => {
    updateService(serviceId, "ports", [
      ...services().find((s) => s.id === serviceId)!.ports,
      { host: "", container: "" },
    ]);
  };

  const removePort = (serviceId: string, index: number) => {
    const svc = services().find((s) => s.id === serviceId)!;
    updateService(serviceId, "ports", svc.ports.filter((_, i) => i !== index));
  };

  const updatePort = (serviceId: string, index: number, field: "host" | "container", value: string) => {
    const svc = services().find((s) => s.id === serviceId)!;
    const newPorts = [...svc.ports];
    newPorts[index] = { ...newPorts[index], [field]: value };
    updateService(serviceId, "ports", newPorts);
  };

  const addEnv = (serviceId: string) => {
    updateService(serviceId, "env", [
      ...services().find((s) => s.id === serviceId)!.env,
      { key: "", value: "" },
    ]);
  };

  const removeEnv = (serviceId: string, index: number) => {
    const svc = services().find((s) => s.id === serviceId)!;
    updateService(serviceId, "env", svc.env.filter((_, i) => i !== index));
  };

  const updateEnv = (serviceId: string, index: number, field: "key" | "value", value: string) => {
    const svc = services().find((s) => s.id === serviceId)!;
    const newEnv = [...svc.env];
    newEnv[index] = { ...newEnv[index], [field]: value };
    updateService(serviceId, "env", newEnv);
  };

  const addVolume = (serviceId: string) => {
    updateService(serviceId, "volumes", [
      ...services().find((s) => s.id === serviceId)!.volumes,
      { source: "", target: "" },
    ]);
  };

  const removeVolume = (serviceId: string, index: number) => {
    const svc = services().find((s) => s.id === serviceId)!;
    updateService(serviceId, "volumes", svc.volumes.filter((_, i) => i !== index));
  };

  const updateVolume = (serviceId: string, index: number, field: "source" | "target", value: string) => {
    const svc = services().find((s) => s.id === serviceId)!;
    const newVols = [...svc.volumes];
    newVols[index] = { ...newVols[index], [field]: value };
    updateService(serviceId, "volumes", newVols);
  };

  const toggleDependsOn = (serviceId: string, depName: string) => {
    const svc = services().find((s) => s.id === serviceId)!;
    const deps = svc.dependsOn.includes(depName)
      ? svc.dependsOn.filter((d) => d !== depName)
      : [...svc.dependsOn, depName];
    updateService(serviceId, "dependsOn", deps);
  };

  const validServices = () => services().filter((s) => s.name.trim() && s.image.trim());

  const canProceedStep1 = () => stackName().trim().length > 0;
  const canProceedStep2 = () => validServices().length > 0;

  const goToReview = () => {
    setGeneratedYaml(generateYaml(stackName(), validServices()));
    setStep(3);
  };

  const handleSaveOnly = async () => {
    setSaving(true);
    setError("");
    try {
      const name = stackName().trim();
      const dir = `${await getStacksDir()}/${name}`;
      const filePath = `${dir}/docker-compose.yml`;
      const yamlContent = generatedYaml();
      await invoke("save_compose_file", { path: filePath, content: yamlContent });
      showToast(`Stack "${name}" saved`, "success");
      props.onClose();
      props.onDeployed?.();
    } catch (e) {
      setError(`Failed to save: ${e}`);
    }
    setSaving(false);
  };

  const handleDeploy = async () => {
    setDeploying(true);
    setError("");
    try {
      const name = stackName().trim();
      const dir = `${await getStacksDir()}/${name}`;
      const filePath = `${dir}/docker-compose.yml`;
      const yamlContent = generatedYaml();
      await invoke("save_compose_file", { path: filePath, content: yamlContent });
      await invoke("compose_deploy_path", { path: dir });
      showToast(`Stack "${name}" deployed!`, "success");
      props.onClose();
      props.onDeployed?.();
    } catch (e) {
      setError(`Deploy failed: ${e}`);
    }
    setDeploying(false);
  };

  // Cached absolute stacks directory resolved by the Tauri backend.
  // Hard-coding `~/.config/orca/stacks` fails under save_compose_file's
  // `validate_compose_path`, which rejects non-absolute paths and never
  // expands `~`. We resolve once on first use and reuse the value.
  let stacksDirCache: string | null = null;
  const getStacksDir = async (): Promise<string> => {
    if (stacksDirCache) return stacksDirCache;
    const resolved = (await invoke("get_stacks_dir")) as string;
    stacksDirCache = resolved;
    return resolved;
  };

  // Close autocomplete on click outside
  const handleGlobalClick = () => {
    setActiveImageField(null);
    setImageResults([]);
  };

  onMount(() => {
    document.addEventListener("click", handleGlobalClick);
    onCleanup(() => {
      document.removeEventListener("click", handleGlobalClick);
      if (searchTimeout) clearTimeout(searchTimeout);
    });
  });

  const restartOptions = [
    { value: "no", label: "No" },
    { value: "always", label: "Always" },
    { value: "unless-stopped", label: "Unless Stopped" },
    { value: "on-failure", label: "On Failure" },
  ];

  return (
    <div class="modal-overlay"
      onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
      onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay") && !deploying() && !saving()) props.onClose(); }}>
      <div class="modal-dialog" style={{ "max-width": "900px", height: "85vh", display: "flex", "flex-direction": "column" }}>
        <div class="modal-header">
          <h2 class="modal-title">
            {step() === 1 && "Create Compose Stack — Name"}
            {step() === 2 && "Create Compose Stack — Services"}
            {step() === 3 && "Create Compose Stack — Review & Deploy"}
          </h2>
          <button class="modal-close" onClick={() => { if (!deploying() && !saving()) props.onClose(); }}>{"\u00d7"}</button>
        </div>

        {/* Step indicators */}
        <div style={{ display: "flex", gap: "4px", padding: "0 20px 12px", "align-items": "center" }}>
          <For each={[1, 2, 3]}>
            {(s) => (
              <div style={{
                flex: "1",
                height: "3px",
                "border-radius": "2px",
                background: s <= step() ? "#58a6ff" : "#30363d",
                transition: "background 0.2s",
              }} />
            )}
          </For>
        </div>

        <div class="modal-body" style={{ flex: "1", overflow: "auto", display: "flex", "flex-direction": "column", gap: "16px" }}>
          {/* Step 1: Stack Name */}
          <Show when={step() === 1}>
            <div style={{ "max-width": "500px", margin: "40px auto", width: "100%" }}>
              <div class="form-group">
                <label class="form-label">Stack Name</label>
                <input
                  class="form-input"
                  type="text"
                  placeholder="e.g., my-web-app"
                  value={stackName()}
                  onInput={(e) => setStackName(e.currentTarget.value.replace(/[^a-zA-Z0-9_-]/g, ""))}
                  autofocus
                />
                <span class="form-hint">
                  This will be the directory name under ~/.config/orca/stacks/. Only letters, numbers, hyphens, and underscores.
                </span>
              </div>
            </div>
          </Show>

          {/* Step 2: Services */}
          <Show when={step() === 2}>
            <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
              <For each={services()}>
                {(svc) => {
                  const isEditing = () => editingServiceId() === svc.id;
                  const otherServiceNames = () =>
                    services()
                      .filter((s) => s.id !== svc.id && s.name.trim())
                      .map((s) => s.name.trim());

                  return (
                    <div style={{
                      border: "1px solid #30363d",
                      "border-radius": "8px",
                      background: "#161b22",
                      overflow: "hidden",
                    }}>
                      {/* Service card header */}
                      <div
                        style={{
                          display: "flex",
                          "align-items": "center",
                          "justify-content": "space-between",
                          padding: "10px 14px",
                          background: "#1c2128",
                          cursor: "pointer",
                          "border-bottom": isEditing() ? "1px solid #30363d" : "none",
                        }}
                        onClick={() => setEditingServiceId(isEditing() ? null : svc.id)}
                      >
                        <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
                          <span style={{
                            color: svc.name ? "#e6edf3" : "#484f58",
                            "font-weight": "600",
                            "font-size": "14px",
                          }}>
                            {svc.name || "(unnamed service)"}
                          </span>
                          <Show when={svc.image}>
                            <span style={{ color: "#8b949e", "font-size": "12px" }}>{svc.image}</span>
                          </Show>
                          <Show when={svc.ports.length > 0}>
                            <span style={{ color: "#58a6ff", "font-size": "11px" }}>
                              {svc.ports.filter((p) => p.host && p.container).map((p) => `${p.host}:${p.container}`).join(", ")}
                            </span>
                          </Show>
                        </div>
                        <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
                          <button
                            class="btn btn-sm"
                            onClick={(e) => { e.stopPropagation(); setEditingServiceId(isEditing() ? null : svc.id); }}
                            style={{ "font-size": "11px" }}
                          >
                            {isEditing() ? "Collapse" : "Edit"}
                          </button>
                          <button
                            class="btn btn-sm"
                            onClick={(e) => { e.stopPropagation(); removeService(svc.id); }}
                            style={{ color: "#f85149", "font-size": "11px" }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>

                      {/* Service edit form */}
                      <Show when={isEditing()}>
                        <div style={{ padding: "14px", display: "flex", "flex-direction": "column", gap: "12px" }}>
                          {/* Name & Image row */}
                          <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "12px" }}>
                            <div class="form-group">
                              <label class="form-label">Service Name</label>
                              <input
                                class="form-input"
                                type="text"
                                placeholder="e.g., web, db, redis"
                                value={svc.name}
                                onInput={(e) => updateService(svc.id, "name", e.currentTarget.value.replace(/[^a-zA-Z0-9_-]/g, ""))}
                              />
                            </div>
                            <div class="form-group" style={{ position: "relative" }}>
                              <label class="form-label">Image</label>
                              <input
                                class="form-input"
                                type="text"
                                placeholder="e.g., nginx:alpine"
                                value={svc.image}
                                onInput={(e) => handleImageInput(svc.id, e.currentTarget.value)}
                                onClick={(e) => e.stopPropagation()}
                                onFocus={() => { if (svc.image.length >= 2) { setActiveImageField(svc.id); searchImages(svc.image); } }}
                              />
                              <Show when={activeImageField() === svc.id && imageResults().length > 0}>
                                <div style={{
                                  position: "absolute",
                                  top: "100%",
                                  left: "0",
                                  right: "0",
                                  background: "#1c2128",
                                  border: "1px solid #30363d",
                                  "border-radius": "6px",
                                  "max-height": "200px",
                                  "overflow-y": "auto",
                                  "z-index": "100",
                                  "box-shadow": "0 8px 24px rgba(0,0,0,0.4)",
                                }}>
                                  <For each={imageResults()}>
                                    {(img) => (
                                      <div
                                        style={{
                                          padding: "8px 12px",
                                          cursor: "pointer",
                                          "font-size": "13px",
                                          color: "#e6edf3",
                                          "border-bottom": "1px solid #21262d",
                                        }}
                                        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); selectImage(svc.id, img); }}
                                      >
                                        {img}
                                      </div>
                                    )}
                                  </For>
                                </div>
                              </Show>
                            </div>
                          </div>

                          {/* Ports */}
                          <div class="form-group">
                            <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                              <label class="form-label" style={{ margin: "0" }}>Ports</label>
                              <button class="btn btn-sm" onClick={() => addPort(svc.id)} style={{ "font-size": "11px" }}>+ Add Port</button>
                            </div>
                            <For each={svc.ports}>
                              {(port, i) => (
                                <div style={{ display: "flex", gap: "8px", "align-items": "center", "margin-top": "6px" }}>
                                  <input
                                    class="form-input"
                                    type="text"
                                    placeholder="Host port"
                                    value={port.host}
                                    onInput={(e) => updatePort(svc.id, i(), "host", e.currentTarget.value)}
                                    style={{ width: "120px" }}
                                  />
                                  <span style={{ color: "#8b949e" }}>:</span>
                                  <input
                                    class="form-input"
                                    type="text"
                                    placeholder="Container port"
                                    value={port.container}
                                    onInput={(e) => updatePort(svc.id, i(), "container", e.currentTarget.value)}
                                    style={{ width: "120px" }}
                                  />
                                  <button
                                    class="btn btn-sm"
                                    onClick={() => removePort(svc.id, i())}
                                    style={{ color: "#f85149", "font-size": "11px", padding: "4px 8px" }}
                                  >
                                    {"\u2715"}
                                  </button>
                                </div>
                              )}
                            </For>
                          </div>

                          {/* Environment Variables */}
                          <div class="form-group">
                            <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                              <label class="form-label" style={{ margin: "0" }}>Environment Variables</label>
                              <button class="btn btn-sm" onClick={() => addEnv(svc.id)} style={{ "font-size": "11px" }}>+ Add Variable</button>
                            </div>
                            <For each={svc.env}>
                              {(envVar, i) => (
                                <div style={{ display: "flex", gap: "8px", "align-items": "center", "margin-top": "6px" }}>
                                  <input
                                    class="form-input"
                                    type="text"
                                    placeholder="KEY"
                                    value={envVar.key}
                                    onInput={(e) => updateEnv(svc.id, i(), "key", e.currentTarget.value)}
                                    style={{ flex: "1" }}
                                  />
                                  <span style={{ color: "#8b949e" }}>=</span>
                                  <input
                                    class="form-input"
                                    type="text"
                                    placeholder="value"
                                    value={envVar.value}
                                    onInput={(e) => updateEnv(svc.id, i(), "value", e.currentTarget.value)}
                                    style={{ flex: "1" }}
                                  />
                                  <button
                                    class="btn btn-sm"
                                    onClick={() => removeEnv(svc.id, i())}
                                    style={{ color: "#f85149", "font-size": "11px", padding: "4px 8px" }}
                                  >
                                    {"\u2715"}
                                  </button>
                                </div>
                              )}
                            </For>
                          </div>

                          {/* Volumes */}
                          <div class="form-group">
                            <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                              <label class="form-label" style={{ margin: "0" }}>Volumes</label>
                              <button class="btn btn-sm" onClick={() => addVolume(svc.id)} style={{ "font-size": "11px" }}>+ Add Volume</button>
                            </div>
                            <For each={svc.volumes}>
                              {(vol, i) => (
                                <div style={{ display: "flex", gap: "8px", "align-items": "center", "margin-top": "6px" }}>
                                  <input
                                    class="form-input"
                                    type="text"
                                    placeholder="Source (name or /path)"
                                    value={vol.source}
                                    onInput={(e) => updateVolume(svc.id, i(), "source", e.currentTarget.value)}
                                    style={{ flex: "1" }}
                                  />
                                  <span style={{ color: "#8b949e" }}>:</span>
                                  <input
                                    class="form-input"
                                    type="text"
                                    placeholder="Target (/path/in/container)"
                                    value={vol.target}
                                    onInput={(e) => updateVolume(svc.id, i(), "target", e.currentTarget.value)}
                                    style={{ flex: "1" }}
                                  />
                                  <button
                                    class="btn btn-sm"
                                    onClick={() => removeVolume(svc.id, i())}
                                    style={{ color: "#f85149", "font-size": "11px", padding: "4px 8px" }}
                                  >
                                    {"\u2715"}
                                  </button>
                                </div>
                              )}
                            </For>
                          </div>

                          {/* Depends On */}
                          <Show when={otherServiceNames().length > 0}>
                            <div class="form-group">
                              <label class="form-label">Depends On</label>
                              <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                                <For each={otherServiceNames()}>
                                  {(depName) => {
                                    const isSelected = () => svc.dependsOn.includes(depName);
                                    return (
                                      <button
                                        class={`btn btn-sm ${isSelected() ? "btn-primary" : ""}`}
                                        onClick={() => toggleDependsOn(svc.id, depName)}
                                        style={{ "font-size": "12px" }}
                                      >
                                        {depName}
                                      </button>
                                    );
                                  }}
                                </For>
                              </div>
                            </div>
                          </Show>

                          {/* Restart Policy */}
                          <div class="form-group">
                            <label class="form-label">Restart Policy</label>
                            <Dropdown
                              value={svc.restart}
                              options={restartOptions}
                              onChange={(val) => updateService(svc.id, "restart", val)}
                              style={{ width: "200px" }}
                            />
                          </div>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>

              <button class="btn" onClick={addService} style={{ "align-self": "flex-start" }}>
                + Add Service
              </button>
            </div>
          </Show>

          {/* Step 3: Review */}
          <Show when={step() === 3}>
            <div style={{ flex: "1", "min-height": "0", display: "flex", "flex-direction": "column", gap: "12px" }}>
              <div style={{
                flex: "1",
                "min-height": "0",
                border: "1px solid #30363d",
                "border-radius": "8px",
                overflow: "hidden",
              }}>
                <YamlEditor
                  value={generatedYaml()}
                  title={`${stackName()}/docker-compose.yml`}
                  onSave={(content) => setGeneratedYaml(content)}
                />
              </div>
              <Show when={error()}>
                <div style={{
                  background: "rgba(248, 81, 73, 0.1)",
                  border: "1px solid #f85149",
                  "border-radius": "8px",
                  padding: "10px 12px",
                  color: "#f85149",
                  "font-size": "12px",
                  "font-family": "'JetBrains Mono', monospace",
                  "white-space": "pre-wrap",
                  "max-height": "100px",
                  "overflow-y": "auto",
                }}>{error()}</div>
              </Show>
            </div>
          </Show>
        </div>

        <div class="modal-footer">
          <Show when={step() > 1}>
            <button class="btn" onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)} disabled={deploying() || saving()}>
              Back
            </button>
          </Show>
          <div style={{ flex: "1" }} />
          <button class="btn" onClick={() => { if (!deploying() && !saving()) props.onClose(); }} disabled={deploying() || saving()}>
            Cancel
          </button>
          <Show when={step() < 3}>
            <button
              class="btn btn-primary"
              disabled={step() === 1 ? !canProceedStep1() : !canProceedStep2()}
              onClick={() => {
                if (step() === 2) {
                  goToReview();
                } else {
                  // Capture the previous step before advancing — checking
                  // `step() === 1` AFTER setStep is always false and the
                  // auto-expand branch never fires.
                  const wasStep1 = step() === 1;
                  setStep((s) => (s + 1) as 1 | 2 | 3);
                  if (wasStep1 && services().length > 0) {
                    setEditingServiceId(services()[0].id);
                  }
                }
              }}
            >
              Next
            </button>
          </Show>
          <Show when={step() === 3}>
            <button class="btn" onClick={handleSaveOnly} disabled={deploying() || saving()}>
              {saving() ? <><Spinner size={12} />{" Saving..."}</> : "Save Only"}
            </button>
            <button class="btn btn-primary" onClick={handleDeploy} disabled={deploying() || saving()}>
              {deploying() ? <><Spinner size={12} />{" Deploying..."}</> : "Deploy"}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
