// The Gateway page's "Landing page" tab: the page at the gateway's domain
// that lists every routed service. Its settings, and each route as it
// appears there, with where to change it.

import { createResource, createSignal, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { GatewayRoute, LandingSettings } from "../../lib/types";
import { showToast } from "../Toast";
import Dropdown from "../Dropdown";

const REFERENCE = "https://orca-desktop.com/docs/gateway/#the-landing-page";

interface Props {
  routes: GatewayRoute[];
  onEditRoute: (route: GatewayRoute) => void;
  onChanged: () => void;
}

const muted = { color: "#8b949e", "font-size": "12px" } as const;

/** The engines the page knows by name; anything else is a custom URL. Mirrors WEB_SEARCH_ENGINES in Rust. */
const ENGINES = [
  { value: "", label: "Off: only find services" },
  { value: "google", label: "Google" },
  { value: "duckduckgo", label: "DuckDuckGo" },
  { value: "bing", label: "Bing" },
  { value: "brave", label: "Brave Search" },
  { value: "kagi", label: "Kagi" },
  { value: "ecosia", label: "Ecosia" },
  { value: "startpage", label: "Startpage" },
  { value: "custom", label: "Custom URL…" },
];
const isEngine = (v: string | null | undefined) => !!v && ENGINES.some((e) => e.value === v && v !== "custom");
const validCustom = (v: string) => /^https?:\/\/\S+$/.test(v) && v.includes("{query}");

/** The section a route is shown under, as the page decides it. */
function groupOf(r: GatewayRoute): string {
  if (r.presentation?.group) return r.presentation.group;
  const owner = r.owner ?? "";
  for (const prefix of ["project:", "stack:"]) if (owner.startsWith(prefix)) return owner.slice(prefix.length);
  if (owner.startsWith("dev:")) return owner.slice(4).split(":")[0];
  return "Services";
}

const fromLabel = (label: string) =>
  label
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

/** The card title, as the page picks it: a worktree route reads "Web · feature-x". */
function titleOf(r: GatewayRoute): string {
  if (r.presentation?.title) return r.presentation.title;
  const label = r.hostname.split(".")[0];
  const owner = r.owner ?? "";
  if (!owner.startsWith("dev:")) return fromLabel(label);
  const [project, instance = ""] = owner.slice(4).split(":");
  let service = label.endsWith(`-${project}`) ? label.slice(0, -project.length - 1) : label;
  if (instance && service.endsWith(`-${instance}`)) service = service.slice(0, -instance.length - 1);
  return instance ? `${fromLabel(service || label)} · ${instance}` : fromLabel(service || label);
}

/** Where a route's presentation is changed, when not here. */
function managedBy(r: GatewayRoute): string | null {
  const owner = r.owner ?? "";
  if (owner.startsWith("label:")) return `the orca.route labels on ${owner.slice(6)}`;
  if (owner.startsWith("project:")) return `the orca.yaml of ${owner.slice(8)}`;
  if (owner.startsWith("dev:")) return "the worktree project";
  if (owner.startsWith("stack:")) return `the template or orca.yaml of ${owner.slice(6)}`;
  return null;
}

function Toggle(props: { on: boolean; onChange: (on: boolean) => void; label: string; hint: string }) {
  return (
    <div class="settings-row">
      <div class="settings-row-left">
        <span class="settings-label">{props.label}</span>
        <span class="settings-description">{props.hint}</span>
      </div>
      <div class="settings-toggle" role="switch" aria-checked={props.on} tabIndex={0}
        onClick={() => props.onChange(!props.on)}
        onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); props.onChange(!props.on); } }}>
        <div class={`toggle-track${props.on ? " toggle-on" : ""}`}><div class="toggle-thumb" /></div>
      </div>
    </div>
  );
}

