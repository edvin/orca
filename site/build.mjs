// Builds orca-desktop.com into ../docs (served by GitHub Pages).
//
//   node build.mjs            build once
//   node build.mjs --watch    rebuild on changes
//
// Pages: the landing page and download page are HTML templates in src/;
// docs are Markdown in content/docs/ (plus a few files shared with the repo's
// own docs/ folder, so GitHub and the site read the same text).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";
import { createHighlighter } from "shiki";
import YAML from "yaml";
import { NAV, SHARED_DOCS } from "./src/nav.mjs";
import { layout, docPage } from "./src/layout.mjs";
import { homePage } from "./src/home.mjs";
import { downloadPage } from "./src/download.mjs";
import { workspacesPage } from "./src/workspaces.mjs";
import { changelogPage } from "./src/changelog.mjs";
import { notFoundPage } from "./src/notfound.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");
const OUT = path.join(REPO, "docs");
const SITE = "https://orca-desktop.com";

// --- Markdown ----------------------------------------------------------------

const highlighter = await createHighlighter({
  themes: ["github-dark-default", "github-light-default"],
  langs: ["bash", "shell", "yaml", "json", "toml", "text", "ts", "js", "rust", "dockerfile", "dotenv", "ini", "html", "powershell"],
});

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const decodeEntities = (s) =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export const slugify = (s) =>
  decodeEntities(String(s).replace(/<[^>]+>/g, ""))
    .toLowerCase()
    .replace(/[`'"’.,:;!?()[\]{}/\\*+=]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

export function highlight(code, lang) {
  const known = highlighter.getLoadedLanguages();
  const l = lang === "sh" || lang === "console" ? "bash" : lang === "yml" ? "yaml" : lang;
  return highlighter.codeToHtml(code, {
    lang: known.includes(l) ? l : "text",
    themes: { light: "github-light-default", dark: "github-dark-default" },
    defaultColor: false,
  });
}

/** A code block with an optional file tab and a copy button. */
export function codeBlock(code, lang = "text", title = "") {
  const label = title || (["bash", "shell", "sh", "powershell"].includes(lang) ? "Terminal" : "");
  return `<div class="code${label ? " has-title" : ""}">${
    label ? `<div class="code-title"><span>${escapeHtml(label)}</span></div>` : ""
  }<button class="copy" type="button" aria-label="Copy code"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>${highlight(
    code.replace(/\n$/, ""),
    lang,
  )}</div>`;
}

const CALLOUT_ICONS = {
  NOTE: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  TIP: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z"/></svg>',
  WARNING: '<svg viewBox="0 0 24 24"><path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/></svg>',
  IMPORTANT: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16h.01"/></svg>',
  CAUTION: '<svg viewBox="0 0 24 24"><path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/></svg>',
};

function markdown(src, { rewriteLink } = {}) {
  const headings = [];
  const used = new Map();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        let id = slugify(html);
        const n = used.get(id) ?? 0;
        used.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        if (depth === 2 || depth === 3) headings.push({ depth, id, text: decodeEntities(html.replace(/<[^>]+>/g, "")) });
        if (depth === 1) return "";
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${html}</h${depth}>\n`;
      },
      code({ text, lang = "" }) {
        const [language, ...rest] = (lang || "text").split(/\s+/);
        const title = /title="([^"]+)"/.exec(rest.join(" "))?.[1] ?? "";
        return codeBlock(text, language, title);
      },
      blockquote({ tokens }) {
        const first = tokens[0];
        const m = first?.type === "paragraph" && /^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*/.exec(first.raw);
        if (!m) return `<blockquote>${this.parser.parse(tokens)}</blockquote>`;
        const kind = m[1];
        const body = this.parser.parse(tokens).replace(/^<p>\s*\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*/, "<p>");
        const label = { NOTE: "Note", TIP: "Tip", WARNING: "Warning", IMPORTANT: "Important", CAUTION: "Caution" }[kind];
        return `<div class="callout callout-${kind.toLowerCase()}"><div class="callout-head">${CALLOUT_ICONS[kind]}<span>${label}</span></div>${body}</div>`;
      },
      table(token) {
        // Wrapped so wide tables scroll instead of the page.
        let header = "<tr>" + token.header.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</th>`).join("") + "</tr>";
        let body = token.rows
          .map((row) => "<tr>" + row.map((c) => `<td${c.align ? ` style="text-align:${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</td>`).join("") + "</tr>")
          .join("");
        return `<div class="table-wrap"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
      },
      image({ href, title, text }) {
        return `<figure class="shot"><img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy" decoding="async">${
          title ? `<figcaption>${escapeHtml(title)}</figcaption>` : ""
        }</figure>`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const target = rewriteLink ? rewriteLink(href) : href;
        const external = /^https?:\/\//.test(target) && !target.startsWith(SITE);
        return `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ""}${
          external ? ' target="_blank" rel="noopener"' : ""
        }>${text}</a>`;
      },
    },
  });
  const html = marked.parse(src);
  return { html, headings };
}

function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  // Simple `key: value` lines, so values may contain colons unquoted.
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([\w-]+):\s*(.*?)(\s+#.*)?$/.exec(line);
    if (!kv) continue;
    let v = kv[2];
    if (/^["'].*["']$/.test(v)) v = YAML.parse(v);
    data[kv[1]] = v;
  }
  return { data, body: text.slice(m[0].length) };
}

/** Links between the repo's own Markdown docs become site links. */
function repoLinkRewriter(href) {
  const map = Object.fromEntries(SHARED_DOCS.map((d) => [d.file, `/docs/${d.slug}/`]));
  const [file, hash] = href.split("#");
  if (map[file]) return map[file] + (hash ? `#${hash}` : "");
  if (/^[\w./-]+\.md$/.test(file) && !file.startsWith("http")) return `https://github.com/edvin/orca/blob/main/docs/${file}`;
  return href;
}

