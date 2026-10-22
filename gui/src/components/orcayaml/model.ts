// orca.yaml as the editor's form sees it, read from and written back into
// a YAML document so comments, `dev:` and anything the form doesn't know
// survive an edit. Each form edit rewrites only the section it touches.

import { parseDocument, isMap, isScalar, isSeq } from "yaml";
import type { Document, YAMLMap } from "yaml";

export interface RouteM {
  hostname: string;
  service: string;
  port: number | null;
  path?: string;
  title?: string;
  description?: string;
  group?: string;
  icon?: string;
  hidden?: boolean;
}

export interface LinkM {
  name: string;
  /** Environment → URL, in the file's order. */
  urls: [string, string][];
}

export interface LinkGroupM {
  group: string;
  links: LinkM[];
}

export interface HookM {
  service: string;
  command: string;
}

export interface BuildM {
  name: string;
  context: string;
  dockerfile: string;
  tag: string;
  args: [string, string][];
}

export interface Model {
  routes: RouteM[];
  links: LinkGroupM[];
  hooks: HookM[];
  builds: BuildM[];
  hasDev: boolean;
}

/** The form's view of `text`, or the YAML error that keeps the form closed. */
export function read(text: string): { model: Model } | { error: string } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { error: doc.errors[0].message };
  const js = (doc.toJS() ?? {}) as Record<string, unknown>;
  if (typeof js !== "object" || Array.isArray(js)) return { error: "orca.yaml must be a mapping of keys" };
  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
  const routes: RouteM[] = (Array.isArray(js.gateway) ? js.gateway : [])
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      hostname: str(r.hostname) ?? "",
      service: str(r.service) ?? "",
      port: r.port === undefined || r.port === null || r.port === "" ? null : Number(r.port),
      path: str(r.path),
      title: str(r.title),
      description: str(r.description),
      group: str(r.group),
      icon: str(r.icon),
      hidden: r.hidden === true,
    }));
  const links: LinkGroupM[] =
    js.links && typeof js.links === "object" && !Array.isArray(js.links)
      ? Object.entries(js.links as Record<string, unknown>).map(([group, items]) => ({
          group,
          links: (Array.isArray(items) ? items : [])
            .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
            .map((l) => ({
              name: str(l.name) ?? "",
              urls: Object.entries(l)
                .filter(([k]) => k !== "name")
                .map(([k, v]) => [k, str(v) ?? ""] as [string, string]),
            })),
        }))
      : [];
  const hooksJs = js.hooks as { after_up?: unknown } | undefined;
  const hooks: HookM[] = (Array.isArray(hooksJs?.after_up) ? hooksJs!.after_up : []).map((h: unknown) => {
    const s = String(h ?? "");
    const i = s.indexOf(":");
    return i < 0 ? { service: "", command: s.trim() } : { service: s.slice(0, i).trim(), command: s.slice(i + 1).trim() };
  });
  const builds: BuildM[] = (Array.isArray(js.builds) ? js.builds : [])
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
    .map((b) => ({
      name: str(b.name) ?? "",
      context: str(b.context) ?? "",
      dockerfile: str(b.dockerfile) ?? "",
      tag: str(b.tag) ?? "",
      args:
        b.args && typeof b.args === "object"
          ? Object.entries(b.args as Record<string, unknown>).map(([k, v]) => [k, str(v) ?? ""] as [string, string])
          : [],
    }));
  return { model: { routes, links, hooks, builds, hasDev: js.dev !== undefined && js.dev !== null } };
}

type Section = "gateway" | "links" | "hooks" | "builds";

/** `text` with one section set to the form's value (removed when empty). */
export function write(text: string, section: Section, model: Model): string {
  const doc = parseDocument(text);
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
  const root = doc.contents as YAMLMap;
  // Hooks: after_up is the one the form edits; other hook kinds stay.
  const [parent, key, value] =
    section === "hooks" && isMap(root.get("hooks"))
      ? [root.get("hooks") as YAMLMap, "after_up", (sectionValue(section, model) as { after_up?: string[] } | undefined)?.after_up]
      : [root, section, sectionValue(section, model)];
  if (value === undefined) {
    parent.delete(key);
    if (parent !== root && parent.items.length === 0) root.delete(section);
  } else parent.set(key, merge(doc, parent.get(key, true), value));
  const out = doc.toString();
  return out === "{}\n" ? "" : out;
}

/** `value` as a node, reusing `node` where it has the same shape so the
 *  comments on entries that stay keep their place. */
function merge(doc: Document, node: unknown, value: unknown): unknown {
  if (Array.isArray(value) && isSeq(node)) {
    node.items = value.map((v, i) => merge(doc, node.items[i], v)) as typeof node.items;
    return node;
  }
  if (value && typeof value === "object" && !Array.isArray(value) && isMap(node)) {
    const entries = Object.entries(value);
    for (const pair of [...node.items]) {
      const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      if (!entries.some(([e]) => e === k)) node.delete(pair.key);
    }
    for (const [k, v] of entries) node.set(k, merge(doc, node.get(k, true), v));
    return node;
  }
  // `22` read as "22" by the form stays `22`.
  if (isScalar(node) && !(value && typeof value === "object") && String(node.value) === String(value)) return node;
  return doc.createNode(value);
}

function sectionValue(section: Section, m: Model): unknown {
  const clean = <T extends object>(o: T) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false));
  switch (section) {
    case "gateway":
      return m.routes.length === 0
        ? undefined
        : m.routes.map((r) =>
            clean({
              hostname: r.hostname,
              service: r.service,
              port: r.port ?? undefined,
              path: r.path,
              title: r.title,
              description: r.description,
              group: r.group,
              icon: r.icon,
              hidden: r.hidden,
            }),
          );
    case "links":
      return m.links.length === 0
        ? undefined
        : Object.fromEntries(
            m.links.map((g) => [
              g.group || "Links",
              g.links.map((l) => ({ name: l.name, ...Object.fromEntries(l.urls.filter(([k, v]) => k && v)) })),
            ]),
          );
    case "hooks":
      return m.hooks.length === 0 ? undefined : { after_up: m.hooks.map((h) => `${h.service}: ${h.command}`) };
    case "builds":
      return m.builds.length === 0
        ? undefined
        : m.builds.map((b) =>
            clean({
              name: b.name,
              context: b.context,
              dockerfile: b.dockerfile && b.dockerfile !== "Dockerfile" ? b.dockerfile : undefined,
              tag: b.tag,
              args: b.args.length ? Object.fromEntries(b.args.filter(([k]) => k)) : undefined,
            }),
          );
  }
}

/** `shop` → `shop.<domain>`; a name with a dot stays as is. */
export function fullHost(host: string, domain: string): string {
  const h = host.trim().replace("{domain}", domain).toLowerCase();
  return !h ? "" : h.includes(".") ? h : `${h}.${domain}`;
}
