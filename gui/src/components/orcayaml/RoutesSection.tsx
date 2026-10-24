// Routes in the orca.yaml editor: one card per route, with the service and
// port picked from the stack, the URL it gives, and how it shows on the
// landing page. Suggests routes the stack is missing, such as Soketi's
// /app/* for Pusher clients.

import { createSignal, For, Index, Show } from "solid-js";
import Dropdown from "../Dropdown";
import HelpLink from "../HelpLink";
import { fullHost, type RouteM } from "./model";

export interface StudioService {
  name: string;
  image?: string | null;
  ports: number[];
}

export interface RouteStatus {
  hostname: string;
  path?: string | null;
  status: "active" | "paused" | "waiting" | "blocked" | "unknown";
  detail: string;
}

const STATUS: Record<RouteStatus["status"], { label: string; color: string }> = {
  active: { label: "Active", color: "#3fb950" },
  paused: { label: "Paused", color: "#8b949e" },
  waiting: { label: "Waiting", color: "#d29922" },
  blocked: { label: "Not applied", color: "#f85149" },
  unknown: { label: "No such service", color: "#f85149" },
};

/** Ports that look like a web app or UI, in order of preference. */
const WEB_PORTS = [80, 8080, 3000, 5173, 8000, 4200, 5000, 8081, 3001, 8888, 9000, 4000, 1080, 8025, 8123, 15672, 9001];

const label = { "font-size": "11px", color: "#8b949e", "margin-bottom": "4px", display: "block" } as const;
const muted = { color: "#8b949e", "font-size": "12px" } as const;

