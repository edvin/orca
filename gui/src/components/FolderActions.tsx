// "Open in VS Code / Terminal / Finder" for a folder on this computer.

import { createResource, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./Toast";

interface FolderApp {
  id: string;
  label: string;
  kind: "editor" | "terminal";
}

let appsCache: Promise<FolderApp[]> | null = null;
const folderApps = () => (appsCache ??= invoke<FolderApp[]>("folder_apps").catch(() => []));

let remoteCache: Promise<boolean> | null = null;
document.addEventListener("orca-host-switch", () => {
  remoteCache = null;
});
/** Folders of a remote host aren't on this computer. */
export const isRemoteHost = () =>
  (remoteCache ??= invoke<{ is_remote: boolean }>("get_active_host").then((h) => h.is_remote, () => false));

const fileManager = navigator.platform.includes("Mac") ? "Finder" : navigator.platform.includes("Win") ? "Explorer" : "Files";

const ICONS = {
  editor: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16" />
    </svg>
  ),
  terminal: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="m7 9 3 3-3 3M12.5 15H17" />
    </svg>
  ),
  files: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v6.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5Z" />
    </svg>
  ),
};

/** The first editor and the first terminal found, plus the file manager:
 *  labelled buttons, or with `compact`, icons with a tooltip. */
export default function FolderActions(props: { path: string; compact?: boolean }) {
  const [apps] = createResource(async () => ((await isRemoteHost()) ? null : folderApps()));
  const pick = (kind: string) => (apps() ?? []).find((a) => a.kind === kind);
  const open = (app: FolderApp) =>
    invoke("open_folder_in", { path: props.path, app: app.id }).catch((e) => showToast(String(e), "error"));
  const reveal = () => invoke("reveal_path", { path: props.path }).catch((e) => showToast(String(e), "error"));

  return (
    <Show when={apps()}>
      <div class="folder-actions" classList={{ compact: !!props.compact }}>
        <For each={[pick("editor"), pick("terminal")].filter((a): a is FolderApp => !!a)}>
          {(a) => (
            <Show when={props.compact} fallback={
              <button class="btn btn-sm" title={`Open ${props.path} in ${a.label}`} onClick={() => void open(a)}>
                Open in {a.label}
              </button>
            }>
              <button class="btn btn-sm btn-icon" data-tip={`Open in ${a.label}`} aria-label={`Open in ${a.label}`}
                onClick={() => void open(a)}>
                {ICONS[a.kind]()}
              </button>
            </Show>
          )}
        </For>
        <Show when={props.compact} fallback={
          <button class="btn btn-sm" title={`Show ${props.path} in ${fileManager}`} onClick={reveal}>{fileManager}</button>
        }>
          <button class="btn btn-sm btn-icon" data-tip={`Show in ${fileManager}`} aria-label={`Show in ${fileManager}`}
            onClick={reveal}>
            {ICONS.files()}
          </button>
        </Show>
      </div>
    </Show>
  );
}
