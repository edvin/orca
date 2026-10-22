// A stack's orca.yaml: what Orca read from it and applied, and an editor to
// create or change it. A stack without one gets a starting file built from
// its running services.

import { createSignal, createResource, For, Show, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import YamlEditor from "./YamlEditor";
import { showToast } from "./Toast";
import { safeHref } from "../lib/sanitize";

interface RouteStatus {
  hostname: string;
  path?: string | null;
  service: string;
  port: number;
  status: "active" | "paused" | "waiting" | "blocked" | "unknown";
  detail: string;
}

interface Report {
  path: string;
  exists: boolean;
  reference: string;
  suggestion?: string;
  text?: string;
  local_override?: boolean;
  error?: string | null;
  warnings?: string[];
  routes?: RouteStatus[];
  links?: Array<{ group: string; count: number }>;
  builds?: string[];
  hooks?: string[];
  has_dev?: boolean;
}

interface Validation {
  ok: boolean;
  error?: string | null;
  line?: number | null;
  warnings: string[];
}

const STATUS: Record<RouteStatus["status"], { label: string; color: string }> = {
  active: { label: "Active", color: "#3fb950" },
  paused: { label: "Paused", color: "#8b949e" },
  waiting: { label: "Waiting", color: "#d29922" },
  blocked: { label: "Not applied", color: "#f85149" },
  unknown: { label: "No such service", color: "#f85149" },
};

const muted = { color: "#8b949e", "font-size": "12px" } as const;
const sectionTitle = { color: "#e6edf3", "font-size": "13px", "font-weight": "600", "margin-bottom": "6px" } as const;

export default function StackOrcaYaml(props: { stackName: string }) {
  const [report, { mutate, refetch }] = createResource(
    () => props.stackName,
    (name) => invoke<Report>("stack_orca_yaml", { name }),
  );
  // Text being written for a stack that has no orca.yaml yet.
  const [draft, setDraft] = createSignal<string | null>(null);
  const [check, setCheck] = createSignal<Validation | null>(null);

  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const validateSoon = (text: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      invoke<Validation>("validate_orca_yaml", { text }).then(setCheck).catch(() => setCheck(null));
    }, 400);
  };

  const save = async (text: string) => {
    try {
      const r = await invoke<Report>("save_stack_orca_yaml", { name: props.stackName, text });
      mutate(r);
      setDraft(null);
      setCheck(null);
      showToast("orca.yaml saved. Orca applies it now.", "success");
      // Routes apply within a moment; show their state once they have.
      setTimeout(() => void refetch(), 1500);
    } catch (e) {
      showToast(String(e), "error");
      throw e;
    }
  };

  const openReference = () => {
    const url = safeHref(report()?.reference);
    if (url) shellOpen(url).catch(() => window.open(url, "_blank", "noopener,noreferrer"));
  };

  return (
    <div class="detail-overview" style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
      <Show when={report.error}>
        <div style={{ color: "#f85149", "font-size": "13px" }}>Could not read this stack's orca.yaml: {String(report.error)}</div>
      </Show>

      <Show when={report()}>
        {(r) => (
          <>
            <div style={{ display: "flex", "align-items": "center", gap: "12px", "flex-wrap": "wrap" }}>
              <code class="mono" style={{ color: "#8b949e", "font-size": "12px", "word-break": "break-all", flex: "1" }}>{r().path}</code>
              <Show when={r().local_override}>
                <span style={muted}>orca.local.yaml overrides some values on this machine</span>
              </Show>
              <button class="btn btn-sm" onClick={openReference}>orca.yaml reference</button>
            </div>

            {/* No orca.yaml yet: explain, and offer a starting file. */}
            <Show when={!r().exists && draft() === null}>
              <div class="card" style={{ display: "flex", "flex-direction": "column", gap: "10px", "max-width": "720px" }}>
                <div style={{ color: "#e6edf3", "font-size": "14px", "font-weight": "600" }}>This stack has no orca.yaml yet</div>
                <div style={{ color: "#c9d1d9", "font-size": "13px", "line-height": "1.6" }}>
                  An <span class="mono">orca.yaml</span> next to the compose file gives the stack HTTPS hostnames through the
                  gateway, links to its other environments, build targets and setup commands. Orca reads it whenever the stack
                  runs, however it was started, so commit it and everyone on the team gets the same setup.
                </div>
                <div>
                  <button
                    class="btn btn-primary"
                    onClick={() => {
                      const text = r().suggestion ?? "";
                      setDraft(text);
                      validateSoon(text);
                    }}
                  >
                    Create orca.yaml
                  </button>
                  <span style={{ ...muted, "margin-left": "10px" }}>Starts from this stack's running services; nothing is saved until you save.</span>
                </div>
              </div>
            </Show>

            {/* What Orca read and applied. */}
            <Show when={r().exists}>
              <Show when={r().error}>
                <div style={{ padding: "10px 14px", background: "rgba(248,81,73,0.08)", border: "1px solid rgba(248,81,73,0.35)", "border-radius": "8px", "font-size": "13px", color: "#e6edf3" }}>
                  Orca can't read this file, so none of it applies: {r().error}
                </div>
              </Show>
              <Show when={(r().warnings ?? []).length > 0}>
                <div style={{ padding: "10px 14px", background: "rgba(210,153,34,0.08)", border: "1px solid rgba(210,153,34,0.35)", "border-radius": "8px", "font-size": "12px", color: "#e6edf3", display: "flex", "flex-direction": "column", gap: "4px" }}>
                  <For each={r().warnings}>{(w) => <span>{w}</span>}</For>
                </div>
              </Show>

              <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
                <div style={{ "grid-column": "1 / -1" }}>
                  <div style={sectionTitle}>Gateway routes</div>
                  <Show when={(r().routes ?? []).length > 0} fallback={<div style={muted}>None. Add a <span class="mono">gateway:</span> entry to give a service a hostname.</div>}>
                    <table class="table">
                      <thead>
                        <tr><th>Hostname</th><th>Service</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        <For each={r().routes}>
                          {(route) => (
                            <tr>
                              <td class="mono" style={{ "word-break": "break-all" }}>{route.hostname}{route.path ?? ""}</td>
                              <td class="mono">{route.service}:{route.port}</td>
                              <td>
                                <span style={{ color: STATUS[route.status].color, "font-size": "12px", "font-weight": "600" }}>{STATUS[route.status].label}</span>
                                <Show when={route.detail}>
                                  <span style={{ ...muted, "margin-left": "8px" }}>{route.detail}</span>
                                </Show>
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </Show>
                </div>
                <div>
                  <div style={sectionTitle}>Links</div>
                  <Show when={(r().links ?? []).length > 0} fallback={<div style={muted}>None</div>}>
                    <For each={r().links}>{(g) => <div style={{ "font-size": "13px", color: "#c9d1d9" }}>{g.group} <span style={muted}>· {g.count}</span></div>}</For>
                    <div style={{ ...muted, "margin-top": "4px" }}>Shown on the Gateway page</div>
                  </Show>
                </div>
                <div>
                  <div style={sectionTitle}>Build targets</div>
                  <Show when={(r().builds ?? []).length > 0} fallback={<div style={muted}>None</div>}>
                    <For each={r().builds}>{(b) => <div class="mono" style={{ "font-size": "12px", color: "#c9d1d9" }}>{b}</div>}</For>
                    <div style={{ ...muted, "margin-top": "4px" }}>On the Builds page</div>
                  </Show>
                </div>
                <div>
                  <div style={sectionTitle}>Setup hooks</div>
                  <Show when={(r().hooks ?? []).length > 0} fallback={<div style={muted}>None</div>}>
                    <For each={r().hooks}>{(h) => <div class="mono" style={{ "font-size": "12px", color: "#c9d1d9", "word-break": "break-all" }}>{h}</div>}</For>
                    <div style={{ ...muted, "margin-top": "4px" }}>Run after every start from Orca</div>
                  </Show>
                </div>
                <Show when={r().has_dev}>
                  <div>
                    <div style={sectionTitle}>Worktree instances</div>
                    <div style={muted}>This file has a <span class="mono">dev:</span> section: manage it on the Projects page.</div>
                  </div>
                </Show>
              </div>
            </Show>

            {/* The file itself: the draft of a new one, or the existing one. */}
            <Show when={draft() !== null || r().exists}>
              <div style={{ height: "calc(100vh - 360px)", "min-height": "320px", "border-radius": "8px", overflow: "hidden", border: "1px solid #21262d" }}>
                <YamlEditor
                  value={draft() ?? r().text ?? ""}
                  readOnly={false}
                  title={draft() !== null ? "New orca.yaml" : "orca.yaml"}
                  onChange={validateSoon}
                  onSave={save}
                  saveLabel="Save"
                  unsaved={draft() !== null}
                  onClose={draft() !== null ? () => { setDraft(null); setCheck(null); } : undefined}
                />
              </div>
              <Show when={check()}>
                {(v) => (
                  <div style={{ "font-size": "12px", display: "flex", "flex-direction": "column", gap: "3px" }}>
                    <Show when={v().error}>
                      <span style={{ color: "#f85149" }}>
                        {v().error}{v().line ? ` (line ${v().line})` : ""}
                      </span>
                    </Show>
                    <For each={v().warnings}>{(w) => <span style={{ color: "#d29922" }}>{w}</span>}</For>
                    <Show when={!v().error && v().warnings.length === 0}>
                      <span style={{ color: "#3fb950" }}>Looks good</span>
                    </Show>
                  </div>
                )}
              </Show>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