// --- Pages -------------------------------------------------------------------

function loadDocs() {
  const docs = [];
  for (const section of NAV) {
    for (const item of section.items) {
      const shared = SHARED_DOCS.find((d) => d.slug === item);
      const file = shared ? path.join(REPO, "docs", shared.file) : path.join(ROOT, "content/docs", `${item}.md`);
      if (!fs.existsSync(file)) {
        console.warn(`  missing doc: ${item}`);
        continue;
      }
      let { data, body } = frontMatter(fs.readFileSync(file, "utf8"));
      if (shared) {
        // The repo file's H1 is the title; its first paragraph the description.
        const h1 = /^#\s+(.+)$/m.exec(body);
        data = { title: shared.title ?? h1?.[1], nav: shared.nav, description: shared.description, ...data };
      }
      const { html, headings } = markdown(body, { rewriteLink: shared ? repoLinkRewriter : undefined });
      docs.push({
        slug: item,
        section: section.title,
        title: data.title ?? item,
        nav: data.nav ?? data.title ?? item,
        description: data.description ?? "",
        html,
        headings,
        source: shared ? `docs/${shared.file}` : `site/content/docs/${item}.md`,
        text: body,
      });
    }
  }
  return docs;
}

function write(rel, html) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

/** Plain text of a doc's sections, for the search index. */
function searchEntries(doc) {
  const out = [];
  const parts = doc.text.split(/^(?=##+\s)/m);
  for (const part of parts) {
    const m = /^(##+)\s+(.+)$/m.exec(part);
    const heading = m ? m[2].replace(/`/g, "") : "";
    const text = part
      .replace(/^---[\s\S]*?---/, "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^#+\s+.*$/gm, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_>|#-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    out.push({
      t: doc.title,
      h: heading,
      u: `/docs/${doc.slug}/${heading ? `#${slugify(heading)}` : ""}`,
      s: doc.section,
      x: text.slice(0, 600),
    });
  }
  return out;
}

/** GitHub's API through the `gh` CLI when it's signed in (no rate limit), else anonymously. */
async function githubApi(endpoint, params = {}, { anonymous = false } = {}) {
  try {
    if (anonymous) throw new Error("anonymous");
    const { execFileSync } = await import("node:child_process");
    const args = ["api", "-X", "GET", endpoint, ...Object.entries(params).flatMap(([k, v]) => ["-f", `${k}=${v}`])];
    return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 }));
  } catch {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`https://api.github.com/${endpoint}${qs ? `?${qs}` : ""}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "orca-site-build" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

async function fetchReleases() {
  try {
    // The API now and then answers with an empty list; that's never true here.
    let list = await githubApi("repos/edvin/orca/releases", { per_page: 15 });
    if (!list?.length) list = await githubApi("repos/edvin/orca/releases", { per_page: 15 }, { anonymous: true });
    if (!list?.length) throw new Error("empty release list");
    return list
      .filter((r) => !r.draft)
      .map((r) => ({
        tag: r.tag_name,
        name: r.name,
        date: r.published_at,
        url: r.html_url,
        html: markdown((r.body ?? "").replace(/\r\n/g, "\n")).html,
        assets: (r.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
      }));
  } catch (e) {
    console.warn(`  could not fetch releases (${e.message}); using the cached copy`);
    const cache = path.join(ROOT, ".releases-cache.json");
    return fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, "utf8")) : [];
  }
}

async function fetchStars() {
  try {
    const n = (await githubApi("repos/edvin/orca")).stargazers_count;
    return typeof n === "number" ? (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)) : null;
  } catch {
    return null;
  }
}

async function build() {
  const t0 = Date.now();
  const docs = loadDocs();
  const releases = await fetchReleases();
  if (releases.length) fs.writeFileSync(path.join(ROOT, ".releases-cache.json"), JSON.stringify(releases));
  const latest = releases[0];
  const stars = await fetchStars();
  const version = Date.now().toString(36);
  const ctx = { docs, releases, latest, stars, version, codeBlock, highlight, SITE };

  // Assets
  copyDir(path.join(ROOT, "assets"), path.join(OUT, "assets"));
  const fonts = path.join(OUT, "assets/fonts");
  fs.mkdirSync(fonts, { recursive: true });
  for (const [pkg, file] of [
    ["inter", "inter-latin-wght-normal.woff2"],
    ["jetbrains-mono", "jetbrains-mono-latin-wght-normal.woff2"],
  ]) {
    fs.copyFileSync(path.join(ROOT, "node_modules/@fontsource-variable", pkg, "files", file), path.join(fonts, file));
  }

  write("index.html", layout(ctx, { path: "/", title: "Orca — the open source container platform for local development", description: "Free, open source desktop app for Docker containers, compose stacks and Kubernetes, with HTTPS hostnames for every service, a running copy of your app per git worktree, and APIs for AI agents.", body: homePage(ctx), page: "home" }));
  write("workspaces/index.html", layout(ctx, { path: "/workspaces/", title: "Workspaces: your team's local setup in one repo", description: "One repo sets up a team's whole local environment: shared services, your domain and certificate, and every project with its setup steps and secrets. One link to join, one click (or one sentence to Claude) per project.", body: workspacesPage(ctx), page: "workspaces" }));
  write("download/index.html", layout(ctx, { path: "/download/", title: "Download Orca", description: "Download Orca Desktop for macOS, Windows and Linux, or install the Orca daemon on a Linux server.", body: downloadPage(ctx), page: "download" }));
  write("changelog/index.html", layout(ctx, { path: "/changelog/", title: "Changelog — Orca", description: "What's new in each Orca Desktop release.", body: changelogPage(ctx), page: "changelog" }));
  write("404.html", layout(ctx, { path: "/404.html", title: "Page not found — Orca", description: "", body: notFoundPage(ctx), page: "404" }));

  docs.forEach((doc, i) => {
    write(
      `docs/${doc.slug}/index.html`,
      layout(ctx, {
        path: `/docs/${doc.slug}/`,
        title: `${doc.title} — Orca docs`,
        description: doc.description,
        body: docPage(ctx, doc, docs[i - 1], docs[i + 1]),
        page: "docs",
      }),
    );
  });
  // /docs/ itself goes to the introduction.
  write("docs/index.html", layout(ctx, { path: "/docs/", title: "Orca docs", description: "Documentation for Orca Desktop.", body: docPage(ctx, docs[0], null, docs[1]), page: "docs", canonical: `/docs/${docs[0].slug}/` }));

  write("assets/search.json", JSON.stringify(docs.flatMap(searchEntries)));

  const urls = ["/", "/workspaces/", "/download/", "/changelog/", ...docs.map((d) => `/docs/${d.slug}/`)];
  write(
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${SITE}${u}</loc></url>`)
      .join("\n")}\n</urlset>\n`,
  );
  write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
  write(".nojekyll", "");
  console.log(`built ${docs.length} docs pages in ${Date.now() - t0} ms (latest ${latest?.tag ?? "none"}, ${latest?.assets?.length ?? 0} assets, ${stars ?? "?"} stars)`);
}

await build();

if (process.argv.includes("--watch")) {
  let timer;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        // Content and CSS rebuild live; template (src/*.mjs) edits need a restart.
        await build();
      } catch (e) {
        console.error(e);
      }
    }, 150);
  };
  for (const dir of ["content", "assets", "src"]) fs.watch(path.join(ROOT, dir), { recursive: true }, rebuild);
  fs.watch(path.join(REPO, "docs"), (_, f) => f?.endsWith(".md") && rebuild());
  console.log("watching…");
}
