// A container's Overview tab: where it sits (stack, image, engine), how it's
// doing (health, restart policy, gateway), and live usage drawn as instruments.

import { createMemo, createResource, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { ActiveHost, Container, ContainerStats } from "../lib/types";
import { getMetricsHistory, type MetricSnapshot } from "../lib/metricsStore";
import { containersStore } from "../lib/dockerStore";
import { useHealth } from "../lib/healthStore";
import { formatBytes, formatTimestamp, splitImage } from "../lib/format";
import { portGroups, portText } from "../lib/ports";
import CopyButton from "./CopyButton";

type HealthEntry = { output: string; exit_code: number; started_at: string; finished_at: string };

export interface ContainerOverviewProps {
  container: Container;
  stats: ContainerStats | null;
  inspect: any;
  onTab: (tab: "logs" | "terminal" | "files" | "resources" | "inspect") => void;
  onExpose: () => void;
  onOpenStack?: (stack: string) => void;
  onOpenImage?: (ref: string) => void;
  /** Bumped when the gateway's routes may have changed. */
  routesVersion?: number;
}

const ACCENTS = ["#f0883e", "#58a6ff", "#3fb950", "#bc8cff", "#39c5cf", "#f778ba", "#e3b341"];
const accentOf = (name: string) => ACCENTS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % ACCENTS.length];

function parseTime(v: string | number | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  const d = !isNaN(n) && n > 1e8 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(v as string);
  return isNaN(d.getTime()) || d.getFullYear() < 1971 ? null : d;
}

function since(d: Date | null): string {
  if (!d) return "–";
  const diff = Date.now() - d.getTime();
  if (diff < 0) return "–";
  const m = Math.floor(diff / 60000), h = Math.floor(m / 60), days = Math.floor(h / 24);
  if (days > 0) return `${days}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return m > 0 ? `${m}m` : "< 1m";
}

/** Bytes per second between the last two readings. */
function rate(h: MetricSnapshot[], key: "networkRx" | "networkTx"): number | null {
  if (h.length < 2) return null;
  const a = h[h.length - 2], b = h[h.length - 1];
  const dt = (b.timestamp - a.timestamp) / 1000;
  return dt > 0 ? Math.max(0, (b[key] - a[key]) / dt) : null;
}

/** An area sparkline that fills its box. */
function Spark(props: { data: number[]; color: string; max?: number; id: string }) {
  const path = createMemo(() => {
    const d = props.data;
    if (d.length < 2) return null;
    const max = Math.max(props.max ?? 0, ...d, 1e-9);
    const pts = d.map((v, i) => [(i / (d.length - 1)) * 300, 30 - (v / max) * 26] as const);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    return { line, area: `${line} L300 34 L0 34 Z`, last: pts[pts.length - 1] };
  });
  return (
    <Show when={path()} fallback={<div class="cov-spark-empty">Collecting readings…</div>}>
      {(p) => (
        <svg class="cov-spark" viewBox="0 0 300 34" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={`cov-g-${props.id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stop-color={props.color} stop-opacity="0.35" />
              <stop offset="1" stop-color={props.color} stop-opacity="0" />
            </linearGradient>
          </defs>
          <path d={p().area} fill={`url(#cov-g-${props.id})`} />
          <path d={p().line} fill="none" stroke={props.color} stroke-width="1.6" vector-effect="non-scaling-stroke" />
        </svg>
      )}
    </Show>
  );
}

/** A 270° gauge, filled to `pct`. */
function Gauge(props: { pct: number; color: string; label: string }) {
  const r = 38, c = 2 * Math.PI * r, arc = c * 0.75;
  const fill = () => Math.max(0.5, Math.min(100, props.pct)) / 100 * arc;
  return (
    <svg class="cov-gauge" width="88" height="88" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r={r} fill="none" stroke="#1c2430" stroke-width="6" stroke-linecap="round"
        stroke-dasharray={`${arc} ${c}`} transform="rotate(135 50 50)" />
      <circle cx="50" cy="50" r={r} fill="none" stroke={props.color} stroke-width="6" stroke-linecap="round"
        stroke-dasharray={`${fill()} ${c}`} transform="rotate(135 50 50)" style={{ filter: `drop-shadow(0 0 4px ${props.color})` }} />
      <circle cx="50" cy="50" r="24" fill="#0e131a" stroke="#273140" />
      <text x="50" y="54" fill="#8b97a6" font-size="11" text-anchor="middle">{props.label}</text>
    </svg>
  );
}

