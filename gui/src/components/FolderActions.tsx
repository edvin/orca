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

/** The first editor and the first terminal found, plus the file manager. */
export default function FolderActions(props: { path: string; compact?: boolean }) {
  const [apps] = createResource(async () => ((await isRemoteHost()) ? null : folderApps()));
  const pick = (kind: string) => (apps() ?? []).find((a) => a.kind === kind);
  const open = (app: FolderApp) =>
    invoke("open_folder_in", { path: props.path, app: app.id }).catch((e) => showToast(String(e), "error"));

  return (
    <Show when={apps()}>
      <div class="folder-actions">
        <For each={[pick("editor"), pick("terminal")].filter((a): a is FolderApp => !!a)}>
          {(a) => (
            <button class="btn btn-sm" title={`Open ${props.path} in ${a.label}`} onClick={() => void open(a)}>
              {props.compact ? a.label : `Open in ${a.label}`}
            </button>
          )}
        </For>
        <button class="btn btn-sm" title={`Show ${props.path} in ${fileManager}`}
          onClick={() => invoke("reveal_path", { path: props.path }).catch((e) => showToast(String(e), "error"))}>
          {fileManager}
        </button>
      </div>
    </Show>
  );
}
