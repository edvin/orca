// Setup wizard: five short steps from a compose file to a `dev:` section in
// orca.yaml, with a live preview of what one worktree's instance will be.
import { createSignal, For, Match, Show, Switch, onMount } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { devApi } from "../../lib/dev";
import type { DevConfigT, DevProject, SetupAnalysis } from "../../lib/dev";
import { showToast } from "../Toast";
import { YamlView } from "./DevBits";
import { DataSection, ProfilesSection, ReachSection, SharedSection, TopologyPreview } from "./SetupSections";
import type { SectionProps } from "./SetupSections";

interface Props {
  project: DevProject;
  onClose: () => void;
  onSaved: () => void;
}

const STEPS = [
  { id: "shared", title: "Shared or per worktree?" },
  { id: "data", title: "How much data do worktrees share?" },
  { id: "reach", title: "How do you reach it?" },
  { id: "profiles", title: "Profiles and setup commands" },
  { id: "review", title: "Review and save" },
] as const;

export default function SetupWizard(props: Props) {
  const [analysis, setAnalysis] = createSignal<SetupAnalysis | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [dev, setDev] = createStore<DevConfigT>({} as DevConfigT);
  const [step, setStep] = createSignal(0);
  const [visited, setVisited] = createSignal(new Set<number>([0]));

  onMount(async () => {
    try {
      const a = await devApi.setup(props.project.id);
      setDev(structuredClone(a.dev));
      setAnalysis(a);
    } catch (e) {
      setError(String(e));
    }
  });

  const go = (i: number) => {
    setStep(i);
    setVisited(new Set([...visited(), i]));
  };

  const sample = () =>
    props.project.instances.find((i) => !i.is_main)?.name ?? "feature";

  const section = (): SectionProps => ({
    analysis: analysis()!,
    dev,
    setDev,
    sample: sample(),
    projectId: props.project.id,
    domain: props.project.gateway?.domain ?? "localhost",
    httpsPort: props.project.gateway?.https_port,
  });

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="modal-dialog dev-wizard" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <div>
            <div class="modal-title">Set up {props.project.id} for worktrees</div>
            <div style={{ "font-size": "12px", color: "#8b949e", "margin-top": "3px" }}>
              Saved as the <span class="mono">dev:</span> section of orca.yaml, so teammates and every worktree get the same setup.
            </div>
          </div>
          <button class="modal-close" onClick={props.onClose}>×</button>
        </div>
        <Show when={error()}>
          <div class="dev-error" style={{ margin: "16px" }}>{error()}</div>
        </Show>
        <Show when={!analysis() && !error()}>
          <div style={{ padding: "40px", color: "#8b949e", "text-align": "center" }}>Reading the compose file…</div>
        </Show>
        <Show when={analysis()}>
          <div class="dev-wizard-body">
            <div class="dev-wizard-steps">
              <For each={STEPS}>
                {(s, i) => (
                  <button
                    class="dev-wizard-step"
                    classList={{ active: step() === i(), done: visited().has(i()) && step() !== i() }}
                    onClick={() => go(i())}
                  >
                    <span class="num">{visited().has(i()) && step() !== i() ? "✓" : i() + 1}</span>
                    {s.title}
                  </button>
                )}
              </For>
            </div>
            <div class="dev-wizard-main">
              <h3>{STEPS[step()].title}</h3>
              <Switch>
                <Match when={STEPS[step()].id === "shared"}>
                  <SharedSection {...section()} />
                </Match>
                <Match when={STEPS[step()].id === "data"}>
                  <DataSection {...section()} />
                </Match>
                <Match when={STEPS[step()].id === "reach"}>
                  <ReachSection {...section()} />
                </Match>
                <Match when={STEPS[step()].id === "profiles"}>
                  <ProfilesSection {...section()} />
                </Match>
                <Match when={STEPS[step()].id === "review"}>
                  <Review {...section()} project={props.project} onSaved={props.onSaved} onClose={props.onClose} />
                </Match>
              </Switch>
            </div>
            <div class="dev-wizard-side">
              <TopologyPreview {...section()} />
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" onClick={props.onClose}>Cancel</button>
            <Show when={step() > 0}>
              <button class="btn" onClick={() => go(step() - 1)}>Back</button>
            </Show>
            <Show when={step() < STEPS.length - 1}>
              <button class="btn btn-primary" onClick={() => go(step() + 1)}>Next</button>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}

