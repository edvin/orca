import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";

export interface TopologyNetwork {
  id: string;
  name: string;
  driver: string;
  subnet: string | null;
  gateway: string | null;
  containers: Array<{ id: string; name: string; ip: string }>;
}

const COLORS = ["#58a6ff", "#3fb950", "#bc8cff", "#f0883e", "#39c5cf", "#f778ba", "#e3b341", "#a5d6ff"];

type Focus = { kind: "net" | "ctr"; id: string } | null;
type Link = { d: string; color: string; x1: number; y1: number; x2: number; y2: number };

/** "shop-web-1" in shop_default reads "web-1": the network already says which stack. */
function chipLabel(net: TopologyNetwork, name: string): string {
  const stack = net.name.endsWith("_default") ? net.name.slice(0, -"_default".length) : null;
  return stack && name.startsWith(`${stack}-`) && name.length > stack.length + 1 ? name.slice(stack.length + 1) : name;
}

function tag(net: TopologyNetwork): string | null {
  if (net.name === "orca-gateway") return "Gateway";
  if (net.name === "bridge") return "Docker default";
  if (net.name.endsWith("_default")) return "Compose";
  return null;
}

/**
 * Docker's networks as cards, each with the containers on it. A container on
 * several networks is what connects them: hover it (or a network) and Orca
 * draws where else it is.
 */
