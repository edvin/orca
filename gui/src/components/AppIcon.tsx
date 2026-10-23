// An app's icon, or its initial on a colour picked from its name.

import { createSignal, Show } from "solid-js";

const ACCENTS = ["#58a6ff", "#3fb950", "#a371f7", "#d29922", "#f85149", "#79c0ff"];

export default function AppIcon(props: { src: string | null | undefined; name: string; size?: number }) {
  const size = () => props.size ?? 28;
  // An https icon the app's security policy blocks shows the initial instead.
  const [failed, setFailed] = createSignal<string | null>(null);
  const accent = () => ACCENTS[[...props.name].reduce((n, c) => n + c.charCodeAt(0), 0) % ACCENTS.length];
  return (
    <span class="app-icon" style={{ width: `${size()}px`, height: `${size()}px`, "font-size": `${Math.round(size() * 0.45)}px` }}>
      <Show when={props.src && failed() !== props.src} fallback={
        <span class="app-icon-initial" style={{ color: accent(), background: `${accent()}1f` }}>
          {(props.name.trim()[0] ?? "?").toUpperCase()}
        </span>
      }>
        <img src={props.src!} alt="" draggable={false} onError={() => setFailed(props.src ?? null)} />
      </Show>
    </span>
  );
}
