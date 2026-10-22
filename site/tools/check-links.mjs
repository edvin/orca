// Checks every internal link and #anchor in the built site.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs");
const pages = new Map();
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".html")) pages.set("/" + path.relative(OUT, p).replace(/index\.html$/, ""), fs.readFileSync(p, "utf8")); } };
walk(OUT);
const ids = new Map([...pages].map(([u, h]) => [u, new Set([...h.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]));
let bad = 0;
for (const [u, html] of pages) {
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    let href = m[1];
    if (/^(https?:|mailto:|data:)/.test(href)) continue;
    let [p, hash] = href.split("#");
    if (!p) p = u;
    if (!p.startsWith("/")) continue;
    if (/\.(css|js|png|webp|json|xml|txt|sh|md|woff2)(\?|$)/.test(p)) { if (!fs.existsSync(path.join(OUT, p.split("?")[0]))) { console.log(`${u}: missing file ${href}`); bad++; } continue; }
    const target = p.endsWith("/") ? p : p + "/";
    if (!pages.has(target) && !pages.has(p)) { console.log(`${u}: broken ${href}`); bad++; continue; }
    if (hash && !ids.get(pages.has(target) ? target : p)?.has(decodeURIComponent(hash))) { console.log(`${u}: missing anchor ${href}`); bad++; }
  }
  for (const m of html.matchAll(/src="(\/[^"]+)"/g)) if (!fs.existsSync(path.join(OUT, m[1].split("?")[0]))) { console.log(`${u}: missing image ${m[1]}`); bad++; }
}
console.log(bad ? `${bad} problems` : "all links ok");
