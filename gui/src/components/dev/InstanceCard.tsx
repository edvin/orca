// One worktree on the instance board: what it is, where to reach it, and
// the one action that matters now.
import { For, Show } from "solid-js";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { DATA_MODE_LABEL, STATUS_META, ago, instanceUrls, tildify } from "../../lib/dev";
import type { DevInstance, DevJob } from "../../lib/dev";
import { JobProgress, StatusDot } from "./DevBits";
import { copyToClipboard } from "../../lib/clipboard";

interface Props {
  inst: DevInstance;
  job: DevJob | null;
  onOpen: () => void;
  onStart: () => void;
  onStop: () => void;
  onRemove: () => void;
}

const GlobeIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
);
const PlugIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" /></svg>
);
const BranchIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
);
const ExternalIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
);
const CopyIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
);

export default function InstanceCard(props: Props) {
  const meta = () => STATUS_META[props.inst.status];
  const busy = () => props.job?.status === "running" || props.inst.status === "starting" || props.inst.status === "stopping";
  const live = () => props.inst.status === "running" || props.inst.status === "partial";
  const urls = () => instanceUrls(props.inst.routes);
  const failedJob = () => (props.job?.status === "failed" ? props.job : null);
  const errorText = () => failedJob()?.error ?? (props.inst.status === "failed" ? props.inst.last_error : null);

  const cardClass = () =>
    "dev-card " +
    (busy() ? "dev-card-busy" : errorText() ? "dev-card-failed" : live() ? "dev-card-running" : "dev-card-idle");

  const stop = (e: MouseEvent) => e.stopPropagation();

  const who = () => {
    const i = props.inst;
    if (!i.last_started) return i.configured ? "Configured, never started" : "Not started yet";
    const by = i.started_by === "mcp" ? "an agent" : i.started_by === "cli" ? "the CLI" : i.started_by === "auto" ? "Orca, as a new worktree" : "you";
    return `Started by ${by} · ${ago(i.last_started)}`;
  };

  return (
    <div class={cardClass()} onClick={props.onOpen}>
      <div class="dev-card-top">
        <div style={{ "min-width": 0 }}>
          <div class="dev-card-name">
            <StatusDot color={busy() ? "#58a6ff" : meta().color} pulse={busy()} />
            {props.inst.name}
            <Show when={props.inst.is_main}>
              <span class="dev-chip" style={{ "font-size": "10px", padding: "1px 7px" }}>main checkout</span>
            </Show>
            <For each={props.inst.profiles ?? []}>
              {(p) => <span class="profile-tag" title={`Runs the ${p} profile`}>+{p}</span>}
            </For>
          </div>
          <div class="dev-card-sub">
            <span style={{ display: "inline-flex", "align-items": "center", gap: "4px" }}>
              <BranchIcon />
              {props.inst.branch ?? `detached ${props.inst.head ?? ""}`}
            </span>
            <Show when={(props.inst.ahead ?? 0) > 0}>
              <span>{props.inst.ahead} ahead</span>
            </Show>
            <Show when={props.inst.dirty}>
              <span style={{ color: "#d29922" }}>uncommitted changes</span>
            </Show>
            <Show when={props.inst.upstream_gone}>
              <span style={{ color: "#a371f7" }} title="The branch was deleted on the remote, usually because its pull request was merged">
                remote branch deleted
              </span>
            </Show>
          </div>
          <Show when={Object.keys(props.inst.data_modes ?? {}).length > 0}>
            <div class="dev-card-sub">
              <For each={Object.entries(props.inst.data_modes)}>
                {([svc, mode]) => (
                  <span
                    class="dev-chip dev-chip-accent"
                    style={{ "font-size": "10.5px", padding: "1px 7px" }}
                    title={mode === "own-database" && props.inst.tenants[svc] ? `Database ${props.inst.tenants[svc]}` : ""}
                  >
                    {svc}: {DATA_MODE_LABEL[mode].toLowerCase()}
                  </span>
                )}
              </For>
            </div>
          </Show>
          <div class="dev-card-sub mono dev-path" style={{ "font-size": "11px", display: "block" }} title={props.inst.path}>
            <span>{tildify(props.inst.path)}</span>
          </div>
        </div>
        <span class="dev-card-status" style={{ color: busy() ? "#58a6ff" : meta().color }} title={meta().hint}>
          {busy() ? (props.job?.action === "up" || props.inst.status === "starting" ? "Starting" : "Stopping") : meta().label}
        </span>
      </div>

      <Show when={busy() && props.job}>
        <JobProgress steps={props.job!.steps} />
      </Show>

      <Show when={!busy() && errorText()}>
        <div class="dev-error">{errorText()!.split("\n")[0]}</div>
      </Show>

      <Show when={!busy() && (urls().length > 0 || props.inst.ports.length > 0)}>
        <div class="dev-card-links" onClick={stop}>
          <For each={urls()}>
            {(u) => (
              <a
                class={`dev-link ${live() ? "" : "dev-link-dim"}`}
                href="#"
                title={live() ? `Open ${u.url}` : "Start the instance to open it"}
                onClick={(e) => {
                  e.preventDefault();
                  if (live()) shellOpen(u.url).catch(() => {});
                }}
              >
                <GlobeIcon />
                <span class="dev-link-text">{u.url.replace(/^https:\/\//, "")}</span>
                <span class="dev-link-svc">{u.service}</span>
                <ExternalIcon />
              </a>
            )}
          </For>
          <For each={props.inst.ports}>
            {(p) => (
              <a
                class={`dev-link dev-link-port ${live() ? "" : "dev-link-dim"}`}
                href="#"
                title="Copy address"
                onClick={(e) => {
                  e.preventDefault();
                  copyToClipboard(`localhost:${p.host_port}`);
                }}
              >
                <PlugIcon />
                <span class="dev-link-text">localhost:{p.host_port}</span>
                <span class="dev-link-svc">{p.service} :{p.container_port}</span>
                <CopyIcon />
              </a>
            )}
          </For>
        </div>
      </Show>

      <Show when={!busy() && !errorText() && !live() && urls().length === 0 && props.inst.ports.length === 0 && props.inst.status !== "orphaned"}>
        <div class="dev-card-hint">
          {props.inst.status === "idle_stopped"
            ? "Stopped after going unused. Opening one of its URLs, or Start, brings it back with the same URLs, ports and data."
            : props.inst.status === "stopped"
              ? "Stopped. Start it again with the same URLs and ports."
              : "Not running. Start it to get its own URLs and ports; shared services are reused."}
        </div>
      </Show>

      <Show when={props.inst.status === "orphaned"}>
        <div class="dev-card-hint">
          The worktree folder is gone. Remove the instance to free its containers, volumes and ports.
        </div>
      </Show>

      <Show when={props.inst.services.length > 0 && !busy()}>
        <div class="dev-services">
          <For each={props.inst.services}>
            {(s) => (
              <span title={`${s.container_name} · ${s.state}`}>
                <StatusDot color={s.state.toLowerCase() === "running" ? "#3fb950" : "#6e7681"} />
                {s.name}
              </span>
            )}
          </For>
        </div>
      </Show>

      <div class="dev-card-footer" onClick={stop}>
        <span class="dev-who">{who()}</span>
        <Show when={props.inst.status === "orphaned"}>
          <button class="btn btn-sm btn-danger" onClick={props.onRemove}>Remove</button>
        </Show>
        <Show when={props.inst.status !== "orphaned"}>
          <Show
            when={live() || busy()}
            fallback={
              <button class="btn btn-sm btn-primary" onClick={props.onStart}>
                {errorText() ? "Retry" : "Start"}
              </button>
            }
          >
            <button class="btn btn-sm" disabled={busy()} onClick={props.onStop}>Stop</button>
          </Show>
        </Show>
      </div>
    </div>
  );
}
