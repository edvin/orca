// Runs the app's GUI in a browser against a real daemon: Tauri's invoke()
// becomes the daemon REST call the Tauri command would make. The table is
// read from src-tauri/src/commands.rs each time, so it follows the app as it
// changes; commands it can't map fail loudly (see `unknown` in the page).

import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** { command: { method, path: [literal | {arg}], text?, body? } } */
export function commandTable() {
  const src = fs.readFileSync(path.join(REPO, "src-tauri/src/commands.rs"), "utf8");
  const table = {};
  for (const part of src.split("#[tauri::command]").slice(1)) {
    const sig = part.match(/pub (?:async )?fn ([a-z_0-9]+)\s*\(([^)]*)\)/);
    if (!sig) continue;
    const [, name, params] = sig;
    const argNames = splitArgs(params)
      .map((p) => p.split(":")[0].trim())
      .filter((a) => a && !["app", "state", "window", "app_handle"].includes(a));
    const body = part.slice(part.indexOf("{"), part.indexOf("\n}\n") + 2);

    // A format!("…{}…", a, b) or "…" path: literal pieces and argument names.
    const parsePath = (expr) => {
      const fm = expr.match(/^format!\(\s*"([^"]*)"\s*((?:,[^;]*?)?)\)$/s);
      const lit = expr.match(/^"([^"]*)"$/);
      if (!fm && !lit) return null;
      const tpl = fm ? fm[1] : lit[1];
      const positional = fm ? splitArgs(fm[2]).map(argOf) : [];
      const out = [];
      let i = 0;
      for (const piece of tpl.split(/(\{[a-z_0-9]*\})/)) {
        if (!piece) continue;
        const ph = piece.match(/^\{([a-z_0-9]*)\}$/);
        if (!ph) out.push(piece);
        else if (ph[1] === "base") continue;
        else out.push({ arg: camel(ph[1] || positional[i++] || "?") });
      }
      return out;
    };

    let m;
    if ((m = body.match(/^\{\s*(get_json|post_json|post_empty|delete|get_text)(?:::<[^>]*>)?\(\s*(&?format!\([\s\S]*?\)|&?"[^"]*")\s*\)/))) {
      const p = parsePath(m[2].replace(/^&/, ""));
      if (p) table[name] = { method: m[1].startsWith("get") ? "GET" : m[1] === "delete" ? "DELETE" : "POST", path: p, text: m[1] === "get_text" };
    } else if ((m = body.match(/^\{\s*patch_json\(\s*(&?format!\([\s\S]*?\)|&?"[^"]*")\s*,/))) {
      const p = parsePath(m[1].replace(/^&/, ""));
      if (p) table[name] = { method: "PATCH", path: p, body: argNames.filter((a) => !p.some((x) => x.arg === camel(a))) };
    } else if ((m = body.match(/daemon_call\(\s*"([A-Z]+)"\s*,\s*(&?format!\([\s\S]*?\)|&?"[^"]*")\s*,\s*(None|Some)/))) {
      const p = parsePath(m[2].replace(/^&/, ""));
      const used = new Set((p ?? []).filter((x) => typeof x !== "string").map((x) => x.arg));
      if (p) table[name] = { method: m[1], path: p, body: m[3] === "Some" ? argNames.filter((a) => !used.has(camel(a))) : null };
    } else if (/daemon_call\(\s*&method\s*,\s*&path\s*,\s*body\s*\)/.test(body)) {
      table[name] = { generic: true };
    } else if ((m = body.match(/\.(get|post|put|patch|delete)\(\s*(format!\("\{base\}[\s\S]*?\))\s*\)/))) {
      const p = parsePath(m[2]);
      if (p) {
        const used = new Set(p.filter((x) => typeof x !== "string").map((x) => x.arg));
        table[name] = { method: m[1].toUpperCase(), path: p, body: /\.json\(/.test(body) ? argNames.filter((a) => !used.has(camel(a))) : null };
      }
    }
  }
  return table;
}

function splitArgs(s) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s.replace(/^\s*,/, "")) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) out.push(cur.trim()), (cur = "");
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
// urlencoding::encode(&name) -> name; id -> id; args.x.y -> x
const argOf = (expr) => (expr.match(/&?([a-z_][a-z_0-9]*)\)*\s*$/) || expr.match(/([a-z_][a-z_0-9]*)/) || [])[1];

/** The init script for the page: invoke() -> fetch(). */
export function bridgeScript({ token, table, extra = {} }) {
  return `(() => {
  const TABLE = ${JSON.stringify(table)};
  const TOKEN = ${JSON.stringify(token)};
  const API = "/api/v1";
  const EXTRA = {${Object.entries(extra).map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(",\n")}};
  window.__orcaUnknown = [];
  const call = async (method, path, body, text) => {
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: "Bearer " + TOKEN, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    let j = null;
    try { j = t ? JSON.parse(t) : null; } catch {}
    if (!r.ok) throw (j && (j.error || j.message)) || t || ("HTTP " + r.status);
    return text ? t : j;
  };
  const snake = (k) => k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
  const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  let cbId = 0;
  window.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => { const id = ++cbId; window["_" + id] = cb; return id; },
    unregisterCallback: () => {},
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    convertFileSrc: (p) => p,
    invoke: async (cmd, args = {}) => {
      if (EXTRA[cmd]) return EXTRA[cmd](args, call);
      if (cmd.startsWith("plugin:")) return null;
      const e = TABLE[cmd];
      if (!e) { window.__orcaUnknown.push(cmd); console.warn("[bridge] unknown command", cmd, args); throw "not in the browser bridge: " + cmd; }
      if (e.generic) return call(args.method, args.path, args.body ?? undefined);
      const path = e.path.map((p) => typeof p === "string" ? p : encodeURIComponent(args[p.arg] ?? "")).join("");
      let body;
      if (e.body) { body = {}; for (const a of e.body) if (args[camel(a)] !== undefined) body[a] = args[camel(a)]; }
      return call(e.method, path, body, e.text);
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
})();`;
}
