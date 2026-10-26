import { For, Show } from "solid-js";
import type { PortGroup } from "../lib/ports";

/** The run's or port's number on this computer, if published. */
function hostText(g: PortGroup): string | undefined {
  if (!g.hostPort) return undefined;
  return g.to ? `${g.hostPort}–${g.hostPort + g.to - g.port}` : `${g.hostPort}`;
}

function containerText(g: PortGroup): string {
  return g.to ? `${g.port}–${g.to}` : `${g.port}`;
}

/** A single TCP port published here can be opened in the browser. */
function url(g: PortGroup): string | undefined {
  if (!g.hostPort || g.to || g.protocol === "udp") return undefined;
  const proto = [443, 8443, 9443].includes(g.hostPort) ? "https" : "http";
  return `${proto}://localhost:${g.hostPort}`;
}

/**
 * A container's port mappings in a grid that uses the width it has, runs of
 * ports folded into one range. `cards` for the Ports section, a compact grid
 * of one-liners otherwise.
 */
export default function PortMappings(props: { groups: PortGroup[]; cards?: boolean }) {
  return (
    <div style={{
      display: "grid",
      "grid-template-columns": `repeat(auto-fill, minmax(${props.cards ? "240px" : "260px"}, 1fr))`,
      gap: props.cards ? "8px" : "2px 16px",
    }}>
      <For each={props.groups}>
        {(g) => {
          const host = hostText(g);
          const href = url(g);
          const proto = g.protocol.replace("+", " + ");
          const stop = (e: MouseEvent) => e.stopPropagation();
          return (
            <Show
              when={props.cards}
              fallback={
                <div
                  class="mono"
                  style={{ "font-size": "12px", "line-height": "1.8", display: "flex", gap: "6px", "align-items": "baseline", "min-width": "0", "white-space": "nowrap" }}
                  title={g.label ? `${g.label}, ${proto}` : proto}
                >
                  <Show when={host} fallback={<span style={{ color: "#6e7681" }}>not published</span>}>
                    <Show when={href} fallback={<span style={{ color: "#c9d1d9" }}>:{host}</span>}>
                      <a href={href} target="_blank" rel="noopener noreferrer" onClick={stop} style={{ color: "#58a6ff" }}>:{host}</a>
                    </Show>
                  </Show>
                  <span style={{ color: "#484f58" }}>{"→"}</span>
                  <span style={{ color: "#8b949e" }}>{containerText(g)}/{g.protocol}</span>
                  <Show when={g.label}>
                    <span style={{ color: "#6e7681", "font-family": "inherit", overflow: "hidden", "text-overflow": "ellipsis" }}>{g.label}</span>
                  </Show>
                </div>
              }
            >
              <div style={{
                display: "flex",
                "align-items": "center",
                gap: "10px",
                padding: "10px 14px",
                background: "rgba(255, 255, 255, 0.03)",
                border: "1px solid rgba(255, 255, 255, 0.06)",
                "border-radius": "8px",
                "min-width": "0",
              }}>
                <div style={{ flex: "1", "min-width": "0" }}>
                  <div class="mono" style={{ "font-size": "13px", display: "flex", gap: "8px", "align-items": "baseline", "white-space": "nowrap" }}>
                    <span style={{ "font-weight": "600", color: host ? "#e6edf3" : "#6e7681" }}>{host ?? "—"}</span>
                    <span style={{ color: "#484f58" }}>{"→"}</span>
                    <span style={{ color: "#8b949e" }}>{containerText(g)}</span>
                  </div>
                  <div style={{ "font-size": "11px", color: "#6e7681", "margin-top": "3px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                    {[g.label, proto.toUpperCase(), g.to ? `${g.to - g.port + 1} ports` : undefined, host ? undefined : "not published"].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <Show when={href}>
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="btn btn-sm"
                    style={{ "font-size": "11px", padding: "4px 10px", "flex-shrink": "0" }}
                    onClick={stop}
                    title={`Open ${href}`}
                  >
                    Open
                  </a>
                </Show>
              </div>
            </Show>
          );
        }}
      </For>
    </div>
  );
}