export default function RoutesSection(props: {
  routes: RouteM[];
  services: StudioService[];
  domain: string;
  projectName: string;
  status?: RouteStatus[];
  onChange: (routes: RouteM[]) => void;
}) {
  const [open, setOpen] = createSignal<Set<number>>(new Set());
  const [customPort, setCustomPort] = createSignal<Set<number>>(new Set());

  const update = (i: number, patch: Partial<RouteM>) =>
    props.onChange(props.routes.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => {
    // Disclosure state is by index; start over rather than shift it.
    setOpen(new Set<number>());
    setCustomPort(new Set<number>());
    props.onChange(props.routes.filter((_, j) => j !== i));
  };
  const add = (r: RouteM) => props.onChange([...props.routes, r]);
  const toggle = (set: Set<number>, i: number) => {
    const next = new Set(set);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  };

  const slug = () => props.projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
  const portsOf = (service: string) => props.services.find((s) => s.name === service)?.ports ?? [];
  const webPort = (s: StudioService) => WEB_PORTS.find((p) => s.ports.includes(p));
  // The hostname the app itself is on: its first route without a path.
  const mainHost = () => props.routes.find((r) => r.hostname && !r.path)?.hostname ?? slug();

  const pusher = () => props.services.find((s) => (s.image ?? "").includes("soketi"));
  const pusherRouted = () => !!pusher() && props.routes.some((r) => r.service === pusher()!.name);
  const unrouted = () =>
    props.services.filter((s) => s !== pusher() && webPort(s) && !props.routes.some((r) => r.service === s.name));

  const statusOf = (r: RouteM) =>
    props.status?.find((s) => s.hostname === fullHost(r.hostname, props.domain) && (s.path ?? undefined) === (r.path || undefined));

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
      <p style={{ ...muted, "font-size": "13px", "line-height": "1.5" }}>
        Each route gives a service an HTTPS hostname through the gateway. WebSockets work with no setup.{" "}
        <HelpLink path="/docs/orca-yaml/#gateway" />
      </p>

      {/* Soketi / Pusher: browsers connect to /app/ on the page's own host. */}
      <Show when={pusher() && !pusherRouted()}>
        <div class="card" style={{ display: "flex", gap: "12px", "align-items": "center", "flex-wrap": "wrap", "border-color": "rgba(88,166,255,0.35)" }}>
          <div style={{ flex: "1", "min-width": "260px" }}>
            <div style={{ color: "#e6edf3", "font-size": "13px", "font-weight": "600" }}>Route Pusher traffic to {pusher()!.name}</div>
            <div style={{ ...muted, "margin-top": "3px", "line-height": "1.5" }}>
              Laravel Echo and pusher-js connect to <span class="mono">/app/…</span> on the page's own hostname. One route sends just
              that path to {pusher()!.name}; everything else on {fullHost(mainHost(), props.domain)} keeps going to the app.
            </div>
          </div>
          <button class="btn btn-sm btn-primary"
            onClick={() => add({ hostname: mainHost(), service: pusher()!.name, port: pusher()!.ports[0] ?? 6001, path: "/app/*" })}>
            Add /app/* route
          </button>
        </div>
      </Show>

      <Show when={unrouted().length > 0}>
        <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap", "align-items": "center" }}>
          <span style={muted}>Without a route:</span>
          <For each={unrouted()}>
            {(s) => (
              <button class="btn btn-sm"
                onClick={() => add({ hostname: props.routes.length === 0 ? slug() : `${s.name}-${slug()}`, service: s.name, port: webPort(s) ?? null })}>
                + {s.name} :{webPort(s)}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Index each={props.routes}>
        {(r, idx) => {
          const i = () => idx;
          const url = () => {
            const host = fullHost(r().hostname, props.domain);
            return host ? `https://${host}${(r().path ?? "").replace(/\*$/, "")}` : "";
          };
          const ports = () => portsOf(r().service);
          const st = () => statusOf(r());
          return (
            <div class="card" style={{ padding: "12px 14px", display: "flex", "flex-direction": "column", gap: "10px" }}>
              <div style={{ display: "grid", "grid-template-columns": "minmax(160px,1.4fr) minmax(130px,1fr) 110px minmax(110px,0.8fr) auto", gap: "10px", "align-items": "end" }}>
                <label>
                  <span style={label}>Hostname</span>
                  <input class="form-input" value={r().hostname} placeholder={slug()} onInput={(e) => update(i(), { hostname: e.currentTarget.value })} />
                </label>
                <div>
                  <span style={label}>Service</span>
                  <Dropdown value={r().service} placeholder="Pick a service"
                    options={[...props.services.map((s) => ({ value: s.name, label: s.name })),
                      ...(r().service && !props.services.some((s) => s.name === r().service) ? [{ value: r().service, label: `${r().service} (not running)` }] : [])]}
                    onChange={(v) => update(i(), { service: v, port: r().port ?? webPort(props.services.find((s) => s.name === v) ?? { name: v, ports: [] }) ?? null })} />
                </div>
                <div>
                  <span style={label}>Port</span>
                  <Show when={ports().length > 0 && !customPort().has(i()) && (r().port === null || ports().includes(r().port!))}
                    fallback={<input class="form-input" type="number" min="1" max="65535" value={r().port ?? ""} placeholder="3000"
                      onInput={(e) => update(i(), { port: e.currentTarget.value ? Number(e.currentTarget.value) : null })} />}>
                    <Dropdown value={r().port ? String(r().port) : ""} placeholder="Port"
                      options={[...ports().map((p) => ({ value: String(p), label: String(p) })), { value: "other", label: "Other…" }]}
                      onChange={(v) => {
                        if (v === "other") setCustomPort((s) => toggle(s, i()));
                        else update(i(), { port: Number(v) });
                      }} />
                  </Show>
                </div>
                <label>
                  <span style={label}>Path</span>
                  <input class="form-input" value={r().path ?? ""} placeholder="All paths" onInput={(e) => update(i(), { path: e.currentTarget.value || undefined })} />
                </label>
                <button class="action-icon action-icon-delete" title="Remove route" style={{ color: "#f85149", "margin-bottom": "6px" }} onClick={() => remove(i())}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
              </div>
              <div style={{ display: "flex", gap: "12px", "align-items": "center", "flex-wrap": "wrap", "font-size": "12px" }}>
                <span class="mono" style={{ color: url() ? "#58a6ff" : "#6e7681" }}>{url() || "Give it a hostname"}</span>
                <Show when={st()}>
                  {(s) => (
                    <span style={{ color: STATUS[s().status].color, "font-weight": "600" }}>
                      {STATUS[s().status].label}<Show when={s().detail}><span style={{ ...muted, "font-weight": "400" }}> · {s().detail}</span></Show>
                    </span>
                  )}
                </Show>
                <Show when={r().hidden}><span style={muted}>Hidden from the landing page</span></Show>
                <button class="btn-link" style={{ "margin-left": "auto", color: "#58a6ff", background: "none", border: "none", cursor: "pointer", padding: "0", "font-size": "12px" }}
                  onClick={() => setOpen((s) => toggle(s, i()))}>
                  {open().has(i()) ? "Hide landing page details" : `Landing page${r().title ? `: ${r().title}` : ""}`}
                </button>
              </div>
              <Show when={open().has(i())}>
                <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px", "padding-top": "4px", "border-top": "1px solid #21262d" }}>
                  <label><span style={label}>Title</span>
                    <input class="form-input" value={r().title ?? ""} placeholder="From the hostname" onInput={(e) => update(i(), { title: e.currentTarget.value || undefined })} /></label>
                  <label><span style={label}>Group</span>
                    <input class="form-input" value={r().group ?? ""} placeholder={props.projectName} onInput={(e) => update(i(), { group: e.currentTarget.value || undefined })} /></label>
                  <label style={{ "grid-column": "1 / -1" }}><span style={label}>Description</span>
                    <input class="form-input" value={r().description ?? ""} placeholder="What it is, in a few words" onInput={(e) => update(i(), { description: e.currentTarget.value || undefined })} /></label>
                  <label><span style={label}>Icon URL</span>
                    <input class="form-input" value={r().icon ?? ""} placeholder="https://…/logo.png" onInput={(e) => update(i(), { icon: e.currentTarget.value || undefined })} /></label>
                  <label style={{ display: "flex", "align-items": "center", gap: "8px", "font-size": "13px", color: "#c9d1d9", "padding-top": "18px" }}>
                    <input type="checkbox" checked={!!r().hidden} onChange={(e) => update(i(), { hidden: e.currentTarget.checked || undefined })} />
                    Hide from the landing page
                  </label>
                </div>
              </Show>
            </div>
          );
        }}
      </Index>

      <div>
        <button class="btn btn-sm" onClick={() => add({ hostname: props.routes.length === 0 ? slug() : "", service: props.services[0]?.name ?? "", port: props.services[0] ? webPort(props.services[0]) ?? null : null })}>
          + Add route
        </button>
      </div>
    </div>
  );
}
