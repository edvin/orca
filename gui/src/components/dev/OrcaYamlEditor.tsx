// The orca.yaml editor: the same settings as a form or as YAML, kept in
// sync, with validation and a dry run against a real worktree.
import { createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { autocompletion } from "@codemirror/autocomplete";
import type { CompletionContext } from "@codemirror/autocomplete";
import YamlEditor from "../YamlEditor";
import Dropdown from "../Dropdown";
import { devApi, instanceUrls } from "../../lib/dev";
import type { DevConfigT, DevProject, PlanView, SetupAnalysis } from "../../lib/dev";
import { showToast } from "../Toast";
import { openDocs } from "../HelpLink";
import OrcaYamlStudio from "../orcayaml/OrcaYamlStudio";
import { DataSection, ProfilesSection, ReachSection, SharedSection, TopologyPreview } from "./SetupSections";
import type { SectionProps } from "./SetupSections";

interface Props {
  project: DevProject;
  onClose: () => void;
  onSaved: () => void;
}

/** Keys Orca understands, with a line of help each, for completion. */
const KEYS: [string, string][] = [
  ["dev", "Worktree instances: what is shared, how instances are reached"],
  ["naming", "How instances and hostnames are named"],
  ["instance", "naming: branch | folder — where instance names come from"],
  ["hostname", 'Hostname pattern; default "{service}-{instance}-{project}.{domain}" (flat), or "{service}.{instance}.{project}.{domain}" (nested)'],
  ["start", "manual | on-create — start new worktrees automatically?"],
  ["shared", "Services that run once and are shared by every worktree"],
  ["data", "shared | own-database | own-server — default data mode for new worktrees"],
  ["database", "The database the app uses in this shared service"],
  ["own_database", "Settings for a worktree's own database"],
  ["seed", "clone-main | empty — how a worktree's own database starts"],
  ["host_port", "Publish the shared service on this host port"],
  ["env", "Extra environment per service; values can use {url.web}, {db.postgres}, {port.api.9229}"],
  ["expose", "Services opened in a browser through the gateway: web: 3000"],
  ["host_ports", "Container ports published on a free host port per worktree"],
  ["hooks", "Commands run in containers: under dev.instance for worktrees, at the top for the stack"],
  ["after_up", '"service: command" lines run after every start'],
  ["after_own_database", '"service: command" lines run when a worktree gets its own database'],
  ["limits", "memory and cpus limits per service"],
  ["compose", "Compose file(s) to use"],
  ["project", "Project name (defaults to the folder name)"],
  ["gateway", "Routes for the stack: - {hostname: app, service: web, port: 3000, path: /api/*}"],
  ["links", "Environment links by group: Storefront: [{name: Web, local: app, staging: https://…}]"],
  ["builds", "Build targets: - {name, context, dockerfile, tag, args}"],
  ["service", "The compose service a gateway route goes to"],
];

export function orcaCompletions(ctx: CompletionContext) {
  const word = ctx.matchBefore(/[a-z_]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return {
    from: word.from,
    options: KEYS.map(([label, info]) => ({ label, type: "property", info, apply: `${label}: ` })),
  };
}

/** form: the dev: section; project: routes, links, hooks, builds; yaml: the file. */
type View = "form" | "project" | "yaml";

export default function OrcaYamlEditor(props: Props) {
  const [analysis, setAnalysis] = createSignal<SetupAnalysis | null>(null);
  const [view, setView] = createSignal<View>("form");
  // The text the routes/links editor starts from; set when it opens, so its
  // own edits flowing back through `text` don't restart it.
  const [studioSeed, setStudioSeed] = createSignal("");
  const [dev, setDev] = createStore<DevConfigT>({} as DevConfigT);
  const [text, setText] = createSignal("");
  const [yamlError, setYamlError] = createSignal<{ msg: string; line: number | null } | null>(null);
  const [dryInstance, setDryInstance] = createSignal<string>("");
  const [dry, setDry] = createSignal<PlanView | null>(null);
  const [dryError, setDryError] = createSignal<string | null>(null);
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  onMount(async () => {
    try {
      const a = await devApi.setup(props.project.id);
      setDev(structuredClone(a.dev));
      setText(a.orca_yaml.text || (await devApi.writeYaml(props.project.id, { dev: a.dev, dry_run: true })).text);
      setAnalysis(a);
      setDryInstance(props.project.instances.find((i) => !i.is_main)?.name ?? props.project.instances[0]?.name ?? "");
      scheduleCheck();
    } catch (e) {
      showToast(String(e), "error");
    }
  });

  /** Validate and dry-run the current settings, debounced. */
  const scheduleCheck = () => {
    clearTimeout(timer);
    timer = setTimeout(check, 500);
  };
  const check = async () => {
    try {
      const source = view() !== "form" ? text() : (await devApi.writeYaml(props.project.id, { dev: unwrap(dev), dry_run: true })).text;
      const r = await devApi.validateYaml(props.project.id, source, dryInstance() || undefined);
      setYamlError(r.validation.ok ? null : { msg: r.validation.error ?? "invalid", line: r.validation.line });
      setDry(r.plan);
      setDryError(r.plan_error);
    } catch (e) {
      setDryError(String(e));
    }
  };

  const switchView = async (v: View) => {
    if (v === view()) return;
    if (v !== "form") {
      // Form → text: render the form's config (keeps other top-level keys).
      if (view() === "form") {
        const r = await devApi.writeYaml(props.project.id, { dev: unwrap(dev), dry_run: true });
        setText(r.text);
      }
      if (v === "project") setStudioSeed(text());
    } else {
      // YAML → form: only when the YAML parses.
      const r = await devApi.validateYaml(props.project.id, text());
      if (!r.validation.ok || !r.validation.dev) {
        showToast("Fix the YAML error before switching to the form.", "error");
        return;
      }
      setDev(structuredClone(r.validation.dev));
    }
    setView(v);
  };

  const save = async () => {
    setSaving(true);
    try {
      const r =
        view() !== "form"
          ? await devApi.writeYaml(props.project.id, { text: text() })
          : await devApi.writeYaml(props.project.id, { dev: unwrap(dev) });
      showToast(`Saved ${r.path.split("/").pop()}`, "success");
      setDirty(false);
      props.onSaved();
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  // Every form edit goes through this so dirty state and the dry run follow.
  const trackedSetDev = ((...args: unknown[]) => {
    (setDev as (...a: unknown[]) => void)(...args);
    setDirty(true);
    scheduleCheck();
  }) as typeof setDev;

  const section = (): SectionProps => ({
    analysis: analysis()!,
    dev,
    setDev: trackedSetDev,
    sample: dryInstance() || "feature",
    projectId: props.project.id,
    domain: props.project.gateway?.domain ?? "localhost",
    httpsPort: props.project.gateway?.https_port,
  });

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="modal-dialog dev-wizard" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <div>
            <div class="modal-title">orca.yaml</div>
            <div class="mono" style={{ "font-size": "11.5px", color: "#8b949e", "margin-top": "3px" }}>{analysis()?.orca_yaml.path}</div>
          </div>
          <button
            class="btn btn-sm"
            style={{ "margin-left": "auto", "margin-right": "10px" }}
            onClick={() => void openDocs("/docs/orca-yaml/")}
          >
            Reference
          </button>
          <div class="dev-seg" style={{ "margin-right": "12px" }}>
            <button classList={{ active: view() === "form" }} onClick={() => switchView("form")}>Worktrees</button>
            <button classList={{ active: view() === "project" }} onClick={() => switchView("project")}>Routes, links…</button>
            <button classList={{ active: view() === "yaml" }} onClick={() => switchView("yaml")}>YAML</button>
          </div>
          <button class="modal-close" onClick={props.onClose}>×</button>
        </div>
        <Show when={analysis()} fallback={<div style={{ padding: "40px", color: "#8b949e", "text-align": "center" }}>Loading…</div>}>
          <div class="dev-wizard-body" style={{ "grid-template-columns": "1fr 340px" }}>
            <div class="dev-wizard-main">
              <Show when={view() === "form"}>
                <FormSection title="Shared or per worktree"><SharedSection {...section()} /></FormSection>
                <FormSection title="Data"><DataSection {...section()} /></FormSection>
                <FormSection title="Reach"><ReachSection {...section()} /></FormSection>
                <FormSection title="Profiles and setup commands"><ProfilesSection {...section()} /></FormSection>
              </Show>
              <Show when={view() === "project"}>
                <p style={{ color: "#8b949e", "font-size": "12px", "margin": "0 0 12px", "line-height": "1.5" }}>
                  For the project as it runs from its own folder. Worktree instances get their hostnames from the Worktrees view (Reach).
                </p>
                <OrcaYamlStudio
                  noYamlTab
                  text={studioSeed()}
                  services={analysis()!.services.map((s) => ({ name: s.name, image: s.image, ports: s.ports.map((p) => p.target) }))}
                  domain={analysis()!.hostnames.domain}
                  projectName={props.project.root.split("/").filter(Boolean).pop() ?? props.project.id}
                  height="calc(100vh - 340px)"
                  onChange={(t) => {
                    setText(t);
                    setDirty(true);
                    scheduleCheck();
                  }}
                />
              </Show>
              <Show when={view() === "yaml"}>
                <div style={{ height: "calc(100% - 40px)", "min-height": "360px", display: "flex", "flex-direction": "column" }}>
                  <YamlEditor
                    value={text()}
                    height="100%"
                    onChange={(t) => {
                      setText(t);
                      setDirty(true);
                      scheduleCheck();
                    }}
                    extensions={[autocompletion({ override: [orcaCompletions] })]}
                  />
                </div>
                <Show when={yamlError()}>
                  <div class="dev-error" style={{ "margin-top": "8px" }}>
                    {yamlError()!.line ? `Line ${yamlError()!.line}: ` : ""}
                    {yamlError()!.msg}
                  </div>
                </Show>
              </Show>
            </div>
            <div class="dev-wizard-side">
              <div class="dev-preview-title">Dry run</div>
              <Dropdown
                value={dryInstance()}
                options={props.project.instances.map((i) => ({ value: i.name, label: `as worktree "${i.name}"` }))}
                onChange={(v) => {
                  setDryInstance(v);
                  scheduleCheck();
                }}
                style={{ width: "100%", "margin-bottom": "10px" }}
              />
              <Show when={dryError()}>
                <div class="dev-error" style={{ "margin-bottom": "10px" }}>{dryError()}</div>
              </Show>
              <Show when={dry()}>
                <div style={{ "font-size": "12px", color: "#8b949e", "margin-bottom": "6px" }}>
                  Runs {dry()!.plan.running_services.join(", ") || "nothing"}
                </div>
                <div class="dev-card-links" style={{ "margin-bottom": "10px" }}>
                  <For each={instanceUrls(dry()!.plan.routes.map((r) => ({ service: r.service, hostname: r.hostname, path: r.path, url: r.url })))}>
                    {(u) => (
                      <div class="dev-link" style={{ cursor: "default" }}>
                        <span class="dev-link-text">{u.url.replace(/^https:\/\//, "")}</span>
                      </div>
                    )}
                  </For>
                  <For each={dry()!.plan.host_ports}>
                    {(p) => (
                      <div class="dev-link dev-link-port" style={{ cursor: "default" }}>
                        <span class="dev-link-text">localhost:{p.host_port}</span>
                        <span class="dev-link-svc">{p.service} :{p.container_port}</span>
                      </div>
                    )}
                  </For>
                </div>
                <For each={dry()!.plan.warnings}>{(w) => <div class="dev-warning" style={{ "margin-bottom": "6px" }}>{w}</div>}</For>
              </Show>
              <Show when={view() === "form" && analysis()}>
                <div style={{ "margin-top": "14px" }}>
                  <TopologyPreview {...section()} />
                </div>
              </Show>
            </div>
          </div>
          <div class="modal-footer">
            <Show when={dirty()}>
              <span style={{ "font-size": "12px", color: "#d29922", "margin-right": "auto" }}>Unsaved changes</span>
            </Show>
            <button class="btn" onClick={props.onClose}>Close</button>
            <button class="btn btn-primary" disabled={saving() || !dirty() || (view() !== "form" && !!yamlError())} onClick={save}>
              Save
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}

function FormSection(props: { title: string; children: import("solid-js").JSX.Element }) {
  return (
    <div style={{ "margin-bottom": "28px", "padding-bottom": "8px", "border-bottom": "1px solid #21262d" }}>
      <h3>{props.title}</h3>
      {props.children}
    </div>
  );
}
