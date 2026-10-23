// Open a project folder: Orca looks at what's in it (compose files,
// services, profiles, orca.yaml, git) and starts it as a stack. A folder
// without a compose file gets a first compose.yaml; an existing file is
// never overwritten.

import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./Toast";
import Spinner from "./Spinner";
import FolderActions, { isRemoteHost } from "./FolderActions";
import { closeFolderDialog, openFolderTarget } from "../lib/openFolder";
import { devApi } from "../lib/dev";

interface FolderInfo {
  path: string;
  /** The path with ~ for the home folder. */
  display_path?: string;
  name: string;
  compose_files: string[];
  orca_yaml: boolean;
  git: boolean;
  services: string[];
  profiles: string[];
  stack: string | null;
  /** Another folder that already runs under the same project name. */
  conflict: string | null;
  error: string | null;
}

const STARTER = `services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
`;

export default function OpenFolderDialog(props: { onNavigate: (target: string) => void }) {
  const [path, setPath] = createSignal("");
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [addProject, setAddProject] = createSignal(true);
  const [starter, setStarter] = createSignal(STARTER);
  const [remote] = createResource(isRemoteHost);

  const [info, { refetch }] = createResource(path, async (p) => {
    if (!p) return null;
    try {
      return await invoke<FolderInfo>("inspect_folder", { path: p });
    } catch (e) {
      setError(String(e));
      return null;
    }
  });

  /** Look at a folder; the same one again looks again (after fixing what was wrong). */
  const open = (p: string) => {
    setError("");
    if (p === path()) void refetch();
    else setPath(p);
  };

  // A dropped file stands for its folder (the daemon takes the file's folder).
  createEffect(on(openFolderTarget, (t) => {
    if (t) open(t);
  }));

  const choose = async () => {
    const picked = await invoke<string | null>("pick_folder", { title: "Open a project folder" }).catch(() => null);
    if (picked) open(picked);
  };

  const close = () => {
    if (!busy()) closeFolderDialog();
  };

  const start = async () => {
    const f = info();
    if (!f) return;
    setBusy(true);
    setError("");
    try {
      if (f.compose_files.length === 0) {
        await invoke("create_compose_in_folder", { path: f.path, content: starter() });
      }
      if (f.git && addProject()) {
        await devApi.addProject(f.path).catch(() => {});
      }
      await invoke("compose_deploy_path", { path: f.path });
      showToast(`${f.name} is starting`, "success");
      closeFolderDialog();
      props.onNavigate(`stack:${f.name}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="modal-dialog open-folder">
        <div class="modal-header">
          <h2 class="modal-title">Open a project folder</h2>
          <button class="modal-close" onClick={close}>×</button>
        </div>
        <div class="modal-body">
          <Show when={info()} fallback={
            <div class="open-folder-pick">
              <p>Pick a folder with a compose file (<span class="mono">compose.yaml</span> or <span class="mono">docker-compose.yml</span>). Orca shows what's in it and starts it as a stack.</p>
              <Show when={!remote()}>
                <button class="btn btn-primary btn-lg" onClick={() => void choose()} disabled={info.loading}>
                  {info.loading ? "Looking…" : "Choose a folder…"}
                </button>
                <div class="open-folder-or">or paste a path, or drop a folder onto Orca's window</div>
              </Show>
              <Show when={remote()}>
                <div class="open-folder-or">You're managing a remote host: give the folder's path on that machine.</div>
              </Show>
              <form class="assistant-row" onSubmit={(e) => { e.preventDefault(); if (typed().trim()) open(typed().trim()); }}>
                <input class="form-input mono" placeholder="/path/to/project" value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} />
                <button class="btn" type="submit" disabled={!typed().trim() || info.loading}>Open</button>
              </form>
            </div>
          }>
            {(f) => (
              <div class="open-folder-info">
                <div class="open-folder-head">
                  <div>
                    <div class="open-folder-name">{f().name}</div>
                    <div class="mono open-folder-path">{f().display_path ?? f().path}</div>
                  </div>
                  <button class="btn btn-sm" onClick={() => { setError(""); setPath(""); setTyped(""); }} disabled={busy()}>Another folder</button>
                </div>

                <Show when={f().stack}>
                  {(stack) => (
                    <div class="open-folder-note ok">
                      This folder already runs in Orca as <b>{stack()}</b>.
                      <button class="btn btn-sm" onClick={() => { closeFolderDialog(); props.onNavigate(`stack:${stack()}`); }}>Show it</button>
                    </div>
                  )}
                </Show>

                <Show when={f().compose_files.length > 0} fallback={
                  <div class="open-folder-create">
                    <div class="open-folder-note">There's no compose file here yet. Orca creates <span class="mono">compose.yaml</span> with this, and starts it:</div>
                    <textarea class="form-textarea mono" rows={8} spellcheck={false} value={starter()} onInput={(e) => setStarter(e.currentTarget.value)} />
                  </div>
                }>
                  <div class="open-folder-facts">
                    <div><span>Compose</span><b class="mono">{f().compose_files.join(", ")}</b></div>
                    <Show when={f().services.length > 0}>
                      <div><span>Services</span><div class="open-folder-chips"><For each={f().services}>{(s) => <span class="chip">{s}</span>}</For></div></div>
                    </Show>
                    <Show when={f().profiles.length > 0}>
                      <div><span>Profiles</span><div class="open-folder-chips"><For each={f().profiles}>{(p) => <span class="chip muted">{p}</span>}</For><em>pick which run on the stack's page</em></div></div>
                    </Show>
                    <div><span>orca.yaml</span>{f().orca_yaml ? <b>Found: its routes and setup commands apply</b> : <em>None. Add routes later from the stack's orca.yaml tab</em>}</div>
                  </div>
                </Show>

                <Show when={f().git}>
                  <label class="open-folder-check">
                    <input type="checkbox" checked={addProject()} onChange={(e) => setAddProject(e.currentTarget.checked)} />
                    <span>Also add it to <b>Projects</b>, so each git worktree of it can run side by side</span>
                  </label>
                </Show>

                <Show when={f().conflict && !f().stack}>
                  <div class="open-folder-error">
                    Another folder, {f().conflict}, already runs as the stack “{f().name}”. Starting this one would replace it. Stop
                    that stack first, or rename this folder.
                  </div>
                </Show>
                <Show when={f().error}>
                  <div class="open-folder-error">{f().error}</div>
                </Show>
                <FolderActions path={f().path} />
              </div>
            )}
          </Show>
          <Show when={error()}>
            <div class="open-folder-error">{error()}</div>
          </Show>
        </div>
        <Show when={info()}>
          <div class="modal-footer">
            <button class="btn" onClick={close} disabled={busy()}>Cancel</button>
            <button class="btn btn-primary" disabled={busy() || !!info()?.error || (!!info()?.conflict && !info()?.stack)} onClick={() => void start()}>
              {busy() ? <><Spinner size={12} /> Starting…</> : info()?.stack ? "Start again" : info()?.compose_files.length ? "Start" : "Create and start"}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
