// Projects: run every worktree of a repo as its own instance, with
// infrastructure shared. The page is organised the way the system is:
// shared services on top, one card per worktree below.
import { createSignal, createMemo, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "../components/Toast";
import { confirm, confirmDanger } from "../components/ConfirmDialog";
import { useRefresh } from "../lib/useRefresh";
import { usePoller } from "../lib/poller";
import { DATA_MODE_LABEL, devApi, followJob, tildify } from "../lib/dev";
import type { Candidate, DataMode, DevInstance, DevJob, DevProject } from "../lib/dev";
import InstanceCard from "../components/dev/InstanceCard";
import InstanceDrawer from "../components/dev/InstanceDrawer";
import StartDialog from "../components/dev/StartDialog";
import SetupWizard from "../components/dev/SetupWizard";
import OrcaYamlEditor from "../components/dev/OrcaYamlEditor";
import { StatusDot } from "../components/dev/DevBits";
import Topology from "../components/dev/Topology";

interface Props {
  onNavigate?: (target: string) => void;
}

const SELECTED_KEY = "projects-selected";

export default function ProjectsPage(props: Props) {
  const [projects, setProjects] = createSignal<DevProject[] | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(localStorage.getItem(SELECTED_KEY));
  const [jobs, setJobs] = createSignal<Record<string, DevJob>>({});
  const [drawer, setDrawer] = createSignal<string | null>(null);
  const [startFor, setStartFor] = createSignal<string | null>(null);
  const [candidates, setCandidates] = createSignal<Candidate[]>([]);
  const [pathInput, setPathInput] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [wizard, setWizard] = createSignal(false);
  // The DNS warning can be hidden per hostname (e.g. when only browsers matter).
  const readDismissed = (): string[] => {
    try {
      return JSON.parse(localStorage.getItem("orca.dev.dnsDismissed") ?? "[]");
    } catch {
      return [];
    }
  };
  const [dnsHidden, setDnsHidden] = createSignal<string[]>(readDismissed());
  const dnsDismissed = (host: string) => dnsHidden().includes(host);
  const dismissDns = (host: string) => {
    const next = [...dnsHidden(), host];
    setDnsHidden(next);
    try {
      localStorage.setItem("orca.dev.dnsDismissed", JSON.stringify(next));
    } catch {
      // Private mode: hidden for this session only.
    }
  };
  const [addOpen, setAddOpen] = createSignal(false);
  const [view, setView] = createSignal<"board" | "topology">(
    (localStorage.getItem("projects-view") as "board" | "topology") || "board",
  );
  const setViewPersist = (v: "board" | "topology") => {
    setView(v);
    localStorage.setItem("projects-view", v);
  };
  const [yamlEditor, setYamlEditor] = createSignal(false);
  const following = new Set<string>();

  const selected = createMemo(() => {
    const list = projects() ?? [];
    return list.find((p) => p.id === selectedId()) ?? list[0] ?? null;
  });
  const jobKey = (p: string, i: string) => `${p}/${i}`;
  const jobFor = (inst: DevInstance) => {
    const p = selected();
    return p ? jobs()[jobKey(p.id, inst.name)] ?? null : null;
  };

  let candidatesLoaded = false;
  const readyCandidates = () => candidates().filter((c) => c.has_dev);
  const refresh = async () => {
    try {
      const list = await devApi.listProjects(true);
      setProjects(list);
      setLoadError(null);
      // Pick up jobs started elsewhere (CLI, agents) so their progress shows.
      for (const p of list) {
        for (const i of p.instances ?? []) {
          if (i.job_id && !following.has(i.job_id)) track(p.id, i.name, i.job_id, false);
        }
      }
      // Suggestions run git in every compose folder, so look once, not every poll.
      if (!candidatesLoaded) {
        candidatesLoaded = true;
        devApi.candidates().then(setCandidates).catch(() => {});
      }
    } catch (e) {
      setLoadError(String(e));
      if (projects() === null) setProjects([]);
    }
  };

  usePoller(refresh, 5000);
  useRefresh(() => {
    candidatesLoaded = false;
    void refresh();
  });

  /** Follow a job, keeping the card's progress live; toast the outcome. */
  const track = async (project: string, instance: string, jobId: string, announce: boolean) => {
    following.add(jobId);
    try {
      const done = await followJob(jobId, (j) => setJobs({ ...jobs(), [jobKey(project, instance)]: j }));
      await refresh();
      if (!announce) return;
      if (done.status === "succeeded") {
        const url = done.result?.urls?.[0]?.url;
        const verb = done.action === "up" ? "is running" : done.action === "remove" ? "was removed" : "stopped";
        showToast(`${instance} ${verb}${url && done.action === "up" ? ` at ${url}` : ""}`, "success");
        // Keep a finished start on the card only while it failed.
        const next = { ...jobs() };
        delete next[jobKey(project, instance)];
        setJobs(next);
      } else {
        showToast(`${instance}: ${(done.error ?? "failed").split("\n")[0]}`, "error", {
          label: "Details",
          onClick: () => setDrawer(instance),
        });
      }
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      following.delete(jobId);
    }
  };

  const run = async (
    inst: DevInstance,
    action: "up" | "down" | "remove",
    opts?: { profiles?: string[]; build: boolean; data_modes?: Record<string, DataMode> },
  ) => {
    const p = selected();
    if (!p) return;
    try {
      const job =
        action === "up"
          ? await devApi.up(p.id, inst.name, opts ?? {})
          : action === "down"
            ? await devApi.down(p.id, inst.name)
            : await devApi.remove(p.id, inst.name);
      setJobs({ ...jobs(), [jobKey(p.id, inst.name)]: job });
      track(p.id, inst.name, job.id, true);
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  // First start (or after a failure) opens the dialog so the user sees and
  // can change what will happen; a plain restart uses the remembered setup.
  const onStart = (inst: DevInstance) => {
    if ((inst.status === "stopped" || inst.status === "idle_stopped") && inst.configured) {
      run(inst, "up", { build: true });
    } else {
      setStartFor(inst.name);
    }
  };

  const onRemove = async (inst: DevInstance) => {
    const ok = await confirmDanger({
      title: `Remove ${inst.name}?`,
      message:
        "This deletes the instance's containers, volumes, images, gateway routes, host ports and its .orca folder. " +
        "Your code and the shared services are not touched.",
      confirmLabel: "Remove",
    });
    if (ok) run(inst, "remove");
  };

  const addProject = async (path: string) => {
    if (!path.trim()) return;
    setAdding(true);
    try {
      const r = await devApi.addProject(path.trim());
      setSelectedId(r.id);
      localStorage.setItem(SELECTED_KEY, r.id);
      showToast(r.existing ? `${r.id} was already registered` : `Added ${r.id}`, "success");
      setPathInput("");
      setAddOpen(false);
      await refresh();
      // A project without a dev: section starts with the setup wizard.
      const added = projects()?.find((p) => p.id === r.id);
      if (!r.existing && added && added.orca_yaml && !added.orca_yaml.has_dev) setWizard(true);
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setAdding(false);
    }
  };

  const pickAndAdd = async () => {
    try {
      const path = await invoke<string | null>("pick_folder", { title: "Choose a git repository or one of its worktrees" });
      if (path) addProject(path);
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const removeProject = async (p: DevProject) => {
    const ok = await confirm({
      title: `Unregister ${p.id}?`,
      message: "Orca forgets this project and its instance settings. Your repository is not touched. Stop its instances and shared services first.",
      confirmLabel: "Unregister",
      danger: true,
    });
    if (!ok) return;
    try {
      await devApi.removeProject(p.id);
      showToast(`Unregistered ${p.id}`, "success");
      setSelectedId(null);
      refresh();
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const sharedAction = async (p: DevProject, up: boolean) => {
    try {
      const job = up ? await devApi.sharedUp(p.id) : await devApi.sharedDown(p.id);
      setJobs({ ...jobs(), [jobKey(p.id, "__shared__")]: job });
      const done = await followJob(job.id, (j) => setJobs({ ...jobs(), [jobKey(p.id, "__shared__")]: j }));
      const next = { ...jobs() };
      delete next[jobKey(p.id, "__shared__")];
      setJobs(next);
      refresh();
      if (done.status === "failed") showToast(done.error ?? "Failed", "error");
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const live = (i: DevInstance) => i.status === "running" || i.status === "partial";
  const cleanupCandidates = () =>
    (selected()?.instances ?? []).filter((i) => i.status === "orphaned" || (i.upstream_gone && !i.is_main));

  const stopAll = async () => {
    const running = (selected()?.instances ?? []).filter(live);
    const ok = await confirm({
      title: `Stop ${running.length} instance${running.length === 1 ? "" : "s"}?`,
      message: `${running.map((i) => i.name).join(", ")} will stop. Settings, ports and data are kept. Shared services keep running.`,
      confirmLabel: "Stop all",
    });
    if (ok) for (const i of running) run(i, "down");
  };

  const cleanUp = async () => {
    const list = cleanupCandidates();
    const ok = await confirmDanger({
      title: `Remove ${list.length} instance${list.length === 1 ? "" : "s"}?`,
      message:
        `${list.map((i) => `${i.name} (${i.status === "orphaned" ? "worktree gone" : "remote branch deleted"})`).join(", ")}. ` +
        "Their containers, volumes, images, own databases, ports and .orca folders are deleted. Worktree folders and branches are not touched.",
      confirmLabel: "Remove",
    });
    if (ok) for (const i of list) run(i, "remove");
  };

  const drawerInst = () => selected()?.instances.find((i) => i.name === drawer()) ?? null;
  const startInst = () => selected()?.instances.find((i) => i.name === startFor()) ?? null;
  const runningCount = (p: DevProject) => (p.instances ?? []).filter((i) => i.status === "running" || i.status === "partial").length;
  const sharedBusy = () => {
    const p = selected();
    return p ? jobs()[jobKey(p.id, "__shared__")]?.status === "running" : false;
  };

  return (
    <div>
      <div class="page-header">
        <div>
          <h1 class="page-title">Projects</h1>
          <div class="dev-subtitle">
            Run every git worktree of a project side by side, each with its own URLs and ports. Databases and other
            infrastructure run once and are shared.
          </div>
        </div>
        <Show when={(projects()?.length ?? 0) > 0}>
          <div class="page-actions">
            <button
              class="btn btn-primary"
              onClick={() => {
                devApi.candidates().then(setCandidates).catch(() => {});
                setAddOpen(true);
              }}
            >
              Add project
            </button>
          </div>
        </Show>
      </div>

      {/* Repos already running here whose orca.yaml is set up for worktrees. */}
      <Show when={(projects()?.length ?? 0) > 0 && readyCandidates().length > 0}>
        <div class="dev-candidates" style={{ "margin-bottom": "16px" }}>
          <For each={readyCandidates()}>
            {(c) => (
              <div class="dev-candidate">
                <div style={{ flex: 1, "min-width": 0 }}>
                  <div style={{ color: "#e6edf3", "font-weight": 500, "font-size": "13px" }}>
                    {c.name ?? c.root} has an orca.yaml set up for worktrees
                  </div>
                  <div class="mono" style={{ color: "#8b949e", "font-size": "11px" }}>{tildify(c.root)}</div>
                </div>
                <button class="btn btn-sm btn-primary" disabled={adding()} onClick={() => addProject(c.root)}>Add</button>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={loadError() && (projects()?.length ?? 0) === 0}>
        <div class="dev-error" style={{ "margin-bottom": "16px" }}>{loadError()}</div>
      </Show>

      <Show when={projects() !== null && projects()!.length === 0}>
        <EmptyState
          candidates={candidates()}
          adding={adding()}
          pathInput={pathInput()}
          setPathInput={setPathInput}
          onPick={pickAndAdd}
          onAdd={addProject}
        />
      </Show>

      <Show when={addOpen()}>
        <div class="modal-overlay" onClick={() => setAddOpen(false)}>
          <div class="modal-dialog" style={{ width: "640px" }} onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <div class="modal-title">Add a project</div>
              <button class="modal-close" onClick={() => setAddOpen(false)}>×</button>
            </div>
            <div class="modal-body">
              <EmptyState
                compact
                candidates={candidates()}
                adding={adding()}
                pathInput={pathInput()}
                setPathInput={setPathInput}
                onPick={pickAndAdd}
                onAdd={addProject}
              />
            </div>
          </div>
        </div>
      </Show>

      <Show when={(projects()?.length ?? 0) > 1}>
        <div class="dev-project-tabs">
          <For each={projects()!}>
            {(p) => (
              <button
                class={`dev-project-tab ${selected()?.id === p.id ? "active" : ""}`}
                onClick={() => {
                  setSelectedId(p.id);
                  localStorage.setItem(SELECTED_KEY, p.id);
                }}
              >
                {p.id}
                <Show when={runningCount(p) > 0}>
                  <span class="dev-count">{runningCount(p)} running</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={selected()}>
        {(p) => (
          <>
            <div class="dev-header">
              <div>
                <div class="dev-header-name">{p().id}</div>
                <div class="dev-header-path">
                  <span class="mono dev-path" style={{ "max-width": "640px" }} title={p().root}><span>{tildify(p().root)}</span></span>
                  <button class="dev-icon-btn" title="Open folder" onClick={() => invoke("reveal_path", { path: p().root }).catch((e) => showToast(String(e), "error"))}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
                  </button>
                </div>
                <div class="dev-chips">
                  <span class="dev-chip">{(p().instances ?? []).length} worktree{(p().instances ?? []).length === 1 ? "" : "s"}</span>
                  <Show when={p().orca_yaml}>
                    <Show
                      when={p().orca_yaml!.has_dev}
                      fallback={<span class="dev-chip dev-chip-warn" title="orca.yaml has no dev: section; Orca guessed the setup">Suggested setup</span>}
                    >
                      <span class="dev-chip dev-chip-ok" title="Setup comes from the dev: section of orca.yaml">orca.yaml</span>
                    </Show>
                  </Show>
                  <Show when={p().gateway}>
                    <span
                      class={`dev-chip ${p().gateway!.running ? "dev-chip-ok" : ""}`}
                      title="The gateway gives each instance its own HTTPS hostname. Orca starts it when an instance needs it."
                    >
                      Gateway {p().gateway!.running ? "running" : "starts on demand"}
                      {p().gateway!.https_port !== 443 ? ` · :${p().gateway!.https_port}` : ""}
                    </span>
                  </Show>
                </div>
              </div>
              <div style={{ display: "flex", gap: "6px" }}>
                <Show when={p().orca_yaml && !p().orca_yaml!.has_dev}>
                  <button class="btn btn-sm btn-primary" onClick={() => setWizard(true)}>Set up worktrees…</button>
                </Show>
                <button class="btn btn-sm" onClick={() => setYamlEditor(true)} title="Edit the dev: section as a form or as YAML">orca.yaml</button>
                <button class="btn btn-sm btn-outline" onClick={() => removeProject(p())}>Unregister</button>
              </div>
            </div>

            <For each={p().errors ?? []}>{(e) => <div class="dev-error" style={{ "margin-bottom": "12px" }}>{e}</div>}</For>
            <Show when={p().orca_yaml?.error}>
              <div class="dev-error" style={{ "margin-bottom": "12px" }}>{p().orca_yaml!.error}</div>
            </Show>

            <Show when={p().gateway?.dns && !p().gateway!.dns!.ok && !dnsDismissed(p().gateway!.dns!.host)}>
              <div class="dev-warning" style={{ "margin-bottom": "12px", display: "flex", gap: "10px", "align-items": "flex-start" }}>
                <div style={{ flex: 1 }}>
                  {p().gateway!.dns!.problem}{" "}
                  <a class="dev-action-link" onClick={() => props.onNavigate?.("gateway")}>Change the gateway domain</a>
                </div>
                <button class="modal-close" style={{ "font-size": "16px" }} title="Hide for this domain" onClick={() => dismissDns(p().gateway!.dns!.host)}>×</button>
              </div>
            </Show>

            <Show when={p().shared_source === "suggested" && p().shared.length > 0}>
              <div class="dev-explainer">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "flex-shrink": 0, "margin-top": "1px" }}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
                <div>
                  Orca picked <b>{p().shared.map((s) => s.name).join(", ")}</b> to run once and be shared by every worktree,
                  because {p().shared.length === 1 ? "it is" : "they are"} infrastructure images not built from your repo.
                  Everything else runs once per worktree.{" "}
                  <a href="#" style={{ color: "#58a6ff" }} onClick={(e) => { e.preventDefault(); setWizard(true); }}>
                    Review and save this setup
                  </a>{" "}
                  to change it and share it with your team through <span class="mono">orca.yaml</span>.
                </div>
              </div>
            </Show>

            <Show when={p().shared.length > 0}>
              <div class="dev-lane">
                <div class="dev-lane-label">
                  Shared services
                  <span class="dev-lane-hint">run once, used by every worktree</span>
                  <div class="dev-lane-actions">
                    <Show
                      when={p().shared.some((s) => s.status === "running")}
                      fallback={<button class="btn btn-sm" disabled={sharedBusy()} onClick={() => sharedAction(p(), true)}>Start shared</button>}
                    >
                      <button class="btn btn-sm btn-outline" disabled={sharedBusy()} onClick={() => sharedAction(p(), false)} title="Instances lose their database until it starts again">
                        Stop shared
                      </button>
                    </Show>
                  </div>
                </div>
                <div class="dev-shared-row">
                  <For each={p().shared}>
                    {(s) => (
                      <div class="dev-shared" title={s.reason ?? ""}>
                        <div class="dev-shared-name">
                          <StatusDot
                            color={sharedBusy() ? "#58a6ff" : s.status === "running" ? "#3fb950" : s.status === "stopped" ? "#d29922" : "#6e7681"}
                            pulse={sharedBusy()}
                          />
                          {s.name}
                        </div>
                        <div class="dev-shared-meta">
                          {s.status === "running" ? "Running" : s.status === "stopped" ? "Stopped" : "Starts with the first instance"}
                          <Show when={s.ports.some((x) => x.host_port)}>
                            {" · "}
                            <span class="mono">
                              {s.ports.filter((x) => x.host_port).map((x) => `localhost:${x.host_port}`).filter((v, i, a) => a.indexOf(v) === i).join(", ")}
                            </span>
                          </Show>
                        </div>
                        <div class="dev-shared-meta">
                          {(() => {
                            const own = (p().instances ?? []).filter((i) => i.data_modes?.[s.name]);
                            if (own.length === 0) return "Data: shared by every worktree";
                            return `${own.map((i) => `${i.name}: ${DATA_MODE_LABEL[i.data_modes[s.name]].toLowerCase()}`).join(" · ")}`;
                          })()}
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <div class="dev-lane">
              <div class="dev-lane-label">
                Instances
                <span class="dev-lane-hint">one per worktree · nothing starts until you (or an agent) start it</span>
                <div class="dev-lane-actions">
                  <div class="dev-seg">
                    <button classList={{ active: view() === "board" }} onClick={() => setViewPersist("board")}>Cards</button>
                    <button classList={{ active: view() === "topology" }} onClick={() => setViewPersist("topology")}>Topology</button>
                  </div>
                  <Show when={cleanupCandidates().length > 0}>
                    <button class="btn btn-sm" onClick={cleanUp} title="Instances whose worktree is gone or whose remote branch was deleted">
                      Clean up {cleanupCandidates().length}
                    </button>
                  </Show>
                  <Show when={(p().instances ?? []).filter(live).length > 1}>
                    <button class="btn btn-sm btn-outline" onClick={stopAll}>Stop all</button>
                  </Show>
                </div>
              </div>
              <Show when={view() === "topology"}>
                <Topology project={p()} onOpen={(n) => setDrawer(n)} />
              </Show>
              <div class="dev-grid" style={{ display: view() === "topology" ? "none" : undefined }}>
                <For each={p().instances ?? []}>
                  {(inst) => (
                    <InstanceCard
                      inst={inst}
                      job={jobFor(inst)}
                      onOpen={() => setDrawer(inst.name)}
                      onStart={() => onStart(inst)}
                      onStop={() => run(inst, "down")}
                      onRemove={() => onRemove(inst)}
                    />
                  )}
                </For>
              </div>
              <div class="form-hint" style={{ "margin-top": "10px" }}>
                New worktrees show up here automatically (<span class="mono">git worktree add ../{p().id}-feature</span>). From a
                worktree, <span class="mono">orca up</span> starts its instance.
              </div>
            </div>

            <Show when={drawerInst()}>
              {(inst) => (
                <InstanceDrawer
                  project={p()}
                  inst={inst()}
                  job={jobFor(inst())}
                  onClose={() => setDrawer(null)}
                  onStart={() => setStartFor(inst().name)}
                  onRestart={() => run(inst(), "up", { build: true })}
                  onStop={() => run(inst(), "down")}
                  onRemove={async () => {
                    await onRemove(inst());
                  }}
                  onRenamed={(n) => {
                    setDrawer(n);
                    refresh();
                  }}
                  onNavigate={props.onNavigate}
                />
              )}
            </Show>

            <Show when={wizard()}>
              <SetupWizard project={p()} onClose={() => setWizard(false)} onSaved={refresh} />
            </Show>
            <Show when={yamlEditor()}>
              <OrcaYamlEditor project={p()} onClose={() => setYamlEditor(false)} onSaved={refresh} />
            </Show>

            <Show when={startInst()}>
              {(inst) => (
                <StartDialog
                  project={p()}
                  inst={inst()}
                  onClose={() => setStartFor(null)}
                  onStart={(opts) => {
                    setStartFor(null);
                    run(inst(), "up", opts);
                  }}
                />
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function EmptyState(props: {
  compact?: boolean;
  candidates: Candidate[];
  adding: boolean;
  pathInput: string;
  setPathInput: (v: string) => void;
  onPick: () => void;
  onAdd: (path: string) => void;
}) {
  return (
    <div class="dev-empty" style={props.compact ? { padding: "8px 0 0" } : undefined}>
      <Show when={!props.compact}>
        <Illustration />
        <h2>One running copy of your app per worktree</h2>
        <p>
          Working with several branches or AI agents at once? Add a repository and Orca runs each of its git worktrees as
          its own instance, with its own URLs and ports, while databases and other infrastructure run once and are shared.
          Your compose files are never changed.
        </p>
      </Show>
      <Show when={props.compact}>
        <p style={{ "margin-bottom": "14px" }}>Pick any folder inside a git repository; Orca finds the main checkout and all its worktrees.</p>
      </Show>
      <button class="btn btn-primary btn-lg" disabled={props.adding} onClick={props.onPick}>
        Choose a repository…
      </button>
      <div style={{ color: "#6e7681", "font-size": "12px", margin: "14px 0 8px" }}>or paste a path</div>
      <form
        class="dev-path-input"
        onSubmit={(e) => {
          e.preventDefault();
          props.onAdd(props.pathInput);
        }}
      >
        <input
          class="form-input mono"
          style={{ flex: 1 }}
          placeholder="/home/you/code/myapp"
          value={props.pathInput}
          onInput={(e) => props.setPathInput(e.currentTarget.value)}
        />
        <button class="btn" type="submit" disabled={props.adding || !props.pathInput.trim()}>Add</button>
      </form>
      <Show when={props.candidates.length > 0}>
        <div class="dev-candidates">
          <div class="dev-section-title">Found on this machine</div>
          <For each={[...props.candidates].sort((a, b) => Number(!!b.has_dev) - Number(!!a.has_dev))}>
            {(c) => (
              <div class="dev-candidate">
                <div style={{ flex: 1, "min-width": 0 }}>
                  <div style={{ color: "#e6edf3", "font-weight": 500, "font-size": "13px" }}>
                    {c.name ?? c.root}
                    <Show when={c.has_dev}>
                      <span title="Its orca.yaml already has a dev: section" style={{ "margin-left": "8px", "font-size": "10px", "font-weight": 600, "text-transform": "uppercase", "letter-spacing": "0.04em", color: "#3fb950", border: "1px solid #238636", "border-radius": "4px", padding: "1px 5px" }}>orca.yaml ready</span>
                    </Show>
                  </div>
                  <div class="mono" style={{ color: "#8b949e", "font-size": "11px" }}>
                    {tildify(c.root)} · running as {c.stacks.join(", ")}
                  </div>
                </div>
                <button class="btn btn-sm btn-primary" disabled={props.adding} onClick={() => props.onAdd(c.root)}>Add</button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** Shared services on top, worktree instances below: the whole idea in one picture. */
function Illustration() {
  return (
    <svg width="300" height="132" viewBox="0 0 300 132" fill="none" style={{ display: "block", margin: "0 auto" }}>
      <rect x="70" y="6" width="160" height="34" rx="8" fill="rgba(63,185,80,0.08)" stroke="rgba(63,185,80,0.45)" />
      <circle cx="90" cy="23" r="4" fill="#3fb950" />
      <text x="102" y="27" fill="#c9d1d9" font-size="11" font-family="sans-serif">postgres · redis</text>
      <path d="M150 40v14M60 54h180M60 54v14M150 54v14M240 54v14" stroke="#30363d" stroke-width="1.5" />
      <For each={[0, 1, 2]}>
        {(i) => (
          <g>
            <rect x={20 + i * 90} y="68" width="80" height="56" rx="8" fill="rgba(22,27,34,0.9)" stroke={i === 1 ? "rgba(88,166,255,0.6)" : "#30363d"} />
            <circle cx={33 + i * 90} cy="82" r="3.5" fill={i === 2 ? "#6e7681" : "#3fb950"} />
            <text x={42 + i * 90} y="86" fill="#e6edf3" font-size="10" font-family="sans-serif" font-weight="600">
              {["main", "feat-auth", "agent-x"][i]}
            </text>
            <rect x={28 + i * 90} y="94" width="64" height="10" rx="3" fill="rgba(88,166,255,0.15)" />
            <rect x={28 + i * 90} y="108" width="44" height="8" rx="3" fill="rgba(110,118,129,0.15)" />
          </g>
        )}
      </For>
    </svg>
  );
}
