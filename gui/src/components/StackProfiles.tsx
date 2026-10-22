// Compose profiles on a stack's page: the optional parts of the stack as
// cards to switch on and off, what that starts and stops, and services that
// need another profile. The choice is remembered on this machine and used
// whenever Orca starts the stack.

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { StackProfilesReport } from "../lib/types";
import ProfileCards from "./ProfileCards";

export const PROFILES_DOC = "https://orca-desktop.com/docs/profiles/";

const muted = { color: "#8b949e", "font-size": "12px" } as const;

/** Services that run with `profiles` on: those without one, and those in one of them. */
export function enabledServices(report: StackProfilesReport, profiles: string[]): string[] {
  return report.services
    .filter((s) => s.profiles.length === 0 || s.profiles.some((p) => profiles.includes(p)))
    .map((s) => s.name);
}

export default function StackProfiles(props: {
  report: StackProfilesReport;
  busy: boolean;
  onSave: (profiles: string[], apply: boolean) => void;
  onOpenDocs: () => void;
}) {
  const [selected, setSelected] = createSignal<string[]>([]);
  createEffect(() => setSelected([...props.report.active]));

  const stateOf = (name: string) => props.report.services.find((s) => s.name === name)?.state ?? null;
  const always = () => props.report.services.filter((s) => s.profiles.length === 0);
  const toggle = (p: string) =>
    setSelected((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const changed = () => !same(selected(), props.report.active);

  const on = createMemo(() => enabledServices(props.report, selected()));
  const willStart = () => on().filter((s) => stateOf(s) !== "Running");
  const willStop = () =>
    // Containers of switched-off services go, running or not; compose recreates them later.
    props.report.services.filter((s) => !on().includes(s.name) && s.state !== null).map((s) => s.name);

  // A service that's on but depends on one that isn't: compose refuses to
  // start it. Offer the profile that brings the dependency along.
  const missing = createMemo(() => {
    const out: { service: string; needs: string; profile: string | null }[] = [];
    for (const name of on()) {
      const svc = props.report.services.find((s) => s.name === name);
      for (const dep of svc?.depends_on ?? []) {
        if (on().includes(dep)) continue;
        const target = props.report.services.find((s) => s.name === dep);
        out.push({ service: name, needs: dep, profile: target?.profiles[0] ?? null });
      }
    }
    return out;
  });

  return (
    <div class="profiles-panel">
      <div style={{ display: "flex", "align-items": "baseline", gap: "10px", "flex-wrap": "wrap" }}>
        <div style={{ color: "#e6edf3", "font-size": "14px", "font-weight": "600" }}>Profiles</div>
        <div style={{ ...muted, flex: "1", "min-width": "240px" }}>
          Optional parts of this stack, from the compose file. Pick what you need; Orca remembers it on this machine and starts
          the same set every time.{" "}
          <button class="link-btn" onClick={() => props.onOpenDocs()}>How profiles work</button>
        </div>
      </div>

      <ProfileCards profiles={props.report.profiles} always={always().map((s) => s.name)} selected={selected()}
        onToggle={toggle} stateOf={stateOf} disabled={props.busy} />

      <Show when={missing().length > 0}>
        <div class="profiles-note warn">
          <For each={missing()}>
            {(m) => (
              <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap" }}>
                <span>
                  <b>{m.service}</b> needs <b>{m.needs}</b>
                  {m.profile ? <>, which is in the <b>{m.profile}</b> profile</> : null}. Compose won't start it without.
                </span>
                <Show when={m.profile}>
                  <button class="btn btn-sm" onClick={() => toggle(m.profile!)}>Turn on {m.profile}</button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={changed() || !props.report.remembered}>
        <div class="profiles-bar">
          <div style={{ flex: "1", "min-width": "240px", "font-size": "12.5px", color: "#c9d1d9", display: "flex", "flex-direction": "column", gap: "3px" }}>
            <Show when={changed()} fallback={<span style={muted}>Running what compose starts by default. Save this set to have Orca start it every time.</span>}>
              <Show when={props.report.running} fallback={<span>Applies the next time you start the stack.</span>}>
                <Show when={willStart().length > 0}><span><span style={{ color: "#3fb950" }}>Starts</span> {willStart().join(", ")}</span></Show>
                <Show when={willStop().length > 0}><span><span style={{ color: "#f0883e" }}>Stops and removes</span> {willStop().join(", ")} <span style={muted}>(volumes are kept)</span></span></Show>
                <Show when={willStart().length === 0 && willStop().length === 0}><span style={muted}>Nothing to start or stop.</span></Show>
              </Show>
            </Show>
          </div>
          <Show when={changed()}>
            <button class="btn btn-sm" disabled={props.busy} onClick={() => setSelected([...props.report.active])}>Reset</button>
          </Show>
          <Show when={props.report.running && changed()} fallback={
            <button class="btn btn-sm btn-primary" disabled={props.busy || missing().length > 0} onClick={() => props.onSave(selected(), false)}>
              {props.busy ? "Saving…" : "Save"}
            </button>
          }>
            <button class="btn btn-sm btn-primary" disabled={props.busy || missing().length > 0} onClick={() => props.onSave(selected(), true)}>
              {props.busy ? "Applying…" : "Apply"}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
