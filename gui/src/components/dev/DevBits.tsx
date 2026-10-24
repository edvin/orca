// Small building blocks for the Worktrees page: job progress and the
// annotated YAML view of generated files.
import { For, Show, JSX } from "solid-js";
import type { JobStep, StepStatus } from "../../lib/dev";
import { DATA_MODE_LABEL, dataModeDescription } from "../../lib/dev";

const Check = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
);
const Cross = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f85149" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
);
const Dash = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#484f58" stroke-width="3" stroke-linecap="round"><path d="M6 12h12" /></svg>
);
const Circle = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#30363d" stroke-width="3"><circle cx="12" cy="12" r="8" /></svg>
);

function StepIcon(props: { status: StepStatus }) {
  return (
    <span class="dev-step-icon">
      {props.status === "done" ? <Check /> :
       props.status === "failed" ? <Cross /> :
       props.status === "skipped" ? <Dash /> :
       props.status === "running" ? <span class="dev-step-spinner" /> : <Circle />}
    </span>
  );
}

/** Full step list: one row per step with its result. */
export function JobSteps(props: { steps: JobStep[] }) {
  return (
    <div class="dev-steps">
      <For each={props.steps}>
        {(s) => (
          <div class={`dev-step dev-step-${s.status}`}>
            <StepIcon status={s.status} />
            <span class="dev-step-label">{s.label}</span>
            <Show when={s.detail && s.status !== "failed"}>
              <span class="dev-step-detail" title={s.detail ?? ""}>{s.detail}</span>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

/** Compact progress for cards: a segmented bar and the current step. */
export function JobProgress(props: { steps: JobStep[] }) {
  const current = () =>
    props.steps.find((s) => s.status === "running") ??
    props.steps.find((s) => s.status === "pending");
  const doneCount = () => props.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  return (
    <div>
      <div class="dev-progress">
        <For each={props.steps}>{(s) => <div class={`dev-progress-seg ${s.status}`} title={s.label} />}</For>
      </div>
      <Show when={current()}>
        <div class="dev-progress-label">
          <span class="dev-step-spinner" />
          {current()!.label}
          <span style={{ color: "#6e7681", "margin-left": "auto" }}>
            {doneCount()}/{props.steps.length}
          </span>
        </div>
      </Show>
    </div>
  );
}

/**
 * YAML with Orca's annotations made visible: the "why" comments Orca adds
 * to each generated line are highlighted, and !reset / !override tags stand
 * out, so a reader can see what changed relative to their compose file.
 */
export function YamlView(props: { text: string; style?: JSX.CSSProperties }) {
  const lines = () => props.text.split("\n");
  return (
    <pre class="dev-code" style={props.style}>
      <For each={lines()}>
        {(line) => (
          <>
            <YamlLine line={line} />
            {"\n"}
          </>
        )}
      </For>
    </pre>
  );
}

function YamlLine(props: { line: string }) {
  const parts = (): JSX.Element[] => {
    const line = props.line;
    if (line.trimStart().startsWith("#")) {
      return [<span class="y-header">{line}</span>];
    }
    // Split off a trailing "  # why" comment (not inside a quoted string).
    let code = line;
    let comment = "";
    const idx = findComment(line);
    if (idx >= 0) {
      code = line.slice(0, idx);
      comment = line.slice(idx);
    }
    const out: JSX.Element[] = [];
    const m = code.match(/^(\s*-?\s*)([^:"]+?)(:)(.*)$/);
    if (m && !code.trimStart().startsWith('"')) {
      out.push(m[1]);
      out.push(<span class="y-key">{m[2]}</span>);
      out.push(m[3]);
      out.push(...valueParts(m[4]));
    } else {
      out.push(...valueParts(code));
    }
    if (comment) out.push(<span class="y-why">{comment}</span>);
    return out;
  };
  return <>{parts()}</>;
}

function valueParts(v: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  const re = /(!reset|!override)|("(?:[^"\\]|\\.)*")/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v))) {
    if (m.index > last) out.push(v.slice(last, m.index));
    out.push(m[1] ? <span class="y-tag">{m[1]}</span> : <span class="y-str">{m[2]}</span>);
    last = m.index + m[0].length;
  }
  if (last < v.length) out.push(v.slice(last));
  return out;
}

/** Index of a `  # comment` outside double quotes, or -1. */
function findComment(line: string): number {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && inStr) {
      i++;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (!inStr && c === "#" && i >= 2 && line[i - 1] === " " && line[i - 2] === " ") return i - 2;
  }
  return -1;
}

/** Status dot with an optional pulse for in-between states. */
export function StatusDot(props: { color: string; pulse?: boolean }) {
  return <span class={`dev-dot ${props.pulse ? "dev-dot-pulse" : ""}`} style={{ background: props.color }} />;
}

/** Three choices for one shared service, with what each one means here. */
export function DataModePicker(props: {
  choice: import("../../lib/dev").DataChoice;
  value: import("../../lib/dev").DataMode;
  onChange: (m: import("../../lib/dev").DataMode) => void;
  disabled?: boolean;
}) {
  const modes: import("../../lib/dev").DataMode[] = ["shared", "own-database", "own-server"];
  return (
    <div style={{ display: "grid", "grid-template-columns": "1fr 1fr 1fr", gap: "8px" }}>
      <For each={modes}>
        {(m) => {
          const unavailable = () => m === "own-database" && !props.choice.supports_own_database;
          return (
            <button
              type="button"
              class={`dev-option ${props.value === m ? "selected" : ""}`}
              disabled={props.disabled || unavailable()}
              title={unavailable() ? props.choice.own_database_note ?? "" : ""}
              onClick={() => props.onChange(m)}
            >
              <span class="dev-radio" />
              <span>
                <div class="dev-option-title">
                  {DATA_MODE_LABEL[m]}
                  {m === props.choice.default_mode ? <span style={{ color: "#6e7681", "font-weight": 400 }}> · default</span> : null}
                </div>
                <div class="dev-option-desc">
                  {unavailable() ? props.choice.own_database_note : dataModeDescription(m, props.choice)}
                </div>
              </span>
            </button>
          );
        }}
      </For>
    </div>
  );
}
