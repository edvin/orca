import { createSignal, For, onMount, Show } from "solid-js";
import { engineApi, type Integration } from "../lib/engine";
import { showToast } from "./Toast";

/**
 * Settings → Engine on Windows: `docker` in PowerShell and in one WSL distro
 * using Orca's engine, as Docker Desktop's WSL integration did.
 */
export default function WslIntegration() {
  const [state, setState] = createSignal<Integration | null>(null);
  const [distro, setDistro] = createSignal<string | null>(null);
  const [powershell, setPowershell] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [log, setLog] = createSignal<string[]>([]);

  const refresh = async () => {
    try {
      const s = await engineApi.integration();
      setState(s);
      setDistro(s.distro);
      setPowershell(s.powershell);
    } catch {
      setState(null);
    }
  };
  onMount(refresh);

  const changed = () => state() !== null && (distro() !== state()!.distro || powershell() !== state()!.powershell);

  const apply = async () => {
    setSaving(true);
    setLog([]);
    try {
      const r = await engineApi.setIntegration({ distro: distro(), powershell: powershell() });
      setLog(r.log);
      showToast("docker now uses Orca's engine there", "success");
      await refresh();
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Show when={state()}>
      {(s) => (
        <div class="settings-section">
          <h2 class="settings-section-title">Engine</h2>
          <p style={{ "font-size": "12px", color: "#8b949e", margin: "0 0 10px" }}>
            Orca runs Docker in a WSL distro of its own. Let the <code>docker</code> command use it from PowerShell and from
            one of your distros (a Docker CLI is installed there if it has none).
          </p>
          <div class="card" style={{ padding: "14px 16px", display: "flex", "flex-direction": "column", gap: "10px" }}>
            <label class="engine-option">
              <input type="checkbox" checked={powershell()} disabled={saving()} onChange={(e) => setPowershell(e.currentTarget.checked)} />
              <span>
                <b>PowerShell and Command Prompt</b>
                <span class="engine-sub">
                  {s().docker_exe ? `Uses ${s().docker_exe}` : "Downloads Docker's CLI and compose for Windows"}, with a{" "}
                  <code>docker context</code> named <code>orca</code>.
                </span>
              </span>
            </label>
            <div style={{ "font-size": "12px", color: "#8b949e", "margin-top": "4px" }}>
              One WSL distro: its <code>/home</code> is at the same path for the engine, so bind mounts from it just work.
            </div>
            <label class="engine-option">
              <input type="radio" name="wsl-distro" checked={distro() === null} disabled={saving()} onChange={() => setDistro(null)} />
              <span><b>None</b></span>
            </label>
            <For each={s().distros}>
              {(d) => (
                <label class="engine-option">
                  <input type="radio" name="wsl-distro" checked={distro() === d.name} disabled={saving()} onChange={() => setDistro(d.name)} />
                  <span>
                    <b>{d.name}</b>
                    <span class="engine-sub">{d.running ? "running" : "not running"}</span>
                  </span>
                </label>
              )}
            </For>
            <Show when={log().length > 0}>
              <pre class="ddm-log">{log().join("\n")}</pre>
            </Show>
            <div style={{ display: "flex", "justify-content": "flex-end" }}>
              <button class="btn btn-primary" disabled={!changed() || saving()} onClick={apply}>
                {saving() ? "Setting up..." : "Apply"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
