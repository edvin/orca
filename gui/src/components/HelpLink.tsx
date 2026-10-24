import type { JSX } from "solid-js";
import { open as shellOpen } from "@tauri-apps/plugin-shell";

const SITE = "https://orca-desktop.com";

/** Opens a page of Orca's docs in the browser. */
export function openDocs(path: string) {
  const url = SITE + path;
  return shellOpen(url).catch(() => window.open(url, "_blank", "noopener,noreferrer"));
}

/**
 * A link to the docs, for a page's one-line subtitle: "Every git worktree
 * of a project, running side by side. How it works". Pages say what they're
 * for in a line and leave the explaining to the docs.
 */
export default function HelpLink(props: { path: string; children?: JSX.Element }) {
  return (
    <button
      type="button"
      class="help-link"
      onClick={(e) => {
        e.stopPropagation();
        void openDocs(props.path);
      }}
    >
      {props.children ?? "How it works"}
    </button>
  );
}
