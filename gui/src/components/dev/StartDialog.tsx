// Start dialog: shows what starting an instance will do before it happens,
// and lets the user choose the compose profiles and data mode per shared
// service.
import { createSignal, createEffect, For, Show, on } from "solid-js";
import ProfileCards from "../ProfileCards";
import { devApi, tildify } from "../../lib/dev";
import type { DataMode, DevInstance, DevProject, PlanView } from "../../lib/dev";
import { DataModePicker, YamlView } from "./DevBits";

interface Props {
  project: DevProject;
  inst: DevInstance;
  onClose: () => void;
  onStart: (opts: { profiles: string[]; build: boolean; data_modes: Record<string, DataMode> }) => void;
}

export default function StartDialog(props: Props) {
  const [profiles, setProfiles] = createSignal<string[]>(props.inst.profiles ?? []);
  const [plan, setPlan] = createSignal<PlanView | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [build, setBuild] = createSignal(true);
  const [showOverride, setShowOverride] = createSignal(false);
  // Chosen data modes; empty until the first plan tells us the current ones.
  const [modes, setModes] = createSignal<Record<string, DataMode>>({});

  createEffect(
    on([profiles, modes], async ([p, m]) => {
      setLoading(true);
      setError(null);
      try {
        const v = await devApi.plan(props.project.id, props.inst.name, p, m);
        setPlan(v);
        if (Object.keys(m).length === 0 && v.data.length > 0) {
          // Adopt the instance's current modes (one more reload, then stable).
          const current: Record<string, DataMode> = {};
          for (const c of v.data) current[c.service] = c.mode;
          setModes(current);
        }
      } catch (e) {
        setPlan(null);
        setError(String(e));
      } finally {
        setLoading(false);
      }
    }),
  );

  const toggleProfile = (p: string) =>
    setProfiles((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  /** Services in no profile: they always run. */
  const always = () => {
    const v = plan()?.plan;
    if (!v) return [];
    const members = new Set(v.profiles.flatMap((p) => p.services));
    return [...v.running_services, ...v.left_out].filter((s) => !members.has(s)).sort();
  };

  const urls = () => {
    const seen = new Set<string>();
    return (plan()?.plan.routes ?? []).filter((r) => {
      const key = r.url + (r.path ?? "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="modal-dialog" style={{ width: "680px" }} onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <div>
            <div class="modal-title">Start {props.inst.name}</div>
            <div style={{ "font-size": "12px", color: "#8b949e", "margin-top": "3px" }}>
              {props.inst.branch ?? "detached HEAD"} · <span class="mono">{tildify(props.inst.path)}</span>
            </div>
          </div>
          <button class="modal-close" onClick={props.onClose}>×</button>
        </div>
        <div class="modal-body" style={{ "max-height": "68vh", overflow: "auto" }}>
          <div class="dev-section">
            <div class="dev-section-title">What runs</div>
            <Show when={(plan()?.plan.profiles.length ?? 0) > 0} fallback={
              <div style={{ "font-size": "12.5px", color: "#c9d1d9" }}>
                <Show when={plan()} fallback="…">{plan()!.plan.running_services.join(", ")}</Show>
              </div>
            }>
              <ProfileCards profiles={plan()!.plan.profiles} always={always()} selected={profiles()} onToggle={toggleProfile} />
              <div style={{ "font-size": "12px", color: "#8b949e", "margin-top": "8px" }}>
                Runs {plan()!.plan.running_services.join(", ") || "nothing"}
                <Show when={plan()!.plan.left_out.length > 0}>
                  <span style={{ color: "#6e7681" }}> · leaves out {plan()!.plan.left_out.join(", ")}</span>
                </Show>
                . Remembered for this worktree.
              </div>
            </Show>
          </div>

          <Show when={(plan()?.data.length ?? 0) > 0}>
            <div class="dev-section">
              <div class="dev-section-title">Data</div>
              <For each={plan()!.data}>
                {(c) => (
                  <div style={{ "margin-bottom": "12px" }}>
                    <div style={{ "font-size": "13px", color: "#e6edf3", "margin-bottom": "6px", "font-weight": 500 }}>
                      {c.service}
                      <Show when={c.kind}>
                        <span style={{ color: "#6e7681", "font-weight": 400 }}> · {c.kind}{c.shared_db && c.kind !== "redis" ? ` · ${c.shared_db}` : ""}</span>
                      </Show>
                    </div>
                    <DataModePicker
                      choice={c}
                      value={modes()[c.service] ?? c.mode}
                      onChange={(m) => setModes({ ...modes(), [c.service]: m })}
                    />
                  </div>
                )}
              </For>
              <div class="form-hint">Orca remembers these choices for this worktree.</div>
            </div>
          </Show>

          <div class="dev-section">
            <div class="dev-section-title">You'll get</div>
            <Show when={loading()}>
              <div style={{ color: "#8b949e", "font-size": "12px" }}>Reading compose files…</div>
            </Show>
            <Show when={error()}>
              <div class="dev-error">{error()}</div>
            </Show>
            <Show when={plan() && !loading()}>
              <div class="dev-card-links">
                <For each={urls()}>
                  {(r) => (
                    <div class="dev-link" style={{ cursor: "default" }}>
                      <span class="dev-link-text">
                        {r.url.replace(/^https:\/\//, "")}
                        {r.path ? r.path.replace(/\*$/, "") : ""}
                      </span>
                      <span class="dev-link-svc">{r.service} :{r.port}</span>
                    </div>
                  )}
                </For>
                <For each={plan()!.plan.host_ports}>
                  {(p) => (
                    <div class="dev-link dev-link-port" style={{ cursor: "default" }}>
                      <span class="dev-link-text">localhost:{p.host_port}</span>
                      <span class="dev-link-svc">{p.service} :{p.container_port}</span>
                    </div>
                  )}
                </For>
                <Show when={urls().length === 0 && plan()!.plan.host_ports.length === 0}>
                  <div style={{ color: "#8b949e", "font-size": "12px" }}>
                    No browser URLs or host ports: nothing that runs publishes a port.
                  </div>
                </Show>
              </div>
              <Show when={plan()!.shared_services.length > 0}>
                <div style={{ "font-size": "12px", color: "#8b949e", "margin-top": "10px" }}>
                  The app reaches {plan()!.shared_services.join(", ")} by name, as usual. Orca connects them to this
                  instance's network.
                  <Show when={Object.keys(plan()!.plan.own_databases).length > 0}>
                    {" "}Connection strings that point at{" "}
                    {Object.values(plan()!.plan.own_databases).map((d) => d.shared_db).join(", ")} are switched to this
                    instance's own database.
                  </Show>
                </div>
              </Show>
              <For each={plan()!.plan.warnings}>
                {(w) => <div class="dev-warning" style={{ "margin-top": "8px" }}>{w}</div>}
              </For>
              <Show when={plan()!.resolved_mode}>
                <div class="dev-warning" style={{ "margin-top": "8px" }}>
                  Your Compose version is older than 2.24.4, so Orca writes a fully resolved compose file instead of a
                  small override. Your own files are still untouched.
                </div>
              </Show>
            </Show>
          </div>

          <div class="dev-section" style={{ "margin-bottom": "4px" }}>
            <label style={{ display: "flex", gap: "8px", "align-items": "center", "font-size": "12.5px", color: "#c9d1d9", cursor: "pointer" }}>
              <input type="checkbox" checked={build()} onChange={(e) => setBuild(e.currentTarget.checked)} />
              Rebuild images from this worktree's code
            </label>
            <Show when={plan()}>
              <button
                class="btn btn-sm btn-outline"
                style={{ "margin-top": "12px" }}
                onClick={() => setShowOverride(!showOverride())}
              >
                {showOverride() ? "Hide" : "Show"} the generated compose override
              </button>
              <Show when={showOverride()}>
                <div style={{ "font-size": "11.5px", color: "#8b949e", margin: "8px 0 6px" }}>
                  Written to <span class="mono">.orca/compose.override.yaml</span> in the worktree. Green comments explain each line.
                </div>
                <YamlView text={plan()!.plan.override_yaml} style={{ "max-height": "320px" }} />
              </Show>
            </Show>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" onClick={props.onClose}>Cancel</button>
          <button
            class="btn btn-primary"
            disabled={!!error() || loading()}
            onClick={() => props.onStart({ profiles: profiles(), build: build(), data_modes: modes() })}
          >
            Start instance
          </button>
        </div>
      </div>
    </div>
  );
}
