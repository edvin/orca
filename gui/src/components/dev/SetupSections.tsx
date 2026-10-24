// The parts of a project's dev setup, each editing the same `dev:` config.
// The setup wizard shows them as steps; the orca.yaml editor's form view
// shows them on one page.
import { For, Show, createMemo, createSignal } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import { produce } from "solid-js/store";
import Dropdown from "../Dropdown";
import {
  DATA_MODE_LABEL,
  HOSTNAME_FLAT,
  HOSTNAME_NESTED,
  NESTED_COOKIE_DOMAIN,
  certCovers,
  exposePort,
  hostnamePatternWarnings,
  hostnameStyle,
  previewHostname,
  renderHostname,
} from "../../lib/dev";
import type { HostnameStyle } from "../../lib/dev";
import type { DataChoice, DataMode, DevConfigT, SetupAnalysis, SetupService } from "../../lib/dev";
import { DataModePicker } from "./DevBits";
import HelpLink from "../HelpLink";

export interface SectionProps {
  analysis: SetupAnalysis;
  dev: DevConfigT;
  setDev: SetStoreFunction<DevConfigT>;
  /** Example instance name for previews. */
  sample: string;
  projectId: string;
  domain: string;
  /** Gateway HTTPS port; shown in URLs when not 443. */
  httpsPort?: number;
}

const isShared = (dev: DevConfigT, name: string) => name in dev.shared;
const portSuffix = (p: SectionProps) => (p.httpsPort && p.httpsPort !== 443 ? `:${p.httpsPort}` : "");

// --- Shared or per worktree --------------------------------------------------

export function SharedSection(props: SectionProps) {
  const [dragging, setDragging] = createSignal<string | null>(null);

  const move = (name: string, toShared: boolean) => {
    props.setDev(
      produce((d) => {
        if (toShared) {
          if (!(name in d.shared)) d.shared[name] = { data: "shared" };
          delete d.instance.expose[name];
          delete d.instance.host_ports[name];
        } else {
          delete d.shared[name];
          // Give it the reach Orca would pick by default.
          const svc = props.analysis.services.find((s) => s.name === name);
          const browser = svc?.ports.find((p) => p.published && p.suggested === "browser");
          if (browser) d.instance.expose[name] = browser.target;
          const host = (svc?.ports ?? []).filter((p) => p.published && p.suggested === "host").map((p) => p.target);
          if (host.length) d.instance.host_ports[name] = host;
        }
      }),
    );
  };

  const column = (shared: boolean) => props.analysis.services.filter((s) => isShared(props.dev, s.name) === shared);

  const Column = (p: { shared: boolean; title: string; hint: string }) => (
    <div
      class="dev-dropzone"
      classList={{ "dev-dropzone-active": !!dragging() }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const name = dragging();
        if (name && isShared(props.dev, name) !== p.shared) move(name, p.shared);
        setDragging(null);
      }}
    >
      <div class="dev-dropzone-title">
        {p.title}
        <span>{p.hint}</span>
      </div>
      <For each={column(p.shared)} fallback={<div class="dev-dropzone-empty">Drag services here</div>}>
        {(svc) => (
          <ServiceTile svc={svc} shared={p.shared} onMove={() => move(svc.name, !p.shared)} onDragStart={() => setDragging(svc.name)} onDragEnd={() => setDragging(null)} />
        )}
      </For>
    </div>
  );

  return (
    <div>
      <p class="dev-step-intro">
        Your own code runs per worktree; databases usually run once, shared. Drag a service to move it.{" "}
        <HelpLink path="/docs/worktrees/#shared-and-per-instance-services" />
      </p>
      <div style={{ display: "grid", "grid-template-columns": "minmax(0, 1fr) minmax(0, 1fr)", gap: "12px" }}>
        <Column shared={true} title="Runs once (shared)" hint="one copy for all worktrees" />
        <Column shared={false} title="Runs per worktree" hint="one copy per worktree" />
      </div>
    </div>
  );
}

