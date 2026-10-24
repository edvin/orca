// A stack's databases, when its orca.yaml requires any: where each comes
// from, and the way to the Databases page to connect, snapshot or reset.

import { createResource, For, Show } from "solid-js";
import { databasesApi, ENGINE_NAME, type ProjectNeeds } from "../lib/databases";

export default function StackDatabases(props: { stackName: string; onNavigate?: (target: string) => void }) {
  const [needs] = createResource(
    () => props.stackName,
    (name) =>
      databasesApi
        .quick()
        .then((o) => o.projects.find((p) => p.project === name) ?? null)
        .catch(() => null as ProjectNeeds | null),
  );
  return (
    <Show when={needs()}>
      {(p) => (
        <div class="stack-dbs">
          <div class="stack-dbs-list">
            <For each={p().databases}>
              {(r) => (
                <div class="stack-db" classList={{ bad: !!r.error }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
                  </svg>
                  <Show when={!r.error} fallback={<span>Database: {r.error}</span>}>
                    <span>
                      <b>{ENGINE_NAME[r.engine!]}</b>{" "}
                      <Show when={r.source?.kind !== "own"} fallback={<span class="db-muted">its own {r.replaces ?? "database"}</span>}>
                        <span class="mono">{r.database}</span> on {r.from}
                      </Show>
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <button class="btn btn-sm" onClick={() => props.onNavigate?.("databases")}>Connect, snapshot or reset</button>
        </div>
      )}
    </Show>
  );
}
