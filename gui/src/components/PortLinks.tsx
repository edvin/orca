import { createSignal, For, Show } from "solid-js";
import type { PortGroup } from "../lib/ports";

const MAX = 4;

/** "8080:80", or the run's ports on this computer: "49160–49200". */
function text(g: PortGroup): string {
  if (g.to) {
    const from = g.hostPort ?? g.port;
    return `${from}–${from + g.to - g.port}`;
  }
  return g.hostPort ? `${g.hostPort}:${g.port}` : `${g.port}`;
}

/**
 * A container's published ports in a table cell: links to the web ones,
 * runs folded into a range, and the rest behind "+N more".
 */
export default function PortLinks(props: { groups: PortGroup[] }) {
  const [open, setOpen] = createSignal(false);
  const shown = () => (open() ? props.groups : props.groups.slice(0, MAX));
  const hidden = () => props.groups.length - shown().length;
  return (
    <>
      <For each={shown()}>
        {(g) => (
          <Show
            when={g.hostPort && !g.to && !g.protocol.startsWith("udp")}
            fallback={
              <span
                style={{ color: "#8b949e", "font-size": "12px", "white-space": "nowrap" }}
                title={g.label ? `${g.label}, ${g.protocol.toUpperCase()}` : g.protocol.toUpperCase()}
              >
                {text(g)}
              </span>
            }
          >
            {(() => {
              const proto = [443, 8443, 9443].includes(g.hostPort!) ? "https" : "http";
              return (
                <a
                  href={`${proto}://localhost:${g.hostPort}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{ color: "#58a6ff", "font-size": "12px", "white-space": "nowrap" }}
                  title={`Open ${proto}://localhost:${g.hostPort}${g.label ? ` (${g.label})` : ""}`}
                >
                  {text(g)}
                </a>
              );
            })()}
          </Show>
        )}
      </For>
      <Show when={props.groups.length > MAX}>
        <button
          type="button"
          class="link-button"
          onClick={(e) => { e.stopPropagation(); setOpen(!open()); }}
          style={{ color: "#8b949e", "font-size": "11px", background: "none", border: "none", padding: "0", cursor: "pointer", "white-space": "nowrap" }}
        >
          {open() ? "less" : `+${hidden()} more`}
        </button>
      </Show>
    </>
  );
}
