// The "Open a project folder" dialog, opened from anywhere: the dashboard,
// Containers, ⌘K, or a folder dropped onto the window.

import { createSignal } from "solid-js";

/** `undefined`: closed. `""`: open, asking for a folder. A path: open on it. */
const [folder, setFolder] = createSignal<string | undefined>(undefined);

export const openFolderTarget = folder;
export function openFolderDialog(path = "") {
  setFolder(path);
}
export function closeFolderDialog() {
  setFolder(undefined);
}