function Review(props: SectionProps & { project: DevProject; onSaved: () => void; onClose: () => void }) {
  const [yaml, setYaml] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [gitignore, setGitignore] = createSignal(true);
  const [snippet, setSnippet] = createSignal(!props.analysis.agents_file.has_snippet);
  const [adopt, setAdopt] = createSignal(!!props.analysis.adoption);
  const [saving, setSaving] = createSignal(false);

  onMount(async () => {
    try {
      const r = await devApi.writeYaml(props.projectId, { dev: unwrap(props.dev), dry_run: true });
      setYaml(r.text);
    } catch (e) {
      setError(String(e));
    }
  });

  const save = async () => {
    setSaving(true);
    try {
      const r = await devApi.writeYaml(props.projectId, { dev: unwrap(props.dev), gitignore_local: gitignore() });
      if (snippet()) await devApi.addAgentsSnippet(props.projectId);
      if (adopt() && props.analysis.adoption) await devApi.adopt(props.projectId, props.analysis.adoption.project);
      showToast(`Saved ${r.path.split("/").pop()}. Commit it so every worktree and teammate gets this setup.`, "success");
      props.onSaved();
      props.onClose();
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const agentsName = () => props.analysis.agents_file.path.split("/").pop();

  return (
    <div>
      <p class="dev-step-intro">
        This is what Orca writes to <span class="mono">orca.yaml</span> in the main checkout. Only settings that differ from the
        defaults are written; other sections of the file are kept.
      </p>
      <Show when={error()}>
        <div class="dev-error">{error()}</div>
      </Show>
      <Show when={props.analysis.orca_yaml.has_comments}>
        <div class="dev-warning" style={{ "margin-bottom": "10px" }}>
          Your orca.yaml has comments, and saving from here rewrites the file without them. To keep them, edit the YAML
          directly in the orca.yaml editor instead.
        </div>
      </Show>
      <Show when={yaml()}>
        <YamlView text={yaml()!} style={{ "max-height": "300px" }} />
      </Show>
      <div class="dev-section" style={{ "margin-top": "16px" }}>
        <label class="dev-check">
          <input type="checkbox" checked={gitignore()} onChange={(e) => setGitignore(e.currentTarget.checked)} />
          <span>
            Add <span class="mono">orca.local.yaml</span> to .gitignore, for personal settings that shouldn't be committed.
          </span>
        </label>
        <Show when={!props.analysis.agents_file.has_snippet}>
          <label class="dev-check">
            <input type="checkbox" checked={snippet()} onChange={(e) => setSnippet(e.currentTarget.checked)} />
            <span>
              Tell coding agents how to run the app: add a short section to <span class="mono">{agentsName()}</span>
              {props.analysis.agents_file.exists ? "" : " (new file)"} about <span class="mono">orca up</span> and{" "}
              <span class="mono">.orca/env</span>.
            </span>
          </label>
        </Show>
        <Show when={props.analysis.adoption}>
          {(a) => (
            <label class="dev-check">
              <input type="checkbox" checked={adopt()} onChange={(e) => setAdopt(e.currentTarget.checked)} />
              <span>
                Keep the data from your existing stack <b>{a().project}</b>: Orca stops its containers
                {a().running ? " (they're running now)" : ""} and the shared services take over its volumes
                {a().volumes.length ? ` (${a().volumes.join(", ")})` : ""}. Nothing is deleted.
              </span>
            </label>
          )}
        </Show>
      </div>
      <button class="btn btn-primary btn-lg" disabled={saving() || !yaml()} onClick={save}>
        Save orca.yaml
      </button>
    </div>
  );
}
