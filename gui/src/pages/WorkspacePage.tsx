// The team workspace: join it with one repo URL, then set up any of its
// projects with one click (or by asking an AI tool). Secrets are filled in
// here, from the team's secret manager, never typed into a chat.

import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { showToast } from "../components/Toast";
import { confirm as confirmDialog } from "../components/ConfirmDialog";
import FolderActions from "../components/FolderActions";
import AppIcon from "../components/AppIcon";
import { iconSrc } from "../lib/icons";
import SecretsDialog from "../components/SecretsDialog";
import { JobProgress, JobSteps } from "../components/dev/DevBits";
import { ago, followJob, tildify, type DevJob } from "../lib/dev";
import { certExpiry } from "../lib/format";
import { databasesApi, ENGINE_NAME, shortFrom, type ProjectNeeds } from "../lib/databases";
import {
  clearWorkspaceJoin,
  pendingWorkspaceJoin,
  pendingWorkspaceSetup,
  clearWorkspaceSetup,
  workspaceApi,
  type FolderSuggestion,
  type MachineCheck,
  type WorkspaceProject,
  type WorkspaceStatus,
} from "../lib/workspace";

const DOCS = "https://orca-desktop.com/docs/workspaces/";
const openUrl = (url: string) => shellOpen(url).catch(() => window.open(url, "_blank", "noopener,noreferrer"));