function ServiceTile(props: { svc: SetupService; shared: boolean; onMove: () => void; onDragStart: () => void; onDragEnd: () => void }) {
  return (
    <div class="dev-tile" draggable={true} onDragStart={props.onDragStart} onDragEnd={props.onDragEnd}>
      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
        <span class="dev-tile-name">{props.svc.name}</span>
        <span class="dev-tile-meta">{props.svc.built ? "built from repo" : props.svc.image}</span>
        <button class="btn btn-sm btn-outline" style={{ "margin-left": "auto" }} onClick={props.onMove} title={props.shared ? "Run per worktree" : "Run once and share"}>
          {props.shared ? "→ per worktree" : "← shared"}
        </button>
      </div>
      <div class="dev-tile-facts">
        <Show when={props.svc.ports.length > 0}>
          <span>ports {props.svc.ports.map((p) => (p.published ? `${p.published}:${p.target}` : String(p.target))).join(", ")}</span>
        </Show>
        <Show when={props.svc.volumes.length > 0}>
          <span>volume {props.svc.volumes.join(", ")}</span>
        </Show>
        <Show when={props.svc.referenced_by.length > 0}>
          <span>used by {[...new Set(props.svc.referenced_by.map((r) => r.service))].join(", ")}</span>
        </Show>
      </div>
      <Show when={props.svc.reason}>
        <div class="dev-tile-reason">Orca's suggestion: {props.svc.suggested_shared ? "shared" : "per worktree"} · {props.svc.reason}</div>
      </Show>
    </div>
  );
}

// --- Data ----------------------------------------------------------------------

