import { createSignal, Show, For, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./Toast";
import Spinner from "./Spinner";
import Dropdown from "./Dropdown";

interface RunContainerDialogProps {
  onClose: () => void;
  onCreated: (containerId?: string) => void;
  initialImage?: string;
}

type RunStage = "form" | "pulling" | "creating" | "starting" | "done" | "error";

// Simple cache for tag results
const tagCache = new Map<string, string[]>();

export default function RunContainerDialog(props: RunContainerDialogProps) {
  // Flipped on cleanup so pending debounced tag fetches / network lookups
  // don't write to signals after the dialog is closed.
  let disposed = false;

  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape" && stage() === "form") {
      if (showTagSuggestions()) {
        setShowTagSuggestions(false);
      } else {
        props.onClose();
      }
    }
  };
  onMount(() => {
    document.addEventListener("keydown", handleEscape);
    // Fetch available networks
    (async () => {
      try {
        const nets = (await invoke("list_networks")) as Array<{ name: string; driver: string }>;
        if (disposed) return;
        const builtIn = ["bridge", "host", "none"];
        const options = builtIn.map((n) => ({ value: n, label: n }));
        for (const net of nets) {
          if (!builtIn.includes(net.name)) {
            options.push({ value: net.name, label: `${net.name} (${net.driver})` });
          }
        }
        setAvailableNetworks(options);
      } catch {
        // Keep defaults if fetch fails
      }
    })();
  });
  onCleanup(() => {
    disposed = true;
    document.removeEventListener("keydown", handleEscape);
    if (tagFetchTimer) clearTimeout(tagFetchTimer);
  });

  const [image, setImage] = createSignal(props.initialImage || "");
  const [name, setName] = createSignal("");
  const [command, setCommand] = createSignal("");
  const [env, setEnv] = createSignal("");
  const [ports, setPorts] = createSignal("");
  const [volumes, setVolumes] = createSignal("");
  const [restartPolicy, setRestartPolicy] = createSignal("no");
  const [cpuLimit, setCpuLimit] = createSignal("");
  const [memoryLimit, setMemoryLimit] = createSignal("");
  const [network, setNetwork] = createSignal("bridge");
  const [availableNetworks, setAvailableNetworks] = createSignal<Array<{ value: string; label: string }>>([
    { value: "bridge", label: "bridge" },
    { value: "host", label: "host" },
    { value: "none", label: "none" },
  ]);
  const [showAdvanced, setShowAdvanced] = createSignal(false);
  const [stage, setStage] = createSignal<RunStage>("form");
  const [stageMessage, setStageMessage] = createSignal("");
  const [errorMessage, setErrorMessage] = createSignal("");

  // Tag autocomplete state
  const [tagSuggestions, setTagSuggestions] = createSignal<string[]>([]);
  const [showTagSuggestions, setShowTagSuggestions] = createSignal(false);
  const [tagLoading, setTagLoading] = createSignal(false);
  const [selectedTagIndex, setSelectedTagIndex] = createSignal(-1);
  let tagFetchTimer: ReturnType<typeof setTimeout> | undefined;

  const fetchTags = (imageName: string) => {
    if (tagFetchTimer) clearTimeout(tagFetchTimer);

    // Don't fetch if image already has a tag or is empty
    if (!imageName.trim() || imageName.includes(":")) {
      setTagSuggestions([]);
      setShowTagSuggestions(false);
      return;
    }

    // Check cache first
    const cached = tagCache.get(imageName.trim());
    if (cached) {
      setTagSuggestions(cached);
      setShowTagSuggestions(cached.length > 0);
      setSelectedTagIndex(-1);
      return;
    }

    tagFetchTimer = setTimeout(async () => {
      if (disposed) return;
      setTagLoading(true);
      try {
        const tags = await invoke("fetch_image_tags", { image: imageName.trim() }) as string[];
        if (disposed) return;
        const limited = tags.slice(0, 10);
        tagCache.set(imageName.trim(), limited);
        setTagSuggestions(limited);
        setShowTagSuggestions(limited.length > 0);
        setSelectedTagIndex(-1);
      } catch {
        if (disposed) return;
        setTagSuggestions([]);
        setShowTagSuggestions(false);
      } finally {
        if (!disposed) setTagLoading(false);
      }
    }, 400);
  };

  const selectTag = (tag: string) => {
    const base = image().split(":")[0];
    setImage(`${base}:${tag}`);
    setShowTagSuggestions(false);
    setSelectedTagIndex(-1);
  };

  const handleImageInput = (value: string) => {
    setImage(value);
    fetchTags(value);
  };

  const handleImageKeyDown = (e: KeyboardEvent) => {
    if (!showTagSuggestions()) return;
    const tags = tagSuggestions();
    if (tags.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedTagIndex((i) => Math.min(i + 1, tags.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedTagIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && selectedTagIndex() >= 0) {
      e.preventDefault();
      selectTag(tags[selectedTagIndex()]);
    } else if (e.key === "Tab" && tags.length > 0) {
      e.preventDefault();
      const idx = selectedTagIndex() >= 0 ? selectedTagIndex() : 0;
      selectTag(tags[idx]);
    }
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!image().trim()) return;
    setShowTagSuggestions(false);

    const imgRef = image().trim();

    try {
      // Stage 1: Check if image exists locally
      setStage("pulling");
      setStageMessage(`Checking if ${imgRef} is available locally...`);

      let needsPull = false;
      try {
        await invoke("inspect_image", { id: imgRef });
      } catch {
        needsPull = true;
      }

      // Stage 2: Pull if needed
      if (needsPull) {
        setStageMessage(`Pulling ${imgRef}...`);
        try {
          await invoke("pull_image", { reference: imgRef });
          setStageMessage(`Pulled ${imgRef} successfully`);
        } catch (pullErr) {
          setStage("error");
          setErrorMessage(`Failed to pull image: ${pullErr}`);
          return;
        }
      }

      // Stage 3: Create container
      setStage("creating");
      setStageMessage("Creating container...");

      const envLines = env().split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      const portLines = ports().split(/[,\n]/).map((l) => l.trim()).filter((l) => l.length > 0);
      const volumeLines = volumes().split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

      const result = await invoke("create_and_run_container", {
        image: imgRef,
        name: name().trim() || null,
        command: command().trim() || null,
        env: envLines.length > 0 ? envLines : null,
        ports: portLines.length > 0 ? portLines : null,
        volumes: volumeLines.length > 0 ? volumeLines : null,
        restartPolicy: restartPolicy() !== "no" ? restartPolicy() : null,
        cpuLimit: cpuLimit().trim() ? parseFloat(cpuLimit().trim()) : null,
        memoryLimit: memoryLimit().trim() || null,
        network: network() !== "bridge" ? network() : null,
      });

      // Stage 4: Done
      setStage("starting");
      setStageMessage("Container started!");

      const containerId = (result as any)?.id;
      setTimeout(() => {
        showToast(`Container started from ${imgRef}`, "success");
        props.onCreated(containerId);
        props.onClose();
      }, 600);
    } catch (err) {
      setStage("error");
      setErrorMessage(`${err}`);
    }
  };

  let mouseDownOnOverlay = false;
  const handleOverlayMouseDown = (e: MouseEvent) => {
    mouseDownOnOverlay = (e.target as HTMLElement).classList.contains("modal-overlay");
  };
  const handleOverlayClick = (e: MouseEvent) => {
    if (mouseDownOnOverlay && (e.target as HTMLElement).classList.contains("modal-overlay") && stage() === "form") {
      props.onClose();
    }
    mouseDownOnOverlay = false;
  };

  return (
    <div class="modal-overlay" onMouseDown={handleOverlayMouseDown} onClick={handleOverlayClick}>
      <div class="modal-dialog">
        <div class="modal-header">
          <h2 class="modal-title">Run Container</h2>
          <Show when={stage() === "form" || stage() === "error"}>
            <button class="modal-close" onClick={() => props.onClose()}>{"\u00d7"}</button>
          </Show>
        </div>

        {/* Progress view */}
        <Show when={stage() !== "form" && stage() !== "error"}>
          <div class="modal-body" style={{ "align-items": "center", "justify-content": "center", "min-height": "200px" }}>
            <div style={{ "text-align": "center" }}>
              <Show when={stage() !== "starting" && stage() !== "done"}>
                <Spinner />
              </Show>
              <Show when={stage() === "starting" || stage() === "done"}>
                <div style={{ "font-size": "32px", color: "#3fb950", "margin-bottom": "8px" }}>{"\u2713"}</div>
              </Show>
              <div style={{ "margin-top": "16px", "font-size": "14px", color: "#e6edf3" }}>
                {stageMessage()}
              </div>
              <div class="run-progress-steps">
                <span class={`run-step ${stage() === "pulling" ? "active" : (stage() !== "form" ? "done" : "")}`}>Pull</span>
                <span class="run-step-arrow">{"\u2192"}</span>
                <span class={`run-step ${stage() === "creating" ? "active" : (stage() === "starting" || stage() === "done" ? "done" : "")}`}>Create</span>
                <span class="run-step-arrow">{"\u2192"}</span>
                <span class={`run-step ${stage() === "starting" || stage() === "done" ? "active done" : ""}`}>Start</span>
              </div>
            </div>
          </div>
        </Show>

        {/* Error view */}
        <Show when={stage() === "error"}>
          <div class="modal-body">
            <div style={{
              background: "#da363318",
              border: "1px solid #da363344",
              "border-radius": "8px",
              padding: "16px",
            }}>
              <div style={{ color: "#f85149", "font-weight": "600", "margin-bottom": "8px" }}>Failed to start container</div>
              <div class="mono" style={{ color: "#e6edf3", "font-size": "12px", "word-break": "break-all" }}>
                {errorMessage()}
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" onClick={() => setStage("form")}>Back</button>
            <button class="btn" onClick={() => props.onClose()}>Close</button>
          </div>
        </Show>

        {/* Form view */}
        <Show when={stage() === "form"}>
          <form onSubmit={handleSubmit}>
            <div class="modal-body">
              <div class="form-row">
                <div class="form-group" style={{ flex: 2, position: "relative" }}>
                  <label class="form-label">Image <span style={{ color: "#f85149" }}>*</span></label>
                  <input
                    class="form-input mono"
                    type="text"
                    placeholder="nginx:latest"
                    value={image()}
                    onInput={(e) => handleImageInput(e.currentTarget.value)}
                    onKeyDown={handleImageKeyDown}
                    onBlur={() => {
                      // Delay hiding so click on suggestion registers
                      setTimeout(() => setShowTagSuggestions(false), 200);
                    }}
                    onFocus={() => {
                      if (tagSuggestions().length > 0 && !image().includes(":")) {
                        setShowTagSuggestions(true);
                      }
                    }}
                    autofocus
                    autocomplete="off"
                  />
                  <Show when={showTagSuggestions() && tagSuggestions().length > 0}>
                    <div class="tag-suggestions">
                      <For each={tagSuggestions()}>
                        {(tag, index) => (
                          <div
                            class={`tag-suggestion-item ${selectedTagIndex() === index() ? "selected" : ""}`}
                            onMouseDown={() => selectTag(tag)}
                            onMouseEnter={() => setSelectedTagIndex(index())}
                          >
                            <span class="tag-suggestion-colon">:</span>
                            <span class="tag-suggestion-name">{tag}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={tagLoading()}>
                    <div style={{
                      position: "absolute",
                      right: "10px",
                      top: "34px",
                      color: "#8b949e",
                      "font-size": "11px",
                    }}>
                      loading tags...
                    </div>
                  </Show>
                </div>
                <div class="form-group" style={{ flex: 1 }}>
                  <label class="form-label">Name</label>
                  <input
                    class="form-input"
                    type="text"
                    placeholder="Optional"
                    value={name()}
                    onInput={(e) => setName(e.currentTarget.value)}
                  />
                </div>
              </div>

              <div class="form-group">
                <label class="form-label">Port Mappings</label>
                <input
                  class="form-input mono"
                  type="text"
                  placeholder="8080:80, 5432:5432"
                  value={ports()}
                  onInput={(e) => setPorts(e.currentTarget.value)}
                />
                <span class="form-hint">host:container — comma or newline separated</span>
              </div>

              <div class="form-group">
                <label class="form-label">Environment Variables</label>
                <textarea
                  class="form-textarea mono"
                  placeholder={"KEY=value\nDATABASE_URL=postgres://..."}
                  value={env()}
                  onInput={(e) => setEnv(e.currentTarget.value)}
                  rows={2}
                />
              </div>

              <button
                type="button"
                class="advanced-toggle"
                onClick={() => setShowAdvanced(!showAdvanced())}
              >
                <span class={`advanced-arrow ${showAdvanced() ? "expanded" : ""}`}>&#9654;</span>
                Advanced Options
              </button>

              <Show when={showAdvanced()}>
                <div class="form-group">
                  <label class="form-label">Command Override</label>
                  <input
                    class="form-input mono"
                    type="text"
                    placeholder="/bin/sh -c 'echo hello'"
                    value={command()}
                    onInput={(e) => setCommand(e.currentTarget.value)}
                  />
                </div>

                <div class="form-group">
                  <label class="form-label">Volume Mounts</label>
                  <textarea
                    class="form-textarea mono"
                    placeholder={"/host/path:/container/path"}
                    value={volumes()}
                    onInput={(e) => setVolumes(e.currentTarget.value)}
                    rows={2}
                  />
                  <span class="form-hint">host:container, one per line</span>
                </div>

                <div class="form-group">
                  <label class="form-label">Network</label>
                  <Dropdown
                    value={network()}
                    options={availableNetworks()}
                    onChange={(v) => setNetwork(v)}
                  />
                </div>

                <div class="form-row">
                  <div class="form-group" style={{ flex: 1 }}>
                    <label class="form-label">Restart Policy</label>
                    <Dropdown
                      value={restartPolicy()}
                      options={[
                        { value: "no", label: "No" },
                        { value: "always", label: "Always" },
                        { value: "unless-stopped", label: "Unless Stopped" },
                        { value: "on-failure", label: "On Failure" },
                      ]}
                      onChange={(v) => setRestartPolicy(v)}
                    />
                  </div>
                  <div class="form-group" style={{ flex: 1 }}>
                    <label class="form-label">CPU Limit</label>
                    <input
                      class="form-input"
                      type="number"
                      step="0.1"
                      min="0"
                      placeholder="e.g. 0.5"
                      value={cpuLimit()}
                      onInput={(e) => setCpuLimit(e.currentTarget.value)}
                    />
                  </div>
                  <div class="form-group" style={{ flex: 1 }}>
                    <label class="form-label">Memory</label>
                    <input
                      class="form-input"
                      type="text"
                      placeholder="512m"
                      value={memoryLimit()}
                      onInput={(e) => setMemoryLimit(e.currentTarget.value)}
                    />
                  </div>
                </div>
              </Show>
            </div>

            <div class="modal-footer">
              <button type="button" class="btn" onClick={() => props.onClose()}>Cancel</button>
              <button type="submit" class="btn btn-primary" disabled={!image().trim()}>Run</button>
            </div>
          </form>
        </Show>
      </div>
    </div>
  );
}