export default function LandingPageTab(props: Props) {
  const [landing, { mutate }] = createResource(() => invoke<{ settings: LandingSettings; url: string }>("gateway_get_landing"));
  const [saving, setSaving] = createSignal(false);

  const save = async (patch: Partial<LandingSettings>) => {
    const current = landing()?.settings;
    if (!current) return;
    const settings = { ...current, ...patch };
    setSaving(true);
    try {
      const r = await invoke<{ settings: LandingSettings }>("gateway_set_landing", { settings });
      mutate((l) => (l ? { ...l, settings: r.settings } : l));
      showToast("Landing page updated", "success");
    } catch (e) {
      showToast(`Could not save: ${e}`, "error");
    }
    setSaving(false);
  };

  const setHidden = async (r: GatewayRoute, hidden: boolean) => {
    try {
      await invoke("gateway_update_route", {
        hostname: r.hostname,
        containerName: r.container_name,
        port: r.port,
        enabled: r.enabled,
        presentation: { ...(r.presentation ?? {}), hidden },
      });
      props.onChanged();
    } catch (e) {
      showToast(`Could not update: ${e}`, "error");
    }
  };

  const openUrl = (url: string) => shellOpen(url).catch(() => window.open(url, "_blank", "noopener,noreferrer"));

  const groups = () => {
    const by = new Map<string, GatewayRoute[]>();
    for (const r of props.routes.filter((x) => x.enabled)) {
      const g = groupOf(r);
      by.set(g, [...(by.get(g) ?? []), r]);
    }
    return [...by.entries()].sort(([a], [b]) => (a === "Services" ? 1 : b === "Services" ? -1 : a.localeCompare(b)));
  };

  // Draft text fields, saved on blur or Enter.
  const [title, setTitle] = createSignal<string | null>(null);
  const [subtitle, setSubtitle] = createSignal<string | null>(null);
  const [customUrl, setCustomUrl] = createSignal<string | null>(null);
  // "custom" chosen but no URL saved yet: show the field.
  const [pickedCustom, setPickedCustom] = createSignal(false);
  const engineChoice = (s: LandingSettings) =>
    pickedCustom() ? "custom" : !s.web_search ? "" : isEngine(s.web_search) ? s.web_search : "custom";
  const saveCustom = (s: LandingSettings) => {
    const v = (customUrl() ?? s.web_search ?? "").trim();
    if (!v || v === s.web_search) {
      setCustomUrl(null);
      return;
    }
    if (!validCustom(v)) {
      // Keep what was typed, so it can be fixed rather than retyped.
      showToast("Use an http(s) URL with {query} where the search terms go", "error");
      return;
    }
    setCustomUrl(null);
    setPickedCustom(false);
    void save({ web_search: v });
  };
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(() => showToast("Copied", "success"), () => {});

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "20px", "max-width": "960px" }}>
      <div style={{ display: "flex", "align-items": "center", gap: "16px", "flex-wrap": "wrap" }}>
        <div style={{ flex: "1", "min-width": "260px" }}>
          <div style={{ color: "#e6edf3", "font-size": "14px", "font-weight": "600" }}>A page that lists every routed service</div>
          <div style={{ ...muted, "margin-top": "4px", "font-size": "13px", "line-height": "1.5" }}>
            Anyone who can reach the gateway sees it at its domain: each service as a card, grouped by project, with whether it
            runs and for how long. It keeps itself up to date while open.
          </div>
        </div>
        <Show when={landing()?.url}>
          {(url) => <button class="btn btn-primary" onClick={() => openUrl(url())}>Open {url().replace("https://", "")}</button>}
        </Show>
      </div>

      <Show when={landing()?.settings}>
        {(s) => (
          <div class="card" style={{ padding: "4px 16px" }}>
            <div class="settings-row">
              <div class="settings-row-left">
                <span class="settings-label">Title</span>
                <span class="settings-description">Shown at the top and in the browser tab</span>
              </div>
              <input id="landing-title" class="form-input" style={{ width: "280px" }} placeholder="Orca Gateway"
                value={title() ?? s().title ?? ""} onInput={(e) => setTitle(e.currentTarget.value)}
                onBlur={() => { if (title() !== null && title() !== (s().title ?? "")) void save({ title: title() || null }); setTitle(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} disabled={saving()} />
            </div>
            <div class="settings-divider" />
            <div class="settings-row">
              <div class="settings-row-left">
                <span class="settings-label">Subtitle</span>
                <span class="settings-description">The line under the title; the domain when empty</span>
              </div>
              <input id="landing-subtitle" class="form-input" style={{ width: "280px" }} placeholder="*.localhost"
                value={subtitle() ?? s().subtitle ?? ""} onInput={(e) => setSubtitle(e.currentTarget.value)}
                onBlur={() => { if (subtitle() !== null && subtitle() !== (s().subtitle ?? "")) void save({ subtitle: subtitle() || null }); setSubtitle(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} disabled={saving()} />
            </div>
            <div class="settings-divider" />
            <Toggle on={s().show_status} onChange={(on) => void save({ show_status: on })} label="Show status and uptime"
              hint="Running, starting, unhealthy, sleeping or stopped, and how long it has been up" />
            <div class="settings-divider" />
            <Toggle on={s().show_targets} onChange={(on) => void save({ show_targets: on })} label="Show container and port"
              hint="The container and port behind each card, handy when debugging" />
          </div>
        )}
      </Show>

      <Show when={landing()?.settings}>
        {(s) => (
          <div class="card landing-search-card">
            <div class="landing-search-head">
              <div>
                <div class="landing-search-title">Search box</div>
                <div class="landing-search-sub">
                  Type a few letters to find a service by name, hostname, project or status, and press Enter to open it. A hostname
                  like <span class="mono">github.com</span> goes straight there. Press <kbd>/</kbd> to jump to the box.
                </div>
              </div>
              <div class="settings-toggle" role="switch" aria-checked={s().search} tabIndex={0} aria-label="Search box"
                onClick={() => void save({ search: !s().search })}
                onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); void save({ search: !s().search }); } }}>
                <div class={`toggle-track${s().search ? " toggle-on" : ""}`}><div class="toggle-thumb" /></div>
              </div>
            </div>
            <Show when={s().search}>
              <div class="settings-divider" />
              <div class="settings-row">
                <div class="settings-row-left">
                  <span class="settings-label">Search the web</span>
                  <span class="settings-description">When no service matches, Enter searches here. Shift+Enter always does.</span>
                </div>
                <Dropdown
                  value={engineChoice(s())}
                  options={ENGINES}
                  style={{ width: "220px" }}
                  onChange={(v) => {
                    if (v === "custom") { setPickedCustom(true); return; }
                    setPickedCustom(false);
                    void save({ web_search: v || null });
                  }}
                />
              </div>
              <Show when={engineChoice(s()) === "custom"}>
                <div class="landing-search-custom">
                  <input class="form-input mono" placeholder="https://intranet.example.com/search?q={query}"
                    value={customUrl() ?? (isEngine(s().web_search) ? "" : s().web_search ?? "")}
                    onInput={(e) => setCustomUrl(e.currentTarget.value)}
                    onBlur={() => saveCustom(s())}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} disabled={saving()} />
                  <span class="landing-search-hint">
                    <span class="mono">{"{query}"}</span> is replaced by what was typed: your company wiki, Jira, GitHub code search, anything with a search URL.
                  </span>
                </div>
              </Show>
            </Show>
            <Show when={landing()?.url}>
              {(url) => (
                <div class="landing-start">
                  <div class="landing-start-icon">★</div>
                  <div class="landing-start-text">
                    <b>Make it your browser's start page</b>
                    <span>
                      Set <span class="mono">{url()}</span> as your browser's home page (and in Safari, for new tabs too). It opens with
                      the cursor in the search box, so you can type a service or a search right away.
                    </span>
                  </div>
                  <button class="btn btn-sm" onClick={() => void copy(url())}>Copy address</button>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>

      <div>
        <div style={{ display: "flex", "align-items": "baseline", gap: "12px", "margin-bottom": "10px", "flex-wrap": "wrap" }}>
          <h3 style={{ color: "#e6edf3", "font-size": "14px", "font-weight": "600" }}>On the page</h3>
          <span style={muted}>
            Routes you added here are edited here. Others take their title, description, group and icon from where they come from:{" "}
            <span class="mono">title:</span> in orca.yaml or <span class="mono">orca.route.title</span> labels.{" "}
            <button class="btn-link" style={{ color: "#58a6ff", background: "none", border: "none", cursor: "pointer", padding: "0", "font-size": "12px" }}
              onClick={() => openUrl(REFERENCE)}>How</button>
          </span>
        </div>
        <Show when={groups().length > 0} fallback={<div style={muted}>No routes yet. Add one on the Routes tab and it appears here.</div>}>
          <For each={groups()}>
            {([name, routes]) => (
              <div style={{ "margin-bottom": "16px" }}>
                <div style={{ "font-size": "11px", "font-weight": "700", color: "#8b949e", "text-transform": "uppercase", "letter-spacing": "0.08em", "margin-bottom": "6px" }}>{name}</div>
                <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                  <For each={routes}>
                    {(r) => {
                      const source = managedBy(r);
                      const hidden = () => !!r.presentation?.hidden;
                      return (
                        <div class="card" style={{ display: "flex", "align-items": "center", gap: "12px", padding: "10px 14px", opacity: hidden() ? 0.55 : 1 }}>
                          <div style={{ flex: "1", "min-width": "0" }}>
                            <div style={{ color: "#e6edf3", "font-size": "13px", "font-weight": "600" }}>
                              {titleOf(r)}
                              <Show when={hidden()}><span style={{ ...muted, "font-weight": "400", "margin-left": "8px" }}>Hidden from the page</span></Show>
                            </div>
                            <Show when={r.presentation?.description}><div style={{ color: "#a8b3bf", "font-size": "12px", "margin-top": "2px" }}>{r.presentation!.description}</div></Show>
                            <div class="mono" style={{ color: "#58a6ff", "font-size": "11.5px", "margin-top": "3px", "word-break": "break-all" }}>{r.hostname}{r.path ?? ""}</div>
                          </div>
                          <Show when={source} fallback={
                            <>
                              <button class="btn btn-sm" onClick={() => void setHidden(r, !hidden())}>{hidden() ? "Show" : "Hide"}</button>
                              <button class="btn btn-sm" onClick={() => props.onEditRoute(r)}>Edit</button>
                            </>
                          }>
                            <span style={{ ...muted, "max-width": "240px", "text-align": "right" }}>Change in {source}</span>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
