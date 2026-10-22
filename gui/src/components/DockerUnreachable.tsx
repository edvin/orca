// Shown on list pages when Orca can't get the list from Docker, instead of
// loading skeletons that never finish or data that silently goes stale.

import { Show } from "solid-js";

export default function DockerUnreachable(props: { error: string | null; stale: boolean; onNavigate?: (target: string) => void }) {
  return (
    <Show when={props.error}>
      <div class="docker-unreachable">
        <div>
          <b>{props.stale ? "Can't reach Docker: this list may be out of date" : "Can't reach Docker"}</b>
          <span>Docker or Orca's VM may be stopped or starting. System Health shows what's wrong and can fix it.</span>
          <code>{props.error}</code>
        </div>
        <button class="btn btn-sm btn-primary" onClick={() => props.onNavigate?.("environment")}>Open System Health</button>
      </div>
    </Show>
  );
}
