// The Gateway page's "Requests" tab: recent requests through the gateway,
// newest first, and why the failed ones failed.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import HelpLink from "../HelpLink";

interface GatewayRequest {
  at: number;
  method: string;
  host: string;
  uri: string;
  status: number;
  ms: number;
  size: number;
  route?: string;
  group?: string;
  error?: string;
  hint?: string;
}

function statusColor(s: number): string {
  if (s === 0 || s >= 500) return "#f85149";
  if (s >= 400) return "#d29922";
  if (s >= 300) return "#8b949e";
  return "#3fb950";
}

function time(at: number): string {
  return new Date(at * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function RequestsTab() {
  const [requests, setRequests] = createSignal<GatewayRequest[] | null>(null);
  const [query, setQuery] = createSignal("");
  const [problems, setProblems] = createSignal(false);
  const [open, setOpen] = createSignal<number | null>(null);

  const load = () => {
    if (document.hidden) return;
    invoke<GatewayRequest[]>("gateway_requests", { limit: 300, problems: problems(), q: query() || null })
      .then((r) => setRequests(Array.isArray(r) ? r : []), () => setRequests([]));
  };
  // Live while the tab is open.
  onMount(load);
  const timer = setInterval(load, 3000);
  onCleanup(() => clearInterval(timer));
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const onQuery = (v: string) => {
    setQuery(v);
    clearTimeout(debounce);
    debounce = setTimeout(load, 250);
  };

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
      <div style={{ color: "#8b949e", "font-size": "13px" }}>
        Every request through the gateway, newest first. A failed one says why.{" "}
        <HelpLink path="/docs/gateway/#requests" />
      </div>
      <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
        <input class="form-input" type="search" style={{ flex: "1", "min-width": "240px", "max-width": "460px" }}
          placeholder="Filter: hostname, path, project or status (502)" value={query()} onInput={(e) => onQuery(e.currentTarget.value)} />
        <button class="btn btn-sm" classList={{ "btn-primary": problems() }} onClick={() => { setProblems(!problems()); load(); }}>
          Only problems
        </button>
      </div>
      <Show when={requests()} fallback={<div style={{ color: "#8b949e", "font-size": "13px" }}>Loading…</div>}>
        {(list) => (
          <Show when={list().length > 0} fallback={
            <div class="empty" style={{ padding: "32px" }}>
              <p class="empty-title">{query() || problems() ? "No request matches" : "No requests yet"}</p>
              <p>{query() || problems() ? "Try fewer words, or show all requests." : "Open one of the gateway's addresses and it shows up here."}</p>
            </div>
          }>
            <table class="table gw-requests">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Status</th>
                  <th>Request</th>
                  <th>Route</th>
                  <th style={{ "text-align": "right" }}>Time taken</th>
                  <th style={{ "text-align": "right" }}>Size</th>
                </tr>
              </thead>
              <tbody>
                <For each={list()}>
                  {(r, i) => (
                    <>
                      <tr classList={{ "gw-req-failed": !!r.error, open: open() === i() }}
                        onClick={() => r.error && setOpen(open() === i() ? null : i())} style={{ cursor: r.error ? "pointer" : "default" }}>
                        <td class="mono" style={{ color: "#8b949e", "white-space": "nowrap" }}>{time(r.at)}</td>
                        <td class="mono" style={{ color: statusColor(r.status), "font-weight": "600" }}>{r.status || "—"}</td>
                        <td style={{ "min-width": "0", "max-width": "520px" }}>
                          <div class="mono gw-req-url" title={`${r.method} https://${r.host}${r.uri}`}>
                            <span style={{ color: "#6e7681" }}>{r.method} </span>{r.host}<span style={{ color: "#8b949e" }}>{r.uri}</span>
                          </div>
                          <Show when={r.hint}>{(h) => <div class="gw-req-hint">{h()}</div>}</Show>
                        </td>
                        <td style={{ color: "#c9d1d9", "font-size": "12.5px" }}>
                          {r.route ?? "—"}
                          <Show when={r.group}>{(g) => <span style={{ color: "#6e7681" }}> · {g()}</span>}</Show>
                        </td>
                        <td class="mono" style={{ "text-align": "right", color: r.ms > 2000 ? "#d29922" : "#8b949e" }}>
                          {r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)} s` : `${Math.round(r.ms)} ms`}
                        </td>
                        <td class="mono" style={{ "text-align": "right", color: "#8b949e" }}>{size(r.size)}</td>
                      </tr>
                      <Show when={open() === i() && r.error}>
                        <tr class="gw-req-detail"><td colspan={6} class="mono">{r.error}</td></tr>
                      </Show>
                    </>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        )}
      </Show>
    </div>
  );
}
