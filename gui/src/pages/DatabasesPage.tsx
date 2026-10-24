// Databases: the servers projects get a database on (the workspace's shared
// ones, and the ones Orca runs itself), the databases on them with what to
// do with each, and every project whose orca.yaml requires one.

import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { showToast } from "../components/Toast";
import { confirmDanger } from "../components/ConfirmDialog";
import HelpLink from "../components/HelpLink";
import AppIcon from "../components/AppIcon";
import CopyButton from "../components/CopyButton";
import Spinner from "../components/Spinner";
import { iconSrc } from "../lib/icons";
import { tildify } from "../lib/dev";
import type { GatewayRoute } from "../lib/types";
import {
  bytes,
  databasesApi,
  ENGINE_ICON,
  ENGINE_NAME,
  REQUIRE_SNIPPET,
  type ConnectionInfo,
  type DatabaseInfo,
  type DatabaseServer,
  type DatabasesOverview,
  type Snapshot,
} from "../lib/databases";

const openUrl = (url: string) => shellOpen(url).catch(() => window.open(url, "_blank", "noopener,noreferrer"));

export default function DatabasesPage(props: { onNavigate?: (target: string) => void }) {
  const [data, { refetch }] = createResource<DatabasesOverview | null>(() => databasesApi.overview().catch(() => null));
  const [routes] = createResource(() => invoke<GatewayRoute[]>("gateway_list_routes").catch(() => [] as GatewayRoute[]));
  const timer = setInterval(() => { if (!document.hidden) void refetch(); }, 10_000);
  onCleanup(() => clearInterval(timer));

  const [busy, setBusy] = createSignal<string | null>(null);
  const [connection, setConnection] = createSignal<{ server: DatabaseServer; db: DatabaseInfo; info: ConnectionInfo } | null>(null);
  const [snapshotsFor, setSnapshotsFor] = createSignal<{ server: DatabaseServer; db: DatabaseInfo } | null>(null);

  /** The workspace's phpMyAdmin or pgAdmin, when it routes one. */
  const adminTool = (s: DatabaseServer) => {
    const want = s.engine === "postgres" ? /pgadmin|adminer/i : /phpmyadmin|adminer/i;
    const r = (routes() ?? []).find((r) => r.enabled && want.test(`${r.presentation?.title ?? ""} ${r.hostname}`));
    return r ? { title: r.presentation?.title ?? r.hostname, url: r.url ?? `https://${r.hostname}` } : null;
  };

  const run = async (key: string, f: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await f();
      showToast(done, "success");
      await refetch();
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const connect = async (server: DatabaseServer, db: DatabaseInfo) => {
    try {
      setConnection({ server, db, info: await databasesApi.connection(server.id, db.name) });
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const reset = async (server: DatabaseServer, db: DatabaseInfo) => {
    const ok = await confirmDanger({
      title: `Reset ${db.name}`,
      message: `Every table and row in ${db.name} is deleted, and it starts empty${db.seed ? `. Then Orca runs its seed command: ${db.seed}` : ""}. Take a snapshot first if you might want it back.`,
      confirmLabel: "Reset database",
    });
    if (!ok) return;
    await run(`reset:${server.id}/${db.name}`, async () => {
      const r = await databasesApi.reset(server.id, db.name);
      if (r.seed_output) showToast(`Seeded: ${r.seed_output.split("\n").filter(Boolean).pop()}`, "info");
    }, `${db.name} is empty again`);
  };

  const snapshot = (server: DatabaseServer, db: DatabaseInfo) =>
    run(`snap:${server.id}/${db.name}`, () => databasesApi.snapshot(server.id, db.name), `Saved a snapshot of ${db.name}`);

  const needsAny = () => (data()?.projects.length ?? 0) > 0;
  const serversAny = () => (data()?.servers.length ?? 0) > 0;

  return (
    <div class="db-page">
      <div class="page-header">
        <div>
          <h1 class="page-title">Databases</h1>
          <div class="dev-subtitle">
            A database and a user of its own for each project that requires one.{" "}
            <HelpLink path="/docs/databases/" />
          </div>
        </div>
      </div>

      <Show when={data() !== undefined} fallback={<div class="db-muted">Loading…</div>}>
        <Show when={needsAny() || serversAny()} fallback={<GetStarted />}>
          {/* What each project needs, and where it comes from */}
          <Show when={needsAny()}>
            <div class="db-section-title">Projects</div>
            <div class="db-needs">
              <For each={data()!.projects}>
                {(p) => (
                  <div class="db-need">
                    <div class="db-need-head">
                      <span class={`app-dot ${p.running ? "running" : ""}`} />
                      <b>{p.project}</b>
                      <span class="db-muted mono">{tildify(p.dir)}</span>
                    </div>
                    <For each={p.databases}>
                      {(r) => (
                        <div class="db-need-row" classList={{ bad: !!r.error, own: r.source?.kind === "own" }}>
                          <Show when={!r.error} fallback={<><span class="db-mark bad">✕</span><span>{r.error}</span></>}>
                            <span class={`db-mark ${r.source?.kind === "own" ? "own" : "ok"}`}>{r.source?.kind === "own" ? "○" : "✓"}</span>
                            <span>
                              {ENGINE_NAME[r.engine!]}{r.version ? ` ${r.version}` : ""}
                              {" → "}
                              <Show when={r.source?.kind !== "own"} fallback={<>{r.from} <span class="db-muted">({r.source?.why})</span></>}>
                                <b class="mono">{r.database}</b> on {r.from}
                                <Show when={r.replaces}>{(svc) => <span class="db-muted">, instead of its own {svc()}</span>}</Show>
                              </Show>
                            </span>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </Show>

          {/* The servers, and the databases on each */}
          <div class="db-section-title">Servers</div>
          <Show when={serversAny()} fallback={<div class="db-muted db-pad">None yet: one starts the first time a project needs it.</div>}>
            <For each={data()!.servers}>
              {(s) => (
                <div class="db-server">
                  <div class="db-server-head">
                    <AppIcon src={iconSrc(ENGINE_ICON[s.engine])} name={s.engine} size={30} />
                    <div class="db-server-title">
                      <div>
                        <b>{ENGINE_NAME[s.engine]}{s.version ? ` ${s.version}` : ""}</b>
                        <span class={`db-badge ${s.source}`}>{s.source === "workspace" ? "Workspace" : "Run by Orca"}</span>
                      </div>
                      <div class="db-muted">
                        <span class={`app-dot ${s.running ? "running" : ""}`} /> {s.running ? "Running" : "Stopped"}
                        <Show when={s.container}>{(c) => <> · <span class="mono">{c()}</span> inside containers</>}</Show>
                        <Show when={s.port}>{(p) => <> · <span class="mono">localhost:{p()}</span> from this computer</>}</Show>
                      </div>
                    </div>
                    <div class="db-server-actions">
                      <Show when={adminTool(s)}>
                        {(t) => <button class="btn btn-sm" onClick={() => void openUrl(t().url)}>Open {t().title} ↗</button>}
                      </Show>
                      <Show when={s.source === "orca"}>
                        <Show when={s.running} fallback={
                          <button class="btn btn-sm btn-primary" disabled={busy() === s.id} onClick={() => void run(s.id, () => databasesApi.start(s.id), `${ENGINE_NAME[s.engine]} started`)}>Start</button>
                        }>
                          <button class="btn btn-sm" disabled={busy() === s.id} title="Projects using it lose their database until it starts again"
                            onClick={() => void run(s.id, () => databasesApi.stop(s.id), `${ENGINE_NAME[s.engine]} stopped`)}>Stop</button>
                        </Show>
                      </Show>
                    </div>
                  </div>
                  <Show when={s.databases.length > 0} fallback={<div class="db-muted db-pad">No databases on it yet.</div>}>
                    <table class="table db-table">
                      <thead>
                        <tr><th>Database</th><th>Project</th><th>User</th><th style={{ "text-align": "right" }}>Size</th><th style={{ "text-align": "right" }}>Actions</th></tr>
                      </thead>
                      <tbody>
                        <For each={s.databases}>
                          {(d) => (
                            <tr>
                              <td class="mono">{d.name}</td>
                              <td>
                                <Show when={d.project} fallback={<span class="db-muted" title="Not made by Orca for a project">—</span>}>
                                  <button class="btn-link" onClick={() => props.onNavigate?.(`stack:${d.project}`)}>{d.project}</button>
                                </Show>
                              </td>
                              <td class="mono db-muted">{d.user ?? "—"}</td>
                              <td class="mono" style={{ "text-align": "right" }}>{bytes(d.size)}</td>
                              <td style={{ "text-align": "right", "white-space": "nowrap" }}>
                                <button class="btn btn-sm" disabled={!s.running} onClick={() => void connect(s, d)}>Connect</button>
                                <button class="btn btn-sm" disabled={!s.running || !!busy()} onClick={() => void snapshot(s, d)}>
                                  {busy() === `snap:${s.id}/${d.name}` ? <Spinner size={11} /> : "Snapshot"}
                                </button>
                                <button class="btn btn-sm" onClick={() => setSnapshotsFor({ server: s, db: d })}>
                                  Restore{d.snapshots ? ` (${d.snapshots})` : ""}
                                </button>
                                <Show when={d.project}>
                                  <button class="btn btn-sm btn-danger-outline" disabled={!s.running || !!busy()} onClick={() => void reset(s, d)}>
                                    {busy() === `reset:${s.id}/${d.name}` ? <Spinner size={11} /> : "Reset"}
                                  </button>
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
          </Show>

          <details class="db-howto">
            <summary>Give another project a database</summary>
            <HowTo />
          </details>
        </Show>
      </Show>

      <Show when={connection()}>
        {(c) => <ConnectionDialog {...c()} onClose={() => setConnection(null)} />}
      </Show>
      <Show when={snapshotsFor()}>
        {(t) => <SnapshotsDialog {...t()} onClose={() => { setSnapshotsFor(null); void refetch(); }} />}
      </Show>
    </div>
  );
}

/** Nothing requires a database yet: what this is, and how to start. */
function GetStarted() {
  return (
    <div class="db-empty">
      <div class="db-empty-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
        </svg>
      </div>
      <h2>No project requires a database yet</h2>
      <p>
        Instead of each project running its own database container, a project can say what it needs, and Orca gives it a database
        and a user of its own: on your team's shared server when the workspace has one, otherwise on one Orca runs.
      </p>
      <HowTo />
    </div>
  );
}

function HowTo() {
  return (
    <div class="db-howto-body">
      <ol class="db-steps">
        <li>Add this to the project's <span class="mono">orca.yaml</span>:</li>
      </ol>
      <div class="db-snippet">
        <pre class="mono">{REQUIRE_SNIPPET}</pre>
        <CopyButton text={REQUIRE_SNIPPET} label="Copy" />
      </div>
      <ol class="db-steps" start={2}>
        <li>Start the project. Orca creates its database and user, writes the connection into its <span class="mono">.env</span>, and, with <span class="mono">replaces</span>, leaves its own database container out.</li>
        <li>Its database shows up here, to connect to, snapshot, restore or reset.</li>
      </ol>
      <p class="db-muted">
        Teams can share one server per engine through their workspace's <span class="mono">databases:</span> section.{" "}
        <HelpLink path="/docs/databases/#shared-servers-in-a-workspace">How</HelpLink>
      </p>
    </div>
  );
}

function Field(props: { label: string; value: string; secret?: boolean }) {
  const [shown, setShown] = createSignal(!props.secret);
  return (
    <div class="db-field">
      <span class="db-field-label">{props.label}</span>
      <span class="mono db-field-value">{shown() ? props.value : "••••••••••••"}</span>
      <Show when={props.secret}>
        <button class="btn btn-sm" onClick={() => setShown(!shown())}>{shown() ? "Hide" : "Show"}</button>
      </Show>
      <CopyButton text={props.value} />
    </div>
  );
}

function ConnectionDialog(props: { server: DatabaseServer; db: DatabaseInfo; info: ConnectionInfo; onClose: () => void }) {
  const i = () => props.info;
  return (
    <div class="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="modal-dialog db-dialog">
        <div class="modal-header">
          <h2 class="modal-title">Connect to {props.db.name}</h2>
          <button class="modal-close" onClick={props.onClose}>×</button>
        </div>
        <div class="modal-body">
          <div class="db-fields">
            <Show when={i().host_port}>{(p) => <Field label="From this computer" value={`127.0.0.1:${p()}`} />}</Show>
            <Show when={props.server.container}>{(c) => <Field label="From containers" value={`${c()}:${props.server.engine === "postgres" ? 5432 : 3306}`} />}</Show>
            <Field label="Database" value={i().database} />
            <Show when={i().user}>{(u) => <Field label="User" value={u()} />}</Show>
            <Show when={i().password}>{(p) => <Field label="Password" value={p()} secret />}</Show>
          </div>
          <Show when={i().outside}>
            {(u) => <div class="db-url"><span class="db-muted">For database tools (TablePlus, DBeaver, DataGrip):</span><Field label="URL" value={u()} secret /></div>}
          </Show>
          <Show when={i().inside}>
            {(u) => <div class="db-url"><span class="db-muted">For the project's containers (already in its <span class="mono">.env</span>):</span><Field label="URL" value={u()} secret /></div>}
          </Show>
        </div>
      </div>
    </div>
  );
}

function SnapshotsDialog(props: { server: DatabaseServer; db: DatabaseInfo; onClose: () => void }) {
  const [list, { refetch }] = createResource(() => databasesApi.snapshots(props.server.id, props.db.name).catch(() => [] as Snapshot[]));
  const [label, setLabel] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const act = async (f: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await f(); showToast(done, "success"); await refetch(); } catch (e) { showToast(String(e), "error"); } finally { setBusy(false); }
  };
  const restore = async (s: Snapshot) => {
    const ok = await confirmDanger({
      title: `Restore ${props.db.name}`,
      message: `${props.db.name} is replaced with the snapshot from ${new Date(s.at * 1000).toLocaleString()}. What's in it now is lost unless you take a snapshot first.`,
      confirmLabel: "Restore snapshot",
    });
    if (ok) await act(() => databasesApi.restore(props.server.id, props.db.name, s.name), `${props.db.name} restored`);
  };
  return (
    <div class="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy()) props.onClose(); }}>
      <div class="modal-dialog db-dialog">
        <div class="modal-header">
          <h2 class="modal-title">Snapshots of {props.db.name}</h2>
          <button class="modal-close" onClick={props.onClose}>×</button>
        </div>
        <div class="modal-body">
          <form class="db-snap-new" onSubmit={(e) => { e.preventDefault(); void act(() => databasesApi.snapshot(props.server.id, props.db.name, label()), "Snapshot saved").then(() => setLabel("")); }}>
            <input class="form-input" placeholder="Label, such as before-migration (optional)" value={label()} onInput={(e) => setLabel(e.currentTarget.value)} />
            <button class="btn btn-primary" type="submit" disabled={busy() || !props.server.running}>Take snapshot</button>
          </form>
          <Show when={(list() ?? []).length > 0} fallback={<div class="db-muted db-pad">No snapshots yet. They're compressed SQL dumps kept on this computer.</div>}>
            <div class="db-snaps">
              <For each={list()}>
                {(s) => (
                  <div class="db-snap">
                    <div>
                      <div>{new Date(s.at * 1000).toLocaleString()}</div>
                      <div class="db-muted mono">{s.name} · {bytes(s.bytes)}</div>
                    </div>
                    <button class="btn btn-sm btn-primary" disabled={busy() || !props.server.running} onClick={() => void restore(s)}>Restore</button>
                    <button class="btn btn-sm" disabled={busy()} onClick={() => void act(() => databasesApi.deleteSnapshot(props.server.id, props.db.name, s.name), "Snapshot deleted")}>Delete</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