export function DataSection(props: SectionProps) {
  const shared = () => props.analysis.services.filter((s) => isShared(props.dev, s.name));
  const choiceFor = (svc: SetupService): DataChoice => {
    const conf = props.dev.shared[svc.name];
    const db = conf?.database || svc.shared_db;
    return {
      service: svc.name,
      mode: conf?.data ?? "shared",
      default_mode: "shared",
      kind: svc.kind,
      shared_db: db ?? null,
      tenant: null,
      supports_own_database: !!svc.kind && !!db,
      own_database_note: svc.kind
        ? db
          ? null
          : `Set the database name below so Orca knows what to copy.`
        : `Orca can create separate databases in Postgres, MySQL, MongoDB, Redis and RabbitMQ; ${svc.image ?? svc.name} isn't one of them.`,
    };
  };
  const update = (name: string, patch: Partial<DevConfigT["shared"][string]>) =>
    props.setDev(produce((d) => (d.shared[name] = { ...(d.shared[name] ?? { data: "shared" }), ...patch })));

  return (
    <div>
      <p class="dev-step-intro">
        The data a new worktree gets by default. Each worktree can change it before it starts.{" "}
        <HelpLink path="/docs/worktrees/#data-modes" />
      </p>
      <Show when={shared().length === 0}>
        <div class="form-hint">Nothing is shared, so every worktree has all its data to itself.</div>
      </Show>
      <For each={shared()}>
        {(svc) => (
          <div class="dev-section">
            <div class="dev-section-title">
              {svc.name}
              <span style={{ "font-weight": 400, "text-transform": "none", "letter-spacing": 0, color: "#6e7681" }}>
                {svc.kind ?? svc.image}
              </span>
            </div>
            <DataModePicker choice={choiceFor(svc)} value={props.dev.shared[svc.name]?.data ?? "shared"} onChange={(m: DataMode) => update(svc.name, { data: m })} />
            <div style={{ display: "flex", gap: "16px", "margin-top": "10px", "flex-wrap": "wrap", "align-items": "center" }}>
              <Show when={svc.kind && svc.kind !== "redis"}>
                <label class="dev-inline-field">
                  Database the app uses
                  <input
                    class="form-input mono"
                    style={{ width: "160px" }}
                    placeholder={svc.shared_db ?? "myapp"}
                    value={props.dev.shared[svc.name]?.database ?? ""}
                    onInput={(e) => update(svc.name, { database: e.currentTarget.value || null })}
                  />
                </label>
                <label class="dev-inline-field">
                  A worktree's own database starts as
                  <Dropdown
                    value={props.dev.shared[svc.name]?.own_database?.seed ?? "clone-main"}
                    options={[
                      { value: "clone-main", label: "a copy of the shared data" },
                      { value: "empty", label: "empty" },
                    ]}
                    onChange={(v) => update(svc.name, { own_database: { ...(props.dev.shared[svc.name]?.own_database ?? {}), seed: v as "clone-main" | "empty" } })}
                    style={{ width: "220px" }}
                  />
                </label>
              </Show>
            </div>
            <Show when={svc.kind}>
              <div class="dev-refs">
                <Show when={svc.referenced_by.length > 0}>
                  <div style={{ color: "#8b949e" }}>
                    Connected from{" "}
                    {svc.referenced_by.map((r) => `${r.service} (${r.key})`).join(", ")}
                  </div>
                </Show>
                <Show
                  when={svc.own_database_rewrites.length > 0}
                  fallback={
                    <div style={{ color: "#e3b341" }}>
                      Orca found no setting that names the {svc.kind === "redis" ? "Redis DB number" : `database (${svc.shared_db ?? "?"})`},
                      so in own-database mode the app would still use the shared one. Point it at the worktree's database with{" "}
                      <span class="mono">{`{db.${svc.name}}`}</span> under <span class="mono">dev.instance.env</span> in orca.yaml.
                    </div>
                  }
                >
                  <div style={{ color: "#8b949e" }}>In own-database mode Orca changes, for example for a worktree called "feature":</div>
                  <For each={svc.own_database_rewrites}>
                    {(r) => (
                      <div>
                        <span class="mono">{r.service}.{r.key}</span>{" "}
                        <span class="mono" style={{ color: "#8b949e", "text-decoration": "line-through" }}>{r.from.replace(/(\/\/[^:/@]+:)([^@]+)(@)/, "$1••••$3")}</span>{" "}
                        → <span class="mono" style={{ color: "#7ee787" }}>{r.to.replace(/(\/\/[^:/@]+:)([^@]+)(@)/, "$1••••$3")}</span>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </For>
      <Show when={props.analysis.adoption}>
        {(a) => (
          <div class="dev-explainer" style={{ "margin-top": "8px" }}>
            <div>
              You already run this project with plain <span class="mono">docker compose</span> (stack <b>{a().project}</b>
              {a().volumes.length > 0 ? <>, volumes {a().volumes.join(", ")}</> : null}). On the last step you can let the shared
              services take over that data instead of starting empty.
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

// --- Hostnames ---------------------------------------------------------------------

/** Flat, nested or custom hostnames, with a live example and the reasons to
 *  pick one over the other (cookies shared between services, wildcard
 *  certificates). */
export function HostnamePicker(props: SectionProps) {
  const [custom, setCustom] = createSignal(hostnameStyle(props.dev.naming.hostname) === "custom");
  const style = (): HostnameStyle => (custom() ? "custom" : hostnameStyle(props.dev.naming.hostname));
  const advice = () => props.analysis.hostnames;
  const vars = (service: string) => ({ service, instance: props.sample, project: props.projectId, domain: props.domain });
  const example = (pattern: string, service = "web") => renderHostname(pattern, vars(service));
  // Cards show the pattern's shape with a short name; the line below uses the real worktree.
  const shape = (pattern: string) => renderHostname(pattern, { ...vars("web"), instance: "feature" }).host;
  const current = () => example(props.dev.naming.hostname);
  const certNames = () => advice()?.cert_names ?? null;
  const exposed = () => Object.keys(props.dev.instance.expose ?? {});
  const uncovered = () => {
    const names = certNames();
    if (!names) return [];
    const services = exposed().length > 0 ? exposed() : ["web"];
    return services.map((s) => example(props.dev.naming.hostname, s).host).filter((h) => !certCovers(names, h));
  };
  const cookieVars = () => advice()?.cookie_vars ?? [];
  const scoped = (v: { service: string; key: string }) => props.dev.instance.env?.[v.service]?.[v.key] === NESTED_COOKIE_DOMAIN;
  const unscoped = () => cookieVars().filter((v) => !scoped(v));

  const pick = (s: HostnameStyle) => {
    setCustom(s === "custom");
    if (s === "flat") props.setDev("naming", "hostname", HOSTNAME_FLAT);
    if (s === "nested") props.setDev("naming", "hostname", HOSTNAME_NESTED);
  };
  const scopeCookies = () =>
    props.setDev(
      produce((d) => {
        for (const v of cookieVars()) {
          d.instance.env[v.service] = { ...(d.instance.env[v.service] ?? {}), [v.key]: NESTED_COOKIE_DOMAIN };
        }
      }),
    );
  const useNested = () => {
    pick("nested");
    scopeCookies();
  };

  const options: { style: HostnameStyle; title: string; desc: () => string; example: () => string }[] = [
    {
      style: "flat",
      title: "Flat",
      desc: () => "One level below the domain, so a single wildcard certificate covers every worktree.",
      example: () => shape(HOSTNAME_FLAT),
    },
    {
      style: "nested",
      title: "Nested",
      desc: () => "Each worktree gets its own subdomain. Pick this when the app shares cookies between its services.",
      example: () => shape(HOSTNAME_NESTED),
    },
    {
      style: "custom",
      title: "Custom",
      desc: () => "Write your own pattern from {service}, {instance}, {project} and {domain}.",
      example: () => (style() === "custom" ? shape(props.dev.naming.hostname) : "your pattern"),
    },
  ];

  return (
    <div>
      <div style={{ display: "grid", "grid-template-columns": "repeat(3, minmax(0, 1fr))", gap: "8px" }}>
        <For each={options}>
          {(o) => (
            <button type="button" class={`dev-option ${style() === o.style ? "selected" : ""}`} onClick={() => pick(o.style)}>
              <span class="dev-radio" />
              <span style={{ "min-width": 0 }}>
                <div class="dev-option-title">
                  {o.title}
                  <Show when={o.style === advice()?.recommended}>
                    <span style={{ color: "#3fb950", "font-weight": 400 }}> · recommended</span>
                  </Show>
                </div>
                <div class="dev-option-desc">{o.desc()}</div>
                <div class="mono dev-option-example" title={o.example()}>{o.example()}</div>
              </span>
            </button>
          )}
        </For>
      </div>

      <Show when={style() === "custom"}>
        <input
          class="form-input mono"
          style={{ width: "100%", "margin-top": "10px" }}
          value={props.dev.naming.hostname}
          placeholder={HOSTNAME_FLAT}
          onInput={(e) => props.setDev("naming", "hostname", e.currentTarget.value)}
        />
      </Show>

      <div class="form-hint" style={{ "margin-top": "8px" }}>
        Worktree <span class="mono">{props.sample}</span> opens at{" "}
        <span class="mono" style={{ color: "#58a6ff" }}>
          https://{current().host}
          {portSuffix(props)}
        </span>
        . Long branch names are shortened with a short hash so every hostname stays valid and unique. Override single hostnames in an
        instance's Settings.
      </div>

      <Show when={current().error}>
        <div class="dev-error" style={{ "margin-top": "8px" }}>{current().error}</div>
      </Show>
      <For each={hostnamePatternWarnings(props.dev.naming.hostname)}>
        {(w) => <div class="dev-warning" style={{ "margin-top": "8px" }}>{w}</div>}
      </For>
      <Show when={uncovered().length > 0}>
        <div class="dev-warning" style={{ "margin-top": "8px" }}>
          The gateway's certificate ({certNames()!.join(", ")}) doesn't cover {uncovered().join(", ")}, so browsers will show a
          certificate error. A wildcard certificate only covers one level below the domain.
          <Show when={style() !== "flat"}>
            {" "}
            <a class="dev-action-link" onClick={() => pick("flat")}>Use flat hostnames</a>
          </Show>
        </div>
      </Show>
      <Show when={cookieVars().length > 0 && style() === "flat"}>
        <div class="dev-warning" style={{ "margin-top": "8px" }}>
          <For each={cookieVars()}>
            {(v, i) => (
              <>
                {i() > 0 ? ", " : ""}
                <b>{v.service}</b> sets <span class="mono">{v.key}</span>
                {v.value ? <span class="mono"> ({v.value})</span> : null}
              </>
            )}
          </For>
          . With flat hostnames every worktree sits under the same parent domain, so they would read and overwrite each other's
          cookies (logins, sessions).{" "}
          <a class="dev-action-link" onClick={useNested}>Use nested hostnames and scope the cookie to each worktree</a>
        </div>
      </Show>
      <Show when={cookieVars().length > 0 && style() === "nested"}>
        <Show
          when={unscoped().length === 0}
          fallback={
            <div class="dev-warning" style={{ "margin-top": "8px" }}>
              Nested hostnames only keep cookies apart if the cookie domain follows them:{" "}
              <For each={unscoped()}>
                {(v, i) => (
                  <>
                    {i() > 0 ? ", " : ""}
                    <b>{v.service}</b> <span class="mono">{v.key}</span>
                  </>
                )}
              </For>{" "}
              still uses the compose value. <a class="dev-action-link" onClick={scopeCookies}>Set it per worktree</a>
            </div>
          }
        >
          <div class="dev-note" style={{ "margin-top": "8px" }}>
            Cookies stay inside each worktree:{" "}
            <For each={cookieVars()}>
              {(v, i) => (
                <>
                  {i() > 0 ? ", " : ""}
                  <b>{v.service}</b> <span class="mono">{v.key}</span>
                </>
              )}
            </For>{" "}
            is set to{" "}
            <span class="mono">{previewHostname(NESTED_COOKIE_DOMAIN, vars("web"))}</span> for worktree {props.sample}.
          </div>
        </Show>
      </Show>
    </div>
  );
}

// --- Reach -------------------------------------------------------------------------

type Reach = "browser" | "host" | "internal";

export function ReachSection(props: SectionProps) {
  const perInstance = () => props.analysis.services.filter((s) => !isShared(props.dev, s.name));
  const reachOf = (svc: string, port: number): Reach => {
    if (exposePort(props.dev.instance.expose[svc]) === port) return "browser";
    if ((props.dev.instance.host_ports[svc] ?? []).includes(port)) return "host";
    return "internal";
  };
  const setReach = (svc: string, port: number, r: Reach) =>
    props.setDev(
      produce((d) => {
        if (exposePort(d.instance.expose[svc]) === port) delete d.instance.expose[svc];
        d.instance.host_ports[svc] = (d.instance.host_ports[svc] ?? []).filter((p) => p !== port);
        if (r === "browser") d.instance.expose[svc] = port;
        if (r === "host") d.instance.host_ports[svc] = [...d.instance.host_ports[svc], port];
        if (d.instance.host_ports[svc].length === 0) delete d.instance.host_ports[svc];
      }),
    );
  const hostFor = (svc: string) =>
    previewHostname(props.dev.naming.hostname, { service: svc, instance: props.sample, project: props.projectId, domain: props.domain }) +
    portSuffix(props);
  const exposeHost = (svc: string) => {
    const e = props.dev.instance.expose[svc];
    return typeof e === "object" && e ? e.host ?? "" : "";
  };
  const exposePath = (svc: string) => {
    const e = props.dev.instance.expose[svc];
    return typeof e === "object" && e ? e.path ?? "" : "";
  };
  const setExposeExtra = (svc: string, host: string, path: string) =>
    props.setDev(
      produce((d) => {
        const port = exposePort(d.instance.expose[svc]);
        if (port == null) return;
        d.instance.expose[svc] = host || path ? { port, host: host || null, path: path || null } : port;
      }),
    );
  const portsOf = (svc: SetupService) => {
    const ports = svc.ports.map((p) => p.target);
    // Ports configured in orca.yaml that the compose file doesn't publish.
    const e = exposePort(props.dev.instance.expose[svc.name]);
    if (e != null && !ports.includes(e)) ports.push(e);
    for (const p of props.dev.instance.host_ports[svc.name] ?? []) if (!ports.includes(p)) ports.push(p);
    return ports;
  };

  return (
    <div>
      <p class="dev-step-intro">
        Browser ports get an HTTPS hostname per worktree; other ports get a free host port per worktree.{" "}
        <HelpLink path="/docs/worktrees/#ports" />
      </p>
      <div class="dev-section">
        <div class="dev-section-title">Hostnames</div>
        <HostnamePicker {...props} />
        <div style={{ "margin-top": "12px", display: "flex", gap: "10px", "align-items": "center" }}>
          <span class="form-hint">Instance names come from</span>
          <Dropdown
            value={props.dev.naming.instance}
            options={[
              { value: "branch", label: "the branch (feat/login → feat-login)" },
              { value: "folder", label: "the worktree folder" },
            ]}
            onChange={(v) => props.setDev("naming", "instance", v as "branch" | "folder")}
            style={{ width: "300px" }}
          />
        </div>
      </div>
      <For each={perInstance()}>
        {(svc) => (
          <div class="dev-section">
            <div class="dev-section-title">{svc.name}</div>
            <Show when={portsOf(svc).length > 0} fallback={<div class="form-hint">No ports. Reached only by other services.</div>}>
              <table class="dev-table">
                <tbody>
                  <For each={portsOf(svc)}>
                    {(port) => (
                      <tr>
                        <td class="mono" style={{ width: "90px" }}>:{port}</td>
                        <td>
                          <div class="dev-seg">
                            <For each={["browser", "host", "internal"] as Reach[]}>
                              {(r) => (
                                <button
                                  type="button"
                                  classList={{ active: reachOf(svc.name, port) === r }}
                                  disabled={r === "browser" && exposePort(props.dev.instance.expose[svc.name]) != null && reachOf(svc.name, port) !== "browser"}
                                  title={r === "browser" ? "One browser port per service" : ""}
                                  onClick={() => setReach(svc.name, port, r)}
                                >
                                  {r === "browser" ? "Open in browser" : r === "host" ? "Port on my machine" : "Internal only"}
                                </button>
                              )}
                            </For>
                          </div>
                        </td>
                        <td class="mono" style={{ color: "#8b949e", "font-size": "11.5px" }}>
                          {reachOf(svc.name, port) === "browser"
                            ? `https://${hostFor(exposeHost(svc.name) || svc.name)}${exposePath(svc.name)}`
                            : reachOf(svc.name, port) === "host"
                              ? "localhost:41xxx (picked per worktree)"
                              : "only other services"}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <Show when={exposePort(props.dev.instance.expose[svc.name]) != null}>
                <div style={{ display: "flex", gap: "10px", "align-items": "center", "margin-top": "8px", "font-size": "12px", color: "#8b949e" }}>
                  Serve under
                  <Dropdown
                    value={exposeHost(svc.name)}
                    options={[
                      { value: "", label: "its own hostname" },
                      ...perInstance()
                        .filter((o) => o.name !== svc.name && exposePort(props.dev.instance.expose[o.name]) != null)
                        .map((o) => ({ value: o.name, label: `${o.name}'s hostname` })),
                    ]}
                    onChange={(v) => setExposeExtra(svc.name, v, exposePath(svc.name))}
                    style={{ width: "200px" }}
                  />
                  <Show when={exposeHost(svc.name)}>
                    at path
                    <input
                      class="form-input mono"
                      style={{ width: "120px" }}
                      placeholder="/api"
                      value={exposePath(svc.name)}
                      onInput={(e) => setExposeExtra(svc.name, exposeHost(svc.name), e.currentTarget.value)}
                    />
                  </Show>
                </div>
              </Show>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

// --- Profiles and setup commands -------------------------------------------------------

export function ProfilesSection(props: SectionProps) {
  const perInstance = () => props.analysis.services.filter((s) => !isShared(props.dev, s.name));
  /** Compose profiles of per-instance services, with their members. */
  const profiles = createMemo(() => {
    const out = new Map<string, string[]>();
    for (const s of perInstance()) for (const p of s.profiles) out.set(p, [...(out.get(p) ?? []), s.name]);
    return [...out.entries()];
  });
  const always = () => perInstance().filter((s) => s.profiles.length === 0).map((s) => s.name);
  const hookOn = (line: string) => props.dev.instance.hooks.after_own_database.includes(line);
  const toggleHook = (line: string) =>
    props.setDev(
      produce((d) => {
        const l = d.instance.hooks.after_own_database;
        d.instance.hooks.after_own_database = l.includes(line) ? l.filter((x) => x !== line) : [...l, line];
      }),
    );

  return (
    <div>
      <p class="dev-step-intro">
        Each worktree picks its compose profiles when it starts. Setup commands run inside its containers.{" "}
        <HelpLink path="/docs/profiles/" />
      </p>
      <div class="dev-section">
        <div class="dev-section-title">Profiles</div>
        <Show when={profiles().length > 0} fallback={
          <div class="form-hint">
            Every service starts in every worktree. To make some optional, give them a profile in the compose file, such as{" "}
            <span class="mono">profiles: [search]</span>; worktrees can then start without them.
          </div>
        }>
          <div class="profiles-grid">
            <div class="profile-card always">
              <div class="profile-card-head"><span class="profile-name">Always</span></div>
              <div class="profile-chips"><For each={always()}>{(s) => <span class="profile-chip">{s}</span>}</For></div>
            </div>
            <For each={profiles()}>
              {([name, members]) => (
                <div class="profile-card always" style={{ "border-style": "solid" }}>
                  <div class="profile-card-head"><span class="profile-name">{name}</span><span class="form-hint">optional</span></div>
                  <div class="profile-chips"><For each={members}>{(s) => <span class="profile-chip">{s}</span>}</For></div>
                </div>
              )}
            </For>
          </div>
          <div class="form-hint" style={{ "margin-top": "8px" }}>From the compose file; change them there.</div>
        </Show>
      </div>

      <div class="dev-section">
        <div class="dev-section-title">When a worktree gets its own database</div>
        <Show when={props.analysis.migrations.length > 0} fallback={<div class="form-hint" style={{ "margin-bottom": "6px" }}>Orca found no migration tooling. Add commands below if you have some.</div>}>
          <For each={props.analysis.migrations}>
            {(m) => {
              const line = `${m.service}: ${m.command}`;
              return (
                <label style={{ display: "flex", gap: "8px", "align-items": "center", "font-size": "12.5px", padding: "4px 0", cursor: "pointer" }}>
                  <input type="checkbox" checked={hookOn(line)} onChange={() => toggleHook(line)} />
                  <span class="mono">{line}</span>
                  <span style={{ color: "#6e7681" }}>found in {m.source}</span>
                </label>
              );
            }}
          </For>
        </Show>
        <HookLines
          label="Other commands"
          lines={props.dev.instance.hooks.after_own_database.filter((l) => !props.analysis.migrations.some((m) => `${m.service}: ${m.command}` === l))}
          onChange={(lines) =>
            props.setDev(
              produce((d) => {
                const known = d.instance.hooks.after_own_database.filter((l) => props.analysis.migrations.some((m) => `${m.service}: ${m.command}` === l));
                d.instance.hooks.after_own_database = [...known, ...lines];
              }),
            )
          }
        />
      </div>
      <div class="dev-section">
        <div class="dev-section-title">After every start</div>
        <HookLines label="" lines={props.dev.instance.hooks.after_up} onChange={(lines) => props.setDev("instance", "hooks", "after_up", lines)} />
      </div>
    </div>
  );
}

function HookLines(props: { label: string; lines: string[]; onChange: (lines: string[]) => void }) {
  return (
    <div style={{ "margin-top": "6px" }}>
      <Show when={props.label}>
        <div class="form-hint" style={{ "margin-bottom": "4px" }}>{props.label}</div>
      </Show>
      <textarea
        class="form-input mono"
        style={{ width: "100%", "min-height": "56px", "font-size": "12px" }}
        placeholder="service: command   (one per line, e.g. api: npm run seed)"
        value={props.lines.join("\n")}
        onChange={(e) =>
          props.onChange(
            e.currentTarget.value
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.includes(":")),
          )
        }
      />
    </div>
  );
}

// --- Preview -------------------------------------------------------------------------

/** What one worktree's instance will look like with this setup. */
export function TopologyPreview(props: SectionProps) {
  const shared = () => Object.keys(props.dev.shared);
  const perInstance = () => props.analysis.services.filter((s) => !isShared(props.dev, s.name));
  const host = (svc: string) =>
    previewHostname(props.dev.naming.hostname, { service: svc, instance: props.sample, project: props.projectId, domain: props.domain }) +
    portSuffix(props);
  return (
    <div class="dev-preview">
      <div class="dev-preview-title">Preview</div>
      <div class="dev-preview-box dev-preview-shared">
        <div class="dev-preview-label">Shared · runs once</div>
        <For each={shared()} fallback={<div class="dev-preview-empty">nothing shared</div>}>
          {(s) => (
            <div class="dev-preview-row">
              <span class="dev-dot" style={{ background: "#3fb950" }} />
              {s}
              <span class="dev-preview-note">{DATA_MODE_LABEL[props.dev.shared[s]?.data ?? "shared"].toLowerCase()}</span>
            </div>
          )}
        </For>
      </div>
      <div class="dev-preview-link" />
      <div class="dev-preview-box dev-preview-instance">
        <div class="dev-preview-label">Worktree "{props.sample}"</div>
        <For each={perInstance()} fallback={<div class="dev-preview-empty">no per-worktree services</div>}>
          {(s) => {
            const e = () => props.dev.instance.expose[s.name];
            const hp = () => props.dev.instance.host_ports[s.name] ?? [];
            return (
              <div class="dev-preview-row" style={{ "flex-wrap": "wrap" }}>
                <span class="dev-dot" style={{ background: "#58a6ff" }} />
                {s.name}
                <Show when={e() != null}>
                  <span class="dev-preview-url">
                    {(() => {
                      const ex = e();
                      const h = typeof ex === "object" && ex?.host ? ex.host : s.name;
                      const path = typeof ex === "object" && ex?.path ? ex.path : "";
                      return `${host(h)}${path}`;
                    })()}
                  </span>
                </Show>
                <For each={hp()}>{(p) => <span class="dev-preview-note">:{p} → localhost:41xxx</span>}</For>
              </div>
            );
          }}
        </For>
      </div>
      <div class="dev-preview-foot">Each worktree gets its own copy of the blue part.</div>
    </div>
  );
}