export default function ContainerOverview(props: ContainerOverviewProps) {
  const c = () => props.container;
  const running = () => c().state === "Running";
  const history = () => getMetricsHistory(c().id);
  const all = containersStore.use();
  const { health } = useHealth();

  const stack = () => c().labels?.["com.docker.compose.project"] ?? null;
  const stackMembers = () => {
    const s = stack();
    return s ? all.list().filter((x) => x.labels?.["com.docker.compose.project"] === s) : [];
  };

  const [networks] = createResource(() => c().id, async (id) => {
    try {
      const topo = (await invoke("network_topology")) as Array<{ name: string; containers: Array<{ id: string; ip: string }> }>;
      return topo.filter((n) => n.containers.some((x) => x.id === id)).map((n) => n.name);
    } catch {
      return [] as string[];
    }
  });
  const [route] = createResource(() => [c().name, props.routesVersion ?? 0] as const, async ([name]) => {
    try {
      const routes = (await invoke("gateway_list_routes")) as Array<{ hostname: string; path?: string | null; container_name: string; url?: string; port?: number }>;
      const r = routes.find((x) => x.container_name === name);
      if (!r) return null;
      // "/api/*" serves under /api/
      const path = (r.path ?? "").replace(/\*$/, "");
      return { hostname: `${r.hostname}${path.replace(/\/$/, "")}`, url: r.url || `https://${r.hostname}${path}`, port: r.port };
    } catch {
      return null;
    }
  });

  const ports = () => portGroups(c().image, c().ports);
  const webPort = () => ports().find((g) => g.kind === "web" && g.hostPort);
  const openUrl = () => route()?.url ?? (webPort() ? `http://localhost:${webPort()!.hostPort}` : null);

  const healthStatus = () => c().health_status || props.inspect?.health_status || "";
  const healthLog = (): HealthEntry[] => (c().health_log ?? props.inspect?.health_log ?? []) as HealthEntry[];
  const hasHealth = () => !!healthStatus() && healthStatus() !== "none";
  const healthColor = () => (healthStatus() === "healthy" ? "#7ee2a0" : healthStatus() === "unhealthy" ? "#ff7b72" : "#e3b341");

  const started = () => parseTime(props.inspect?.started_at ?? null);
  const command = (): string => {
    const cmd = props.inspect?.command;
    return Array.isArray(cmd) ? cmd.join(" ") : typeof cmd === "string" ? cmd : "";
  };

  const memLimited = () => (c().memory_limit ?? 0) > 0;
  const memPct = () => {
    const s = props.stats;
    return s && s.memory_limit_bytes > 0 ? (s.memory_usage_bytes / s.memory_limit_bytes) * 100 : 0;
  };
  const [host] = createResource(async () => {
    try {
      return (await invoke("get_active_host")) as ActiveHost;
    } catch {
      return null;
    }
  });

  const restartPolicy = () => c().restart_policy || "no";
  const restarts = () => c().restart_count ?? 0;

  const num = (v: string) => {
    const m = v.match(/^([\d.,]+)\s*(.*)$/);
    return m ? { n: m[1], u: m[2] } : { n: v, u: "" };
  };

  return (
    <div class="cov">
      {/* Where it sits */}
      <div class="cov-ctx">
        <div class="cov-ctx-cell">
          <Show when={stack()} fallback={
            <>
              <div class="cov-badge" style={{ "--accent": "#58a6ff" }}>
                <svg viewBox="0 0 24 24"><path d="M12 2l9 5v10l-9 5-9-5V7z" /><path d="M3 7l9 5 9-5M12 12v10" /></svg>
              </div>
              <div>
                <div class="cov-lbl">Container</div>
                <div class="cov-big">Standalone</div>
                <div class="cov-sub">Not part of a stack</div>
              </div>
            </>
          }>
            {(s) => (
              <>
                <div class="cov-badge" style={{ "--accent": accentOf(s()) }}>{s()[0]?.toUpperCase()}</div>
                <div class="cov-min">
                  <div class="cov-lbl">Stack</div>
                  <button class="cov-big cov-link" onClick={() => props.onOpenStack?.(s())} title="Open the stack">{s()}</button>
                  <div class="cov-sub" style={{ color: accentOf(s()) }}>
                    Compose · {stackMembers().filter((x) => x.state === "Running").length} of {stackMembers().length} running
                  </div>
                </div>
              </>
            )}
          </Show>
        </div>

        <div class="cov-ctx-cell">
          <div class="cov-min">
            <div class="cov-lbl">Image <span class="cov-lbl-note">Created {formatTimestamp(c().created_at)}</span></div>
            <button class="cov-big mono cov-link cov-ellipsis cov-image" title={`${c().image}\nShow it on the Images page`}
              onClick={() => props.onOpenImage?.(c().image.split("@")[0])}>
              {splitImage(c().image).name}
              <Show when={splitImage(c().image).from}><span class="cov-image-from"> · {splitImage(c().image).from}</span></Show>
            </button>
            <div class="cov-chips">
              <For each={ports().filter((g) => g.hostPort)}>
                {(g) => (
                  <button class={`cov-chip ${g.kind === "web" ? "cov-chip-link" : ""}`}
                    title={g.label ? `${g.label}` : undefined}
                    onClick={() => g.kind === "web" && void shellOpen(`http://localhost:${g.hostPort}`)}>
                    :{g.hostPort} → {portText(g)}
                  </button>
                )}
              </For>
              <For each={networks() ?? []}>{(n) => <span class="cov-chip">{n}</span>}</For>
              <Show when={route()}>
                {(r) => <button class="cov-chip cov-chip-link" onClick={() => void shellOpen(r().url)}>{r().hostname} ↗</button>}
              </Show>
            </div>
          </div>
        </div>

        <div class="cov-ctx-cell">
          <div class="cov-min">
            <div class="cov-lbl">Engine</div>
            <div class="cov-big">{health()?.docker_version ? `Docker ${health()!.docker_version}` : "Docker"}</div>
            <div class="cov-sub">
              {host()?.is_remote ? `On ${host()!.name}` : "On this computer"}
              <Show when={props.stats && running() && !memLimited()}> · {formatBytes(props.stats!.memory_limit_bytes)} memory</Show>
            </div>
          </div>
        </div>
      </div>

      <div class="cov-grid">
        {/* How it's set up */}
        <div class="cov-box">
          <div class="cov-row cov-between">
            <span class="cov-lbl">Health check</span>
            <Show when={hasHealth() && healthLog().length}><span class="cov-sub">last {healthLog().length} checks</span></Show>
          </div>
          <Show when={hasHealth()} fallback={
            <div class="cov-health-none">
              <span class="cov-sub">No health check. Orca can only tell whether the process runs.</span>
            </div>
          }>
            <div class="cov-health-state" style={{ color: healthColor() }}>
              {healthStatus() === "healthy" ? "Healthy" : healthStatus() === "unhealthy" ? "Unhealthy" : "Starting"}
            </div>
            <Show when={healthLog().length > 0}>
              <div class="cov-health-bar">
                <For each={healthLog()}>
                  {(e) => (
                    <i classList={{ bad: e.exit_code !== 0 }}
                      title={`${e.started_at ? formatTimestamp(e.started_at) : ""} · exit ${e.exit_code}${e.output?.trim() ? `\n${e.output.trim().slice(0, 300)}` : ""}`} />
                  )}
                </For>
              </div>
            </Show>
          </Show>

          <button class="cov-opt" onClick={() => props.onTab("resources")}>
            <span class={`cov-state ${restartPolicy() !== "no" ? "on" : ""}`} />
            <span class="cov-min">
              <b>Restart policy</b>
              <span class="cov-sub">
                {restartPolicy() === "no" ? "Not restarted by Docker" : restartPolicy()}
                {" · "}{restarts() === 0 ? "never restarted" : `restarted ${restarts()} ${restarts() === 1 ? "time" : "times"}`}
              </span>
            </span>
          </button>
          <button class="cov-opt" onClick={() => (route() ? void shellOpen(route()!.url) : props.onExpose())}>
            <span class={`cov-state ${route() ? "on" : ""}`} />
            <span class="cov-min">
              <b>{route() ? "Exposed via gateway" : "Not exposed via gateway"}</b>
              <span class="cov-sub cov-ellipsis">{route() ? `${route()!.url}${route()!.port ? ` → :${route()!.port}` : ""}` : "Give it an https://….localhost address"}</span>
            </span>
          </button>
          <button class="cov-opt" onClick={() => props.onTab("resources")}>
            <span class={`cov-state ${memLimited() || (c().cpu_limit ?? 0) > 0 ? "on" : ""}`} />
            <span class="cov-min">
              <b>Resource limits</b>
              <span class="cov-sub">
                {memLimited() ? `${formatBytes(c().memory_limit!)} memory` : "No memory limit"}
                {" · "}{(c().cpu_limit ?? 0) > 0 ? `${c().cpu_limit} CPUs` : "no CPU limit"}
              </span>
            </span>
          </button>
        </div>

        {/* Live usage */}
        <div class="cov-box">
          <div class="cov-row cov-between cov-mhead">
            <h3>Live usage</h3>
            <Show when={running()} fallback={<span class="cov-sub">The container is {c().state.toLowerCase()}</span>}>
              <span class="cov-live"><span class="cov-live-dot" />Every 3 s</span>
            </Show>
          </div>

          <div class="cov-tiles">
            <div class="cov-tile">
              <div class="cov-lbl">CPU <span class="cov-lbl-note">· {(c().cpu_limit ?? 0) > 0 ? `limit ${c().cpu_limit} CPUs` : "100% is one core"}</span></div>
              <div class="cov-val">
                <Show when={props.stats && running()} fallback="–">{props.stats!.cpu_percent.toFixed(1)}<small>%</small></Show>
              </div>
              <Show when={running()}>
                <Spark id="cpu" data={history().map((h) => h.cpu)} color="#58a6ff" max={5} />
              </Show>
            </div>

            <div class="cov-tile cov-hot">
              <div class="cov-lbl">Memory <span class="cov-lbl-note">· {memLimited() ? `limit ${formatBytes(c().memory_limit!)}` : "no limit"}</span></div>
              <Show when={props.stats && running()} fallback={<div class="cov-val">–</div>}>
                <div class="cov-val cov-blue">{num(formatBytes(props.stats!.memory_usage_bytes)).n}<small>{num(formatBytes(props.stats!.memory_usage_bytes)).u}</small></div>
                <div class="cov-sub">{memPct().toFixed(1)}% of {memLimited() ? "its limit" : `the engine's ${formatBytes(props.stats!.memory_limit_bytes)}`}</div>
                <Gauge pct={memPct()} color={memPct() > 90 ? "#f85149" : memPct() > 70 ? "#e3b341" : "#bc8cff"} label={`${Math.round(memPct())}%`} />
              </Show>
            </div>

            <div class="cov-tile">
              <div class="cov-lbl">Network <Show when={networks()?.length}><span class="cov-lbl-note">· {networks()!.join(", ")}</span></Show></div>
              <Show when={props.stats && running()} fallback={<div class="cov-val">–</div>}>
                <div class="cov-val">
                  <span class="cov-arrow" style={{ color: "#58a6ff" }}>↓</span>{num(formatBytes(props.stats!.network_rx_bytes)).n}<small>{num(formatBytes(props.stats!.network_rx_bytes)).u}</small>
                  <span class="cov-arrow" style={{ color: "#f0883e", "margin-left": "14px" }}>↑</span>{num(formatBytes(props.stats!.network_tx_bytes)).n}<small>{num(formatBytes(props.stats!.network_tx_bytes)).u}</small>
                </div>
                <Spark id="net" data={history().slice(1).map((h, i) => Math.max(0, h.networkRx - history()[i].networkRx + h.networkTx - history()[i].networkTx))} color="#39c5cf" />
                <div class="cov-sub">
                  <Show when={rate(history(), "networkRx") !== null} fallback="Received and sent since it started">
                    in {formatBytes(rate(history(), "networkRx")!)}/s · out {formatBytes(rate(history(), "networkTx")!)}/s
                  </Show>
                </div>
              </Show>
            </div>

            <div class="cov-tile cov-hot">
              <div class="cov-lbl">Uptime <Show when={started() && running()}><span class="cov-lbl-note">· started {started()!.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></Show></div>
              <div class={`cov-val ${running() ? "cov-blue" : ""}`}>{running() ? since(started() ?? parseTime(c().created_at)) : "Stopped"}</div>
              <Show when={running()}>
                <svg class="cov-timeline" viewBox="0 0 300 20" preserveAspectRatio="none" aria-hidden="true">
                  <line x1="0" y1="10" x2="300" y2="10" stroke="#f0883e" stroke-width="2" stroke-dasharray="10 8" opacity=".8" vector-effect="non-scaling-stroke" />
                </svg>
              </Show>
              <div class="cov-sub">
                {restarts() === 0 ? "No restarts" : `${restarts()} ${restarts() === 1 ? "restart" : "restarts"}`}
                <Show when={!running() && props.inspect?.exit_code !== undefined && props.inspect?.exit_code !== null}> · exit code {props.inspect.exit_code}</Show>
              </div>
            </div>
          </div>

          <div class="cov-strip">
            <span><span class="cov-k">Disk I/O</span>
              <Show when={props.stats && running()} fallback={<b>–</b>}>
                <b>{num(formatBytes(props.stats!.block_read_bytes)).n}</b><u>{num(formatBytes(props.stats!.block_read_bytes)).u} read</u>
                <b class="cov-gap">{num(formatBytes(props.stats!.block_write_bytes)).n}</b><u>{num(formatBytes(props.stats!.block_write_bytes)).u} written</u>
              </Show>
            </span>
            <Show when={props.stats && running() && (c().cpu_limit ?? 0) > 0}>
              <span class="cov-meter-wrap"><span class="cov-k">CPU of its limit</span>
                <span class="cov-meter"><span style={{ width: `${Math.min(100, Math.max(1, props.stats!.cpu_percent / c().cpu_limit!))}%` }} /></span>
                <b>{(props.stats!.cpu_percent / c().cpu_limit!).toFixed(1)}%</b>
              </span>
            </Show>

          </div>
        </div>
      </div>

      {/* Details */}
      <div class="cov-details">
        <div><span class="cov-k">ID</span><span class="mono selectable cov-ellipsis">{c().id.slice(0, 12)}</span><CopyButton text={c().id} label="Copy full container ID" /></div>
        <div class="cov-min"><span class="cov-k">Command</span><span class="mono selectable cov-ellipsis" title={command()}>{command() || "–"}</span></div>
      </div>

      <div class="cov-foot">
        <button class="btn btn-iconed cov-ghost" onClick={() => props.onTab("logs")}>
          <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10" /></svg>Logs
        </button>
        <Show when={running()}>
          <button class="btn btn-iconed cov-ghost" onClick={() => props.onTab("terminal")}>
            <svg viewBox="0 0 24 24"><path d="M4 17l6-5-6-5M12 19h8" /></svg>Terminal
          </button>
          <button class="btn btn-iconed cov-ghost" onClick={() => props.onTab("files")}>
            <svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v10H3z" /></svg>Files
          </button>
        </Show>
        <button class="btn btn-iconed cov-ghost" onClick={() => props.onTab("inspect")}>
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-5-5" /></svg>Inspect
        </button>
        <span class="cov-spacer" />
        <Show when={running() && openUrl()}>
          <button class="btn btn-primary btn-iconed" onClick={() => void shellOpen(openUrl()!)}>
            <svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" /></svg>
            Open {openUrl()!.replace(/^https?:\/\//, "")}
          </button>
        </Show>
      </div>
    </div>
  );
}
