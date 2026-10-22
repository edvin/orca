// Instance detail: everything about one worktree's instance, in tabs.
import { createSignal, createEffect, createMemo, For, Show, onCleanup, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import Dropdown from "../Dropdown";
import { copyToClipboard } from "../../lib/clipboard";
import { showToast } from "../Toast";
import { DATA_MODE_LABEL, STATUS_META, ago, bytes, devApi, followJob, instanceUrls, tildify } from "../../lib/dev";
import type { DataInfo, DataMode, DevInstance, DevJob, DevProject, PlanView } from "../../lib/dev";
import { confirm, confirmDanger } from "../ConfirmDialog";
import { DataModePicker, JobSteps, StatusDot, YamlView } from "./DevBits";
import { usePoller } from "../../lib/poller";

type Tab = "overview" | "logs" | "env" | "data" | "override" | "settings";

interface Props {
  project: DevProject;
  inst: DevInstance;
  job: DevJob | null;
  initialTab?: Tab;
  onClose: () => void;
  onStart: () => void;
  onRestart: () => void;
  onStop: () => void;
  onRemove: () => void;
  onRenamed: (newName: string) => void;
  onNavigate?: (target: string) => void;
}

export default function InstanceDrawer(props: Props) {
  const [tab, setTab] = createSignal<Tab>(props.initialTab ?? "overview");
  const meta = () => STATUS_META[props.inst.status];
  const live = () => props.inst.status === "running" || props.inst.status === "partial";
  const busy = () => props.job?.status === "running";

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  document.addEventListener("keydown", onKey);
  onCleanup(() => document.removeEventListener("keydown", onKey));

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "logs", label: "Logs" },
    { id: "env", label: "Env" },
    { id: "data", label: "Data" },
    { id: "override", label: "Generated files" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <div class="dev-drawer-overlay" data-own-escape onClick={props.onClose}>
      <div class="dev-drawer" onClick={(e) => e.stopPropagation()}>
        <div class="dev-drawer-header">
          <div style={{ flex: 1, "min-width": 0 }}>
            <div class="dev-card-name" style={{ "font-size": "18px" }}>
              <StatusDot color={busy() ? "#58a6ff" : meta().color} pulse={busy()} />
              {props.inst.name}
              <span style={{ "font-size": "12px", color: busy() ? "#58a6ff" : meta().color, "font-weight": 500 }}>
                {busy() ? "Working…" : meta().label}
              </span>
            </div>
            <div class="dev-card-sub" style={{ "flex-wrap": "nowrap" }}>
              <span style={{ "flex-shrink": 0 }}>{props.inst.branch ?? `detached ${props.inst.head ?? ""}`} ·</span>
              <span class="mono dev-path" title={props.inst.path}><span>{tildify(props.inst.path)}</span></span>
              <button class="dev-icon-btn" title="Open folder" onClick={() => invoke("reveal_path", { path: props.inst.path }).catch((e) => showToast(String(e), "error"))}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
              </button>
            </div>
          </div>
          <div style={{ display: "flex", gap: "6px", "flex-shrink": 0 }}>
            <Show when={props.inst.status !== "orphaned"}>
              <Show when={live()} fallback={<button class="btn btn-sm btn-primary" disabled={busy()} onClick={props.onStart}>Start…</button>}>
                <button class="btn btn-sm" disabled={busy()} onClick={props.onRestart} title="Rebuild from this worktree's code and restart">Rebuild</button>
                <button class="btn btn-sm" disabled={busy()} onClick={props.onStop}>Stop</button>
              </Show>
            </Show>
            <button class="btn btn-sm btn-outline" disabled={busy()} onClick={props.onRemove} title="Delete containers, volumes, images and generated files">Remove</button>
            <button class="modal-close" onClick={props.onClose} title="Close (Esc)">×</button>
          </div>
        </div>
        <div class="detail-tab-bar" style={{ padding: "0 14px", "margin-top": "10px" }}>
          <For each={tabs}>
            {(t) => (
              <button class={`detail-tab-item ${tab() === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            )}
          </For>
        </div>
        <div class="dev-drawer-body">
          <Show when={tab() === "overview"}>
            <Overview {...props} />
          </Show>
          <Show when={tab() === "logs"}>
            <Logs project={props.project} inst={props.inst} />
          </Show>
          <Show when={tab() === "env"}>
            <Env project={props.project} inst={props.inst} />
          </Show>
          <Show when={tab() === "data"}>
            <Data project={props.project} inst={props.inst} />
          </Show>
          <Show when={tab() === "override"}>
            <Generated project={props.project} inst={props.inst} />
          </Show>
          <Show when={tab() === "settings"}>
            <Settings project={props.project} inst={props.inst} onRenamed={props.onRenamed} />
          </Show>
        </div>
      </div>
    </div>
  );
}

function Overview(props: Props) {
  const [lastJob, setLastJob] = createSignal<DevJob | null>(null);
  const [showLog, setShowLog] = createSignal(false);

  // Show the running job, or the most recent one for this instance.
  createEffect(
    on(
      () => [props.job?.id, props.job?.status, props.inst.name] as const,
      async () => {
        if (props.job) {
          setLastJob(props.job);
          return;
        }
        try {
          const jobs = await devApi.jobs(props.project.id);
          const mine = jobs.find((j) => j.instance === props.inst.name);
          setLastJob(mine ? await devApi.job(mine.id) : null);
        } catch {
          setLastJob(null);
        }
      },
    ),
  );

  const urls = () => instanceUrls(props.inst.routes);
  const envPath = () => `${props.inst.path}/.orca/env`;
  const actionLabel = (a: string) =>
    ({ up: "Start", down: "Stop", remove: "Remove", shared_up: "Start shared", shared_down: "Stop shared" } as Record<string, string>)[a] ?? a;

  return (
    <>
      <Show when={lastJob()}>
        <div class="dev-section">
          <div class="dev-section-title">
            {lastJob()!.status === "running" ? "In progress" : "Last run"}: {actionLabel(lastJob()!.action)}
            <span style={{ "font-weight": 400, "text-transform": "none", "letter-spacing": 0, color: "#6e7681" }}>
              {ago(lastJob()!.started_at)}
            </span>
          </div>
          <Show when={lastJob()!.status === "failed" && (props.inst.status === "running" || props.inst.status === "partial")}>
            <div class="form-hint" style={{ "margin-bottom": "6px" }}>
              This attempt failed, but the instance kept running as it was before.
            </div>
          </Show>
          <JobSteps steps={lastJob()!.steps} />
          <Show when={lastJob()!.error}>
            <div class="dev-error" style={{ "margin-top": "8px" }}>{lastJob()!.error}</div>
          </Show>
          <Show when={(lastJob()!.log?.length ?? 0) > 0}>
            <button class="btn btn-sm btn-outline" style={{ "margin-top": "8px" }} onClick={() => setShowLog(!showLog())}>
              {showLog() ? "Hide" : "Show"} full output ({lastJob()!.log.length} lines)
            </button>
            <Show when={showLog()}>
              <pre class="dev-code" style={{ "max-height": "320px", "margin-top": "8px" }}>{lastJob()!.log.join("\n")}</pre>
            </Show>
          </Show>
        </div>
      </Show>

      <Show when={urls().length > 0 || props.inst.ports.length > 0}>
        <div class="dev-section">
          <div class="dev-section-title">Reach it</div>
          <table class="dev-table">
            <tbody>
              <For each={urls()}>
                {(u) => (
                  <tr>
                    <td style={{ width: "120px", color: "#8b949e" }}>{u.service}</td>
                    <td class="mono">{u.url}</td>
                    <td style={{ "text-align": "right" }}>
                      <button class="btn btn-sm" onClick={() => shellOpen(u.url).catch(() => {})}>Open</button>{" "}
                      <button class="btn btn-sm btn-outline" onClick={() => copyToClipboard(u.url)}>Copy</button>
                    </td>
                  </tr>
                )}
              </For>
              <For each={props.inst.ports}>
                {(p) => (
                  <tr>
                    <td style={{ color: "#8b949e" }}>{p.service} :{p.container_port}</td>
                    <td class="mono">localhost:{p.host_port}</td>
                    <td style={{ "text-align": "right" }}>
                      <button class="btn btn-sm btn-outline" onClick={() => copyToClipboard(`localhost:${p.host_port}`)}>Copy</button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <div class="form-hint" style={{ "margin-top": "6px" }}>
            Host ports stay the same for this worktree across restarts.
          </div>
        </div>
      </Show>

      <Show when={props.inst.services.length > 0}>
        <div class="dev-section">
          <div class="dev-section-title">Services</div>
          <table class="dev-table">
            <thead>
              <tr><th>Service</th><th>State</th><th>Container</th><th>Image</th></tr>
            </thead>
            <tbody>
              <For each={props.inst.services}>
                {(s) => (
                  <tr>
                    <td style={{ "font-weight": 500 }}>{s.name}</td>
                    <td>
                      <span style={{ display: "inline-flex", gap: "6px", "align-items": "center" }}>
                        <StatusDot color={s.state.toLowerCase() === "running" ? "#3fb950" : "#6e7681"} />
                        {s.state.toLowerCase()}
                      </span>
                    </td>
                    <td>
                      <a href="#" style={{ color: "#58a6ff" }} onClick={(e) => { e.preventDefault(); props.onNavigate?.(`container:${s.container_id}`); }}>
                        {s.container_name}
                      </a>
                    </td>
                    <td class="mono" style={{ color: "#8b949e" }}>{s.image}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <div class="dev-section">
        <div class="dev-section-title">Use it from your tools and agents</div>
        <div class="dev-explainer" style={{ "margin-bottom": "0", display: "block" }}>
          <div>
            URLs, ports and connection strings for this instance are in{" "}
            <a href="#" class="mono" style={{ color: "#58a6ff" }} onClick={(e) => { e.preventDefault(); copyToClipboard(envPath()); }}>
              .orca/env
            </a>{" "}
            inside the worktree (git ignores the folder).
          </div>
          <pre class="dev-code" style={{ "margin-top": "10px" }}>{`cd ${tildify(props.inst.path)}
orca up          # start or rebuild this worktree's instance
orca status      # URLs, ports and service states
eval $(orca env) # load the instance's URLs and ports
orca logs -f     # follow logs`}</pre>
        </div>
      </div>
    </>
  );
}

function Logs(props: { project: DevProject; inst: DevInstance }) {
  const [service, setService] = createSignal("");
  const [text, setText] = createSignal("");
  const [follow, setFollow] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  let box: HTMLPreElement | undefined;

  const load = async () => {
    try {
      const r = await devApi.logs(props.project.id, props.inst.name, { service: service() || undefined, tail: 400 });
      setText(r.logs);
      setError(null);
      if (follow() && box) queueMicrotask(() => box && (box.scrollTop = box.scrollHeight));
    } catch (e) {
      setError(String(e));
    }
  };
  createEffect(on(service, load));
  usePoller(() => follow() && load(), 2500, { immediate: false });

  const colors = ["#79c0ff", "#7ee787", "#d2a8ff", "#ffa657", "#ff7b72", "#a5d6ff", "#f2cc60"];
  const colorFor = (svc: string) => {
    let h = 0;
    for (const c of svc) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return colors[h % colors.length];
  };
  // Memoized (it used to be re-parsed for each of its two readers), and
  // unchanged lines reuse their row object from the previous poll so <For>
  // keeps their DOM nodes instead of rebuilding every row.
  type Row = { svc: string; ts: string; msg: string };
  let prevRows = new Map<string, Row>();
  const lines = createMemo(() => {
    const rows = new Map<string, Row>();
    const parsed = text()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l, i) => {
        let row = prevRows.get(l);
        if (!row) {
          const m = l.match(/^(\S+)\s+\|\s?(\S+)?\s?(.*)$/);
          row = m ? { svc: m[1].replace(/-\d+$/, ""), ts: m[2] ?? "", msg: m[3] ?? "" } : { svc: "", ts: "", msg: l };
        }
        rows.set(l, row);
        return { row, i };
      })
      // compose prints each service's lines as a block; interleave by time.
      .sort((a, b) => (a.row.ts && b.row.ts && a.row.ts !== b.row.ts ? (a.row.ts < b.row.ts ? -1 : 1) : a.i - b.i));
    prevRows = rows;
    return parsed.map((p) => p.row);
  });

  return (
    <>
      <div style={{ display: "flex", gap: "10px", "align-items": "center", "margin-bottom": "10px" }}>
        <Dropdown
          value={service()}
          options={[{ value: "", label: "All services" }, ...props.inst.services.map((s) => ({ value: s.name, label: s.name }))]}
          onChange={setService}
          style={{ width: "200px" }}
        />
        <label style={{ display: "flex", gap: "6px", "align-items": "center", "font-size": "12px", color: "#c9d1d9", cursor: "pointer" }}>
          <input type="checkbox" checked={follow()} onChange={(e) => setFollow(e.currentTarget.checked)} />
          Follow
        </label>
        <button class="btn btn-sm btn-outline" onClick={load}>Refresh</button>
      </div>
      <Show when={error()}>
        <div class="dev-error">{error()}</div>
      </Show>
      <pre class="dev-code dev-logs" ref={box}>
        <Show when={lines().length > 0} fallback={<span style={{ color: "#6e7681" }}>No log output yet.</span>}>
          <For each={lines()}>
            {(l) => (
              <>
                <Show when={l.svc}>
                  <span class="dev-log-svc" style={{ color: colorFor(l.svc) }}>{l.svc.padEnd(10)}</span>{" "}
                </Show>
                <Show when={l.ts}>
                  <span style={{ color: "#6e7681" }}>{l.ts.slice(11, 19)}</span>{" "}
                </Show>
                {l.msg}
                {"\n"}
              </>
            )}
          </For>
        </Show>
      </pre>
    </>
  );
}

function Generated(props: { project: DevProject; inst: DevInstance }) {
  const [plan, setPlan] = createSignal<PlanView | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(
    on(
      () => props.inst.name,
      async () => {
        try {
          setPlan(await devApi.plan(props.project.id, props.inst.name));
          setError(null);
        } catch (e) {
          setError(String(e));
        }
      },
    ),
  );
  return (
    <>
      <Show when={error()}>
        <div class="dev-error">{error()}</div>
      </Show>
      <Show when={!plan() && !error()}>
        <div style={{ color: "#8b949e", "font-size": "12px" }}>Reading compose files…</div>
      </Show>
      <Show when={plan()}>
        <div class="dev-explainer">
          <div>
            Orca never edits your compose files. It adds{" "}
            <b>{plan()!.resolved_mode ? ".orca/compose.resolved.yaml" : ".orca/compose.override.yaml"}</b> on top of{" "}
            <span class="mono">{plan()!.compose_files.map((f) => f.split("/").pop()).join(", ")}</span> and runs them as compose
            project <span class="mono">{plan()!.compose_project}</span>. <span style={{ color: "#7ee787" }}>Green comments</span>{" "}
            say why each line is there; <span style={{ color: "#ffa657" }}>!reset</span> removes a value from your file and{" "}
            <span style={{ color: "#ffa657" }}>!override</span> replaces it.
          </div>
        </div>
        <div class="dev-section">
          <div class="dev-section-title">
            {plan()!.resolved_mode ? "compose.resolved.yaml" : "compose.override.yaml"}
            <button class="btn btn-sm btn-outline" style={{ "margin-left": "auto" }} onClick={() => copyToClipboard(plan()!.plan.override_yaml)}>Copy</button>
          </div>
          <YamlView text={plan()!.plan.override_yaml} />
        </div>
        <div class="dev-section">
          <div class="dev-section-title">
            .orca/env
            <button class="btn btn-sm btn-outline" style={{ "margin-left": "auto" }} onClick={() => copyToClipboard(plan()!.plan.env_file)}>Copy</button>
          </div>
          <pre class="dev-code">{plan()!.plan.env_file}</pre>
        </div>
        <For each={plan()!.plan.warnings}>{(w) => <div class="dev-warning" style={{ "margin-bottom": "6px" }}>{w}</div>}</For>
      </Show>
    </>
  );
}

function Settings(props: { project: DevProject; inst: DevInstance; onRenamed: (n: string) => void }) {
  const [name, setName] = createSignal(props.inst.name);
  const [overrides, setOverrides] = createSignal<Record<string, string>>({ ...props.inst.hostname_overrides });
  const [plan, setPlan] = createSignal<PlanView | null>(null);
  const [saving, setSaving] = createSignal(false);
  const hasContainers = () => props.inst.services.length > 0;

  devApi.plan(props.project.id, props.inst.name).then(setPlan).catch(() => {});

  // Services with a browser URL get a hostname field; show the pattern's
  // default as the placeholder.
  const exposed = () => {
    const seen = new Set<string>();
    return (plan()?.plan.routes ?? [])
      .filter((r) => !r.path && !seen.has(r.service) && seen.add(r.service))
      .map((r) => ({ service: r.service, current: r.hostname }));
  };
  const defaultHost = (svc: string, current: string) =>
    props.inst.hostname_overrides[svc] ? "default from the project's pattern" : current;

  const save = async () => {
    setSaving(true);
    try {
      const r = await devApi.update(props.project.id, props.inst.name, {
        name: name() !== props.inst.name ? name() : undefined,
        hostname_overrides: overrides(),
      });
      showToast(
        live() ? "Saved. Restart the instance to apply new hostnames." : "Saved.",
        "success",
      );
      if (r.name !== props.inst.name) props.onRenamed(r.name);
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setSaving(false);
    }
  };
  const live = () => props.inst.status === "running" || props.inst.status === "partial";

  return (
    <>
      <div class="dev-section">
        <div class="dev-section-title">Name</div>
        <input
          class="form-input mono"
          style={{ width: "320px" }}
          value={name()}
          disabled={hasContainers()}
          onInput={(e) => setName(e.currentTarget.value.toLowerCase())}
        />
        <div class="form-hint" style={{ "margin-top": "6px" }}>
          {hasContainers()
            ? "Stop the instance to rename it: its containers and URLs are named after it."
            : `Used in URLs and container names (${props.project.id}-${name()}-…). Lowercase letters, digits and dashes.`}
        </div>
      </div>
      <div class="dev-section">
        <div class="dev-section-title">Hostnames</div>
        <Show when={exposed().length > 0} fallback={<div class="form-hint">Nothing in this instance opens in a browser.</div>}>
          <table class="dev-table">
            <thead><tr><th style={{ width: "120px" }}>Service</th><th>Hostname</th></tr></thead>
            <tbody>
              <For each={exposed()}>
                {(e) => (
                  <tr>
                    <td>{e.service}</td>
                    <td>
                      <input
                        class="form-input mono"
                        style={{ width: "100%" }}
                        placeholder={defaultHost(e.service, e.current)}
                        value={overrides()[e.service] ?? ""}
                        onInput={(ev) => setOverrides({ ...overrides(), [e.service]: ev.currentTarget.value.trim().toLowerCase() })}
                      />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <div class="form-hint" style={{ "margin-top": "6px" }}>
            Leave empty to use the project's pattern. Overrides are stored by Orca for this worktree, not in orca.yaml.
          </div>
        </Show>
      </div>
      <button class="btn btn-primary" disabled={saving()} onClick={save}>Save</button>
    </>
  );
}

const SECRET_RE = /(PASS|SECRET|TOKEN|KEY|CREDENTIAL)/i;

function maskUrlPassword(v: string): string {
  return v.replace(/(\/\/[^:/@]+:)([^@]+)(@)/, "$1••••$3");
}

function Env(props: { project: DevProject; inst: DevInstance }) {
  const [plan, setPlan] = createSignal<PlanView | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [reveal, setReveal] = createSignal(false);
  devApi
    .plan(props.project.id, props.inst.name)
    .then(setPlan)
    .catch((e) => setError(String(e)));

  const shown = (key: string, value: string) => {
    if (reveal()) return value;
    if (SECRET_RE.test(key)) return "••••••";
    return maskUrlPassword(value);
  };
  const exports = () =>
    (plan()?.plan.env_file ?? "")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return `export ${l.slice(0, i)}='${l.slice(i + 1).replace(/'/g, "'\\''")}'`;
      })
      .join("\n");

  return (
    <>
      <Show when={error()}>
        <div class="dev-error">{error()}</div>
      </Show>
      <Show when={plan()}>
        <div class="dev-explainer">
          <div>
            Two places see this instance: <b>containers</b> reach other services by name (<span class="mono">postgres:5432</span>),
            and <b>your machine</b> (tests, scripts, agents) uses the URLs and host ports in <span class="mono">.orca/env</span>.
            Values Orca set or changed are marked.
          </div>
        </div>
        <div class="dev-section">
          <div class="dev-section-title">
            From your machine · .orca/env
            <span style={{ "margin-left": "auto", display: "flex", gap: "6px" }}>
              <button class="btn btn-sm btn-outline" onClick={() => copyToClipboard(plan()!.plan.env_file)}>Copy .env</button>
              <button class="btn btn-sm btn-outline" onClick={() => copyToClipboard(exports())}>Copy as exports</button>
            </span>
          </div>
          <pre class="dev-code">{plan()!.plan.env_file}</pre>
        </div>
        <div class="dev-section">
          <div class="dev-section-title">
            Inside containers
            <label style={{ "margin-left": "auto", display: "flex", gap: "6px", "align-items": "center", "text-transform": "none", "letter-spacing": 0, "font-weight": 400, cursor: "pointer" }}>
              <input type="checkbox" checked={reveal()} onChange={(e) => setReveal(e.currentTarget.checked)} />
              Show secrets
            </label>
          </div>
          <For each={Object.entries(plan()!.plan.service_env)}>
            {([svc, vars]) => (
              <div style={{ "margin-bottom": "14px" }}>
                <div style={{ "font-weight": 600, "font-size": "13px", color: "#e6edf3", "margin-bottom": "4px" }}>{svc}</div>
                <Show when={vars.length > 0} fallback={<div class="form-hint">No environment variables.</div>}>
                  <table class="dev-table">
                    <tbody>
                      <For each={vars}>
                        {(v) => (
                          <tr>
                            <td class="mono" style={{ width: "34%", color: "#c9d1d9" }}>{v.key}</td>
                            <td class="mono" style={{ "word-break": "break-all", color: v.source === "orca" ? "#a5d6ff" : "#e6edf3" }}>
                              {shown(v.key, v.value)}
                            </td>
                            <td style={{ width: "70px", "text-align": "right" }}>
                              <Show when={v.source === "orca"}>
                                <span class="dev-chip dev-chip-accent" style={{ "font-size": "10px", padding: "1px 7px" }} title={v.why ?? ""}>Orca</span>
                              </Show>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

function Data(props: { project: DevProject; inst: DevInstance }) {
  const [info, setInfo] = createSignal<DataInfo[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const live = () => props.inst.status === "running" || props.inst.status === "partial";

  const load = () =>
    devApi
      .data(props.project.id, props.inst.name)
      .then((d) => {
        setInfo(d);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  load();

  const change = async (c: DataInfo, mode: DataMode) => {
    if (mode === c.mode) return;
    let drop = false;
    if (c.mode === "own-database" && c.tenant && c.kind !== "redis") {
      drop = await confirm({
        title: `Delete ${c.tenant}?`,
        message:
          `${props.inst.name} is leaving its own ${c.service} database ${c.tenant}${c.size ? ` (${bytes(c.size)})` : ""}. ` +
          "Delete it now, or keep it so switching back picks up where you left off?",
        confirmLabel: "Delete it",
        cancelLabel: "Keep it",
        danger: true,
      });
    }
    const modes: Record<string, DataMode> = {};
    for (const x of info() ?? []) modes[x.service] = x.service === c.service ? mode : x.mode;
    setBusy(c.service);
    try {
      await devApi.update(props.project.id, props.inst.name, { data_modes: modes, drop_data: drop });
      showToast(
        live()
          ? `${c.service} will use ${DATA_MODE_LABEL[mode].toLowerCase()} after the next start. Rebuild to apply now.`
          : `${c.service} will use ${DATA_MODE_LABEL[mode].toLowerCase()} from the next start.`,
        "success",
      );
      await load();
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const reset = async (c: DataInfo) => {
    const ok = await confirmDanger({
      title: `Reset ${c.tenant}?`,
      message: `This deletes everything in ${c.tenant} and copies ${c.shared_db} into it again.`,
      confirmLabel: "Reset",
    });
    if (!ok) return;
    setBusy(c.service);
    try {
      const job = await devApi.dataReset(props.project.id, props.inst.name, c.service);
      const done = await followJob(job.id, () => {});
      if (done.status === "succeeded") showToast(`${c.tenant} was reset`, "success");
      else showToast(done.error ?? "Reset failed", "error");
      await load();
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Show when={error()}>
        <div class="dev-error">{error()}</div>
      </Show>
      <Show when={info() && info()!.length === 0}>
        <div class="form-hint">This project has no shared services, so every instance has all its data to itself.</div>
      </Show>
      <For each={info() ?? []}>
        {(c) => (
          <div class="dev-section">
            <div class="dev-section-title">
              {c.service}
              <span style={{ "font-weight": 400, "text-transform": "none", "letter-spacing": 0, color: "#6e7681" }}>
                {c.kind ?? ""}
              </span>
            </div>
            <DataModePicker choice={c} value={c.mode} disabled={busy() === c.service} onChange={(m) => change(c, m)} />
            <div style={{ display: "flex", gap: "12px", "align-items": "center", "margin-top": "10px", "font-size": "12px", color: "#8b949e" }}>
              <Show when={c.mode === "own-database" && c.tenant}>
                <span>
                  Database <span class="mono" style={{ color: "#e6edf3" }}>{c.kind === "redis" ? `DB ${c.tenant}` : c.tenant}</span>
                  {c.size != null
                    ? ` · ${c.kind === "redis" ? `${c.size} keys` : c.kind === "rabbitmq" ? `${c.size} queues` : bytes(c.size)}`
                    : " · created on next start"}
                </span>
                <Show when={c.kind !== "redis"}>
                  <button class="btn btn-sm btn-outline" disabled={busy() === c.service} onClick={() => reset(c)}>
                    {c.kind === "rabbitmq" ? "Empty the vhost" : "Reset to a fresh copy"}
                  </button>
                </Show>
              </Show>
              <Show when={c.mode === "shared" && c.shared_db}>
                <span>
                  Uses <span class="mono" style={{ color: "#e6edf3" }}>{c.kind === "redis" ? "DB 0" : c.kind === "rabbitmq" ? `vhost ${c.shared_db}` : c.shared_db}</span>
                  {c.shared_size != null && c.kind !== "redis" && c.kind !== "rabbitmq" ? ` · ${bytes(c.shared_size)}` : ""} with every other worktree.
                  Changes here are seen everywhere.
                </span>
              </Show>
              <Show when={c.mode === "own-server"}>
                <span>Runs as a {c.service} container inside this instance, with its own volume.</span>
              </Show>
            </div>
          </div>
        )}
      </For>
    </>
  );
}
