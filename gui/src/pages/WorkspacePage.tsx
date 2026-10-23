// The team workspace: join it with one repo URL, then set up any of its
// projects with one click (or by asking an AI tool). Secrets are filled in
// here, from the team's secret manager, never typed into a chat.

import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { showToast } from "../components/Toast";
import { confirm as confirmDialog } from "../components/ConfirmDialog";
import FolderActions from "../components/FolderActions";
import SecretsDialog from "../components/SecretsDialog";
import { JobProgress, JobSteps } from "../components/dev/DevBits";
import { followJob, type DevJob } from "../lib/dev";
import {
  clearWorkspaceJoin,
  pendingWorkspaceJoin,
  workspaceApi,
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

  const timer = setInterval(() => { if (!document.hidden && !Object.values(jobs()).some((j) => j.status === "running")) void refetch(); }, 10_000);
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
    const result = done.result as { missing_secrets?: string[]; urls?: string[] } | null;
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
      message: "Orca forgets the workspace and removes its routes. The cloned projects, their .env files and running services stay.",
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
              <div class="ws-hero">
                <div>
                  <div class="ws-name">{w().name}</div>
                  <Show when={w().description}><div class="ws-desc">{w().description}</div></Show>
                </div>
                <div class="ws-facts">
                  <span class="ws-chip" title="The gateway serves every project under this domain">*.{w().domain}</span>
                  <span class="ws-chip" title={w().certificate === "workspace" ? "The certificate comes with the workspace" : "Orca's own certificate authority signs the names"}>
                    {w().certificate === "workspace" ? "Team certificate" : "Orca CA"}
                  </span>
                  <Show when={w().network}><span class="ws-chip" title="Docker network every project joins">{w().network}</span></Show>
                  <Show when={w().shared}>
                    {(s) => <span class={`ws-chip ${s().running === s().total ? "ok" : "warn"}`}>{s().running}/{s().total} shared services</span>}
                  </Show>
                </div>
              </div>

              <Show when={jobs()[""]}>{(j) => <div class="ws-job"><JobSteps steps={j().steps} /></div>}</Show>

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
                    {(u) => <button class="app-url" title={u.url} onClick={() => void openUrl(u.url)}>{u.title} ↗</button>}
                  </For>
                </div>
              </Show>

              <div class="ws-section-title">
                Projects
                <span class="ws-muted"> · or ask your AI tool: “spin up {w().projects?.[0]?.key ?? "a project"}”</span>
              </div>
              <div class="ws-grid">
                <For each={w().projects}>
                  {(p) => (
                    <ProjectCard
                      project={p}
                      job={jobs()[p.key]}
                      onSetup={(rerun) => void setup(p, rerun)}
                      onSecrets={() => setSecretsFor(p)}
                      onNavigate={props.onNavigate}
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
}) {
  const p = () => props.project;
  const busy = () => props.job?.status === "running";
  const missing = () => p().secrets.filter((s) => !s.filled);
  const state = () => (p().running ? "running" : p().cloned ? "cloned" : "new");
  return (
    <div class="ws-card" classList={{ running: p().running }}>
      <div class="ws-card-head">
        <span class={`app-dot ${p().running ? "running" : ""}`} />
        <b>{p().key}</b>
        <span class={`ws-state ${state()}`}>{p().running ? "Running" : p().cloned ? "Cloned" : "Not cloned"}</span>
      </div>
      <Show when={p().description}><div class="ws-card-desc">{p().description}</div></Show>
      <div class="ws-card-repo mono" title={p().repo}>{p().repo}</div>

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
      <Show when={showFolder()} fallback={
        <button class="ai-connect-more" onClick={() => setShowFolder(true)}>Clone it somewhere other than ~/code?</button>
      }>
        <input class="form-input mono ws-join-folder" placeholder="/Users/you/work/dev-workspace" value={folder()}
          onInput={(e) => setFolder(e.currentTarget.value)} disabled={running()} />
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
