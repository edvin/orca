// A stack's orca.yaml: an editor for routes, links, setup commands and builds
// (or the file itself), with the state of each route. A stack without one
// gets a starting file built from its running services.

import { createSignal, createResource, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import OrcaYamlStudio, { type RouteStatus, type StudioService } from "./orcayaml/OrcaYamlStudio";
import { showToast } from "./Toast";
import HelpLink from "./HelpLink";
import { safeHref } from "../lib/sanitize";

interface Report {
  path: string;
  exists: boolean;
  reference: string;
  suggestion?: string;
  text?: string;
  local_override?: boolean;
  error?: string | null;
  routes?: RouteStatus[];
  has_dev?: boolean;
  services?: StudioService[];
  domain?: string;
}

const muted = { color: "#8b949e", "font-size": "12px" } as const;

export default function StackOrcaYaml(props: { stackName: string }) {
  const [report, { mutate, refetch }] = createResource(
    () => props.stackName,
    (name) => invoke<Report>("stack_orca_yaml", { name }),
  );
  // A new file being written for a stack that has none yet.
  const [draft, setDraft] = createSignal<string | null>(null);

  const save = async (text: string) => {
    try {
      const r = await invoke<Report>("save_stack_orca_yaml", { name: props.stackName, text });
      mutate(r);
      setDraft(null);
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
                  Gives the stack HTTPS hostnames, environment links, build targets and setup commands. Commit it to share the setup.{" "}
                  <HelpLink path="/docs/orca-yaml/" />
                </div>
                <div>
                  <button class="btn btn-primary" onClick={() => setDraft(r().suggestion ?? "")}>Create orca.yaml</button>
                  <span style={{ ...muted, "margin-left": "10px" }}>Starts from this stack's running services; nothing is saved until you save.</span>
                </div>
              </div>
            </Show>

            <Show when={r().exists && r().error}>
              <div style={{ padding: "10px 14px", background: "rgba(248,81,73,0.08)", border: "1px solid rgba(248,81,73,0.35)", "border-radius": "8px", "font-size": "13px", color: "#e6edf3" }}>
                Orca can't read this file, so none of it applies: {r().error}
              </div>
            </Show>
            <Show when={r().has_dev}>
              <div style={muted}>
                This file also has a <span class="mono">dev:</span> section for worktree instances; edit it on the Worktrees page. It is kept as is here.
              </div>
            </Show>

            <Show when={draft() !== null || r().exists}>
              <OrcaYamlStudio
                text={draft() ?? r().text ?? ""}
                isNew={draft() !== null}
                services={r().services ?? []}
                domain={r().domain ?? "localhost"}
                projectName={props.stackName}
                routeStatus={draft() === null ? r().routes : undefined}
                onSave={save}
                onDiscard={draft() !== null ? () => setDraft(null) : undefined}
              />
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
