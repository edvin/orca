import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { PortGroup } from "../lib/ports";

/** How many ports a row shows before "+N". */
const INLINE = 2;

/** The port on this computer: "8080", or a run of them: "49160–49200". */
function hostText(g: PortGroup): string {
  const from = g.hostPort ?? g.port;
  return g.to ? `${from}–${from + g.to - g.port}` : `${from}`;
}

/** The container's side: "80", "5000–5040". */
function containerText(g: PortGroup): string {
  return g.to ? `${g.port}–${g.to}` : `${g.port}`;
}

const isLink = (g: PortGroup) => !!g.hostPort && !g.to && !g.protocol.startsWith("udp");
const url = (g: PortGroup) => `${[443, 8443, 9443].includes(g.hostPort!) ? "https" : "http"}://localhost:${g.hostPort}`;

function describe(g: PortGroup): string {
  const where = g.hostPort ? `localhost:${hostText(g)} → container ${containerText(g)}` : `container ${containerText(g)}, not published`;
  return [where, g.label, g.protocol.toUpperCase()].filter(Boolean).join(" · ");
}

function Chip(props: { g: PortGroup }) {
  return (
    <Show when={isLink(props.g)} fallback={<span class="port-chip" title={describe(props.g)}>{hostText(props.g)}</span>}>
      <a
        class="port-chip port-chip-web"
        href={url(props.g)}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); void shellOpen(url(props.g)); }}
        title={`Open ${url(props.g)}\n${describe(props.g)}`}
      >
        {hostText(props.g)}
      </a>
    </Show>
  );
}

/**
 * A container's published ports in a row: the first few as chips (the ones
 * that open in the browser first), and every one behind "+N".
 */
export default function PortLinks(props: { groups: PortGroup[] }) {
  const [open, setOpen] = createSignal(false);
  // Ports that open in the browser are the ones people come for.
  const sorted = () => [...props.groups].sort((a, b) => Number(isLink(b)) - Number(isLink(a)));
  const inline = () => sorted().slice(0, INLINE);
  const hidden = () => sorted().length - inline().length;

  let wrapper: HTMLSpanElement | undefined;
  const onDocClick = (e: MouseEvent) => { if (wrapper && !wrapper.contains(e.target as Node)) setOpen(false); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    const next = !open();
    setOpen(next);
    if (next) {
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
    }
  };
  const stopListening = () => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  };
  createEffect(() => { if (!open()) stopListening(); });
  onCleanup(stopListening);

  return (
    <span class="port-links">
      <For each={inline()}>{(g) => <Chip g={g} />}</For>
      <Show when={hidden() > 0}>
        <span class="port-more-wrap" ref={wrapper} onClick={(e) => e.stopPropagation()}>
          <button type="button" class={`port-chip port-more ${open() ? "open" : ""}`} onClick={toggle} title={`${sorted().length} ports`}>
            +{hidden()}
          </button>
          <Show when={open()}>
            <div class="port-pop">
              <div class="port-pop-title">{sorted().length} ports</div>
              <For each={sorted()}>
                {(g) => (
                  <div class={`port-pop-row ${isLink(g) ? "port-pop-row-web" : ""}`} title={describe(g)} onClick={() => isLink(g) && void shellOpen(url(g))}>
                    <span class="port-pop-host">{g.hostPort ? hostText(g) : "—"}</span>
                    <span class="port-pop-arrow">→</span>
                    <span class="port-pop-ctr">{containerText(g)}</span>
                    <span class="port-pop-label">{g.label ?? (g.protocol === "tcp" ? "" : g.protocol.toUpperCase())}</span>
                    <Show when={isLink(g)}>
                      <svg class="port-pop-open" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </span>
      </Show>
    </span>
  );
}
