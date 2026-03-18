import { createSignal, Show, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./Toast";

interface RunContainerDialogProps {
  onClose: () => void;
  onCreated: () => void;
  initialImage?: string;
}

export default function RunContainerDialog(props: RunContainerDialogProps) {
  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
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
  const [loading, setLoading] = createSignal(false);
  const [showAdvanced, setShowAdvanced] = createSignal(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!image().trim()) return;

    setLoading(true);
    try {
      const envLines = env().split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      const portLines = ports().split(/[,\n]/).map((l) => l.trim()).filter((l) => l.length > 0);
      const volumeLines = volumes().split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

      await invoke("create_and_run_container", {
        image: image().trim(),
        name: name().trim() || null,
        command: command().trim() || null,
        env: envLines.length > 0 ? envLines : null,
        ports: portLines.length > 0 ? portLines : null,
        volumes: volumeLines.length > 0 ? volumeLines : null,
        restartPolicy: restartPolicy() !== "no" ? restartPolicy() : null,
        cpuLimit: cpuLimit().trim() ? parseFloat(cpuLimit().trim()) : null,
        memoryLimit: memoryLimit().trim() || null,
      });

      showToast("Container created and started", "success");
      props.onCreated();
      props.onClose();
    } catch (err) {
      showToast(`Failed to create container: ${err}`, "error");
    }
    setLoading(false);
  };

  const handleOverlayClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains("modal-overlay")) {
      props.onClose();
    }
  };

  return (
    <div class="modal-overlay" onClick={handleOverlayClick}>
      <div class="modal-dialog">
        <div class="modal-header">
          <h2 class="modal-title">Run Container</h2>
          <button class="modal-close" onClick={props.onClose}>{"\u00d7"}</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div class="modal-body">
            {/* Essential fields */}
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

            {/* Advanced section — collapsed by default */}
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
                  <select
                    class="form-select"
                    value={restartPolicy()}
                    onChange={(e) => setRestartPolicy(e.currentTarget.value)}
                  >
                    <option value="no">No</option>
                    <option value="always">Always</option>
                    <option value="unless-stopped">Unless Stopped</option>
                    <option value="on-failure">On Failure</option>
                  </select>
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
            <button type="button" class="btn" onClick={props.onClose} disabled={loading()}>
              Cancel
            </button>
            <button
              type="submit"
              class="btn btn-primary"
              disabled={loading() || !image().trim()}
            >
              {loading() ? "Creating..." : "Run"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