export default function NetworkMap(props: { networks: TopologyNetwork[]; onOpenContainer?: (id: string) => void }) {
  const [focus, setFocus] = createSignal<Focus>(null);
  const [links, setLinks] = createSignal<Link[]>([]);
  let wrap: HTMLDivElement | undefined;

  const used = () =>
    props.networks
      .filter((n) => n.containers.length > 0)
      .sort((a, b) => b.containers.length - a.containers.length || a.name.localeCompare(b.name));
  const empty = () => props.networks.filter((n) => n.containers.length === 0).sort((a, b) => a.name.localeCompare(b.name));
  const color = (netId: string) => COLORS[Math.max(0, used().findIndex((n) => n.id === netId)) % COLORS.length];

  // Container id -> the networks it's on.
  const netsOf = () => {
    const m = new Map<string, TopologyNetwork[]>();
    for (const n of used()) for (const c of n.containers) m.set(c.id, [...(m.get(c.id) ?? []), n]);
    return m;
  };
  const bridging = () => [...netsOf().values()].filter((ns) => ns.length > 1).length;
  const containerCount = () => netsOf().size;

  /** Networks that share a container with `net`. */
  const neighbours = (net: TopologyNetwork) => {
    const out = new Set<string>();
    for (const c of net.containers) for (const n of netsOf().get(c.id) ?? []) if (n.id !== net.id) out.add(n.id);
    return out;
  };

  const netLit = (net: TopologyNetwork) => {
    const f = focus();
    if (!f) return false;
    if (f.kind === "ctr") return net.containers.some((c) => c.id === f.id);
    const focused = props.networks.find((n) => n.id === f.id);
    return f.id === net.id || (!!focused && neighbours(focused).has(net.id));
  };
  const chipLit = (net: TopologyNetwork, cid: string) => {
    const f = focus();
    if (!f) return false;
    if (f.kind === "ctr") return f.id === cid;
    const nets = netsOf().get(cid) ?? [];
    return nets.length > 1 && nets.some((n) => n.id === f.id);
  };

  // The links: one curve from each chip of the container to its next chip.
  const measure = () => {
    const f = focus();
    if (!wrap || !f) return setLinks([]);
    const base = wrap.getBoundingClientRect();
    const ids = f.kind === "ctr" ? [f.id] : (props.networks.find((n) => n.id === f.id)?.containers ?? []).map((c) => c.id).filter((id) => (netsOf().get(id)?.length ?? 0) > 1);
    const out: Link[] = [];
    for (const id of ids) {
      const chips = [...wrap.querySelectorAll<HTMLElement>(`.netmap-chip[data-cid="${CSS.escape(id)}"]`)];
      // From the hovered network's chip outwards; otherwise in reading order.
      const from = f.kind === "net" ? chips.find((el) => el.dataset.net === f.id) : chips[0];
      if (!from) continue;
      for (const to of chips) {
        if (to === from) continue;
        const a = from.getBoundingClientRect();
        const b = to.getBoundingClientRect();
        // Out of one chip's side and into the other's, like a node editor.
        const ya = a.top + a.height / 2 - base.top, yb = b.top + b.height / 2 - base.top;
        let x1: number, x2: number, d: string;
        if (b.left >= a.right || b.right <= a.left) {
          const right = b.left >= a.right;
          x1 = (right ? a.right : a.left) - base.left;
          x2 = (right ? b.left : b.right) - base.left;
          const k = Math.max(40, Math.abs(x2 - x1) * 0.5) * (right ? 1 : -1);
          d = `M ${x1} ${ya} C ${x1 + k} ${ya}, ${x2 - k} ${yb}, ${x2} ${yb}`;
        } else {
          // One above the other: both from the right, bulging out.
          x1 = a.right - base.left;
          x2 = b.right - base.left;
          const k = 50 + Math.abs(yb - ya) * 0.15;
          const xm = Math.max(x1, x2) + k;
          d = `M ${x1} ${ya} C ${xm} ${ya}, ${xm} ${yb}, ${x2} ${yb}`;
        }
        const y1 = ya, y2 = yb;
        out.push({ d, color: color(to.dataset.net ?? ""), x1, y1, x2, y2 });
      }
    }
    setLinks(out);
  };

  // Again whenever the focus or the networks change (chips move on refresh).
  createEffect(on([focus, () => props.networks], () => requestAnimationFrame(measure)));
  onMount(() => {
    const ro = new ResizeObserver(() => measure());
    if (wrap) ro.observe(wrap);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div class="netmap" ref={wrap} classList={{ "netmap-focused": focus() !== null }} onMouseLeave={() => setFocus(null)}>
      <div class="netmap-bar">
        <span><strong>{used().length}</strong> networks in use</span>
        <span class="netmap-bar-sep" />
        <span><strong>{containerCount()}</strong> containers</span>
        <Show when={bridging() > 0}>
          <span class="netmap-bar-sep" />
          <span class="netmap-bar-bridge"><strong>{bridging()}</strong> on more than one network</span>
        </Show>
        <span class="netmap-hint">Hover a container or a network to see what it connects</span>
      </div>

      <div class="netmap-grid">
        <For each={used()}>
          {(net) => (
            <section
              class="netmap-card"
              classList={{ "netmap-lit": netLit(net) }}
              style={{ "--net": color(net.id) }}
              onMouseEnter={() => setFocus({ kind: "net", id: net.id })}
              onMouseLeave={() => setFocus(null)}
            >
              <header class="netmap-head">
                <span class="netmap-swatch" />
                <div class="netmap-title">
                  <div class="netmap-name">
                    {net.name}
                    <Show when={tag(net)}><span class="netmap-tag">{tag(net)}</span></Show>
                  </div>
                  <div class="netmap-meta">
                    {net.driver || "none"}
                    <Show when={net.subnet}><span> · {net.subnet}</span></Show>
                    <Show when={net.gateway}><span> · gateway {net.gateway}</span></Show>
                  </div>
                </div>
                <span class="netmap-count" title={`${net.containers.length} containers`}>{net.containers.length}</span>
              </header>
              <div class="netmap-chips">
                <For each={[...net.containers].sort((a, b) => a.name.localeCompare(b.name))}>
                  {(c) => {
                    const others = () => (netsOf().get(c.id) ?? []).filter((n) => n.id !== net.id);
                    return (
                      <button
                        type="button"
                        class="netmap-chip"
                        classList={{ "netmap-chip-lit": chipLit(net, c.id), "netmap-chip-shared": others().length > 0 }}
                        data-cid={c.id}
                        data-net={net.id}
                        title={`${c.name}${c.ip ? `\n${c.ip}` : ""}${others().length ? `\nAlso on ${others().map((n) => n.name).join(", ")}` : ""}`}
                        onMouseEnter={(e) => { e.stopPropagation(); setFocus({ kind: "ctr", id: c.id }); }}
                        onMouseLeave={() => setFocus({ kind: "net", id: net.id })}
                        onClick={() => props.onOpenContainer?.(c.id)}
                      >
                        <span class="netmap-chip-name">{chipLabel(net, c.name)}</span>
                        <Show when={c.ip}><span class="netmap-chip-ip">{c.ip.split("/")[0]}</span></Show>
                        <Show when={others().length > 0}>
                          <span class="netmap-chip-also">
                            <For each={others()}>{(n) => <span class="netmap-dot" style={{ background: color(n.id) }} />}</For>
                          </span>
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </div>
            </section>
          )}
        </For>
      </div>

      <Show when={empty().length > 0}>
        <div class="netmap-empty">
          <span>No containers on</span>
          <For each={empty()}>{(n) => <span class="netmap-empty-name" title={`${n.driver || "none"}${n.subnet ? ` · ${n.subnet}` : ""}`}>{n.name}</span>}</For>
        </div>
      </Show>

      <svg class="netmap-links" aria-hidden="true">
        <For each={links()}>
          {(l) => (
            <g style={{ "--link": l.color }}>
              <path class="netmap-link-glow" d={l.d} />
              <path class="netmap-link" d={l.d} />
              <circle class="netmap-link-end" cx={l.x1} cy={l.y1} r="3.5" />
              <circle class="netmap-link-end" cx={l.x2} cy={l.y2} r="3.5" />
            </g>
          )}
        </For>
      </svg>
    </div>
  );
}
