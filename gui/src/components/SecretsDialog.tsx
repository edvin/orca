// Fill in a workspace project's secrets: each with a link to its entry in
// the team's secret manager (or its 1Password reference), a field to paste
// the value, and, when that manager's CLI is set up here, one click to
// fetch them all. Values go straight into the project's .env.

import { createSignal, For, Show } from "solid-js";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { showToast } from "./Toast";
import Spinner from "./Spinner";
import { workspaceApi, type WorkspaceProject, type WorkspaceSecret } from "../lib/workspace";

const PROVIDER: Record<string, string> = { passbolt: "Passbolt", "1password": "1Password" };

export default function SecretsDialog(props: {
  project: WorkspaceProject;
  clis?: { passbolt: boolean; "1password": boolean };
  onClose: () => void;
  /** After saving; `true` when every secret has a value now. */
  onSaved: (allFilled: boolean) => void;
}) {
  const [secrets, setSecrets] = createSignal<WorkspaceSecret[]>(props.project.secrets);
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal(false);
  const [fetching, setFetching] = createSignal(false);

  const missing = () => secrets().filter((s) => !s.filled);
  const canFetch = () => missing().some((s) => props.clis?.[s.provider]);
  const typed = () => Object.entries(values()).filter(([, v]) => v.trim());

  const open = (url: string) => shellOpen(url).catch(() => window.open(url, "_blank", "noopener,noreferrer"));

  const fetchAll = async () => {
    setFetching(true);
    try {
      const r = await workspaceApi.fetchSecrets(props.project.key);
      setSecrets(r.secrets);
      if (r.filled.length) showToast(`Filled in ${r.filled.join(", ")}`, "success");
      for (const f of r.failed) showToast(`${f.name}: ${f.error}`, "error");
      if (r.secrets.every((s) => s.filled)) props.onSaved(true);
    } catch (e) {
      showToast(String(e), "error");
    }
    setFetching(false);
  };

  const save = async () => {
    setBusy(true);
    try {
      const r = await workspaceApi.setEnv(props.project.key, Object.fromEntries(typed().map(([k, v]) => [k, v.trim()])));
      setSecrets(r.secrets);
      setValues({});
      props.onSaved(r.secrets.every((s) => s.filled));
    } catch (e) {
      showToast(String(e), "error");
    }
    setBusy(false);
  };

  return (
    <div class="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy()) props.onClose(); }}>
      <div class="modal-dialog secrets-dialog">
        <div class="modal-header">
          <h2 class="modal-title">Secrets for {props.project.key}</h2>
          <button class="modal-close" onClick={props.onClose}>×</button>
        </div>
        <div class="modal-body">
          <p class="secrets-intro">
            These go into <span class="mono">{props.project.dir.split(/[\\/]/).pop()}/.env</span> on this computer and nowhere else.
            Open each one in your secret manager, copy the value and paste it here.
          </p>
          <Show when={canFetch()}>
            <div class="secrets-fetch">
              <span>Your secret manager's command-line tool is set up on this computer.</span>
              <button class="btn btn-sm btn-primary" disabled={fetching()} onClick={() => void fetchAll()}>
                {fetching() ? <><Spinner size={12} /> Fetching…</> : "Fill in automatically"}
              </button>
            </div>
          </Show>
          <div class="secrets-list">
            <For each={secrets()}>
              {(s) => (
                <div class="secret-row" classList={{ filled: s.filled }}>
                  <div class="secret-head">
                    <b class="mono">{s.name}</b>
                    <span class="secret-provider">{PROVIDER[s.provider] ?? s.provider}</span>
                    <Show when={s.filled}><span class="secret-ok">✓ in .env</span></Show>
                    <span class="secret-spacer" />
                    <Show when={s.link} fallback={
                      <button class="btn btn-sm" title="Copy the reference" onClick={() => navigator.clipboard.writeText(s.reference).then(() => showToast("Reference copied", "success"), () => {})}>
                        <span class="mono">{s.reference}</span>
                      </button>
                    }>
                      {(link) => <button class="btn btn-sm" onClick={() => void open(link())}>Open in {PROVIDER[s.provider]} ↗</button>}
                    </Show>
                  </div>
                  <input
                    class="form-input mono"
                    type="password"
                    autocomplete="off"
                    placeholder={s.filled ? "Paste a new value to replace it" : "Paste the value"}
                    value={values()[s.name] ?? ""}
                    onInput={(e) => setValues({ ...values(), [s.name]: e.currentTarget.value })}
                  />
                </div>
              )}
            </For>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" onClick={props.onClose} disabled={busy()}>Later</button>
          <button class="btn btn-primary" disabled={busy() || typed().length === 0} onClick={() => void save()}>
            {busy() ? "Saving…" : missing().every((m) => values()[m.name]?.trim()) ? "Save and start" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
