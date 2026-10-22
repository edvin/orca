// Compose profiles as cards to switch on and off: the services that always
// run, then one card per profile with its services. Used on a stack's page
// and when starting a worktree instance.

import { For, Show } from "solid-js";

function Chip(props: { name: string; state?: string | null; dim?: boolean }) {
  return (
    <span class="profile-chip" classList={{ dim: !!props.dim }} title={props.state === undefined ? undefined : props.state ?? "Not created"}>
      <Show when={props.state !== undefined}>
        <span class="profile-dot" classList={{ on: props.state === "Running" }} />
      </Show>
      {props.name}
    </span>
  );
}

export default function ProfileCards(props: {
  profiles: { name: string; services: string[] }[];
  always: string[];
  selected: string[];
  onToggle: (profile: string) => void;
  /** Container state per service, for the dot on each chip. */
  stateOf?: (service: string) => string | null;
  disabled?: boolean;
}) {
  const state = (s: string) => (props.stateOf ? props.stateOf(s) : undefined);
  return (
    <div class="profiles-grid">
      <div class="profile-card always">
        <div class="profile-card-head">
          <span class="profile-name">Always</span>
          <span style={{ color: "#8b949e", "font-size": "12px" }}>{props.always.length} service{props.always.length === 1 ? "" : "s"}</span>
        </div>
        <div class="profile-chips">
          <For each={props.always}>{(s) => <Chip name={s} state={state(s)} />}</For>
        </div>
      </div>
      <For each={props.profiles}>
        {(p) => {
          const active = () => props.selected.includes(p.name);
          return (
            <button class="profile-card" classList={{ active: active() }} role="switch" aria-checked={active()}
              disabled={props.disabled} onClick={() => props.onToggle(p.name)}>
              <div class="profile-card-head">
                <span class="profile-name">{p.name}</span>
                <span class={`toggle-track${active() ? " toggle-on" : ""}`} style={{ transform: "scale(0.85)" }}>
                  <span class="toggle-thumb" />
                </span>
              </div>
              <div class="profile-chips">
                <For each={p.services}>{(s) => <Chip name={s} state={state(s)} dim={!active()} />}</For>
              </div>
            </button>
          );
        }}
      </For>
    </div>
  );
}
