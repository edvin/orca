// The orca.yaml editor: routes, links, setup hooks and build targets as
// forms, and the file itself, kept in step. The text is what gets saved; a
// form edit rewrites only its own section, so comments, `dev:` and keys the
// form doesn't know survive. Validated as you type, by the daemon's parser.

import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { autocompletion } from "@codemirror/autocomplete";
import YamlEditor from "../YamlEditor";
import { orcaCompletions } from "../dev/OrcaYamlEditor";
import { read, write, type Model } from "./model";
import RoutesSection, { type RouteStatus, type StudioService } from "./RoutesSection";
import { BuildsSection, HooksSection, LinksSection } from "./Sections";

export type { RouteStatus, StudioService };

type Tab = "routes" | "links" | "hooks" | "builds" | "yaml";

interface Validation {
  ok: boolean;
  error?: string | null;
  line?: number | null;
  warnings: string[];
}

interface Props {
  /** The saved file; the editor starts from it and starts over when it changes. */
  text: string;
  services: StudioService[];
  domain: string;
  projectName: string;
  routeStatus?: RouteStatus[];
  /** A file that isn't saved yet, so it can be saved unchanged. */
  isNew?: boolean;
  /** Without it, the editor has no Save button and reports through onChange. */
  onSave?: (text: string) => Promise<void>;
  onDiscard?: () => void;
  onChange?: (text: string) => void;
  /** Shown at the right of the tab bar. */
  actions?: JSX.Element;
  height?: string;
  /** Leave out the YAML tab, where the surrounding dialog has its own. */
  noYamlTab?: boolean;
}

const EMPTY: Model = { routes: [], links: [], hooks: [], builds: [], hasDev: false };