export default function WorkspacePage(props: { onNavigate?: (target: string) => void }) {
  const [ws, { refetch, mutate }] = createResource(() => workspaceApi.status().catch(() => ({ joined: false }) as WorkspaceStatus));
  // The job running per project ("" for the workspace itself).
  const [jobs, setJobs] = createSignal<Record<string, DevJob>>({});
  const [secretsFor, setSecretsFor] = createSignal<WorkspaceProject | null>(null);

  // A landing page "Not set up" card: show that project and its Set up button.
  const [focused, setFocused] = createSignal<string | null>(null);
  createEffect(on([pendingWorkspaceSetup, () => ws()?.projects], ([key, projects]) => {
    if (!key || !projects) return;
    clearWorkspaceSetup();
    if (!projects.some((p) => p.key === key)) {
      showToast(`The workspace has no project called ${key}`, "error");
      return;
    }
    setFocused(key);
    requestAnimationFrame(() => document.getElementById(`ws-project-${key}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    setTimeout(() => setFocused((k) => (k === key ? null : k)), 4000);
  }));

  // The databases each project's orca.yaml requires, and where they come from.
  const [dbNeeds, { refetch: refetchDbs }] = createResource(() => databasesApi.quick().then((o) => o.projects).catch(() => [] as ProjectNeeds[]));
  const dbTimer = setInterval(() => { if (!document.hidden) void refetchDbs(); }, 15_000);
  onCleanup(() => clearInterval(dbTimer));
  const dbsOf = (dir: string) => (dbNeeds() ?? []).find((n) => n.dir === dir || n.dir.endsWith(dir.replace(/^~/, "")))?.databases ?? [];

  // "Workspace updated", until dismissed (per update, on this machine).
  const SEEN_KEY = "orca.workspace.seenUpdate";
  const [seenUpdate, setSeenUpdate] = createSignal((() => { try { return localStorage.getItem(SEEN_KEY); } catch { return null; } })());
  const dismissUpdate = (at: string) => {
    setSeenUpdate(at);
    try { localStorage.setItem(SEEN_KEY, at); } catch { /* the banner just comes back */ }
  };
  const freshUpdate = () => {
    const u = ws()?.last_update;
    return u && u.at !== seenUpdate() && u.commits.length > 0 ? u : null;
  };

  const timer = setInterval(() => { if (!document.hidden && !Object.values(jobs()).some((j) => j.status === "running")) void refetch(); }, 5_000);
  onCleanup(() => clearInterval(timer));

  const track = async (key: string, start: Promise<DevJob>) => {
    try {
      const job = await start;
      const done = await followJob(job.id, (j) => setJobs({ ...jobs(), [key]: j }));
      await refetch();
      return done;
    } catch (e) {
      showToast(String(e), "error");
      return null;
    }
  };

  const setup = async (p: WorkspaceProject, rerun = false) => {
    const done = await track(p.key, workspaceApi.setup(p.key, rerun));
    if (!done) return;
    if (done.status === "failed") {
      showToast(`${p.key}: ${done.error ?? "setup failed"}`, "error");
      return;
    }
    const result = done.result as { missing_secrets?: string[]; urls?: string[]; warnings?: string[] } | null;
    for (const w of result?.warnings ?? []) showToast(`${p.key}: ${w}`, "info");
    if (result?.missing_secrets?.length) {
      const fresh = ws()?.projects?.find((x) => x.key === p.key) ?? p;
      setSecretsFor(fresh);
      return;
    }
    showToast(`${p.key} is running`, "success");
    // Done: the progress gives way to the project's URLs.
    const { [p.key]: _, ...rest } = jobs();
    setJobs(rest);
  };

  // "Check this machine": asks git servers and the network, so only on click.
  const [checks, setChecks] = createSignal<MachineCheck[] | null>(null);
  const [checking, setChecking] = createSignal(false);
  const runCheck = async () => {
    setChecking(true);
    try {
      setChecks((await workspaceApi.check()).checks);
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setChecking(false);
    }
  };

  const update = async () => {
    const done = await track("", workspaceApi.update());
    if (done?.status === "succeeded") {
      showToast("Workspace up to date", "success");
      const { [""]: _, ...rest } = jobs();
      setJobs(rest);
    }
  };

  const leave = async () => {
    const ok = await confirmDialog({
      title: "Leave the workspace?",
      message: "Orca forgets the workspace, removes its routes and puts the gateway's domain, certificate, title and logo back as they were. The cloned projects, their .env files and running services stay.",
      confirmLabel: "Leave",
      danger: true,
    });
    if (!ok) return;
    await workspaceApi.leave().catch((e) => showToast(String(e), "error"));
    mutate({ joined: false });
  };

  return (
    <div class="workspace-page">
      <div class="page-header">
        <h1 class="page-title">Workspace</h1>
        <Show when={ws()?.joined && !ws()?.error}>
          <div class="page-actions">
            <Show when={ws()?.path}>{(p) => <FolderActions path={p()} compact />}</Show>
            <button class="btn" onClick={() => void runCheck()} disabled={checking()}
              title="Ports, domain, certificates, logins and access to every repository">
              {checking() ? "Checking…" : "Check this machine"}
            </button>
            <button class="btn" onClick={() => void update()} disabled={jobs()[""]?.status === "running"}>
              {jobs()[""]?.status === "running" ? "Updating…" : "Update"}
            </button>
            <button class="btn" onClick={() => void leave()}>Leave</button>
          </div>
        </Show>
      </div>

      <Show when={ws()} fallback={<div class="ws-muted">Loading…</div>}>
        {(w) => (
          <Show when={w().joined} fallback={<JoinPanel onJoined={() => void refetch()} />}>
            <Show when={!w().error} fallback={
              <div class="ws-alert bad">
                <b>The workspace file has a problem</b>
                <span>{w().error}</span>
                <span class="ws-muted">Fix it in {w().path}, then click Update.</span>
                <button class="btn btn-sm" onClick={() => void update()}>Update</button>
              </div>
            }>
              <Show when={freshUpdate()}>
                {(u) => (
                  <div class="ws-updated">
                    <div class="ws-updated-head">
                      <b>Workspace updated {ago(u().at)}</b>
                      <button class="ws-updated-close" title="Dismiss" onClick={() => dismissUpdate(u().at)}>×</button>
                    </div>
                    <ul>
                      <For each={u().commits}>{(c) => <li>{c}</li>}</For>
                      <Show when={u().more > 0}><li class="ws-muted">and {u().more} more</li></Show>
                    </ul>
                  </div>
                )}
              </Show>
              <div class="ws-hero">
                <div class="ws-brand">
                  <Show when={w().logo}>{(src) => <img class="ws-logo" src={src()} alt="" />}</Show>
                  <div>
                    <div class="ws-name">{w().name}</div>
                    <Show when={w().description}><div class="ws-desc">{w().description}</div></Show>
                  </div>
                </div>
                <div class="ws-facts">
                  <span class="ws-chip" title="The gateway serves every project under this domain">*.{w().domain}</span>
                  <span class="ws-chip" title={w().certificate === "workspace" ? "The certificate comes with the workspace" : "Orca's own certificate authority signs the names"}>
                    {w().certificate === "workspace" ? "Team certificate" : "Orca CA"}
                    <Show when={certExpiry(w().certificate_expires)}>{(e) => <span class={`cert-expiry ${e().level}`}> · {e().text}</span>}</Show>
                  </span>
                  <Show when={w().network}><span class="ws-chip" title="Docker network every project joins">{w().network}</span></Show>
                  <Show when={w().shared}>
                    {(s) => <span class={`ws-chip ${s().running === s().total ? "ok" : "warn"}`}>{s().running}/{s().total} shared services</span>}
                  </Show>
                </div>
              </div>

              <Show when={jobs()[""]}>{(j) => <div class="ws-job"><JobSteps steps={j().steps} /></div>}</Show>

              <Show when={checks()}>
                {(list) => (
                  <div class="ws-check">
                    <div class="ws-check-head">
                      <b>{list().some((c) => c.status === "bad") ? "This machine needs a few things" : list().some((c) => c.status === "warn") ? "Almost there" : "This machine is ready"}</b>
                      <button class="ws-updated-close" title="Close" onClick={() => setChecks(null)}>×</button>
                    </div>
                    <For each={list().filter((c) => c.status !== "skip")}>
                      {(c) => (
                        <div class={`ws-check-row ${c.status}`}>
                          <span class="ws-check-mark">{c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✕"}</span>
                          <div>
                            <div><b>{c.label}</b> <span class="ws-muted">{c.detail}</span></div>
                            <Show when={c.fix}>{(f) => <div class="ws-check-fix">{f()}</div>}</Show>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </Show>

              <For each={(w().registries ?? []).filter((r) => !r.logged_in)}>
                {(r) => (
                  <div class="ws-alert">
                    <b>Log in to {r.host}</b>
                    <span>Projects pull their images from it. Run this once in a terminal:</span>
                    <code class="mono">docker login {r.host}</code>
                    <button class="btn btn-sm" onClick={() => navigator.clipboard.writeText(`docker login ${r.host}`).then(() => showToast("Copied", "success"), () => {})}>Copy</button>
                  </div>
                )}
              </For>

              <Show when={(w().shared_urls ?? []).length > 0}>
                <div class="ws-section-title">Shared services</div>
                <div class="ws-shared">
                  <For each={w().shared_urls}>
                    {(u) => (
                      <button class="app-url app-url-icon" title={u.url} onClick={() => void openUrl(u.url)}>
                        <Show when={iconSrc(u.icon)}>{(src) => <img src={src()} alt="" />}</Show>
                        {u.title} ↗
                      </button>
                    )}
                  </For>
                </div>
              </Show>

              <div class="ws-section-title">
                Projects
                <span class="ws-muted"> · or ask your AI tool: “spin up {w().projects?.[0]?.key ?? "a project"}”</span>
              </div>
              <div class="ws-grid">
                <For each={[...(w().projects ?? [])].sort((a, b) => (a.group ?? a.key).localeCompare(b.group ?? b.key) || a.key.localeCompare(b.key))}>
                  {(p) => (
                    <ProjectCard
                      project={p}
                      job={jobs()[p.key]}
                      onSetup={(rerun) => void setup(p, rerun)}
                      onSecrets={() => setSecretsFor(p)}
                      onNavigate={props.onNavigate}
                      focused={focused() === p.key}
                      databases={dbsOf(p.dir)}
                    />
                  )}
                </For>
              </div>
            </Show>
          </Show>
        )}
      </Show>

      <Show when={secretsFor()}>
        {(p) => (
          <SecretsDialog
            project={p()}
            clis={ws()?.secret_clis}
            onClose={() => setSecretsFor(null)}
            onSaved={(allFilled) => {
              const project = p();
              setSecretsFor(null);
              void refetch();
              if (allFilled) void setup(project);
            }}
          />
        )}
      </Show>
    </div>
  );
}

function ProjectCard(props: {
  project: WorkspaceProject;
  job?: DevJob;
  onSetup: (rerun: boolean) => void;
  onSecrets: () => void;
  onNavigate?: (target: string) => void;
  focused?: boolean;
  databases?: ProjectNeeds["databases"];
}) {
  const p = () => props.project;
  const busy = () => props.job?.status === "running";
  const missing = () => p().secrets.filter((s) => !s.filled);
  const state = () => (p().running ? "running" : p().cloned ? "cloned" : "new");
  return (
    <div class="ws-card" id={`ws-project-${p().key}`} classList={{ running: p().running, focused: props.focused }}>
      <div class="ws-card-head">
        <AppIcon src={iconSrc(p().icon)} name={p().key} size={26} />
        <b>{p().key}</b>
        <Show when={p().group}>{(g) => <span class="ws-card-group" title="Its group in the workspace file">{g()}</span>}</Show>
        <span class={`app-dot ${p().running ? "running" : ""}`} />
        <span class={`ws-state ${state()}`}>{p().running ? "Running" : p().cloned ? "Cloned" : "Not cloned"}</span>
      </div>
      <Show when={p().description}><div class="ws-card-desc">{p().description}</div></Show>
      <div class="ws-card-repo mono" title={p().repo}>{p().repo}</div>
      <For each={props.databases ?? []}>
        {(r) => (
          <button class="ws-card-db" classList={{ bad: !!r.error }}
            title={r.error ?? (r.source?.kind === "own" ? `${r.from}: ${r.source?.why}` : `Database ${r.database} on ${r.from}. Open the Databases page.`)}
            onClick={() => props.onNavigate?.("databases")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /></svg>
            {r.error ? `Database: ${r.error}` : `${ENGINE_NAME[r.engine!]} · ${shortFrom(r)}`}
          </button>
        )}
      </For>

      <Show when={p().running && p().urls.length > 0}>
        <div class="app-card-urls">
          <For each={p().urls}>{(u) => <button class="app-url" onClick={() => void openUrl(u)}>{u.replace(/^https:\/\//, "")} ↗</button>}</For>
        </div>
      </Show>

      <Show when={p().cloned && missing().length > 0 && !busy()}>
        <button class="ws-secrets-warn" onClick={props.onSecrets}>
          🔑 {missing().length} secret{missing().length === 1 ? "" : "s"} to fill in
        </button>
      </Show>

      <Show when={props.job}>
        {(j) => (
          <div class="ws-card-job">
            <Show when={busy()} fallback={<JobSteps steps={j().steps} />}><JobProgress steps={j().steps} /></Show>
            <Show when={j().status === "failed" && j().error}>
              <div class="ws-card-error">{j().error}</div>
            </Show>
          </div>
        )}
      </Show>

      <div class="ws-card-actions">
        <Show when={!p().running} fallback={
          <>
            <Show when={p().stack}>{(s) => <button class="btn btn-sm" onClick={() => props.onNavigate?.(`stack:${s()}`)}>Open stack</button>}</Show>
          </>
        }>
          <button class="btn btn-sm btn-primary" disabled={busy()} onClick={() => props.onSetup(false)}>
            {busy() ? "Working…" : p().cloned ? "Start" : "Set up"}
          </button>
        </Show>
        <Show when={p().cloned}><FolderActions path={p().dir} compact /></Show>
        <Show when={p().cloned && p().setup && !busy()}>
          <button class="btn-link ws-rerun" title={p().setup ?? ""} onClick={() => props.onSetup(true)}>Run setup again</button>
        </Show>
      </div>
    </div>
  );
}

function JoinPanel(props: { onJoined: () => void }) {
  const [repo, setRepo] = createSignal("");
  const [folder, setFolder] = createSignal("");
  const [showFolder, setShowFolder] = createSignal(false);
  const [job, setJob] = createSignal<DevJob | null>(null);
  const [suggested, setSuggested] = createSignal<FolderSuggestion | null>(null);

  // Where it'll go, once a repo is typed: beside the user's checkouts, or
  // their copy of it. A local folder is joined where it is.
  let suggestTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(on(repo, (r) => {
    clearTimeout(suggestTimer);
    const url = r.trim();
    if (!url || url.startsWith("/") || url.startsWith("~") || url.startsWith(".")) { setSuggested(null); return; }
    suggestTimer = setTimeout(() => {
      workspaceApi.suggestFolder(url).then((s) => { if (repo().trim() === url) setSuggested(s); }, () => setSuggested(null));
    }, 300);
  }));
  onCleanup(() => clearTimeout(suggestTimer));
  // A workspace already checked out: joined where it is, nothing cloned.
  const pickFolder = async () => {
    const path = await invoke<string | null>("pick_folder", { title: "Choose the workspace's folder" }).catch(() => null);
    if (path) setRepo(path);
  };
  // A path rather than a git URL: that folder is joined where it is.
  const isFolder = () => /^(\/|~\/)/.test(repo().trim());
  const changeFolder = () => {
    setFolder(suggested()?.folder ?? "");
    setShowFolder(true);
  };

  // An orca://workspace?repo=… link fills the form in.
  createEffect(on(pendingWorkspaceJoin, (r) => {
    if (r) {
      setRepo(r);
      clearWorkspaceJoin();
    }
  }));

  const join = async () => {
    try {
      const started = await workspaceApi.join(repo().trim(), folder().trim() || undefined);
      const done = await followJob(started.id, setJob);
      if (done.status === "succeeded") {
        showToast("Workspace joined", "success");
        props.onJoined();
      }
    } catch (e) {
      showToast(String(e), "error");
    }
  };
  const running = () => job()?.status === "running";

  return (
    <div class="ws-join">
      <div class="ws-join-icon">⌂</div>
      <div class="ws-join-title">Join your team's workspace</div>
      <p class="ws-join-sub">
        One repo sets up your whole local environment: the shared services, the gateway on your team's domain with its certificate,
        and every project, ready to set up with one click or by asking your AI tool.
      </p>
      <form class="ws-join-form" onSubmit={(e) => { e.preventDefault(); if (repo().trim() && !running()) void join(); }}>
        <input class="form-input mono" placeholder="git@git.example.com:team/dev-workspace.git" value={repo()}
          onInput={(e) => setRepo(e.currentTarget.value)} disabled={running()} />
        <button class="btn btn-primary" type="submit" disabled={!repo().trim() || running()}>{running() ? "Joining…" : "Join"}</button>
      </form>
      <Show when={!repo().trim() && !running()}>
        <p class="ws-muted ws-join-where">
          Already have it checked out?{" "}
          <button class="btn-link" onClick={() => void pickFolder()}>Choose its folder…</button>
        </p>
      </Show>
      <Show when={showFolder()} fallback={
        <Show when={suggested() || !isFolder()} fallback={
          <p class="ws-muted ws-join-where">
            Joins your copy in <span class="mono">{tildify(repo().trim())}</span> where it is; projects go beside it.
          </p>
        }>
        <Show when={suggested()} fallback={
          <Show when={repo().trim()}>
            <button class="ai-connect-more" onClick={changeFolder}>Keep your code somewhere other than ~/code?</button>
          </Show>
        }>
          {(s) => (
            <p class="ws-muted ws-join-where">
              <Show when={s().existing} fallback={
                <>Clones to <span class="mono">{s().folder}</span>{s().checkouts > 0 ? `, next to your ${s().checkouts} checkouts` : ""}; projects go to <span class="mono">{s().parent}</span> too. </>
              }>
                Uses your copy in <span class="mono">{s().folder}</span>; projects go beside it in <span class="mono">{s().parent}</span>.{" "}
              </Show>
              <button class="btn-link" onClick={changeFolder} disabled={running()}>Change</button>
            </p>
          )}
        </Show>
        </Show>
      }>
        <input class="form-input mono ws-join-folder" placeholder="~/projects/dev-workspace" value={folder()}
          onInput={(e) => setFolder(e.currentTarget.value)} disabled={running()} />
        <p class="ws-muted ws-join-hint">Projects are cloned next to the workspace, so put it where your checkouts are: ones already there are used as they are.</p>
      </Show>
      <Show when={job()}>
        {(j) => (
          <div class="ws-job">
            <JobSteps steps={j().steps} />
            <Show when={j().status === "failed" && j().error}><div class="ws-card-error">{j().error}</div></Show>
          </div>
        )}
      </Show>
      <p class="ws-muted ws-join-foot">
        Setting one up for your team?{" "}
        <button class="btn-link" onClick={() => void openUrl(DOCS)}>Create a workspace</button>: it's one YAML file in a repo.
      </p>
    </div>
  );
}
