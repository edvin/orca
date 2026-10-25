// A line on the dashboard while Docker Desktop's things (or, on Windows, the
// earlier Docker in the default WSL distro) haven't been brought over to
// Orca's engine, or left there, yet. Hidden for this session once closed.

import { createResource, createSignal, Show } from "solid-js";
import { desktopApi, engineApi, isWindows, type DesktopStatus } from "../lib/engine";

let closed = false;

export default function DesktopNudge(props: { onNavigate?: (page: string) => void }) {
  const [hidden, setHidden] = createSignal(closed);
  const [state] = createResource(
    () => !hidden(),
    async () => {
      const [d, earlier, e] = await Promise.all([
        desktopApi.status(),
        isWindows() ? desktopApi.status("earlier").catch(() => null) : Promise.resolve(null),
        engineApi.status().catch(() => null),
      ]);
      return { d, earlier, other: e?.choice.kind === "socket" && !e.from_env };
    },
  );
  const pending = (d: DesktopStatus | null) => {
    if (!d || !d.installed || d.outcome || d.moving) return false;
    const c = d.counts;
    return !c || c.containers + c.images + c.volumes > 0;
  };
  /** The source still waiting: Docker Desktop first. */
  const waiting = () => {
    const s = state();
    if (!s || s.other) return null;
    if (pending(s.d)) return "Docker Desktop";
    if (pending(s.earlier)) return s.earlier!.name ?? "the earlier Docker";
    return null;
  };
  const close = () => {
    closed = true;
    setHidden(true);
  };

  return (
    <Show when={!hidden() && waiting()}>
      <div class="ai-nudge">
        <span class="ai-nudge-icon">⇄</span>
        <div class="ai-nudge-text">
          <b>What's in {waiting()} stays there</b>
          <span>Orca runs its own engine. Bring the images, volumes and projects over, or start fresh.</span>
        </div>
        <button class="btn btn-sm btn-primary" onClick={() => props.onNavigate?.("environment")}>Bring them over</button>
        <button class="ai-nudge-close" title="Not now" onClick={close}>×</button>
      </div>
    </Show>
  );
}