export default function OrcaYamlStudio(props: Props) {
  const [text, setText] = createSignal("");
  const [base, setBase] = createSignal("");
  // The form's state. Kept apart from the text while the form edits, so a
  // half-filled row (a link without a URL yet) isn't dropped on the way
  // through the file; re-read whenever the text changes from elsewhere.
  const [model, setModel] = createSignal<Model>(EMPTY);
  const [parseError, setParseError] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal<Tab>("routes");
  const [check, setCheck] = createSignal<Validation | null>(null);
  const [saving, setSaving] = createSignal(false);

  const reparse = (t: string) => {
    const r = read(t);
    if ("model" in r) {
      setModel(r.model);
      setParseError(null);
    } else setParseError(r.error);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const validateSoon = (t: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      invoke<Validation>("validate_orca_yaml", { text: t })
        .then(setCheck)
        .catch(() => setCheck(null));
    }, 350);
  };

  createEffect(
    on(
      () => props.text,
      (t, prev) => {
        // A refetch of the file just saved: keep any edits made since.
        if (prev !== undefined && t === base()) return;
        setText(t);
        setBase(t);
        reparse(t);
        validateSoon(t);
        // A file the form can't read opens on its text.
        if (!props.noYamlTab && !("model" in read(t))) setTab("yaml");
      },
    ),
  );

  const dirty = () => text() !== base() || !!props.isNew;

  const editSection = (section: "gateway" | "links" | "hooks" | "builds", m: Model) => {
    setModel(m);
    const t = write(text(), section, m);
    setText(t);
    props.onChange?.(t);
    validateSoon(t);
  };

  const onYaml = (t: string) => {
    setText(t);
    reparse(t);
    props.onChange?.(t);
    validateSoon(t);
  };

  const save = async () => {
    if (!props.onSave) return;
    setSaving(true);
    try {
      await props.onSave(text());
      setBase(text());
    } catch {
      // The caller reported it.
    } finally {
      setSaving(false);
    }
  };

  const counts = createMemo(() => ({
    routes: model().routes.length,
    links: model().links.reduce((n, g) => n + g.links.length, 0),
    hooks: model().hooks.length,
    builds: model().builds.length,
  }));

  const TabButton = (p: { id: Tab; label: string; count?: number }) => (
    <button classList={{ active: tab() === p.id }} onClick={() => setTab(p.id)}>
      {p.label}
      <Show when={p.count}><span style={{ "margin-left": "6px", opacity: 0.6 }}>{p.count}</span></Show>
    </button>
  );

  const blocked = () => (check() && !check()!.ok) || !!parseError();

  return (
    <div class="orca-studio" style={{ display: "flex", "flex-direction": "column", gap: "12px", "min-height": "0" }}>
      <div style={{ display: "flex", "align-items": "center", gap: "10px", "flex-wrap": "wrap" }}>
        <div class="dev-seg">
          <TabButton id="routes" label="Routes" count={counts().routes} />
          <TabButton id="links" label="Links" count={counts().links} />
          <TabButton id="hooks" label="Setup commands" count={counts().hooks} />
          <TabButton id="builds" label="Builds" count={counts().builds} />
          <Show when={!props.noYamlTab}><TabButton id="yaml" label="YAML" /></Show>
        </div>
        <span style={{ flex: "1" }} />
        <Status check={check()} parseError={parseError()} onShow={() => { if (!props.noYamlTab) setTab("yaml"); }} />
        {props.actions}
        <Show when={props.onSave}>
          <Show when={props.onDiscard}>
            <button class="btn btn-sm" onClick={() => props.onDiscard?.()}>Discard</button>
          </Show>
          <button class="btn btn-sm btn-primary" disabled={saving() || !dirty() || blocked()} onClick={() => void save()}
            title={blocked() ? "Fix the error first" : undefined}>
            {saving() ? "Saving…" : props.isNew ? "Create orca.yaml" : "Save"}
          </button>
        </Show>
      </div>

      <Show when={!parseError() && check()?.ok && check()!.warnings.length > 0}>
        <div style={{ padding: "8px 12px", background: "rgba(210,153,34,0.08)", border: "1px solid rgba(210,153,34,0.35)", "border-radius": "8px", "font-size": "12px", color: "#e6edf3", display: "flex", "flex-direction": "column", gap: "3px" }}>
          <For each={check()!.warnings}>{(w) => <span>{w}</span>}</For>
        </div>
      </Show>

      <Show when={tab() !== "yaml" && parseError()}>
        <div style={{ padding: "12px 14px", background: "rgba(248,81,73,0.08)", border: "1px solid rgba(248,81,73,0.35)", "border-radius": "8px", "font-size": "13px", color: "#e6edf3" }}>
          The form needs a file it can read: {parseError()}{" "}
          <Show when={!props.noYamlTab}>
            <button class="btn btn-sm" style={{ "margin-left": "8px" }} onClick={() => setTab("yaml")}>Fix it in YAML</button>
          </Show>
        </div>
      </Show>

      <Show when={tab() !== "yaml" && !parseError()}>
        <div style={{ "max-width": "980px" }}>
          <Show when={tab() === "routes"}>
            <RoutesSection routes={model().routes} services={props.services} domain={props.domain} projectName={props.projectName}
              status={props.routeStatus} onChange={(routes) => editSection("gateway", { ...model(), routes })} />
          </Show>
          <Show when={tab() === "links"}>
            <LinksSection groups={model().links} projectName={props.projectName} onChange={(links) => editSection("links", { ...model(), links })} />
          </Show>
          <Show when={tab() === "hooks"}>
            <HooksSection hooks={model().hooks} services={props.services} onChange={(hooks) => editSection("hooks", { ...model(), hooks })} />
          </Show>
          <Show when={tab() === "builds"}>
            <BuildsSection builds={model().builds} services={props.services} onChange={(builds) => editSection("builds", { ...model(), builds })} />
          </Show>
        </div>
      </Show>

      <Show when={tab() === "yaml"}>
        <div style={{ height: props.height ?? "calc(100vh - 380px)", "min-height": "320px", "border-radius": "8px", overflow: "hidden", border: "1px solid #21262d" }}>
          <YamlEditor value={text()} height="100%" onChange={onYaml} extensions={[autocompletion({ override: [orcaCompletions] })]} />
        </div>
      </Show>
    </div>
  );
}

function Status(props: { check: Validation | null; parseError: string | null; onShow: () => void }) {
  const style = { "font-size": "12px", "max-width": "420px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" } as const;
  return (
    <Show when={props.check || props.parseError}>
      <Show when={!props.parseError && props.check?.ok} fallback={
        <button style={{ ...style, color: "#f85149", background: "none", border: "none", cursor: "pointer", padding: "0" }} onClick={() => props.onShow()}
          title={props.parseError ?? props.check?.error ?? ""}>
          {props.check?.line ? `Line ${props.check.line}: ` : ""}{props.check?.error ?? props.parseError}
        </button>
      }>
        <Show when={(props.check?.warnings.length ?? 0) > 0} fallback={<span style={{ ...style, color: "#3fb950" }}>Valid</span>}>
          <span style={{ ...style, color: "#d29922" }} title={props.check!.warnings.join("\n")}>
            {props.check!.warnings.length === 1 ? "1 entry skipped" : `${props.check!.warnings.length} entries skipped`}
          </span>
        </Show>
      </Show>
    </Show>
  );
}
