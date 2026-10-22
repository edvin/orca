// The orca.yaml editor's smaller sections: links, setup hooks and build
// targets. Rows use <Index> so typing in a field keeps its focus while the
// file is rewritten underneath.

import { Index, Show } from "solid-js";
import Dropdown from "../Dropdown";
import type { BuildM, HookM, LinkGroupM, LinkM } from "./model";
import type { StudioService } from "./RoutesSection";

const label = { "font-size": "11px", color: "#8b949e", "margin-bottom": "4px", display: "block" } as const;
const intro = { color: "#8b949e", "font-size": "13px", "line-height": "1.5" } as const;
const linkBtn = { color: "#58a6ff", background: "none", border: "none", cursor: "pointer", padding: "0", "font-size": "12px" } as const;

function RemoveButton(props: { title: string; onClick: () => void }) {
  return (
    <button class="action-icon action-icon-delete" title={props.title} style={{ color: "#f85149" }} onClick={() => props.onClick()}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  );
}

const replaceAt = <T,>(list: T[], i: number, item: T) => list.map((x, j) => (j === i ? item : x));
const removeAt = <T,>(list: T[], i: number) => list.filter((_, j) => j !== i);

export function LinksSection(props: { groups: LinkGroupM[]; projectName: string; onChange: (groups: LinkGroupM[]) => void }) {
  const setGroup = (gi: number, g: LinkGroupM) => props.onChange(replaceAt(props.groups, gi, g));
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
      <p style={intro}>
        Links to this project in each environment, on the Gateway page and the landing page, one tab per environment.{" "}
        <span class="mono">local</span> takes a gateway hostname, with a path if you like (<span class="mono">shop/admin</span>); other
        environments take full URLs.
      </p>
      <Index each={props.groups}>
        {(g, gi) => (
          <div class="card" style={{ padding: "12px 14px", display: "flex", "flex-direction": "column", gap: "10px" }}>
            <div style={{ display: "flex", gap: "10px", "align-items": "end" }}>
              <label style={{ flex: "1", "max-width": "320px" }}>
                <span style={label}>Group</span>
                <input class="form-input" value={g().group} onInput={(e) => setGroup(gi, { ...g(), group: e.currentTarget.value })} />
              </label>
              <span style={{ flex: "1" }} />
              <button class="btn btn-sm" onClick={() => props.onChange(removeAt(props.groups, gi))}>Remove group</button>
            </div>
            <Index each={g().links}>
              {(l, li) => {
                const setLink = (patch: Partial<LinkM>) =>
                  setGroup(gi, { ...g(), links: replaceAt(g().links, li, { ...l(), ...patch }) });
                return (
                  <div style={{ display: "flex", "flex-direction": "column", gap: "6px", "padding-top": "10px", "border-top": "1px solid #21262d" }}>
                    <div style={{ display: "flex", gap: "10px", "align-items": "end" }}>
                      <label style={{ flex: "1", "max-width": "320px" }}>
                        <span style={label}>Name</span>
                        <input class="form-input" value={l().name} placeholder="Storefront" onInput={(e) => setLink({ name: e.currentTarget.value })} />
                      </label>
                      <span style={{ flex: "1" }} />
                      <RemoveButton title="Remove link" onClick={() => setGroup(gi, { ...g(), links: removeAt(g().links, li) })} />
                    </div>
                    <Index each={l().urls}>
                      {(u, ui) => (
                        <div style={{ display: "grid", "grid-template-columns": "140px 1fr auto", gap: "8px", "align-items": "center" }}>
                          <input class="form-input" value={u()[0]} placeholder="staging" aria-label="Environment"
                            onInput={(e) => setLink({ urls: replaceAt(l().urls, ui, [e.currentTarget.value, u()[1]]) })} />
                          <input class="form-input mono" value={u()[1]} aria-label="URL"
                            placeholder={u()[0] === "local" ? `${props.projectName.toLowerCase()}/admin` : `https://${u()[0] || "staging"}.example.com`}
                            onInput={(e) => setLink({ urls: replaceAt(l().urls, ui, [u()[0], e.currentTarget.value]) })} />
                          <RemoveButton title="Remove environment" onClick={() => setLink({ urls: removeAt(l().urls, ui) })} />
                        </div>
                      )}
                    </Index>
                    <div>
                      <button style={linkBtn} onClick={() => {
                        const used = new Set(l().urls.map(([k]) => k));
                        const next = ["local", "staging", "production"].find((k) => !used.has(k)) ?? "";
                        setLink({ urls: [...l().urls, [next, ""]] });
                      }}>+ Environment</button>
                    </div>
                  </div>
                );
              }}
            </Index>
            <div>
              <button class="btn btn-sm" onClick={() => setGroup(gi, { ...g(), links: [...g().links, { name: "", urls: [["local", ""]] }] })}>+ Link</button>
            </div>
          </div>
        )}
      </Index>
      <div>
        <button class="btn btn-sm" onClick={() => props.onChange([...props.groups, { group: props.projectName, links: [{ name: "", urls: [["local", ""]] }] }])}>
          + Link group
        </button>
      </div>
    </div>
  );
}

