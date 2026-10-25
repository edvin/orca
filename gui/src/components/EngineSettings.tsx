import { createSignal, For, onMount, Show } from "solid-js";
import { engineApi, type EngineStatus } from "../lib/engine";
import { showToast } from "./Toast";
import { confirm } from "./ConfirmDialog";

/**
 * Settings → Engine (macOS): Orca's own VM, or another engine such as
 * OrbStack or Colima. Docker Desktop's engine isn't one of the choices: Orca
 * runs its own instead, and brings what's in Docker Desktop over once.
 */
export default function EngineSettings() {
  const [status, setStatus] = createSignal<EngineStatus | null>(null);
  const [custom, setCustom] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  const refresh = async () => {
    try {
      setStatus(await engineApi.status());
    } catch {
      setStatus(null);
    }
  };
  onMount(refresh);

  const current = () => {
    const c = status()?.choice;
    return c?.kind === "socket" ? c.path : "orca";
  };

  const choose = async (path: string, name?: string) => {
    if (path === current()) return;
    const ok = await confirm({
      title: path === "orca" ? "Use Orca's engine?" : `Use ${name ?? "this engine"}?`,
      message:
        "Orca shows and runs the containers of the engine you pick. Containers, images and volumes stay " +
        "in the engine they're in." +
        (path === "orca" ? "" : " Orca's VM settings and Kubernetes only apply to Orca's own engine."),
      confirmLabel: "Switch",
    });
    if (!ok) return;
    setSaving(true);
    try {
      const r = await engineApi.choose(path === "orca" ? { kind: "orca" } : { kind: "socket", path, name: name ?? null });
      showToast(r.connected ? "Switched engine" : "Saved, but the engine isn't answering yet", r.connected ? "success" : "info");
      await refresh();
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const others = () => status()?.others ?? [];

  return (
    <Show when={status()}>
      {(s) => (
        <div class="settings-section">
          <h2 class="settings-section-title">Engine</h2>
          <p style={{ "font-size": "12px", color: "#8b949e", margin: "0 0 10px" }}>
            Where Orca runs containers. Docker Desktop's engine isn't used: bring what's in it over on System Health.
          </p>
          <div class="card" style={{ padding: "14px 16px", display: "flex", "flex-direction": "column", gap: "10px" }}>
            <Show when={s().from_env}>
              <div style={{ "font-size": "12px", color: "#d29922" }}>
                Orca's daemon was started with DOCKER_HOST, which wins over the choice here: {s().socket}
              </div>
            </Show>
            <label class="engine-option">
              <input type="radio" name="engine" checked={current() === "orca"} disabled={saving()} onChange={() => choose("orca")} />
              <span>
                <Show
                  when={s().platform === "macos"}
                  fallback={
                    <>
                      <b>This computer's Docker or Podman</b> <span class="engine-tag">Recommended</span>
                      <span class="engine-sub">The first of the usual sockets that answers. {s().socket ? `Now: ${s().socket}.` : ""}</span>
                    </>
                  }
                >
                  <b>Orca's engine</b> <span class="engine-tag">Recommended</span>
                  <span class="engine-sub">
                    Docker in Orca's own Lima VM: its VM settings, networking fixes and Kubernetes.
                    {s().orca_vm ? ` VM ${s().orca_vm!.name}: ${s().orca_vm!.status}.` : " Not set up yet: System Health sets it up."}
                  </span>
                </Show>
              </span>
            </label>
            <For each={others()}>
              {(o) => (
                <label class="engine-option">
                  <input type="radio" name="engine" checked={current() === o.path} disabled={saving()} onChange={() => choose(o.path, o.name)} />
                  <span>
                    <b>{o.name}</b>
                    <span class="engine-sub">
                      {o.path} · {o.running ? "running" : "not running"}
                    </span>
                  </span>
                </label>
              )}
            </For>
            <Show when={current() !== "orca" && !others().some((o) => o.path === current())}>
              <label class="engine-option">
                <input type="radio" name="engine" checked disabled />
                <span>
                  <b>{s().choice.kind === "socket" ? (s().choice as { name?: string | null }).name ?? "Another engine" : ""}</b>
                  <span class="engine-sub">{current()}</span>
                </span>
              </label>
            </Show>
            <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
              <input
                class="form-input"
                placeholder="Another engine's socket, e.g. /Users/me/.colima/work/docker.sock"
                value={custom()}
                onInput={(e) => setCustom(e.currentTarget.value)}
                style={{ flex: "1" }}
                disabled={saving()}
              />
              <button class="btn" disabled={saving() || !custom().trim()} onClick={() => choose(custom().trim())}>
                Use
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
