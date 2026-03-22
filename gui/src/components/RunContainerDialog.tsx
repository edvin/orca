import { createSignal, Show, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./Toast";
import Spinner from "./Spinner";
import Dropdown from "./Dropdown";

interface RunContainerDialogProps {
  onClose: () => void;
  onCreated: () => void;
  initialImage?: string;
}

type RunStage = "form" | "pulling" | "creating" | "starting" | "done" | "error";

export default function RunContainerDialog(props: RunContainerDialogProps) {
  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape" && stage() === "form") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", handleEscape));
  onCleanup(() => document.removeEventListener("keydown", handleEscape));

  const [image, setImage] = createSignal(props.initialImage || "");
  const [name, setName] = createSignal("");
  const [command, setCommand] = createSignal("");
  const [env, setEnv] = createSignal("");
  const [ports, setPorts] = createSignal("");
  const [volumes, setVolumes] = createSignal("");
  const [restartPolicy, setRestartPolicy] = createSignal("no");
  const [cpuLimit, setCpuLimit] = createSignal("");
  const [memoryLimit, setMemoryLimit] = createSignal("");
  const [showAdvanced, setShowAdvanced] = createSignal(false);
  const [stage, setStage] = createSignal<RunStage>("form");
  const [stageMessage, setStageMessage] = createSignal("");
  const [errorMessage, setErrorMessage] = createSignal("");

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!image().trim()) return;

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
      });

      // Stage 4: Done
      setStage("starting");
      setStageMessage("Container started!");

      setTimeout(() => {
        showToast(`Container started from ${imgRef}`, "success");
        props.onCreated();
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

  const stageIcon = () => {
    switch (stage()) {
      case "pulling": return "\u2B07";
      case "creating": return "\u2692";
      case "starting": return "\u2713";
      case "done": return "\u2713";
      case "error": return "\u2717";
      default: return "";
    }
  };

  return (
    <div class="modal-overlay" onMouseDown={handleOverlayMouseDown} onClick={handleOverlayClick}>
      <div class="modal-dialog">
        <div class="modal-header">
          <h2 class="modal-title">Run Container</h2>
          <Show when={stage() === "form" || stage() === "error"}>
            <button class="modal-close" onClick={props.onClose}>{"\u00d7"}</button>
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
            <button class="btn" onClick={props.onClose}>Close</button>
          </div>
        </Show>

        {/* Form view */}
        <Show when={stage() === "form"}>
          <form onSubmit={handleSubmit}>
            <div class="modal-body">
              <div class="form-row">
                <div class="form-group" style={{ flex: 2 }}>
                  <label class="form-label">Image <span style={{ color: "#f85149" }}>*</span></label>
                  <input
                    class="form-input mono"
                    type="text"
                    placeholder="nginx:latest"
                    value={image()}
                    onInput={(e) => setImage(e.currentTarget.value)}
                    autofocus
                  />
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
              <button type="button" class="btn" onClick={props.onClose}>Cancel</button>
              <button type="submit" class="btn btn-primary" disabled={!image().trim()}>Run</button>
            </div>
          </form>
        </Show>
      </div>
    </div>
  );
}