export function HooksSection(props: { hooks: HookM[]; services: StudioService[]; onChange: (hooks: HookM[]) => void }) {
  const options = () => props.services.map((s) => ({ value: s.name, label: s.name }));
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
      <p style={intro}>
        Commands run inside a service's container after every start from Orca, in order, with <span class="mono">sh -c</span>. They run on
        every start, so make them safe to repeat: <span class="mono">--force</span>, <span class="mono">|| true</span>, <span class="mono">IF NOT EXISTS</span>.
      </p>
      <Index each={props.hooks}>
        {(h, i) => (
          <div style={{ display: "grid", "grid-template-columns": "180px 1fr auto", gap: "8px", "align-items": "center" }}>
            <Dropdown value={h().service} placeholder="Service"
              options={[...options(), ...(h().service && !props.services.some((s) => s.name === h().service) ? [{ value: h().service, label: `${h().service} (not running)` }] : [])]}
              onChange={(v) => props.onChange(replaceAt(props.hooks, i, { ...h(), service: v }))} />
            <input class="form-input mono" value={h().command} placeholder="php artisan migrate --force"
              onInput={(e) => props.onChange(replaceAt(props.hooks, i, { ...h(), command: e.currentTarget.value }))} />
            <RemoveButton title="Remove command" onClick={() => props.onChange(removeAt(props.hooks, i))} />
          </div>
        )}
      </Index>
      <div>
        <button class="btn btn-sm" onClick={() => props.onChange([...props.hooks, { service: props.services[0]?.name ?? "", command: "" }])}>+ Command</button>
      </div>
    </div>
  );
}

export function BuildsSection(props: { builds: BuildM[]; services: StudioService[]; onChange: (builds: BuildM[]) => void }) {
  const set = (i: number, b: BuildM) => props.onChange(replaceAt(props.builds, i, b));
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
      <p style={intro}>Images to build from this project, on the Builds page. Paths are relative to the folder with orca.yaml.</p>
      <Index each={props.builds}>
        {(b, i) => (
          <div class="card" style={{ padding: "12px 14px", display: "flex", "flex-direction": "column", gap: "10px" }}>
            <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(150px, 1fr)) auto", gap: "10px", "align-items": "end" }}>
              <label><span style={label}>Name</span>
                <input class="form-input" value={b().name} placeholder="web" onInput={(e) => set(i, { ...b(), name: e.currentTarget.value })} /></label>
              <label><span style={label}>Context</span>
                <input class="form-input mono" value={b().context} placeholder="./web" onInput={(e) => set(i, { ...b(), context: e.currentTarget.value })} /></label>
              <label><span style={label}>Dockerfile</span>
                <input class="form-input mono" value={b().dockerfile} placeholder="Dockerfile" onInput={(e) => set(i, { ...b(), dockerfile: e.currentTarget.value })} /></label>
              <label><span style={label}>Tag</span>
                <input class="form-input mono" value={b().tag} placeholder="shop-web:dev" onInput={(e) => set(i, { ...b(), tag: e.currentTarget.value })} /></label>
              <RemoveButton title="Remove build" onClick={() => props.onChange(removeAt(props.builds, i))} />
            </div>
            <Show when={b().args.length > 0}>
              <span style={{ ...label, "margin-bottom": "0" }}>Build args</span>
            </Show>
            <Index each={b().args}>
              {(a, ai) => (
                <div style={{ display: "grid", "grid-template-columns": "200px 1fr auto", gap: "8px", "align-items": "center" }}>
                  <input class="form-input mono" value={a()[0]} placeholder="NODE_VERSION" aria-label="Arg name"
                    onInput={(e) => set(i, { ...b(), args: replaceAt(b().args, ai, [e.currentTarget.value, a()[1]]) })} />
                  <input class="form-input mono" value={a()[1]} placeholder="22" aria-label="Arg value"
                    onInput={(e) => set(i, { ...b(), args: replaceAt(b().args, ai, [a()[0], e.currentTarget.value]) })} />
                  <RemoveButton title="Remove arg" onClick={() => set(i, { ...b(), args: removeAt(b().args, ai) })} />
                </div>
              )}
            </Index>
            <div><button style={linkBtn} onClick={() => set(i, { ...b(), args: [...b().args, ["", ""]] })}>+ Build arg</button></div>
          </div>
        )}
      </Index>
      <div>
        <button class="btn btn-sm" onClick={() => {
          const s = props.services[0]?.name ?? "app";
          props.onChange([...props.builds, { name: s, context: ".", dockerfile: "", tag: `${s}:dev`, args: [] }]);
        }}>+ Build target</button>
      </div>
    </div>
  );
}
