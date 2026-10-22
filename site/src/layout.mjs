// The page shell (head, header, footer) and the docs page layout.

import { NAV, TOP_NAV } from "./nav.mjs";

export const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const ICONS = {
  github:
    '<svg viewBox="0 0 24 24" aria-hidden="true" class="fill"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  arrowLeft: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  apple:
    '<svg viewBox="0 0 24 24" aria-hidden="true" class="fill"><path d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9s-2-.9-3.4-.9a5 5 0 0 0-4.2 2.6c-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6s1.8-.8 3.4-.8 2 .8 3.4.8 2.2-1.3 3.1-2.5c1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.7-4.1zM13.9 5c.7-.9 1.2-2 1-3.2-1 0-2.2.7-3 1.6-.6.7-1.2 1.9-1 3.1 1.1.1 2.3-.6 3-1.5z"/></svg>',
  windows:
    '<svg viewBox="0 0 24 24" aria-hidden="true" class="fill"><path d="M3 5.5 10.5 4.5v7H3zM11.5 4.3 21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.3z"/></svg>',
  linux:
    '<svg viewBox="0 0 24 24" aria-hidden="true" class="fill"><path d="M12 2c-2.2 0-3.5 1.9-3.5 4.4 0 1.3.3 2.2-.4 3.4-.9 1.5-2.6 3.4-2.6 6.2 0 .6.1 1.1.3 1.5-.8.4-1.8.6-1.8 1.6 0 1.3 2.3 1 3.7 1.9 1 .6 1.7.9 2.6.6.6-.2 1-.6 1.2-1h2.9c.2.4.6.8 1.2 1 .9.3 1.6 0 2.6-.6 1.4-.9 3.7-.6 3.7-1.9 0-1-1-1.2-1.8-1.6.2-.4.3-.9.3-1.5 0-2.8-1.7-4.7-2.6-6.2-.7-1.2-.4-2.1-.4-3.4C15.5 3.9 14.2 2 12 2zm-1.6 4.5c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1zm3.2 0c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1zM12 9.6c.9 0 2 .5 2 .9s-1.1 1.2-2 1.2-2-.8-2-1.2.9-.9 2-.9z"/></svg>',
  server: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>',
  book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M8 7h7"/></svg>',
};

const logo = `<a class="brand" href="/" aria-label="Orca home"><img src="/assets/img/logo-tile.png" alt="" width="28" height="28"><span>Orca</span></a>`;

function header(ctx, current) {
  const links = TOP_NAV.map(
    (l) => `<a href="${l.href}"${current.startsWith(l.match) ? ' aria-current="page"' : ""}>${l.label}</a>`,
  ).join("");
  return `<header class="site-header">
  <div class="header-inner">
    ${logo}
    <nav class="top-nav" aria-label="Main">${links}<a href="https://github.com/edvin/orca" target="_blank" rel="noopener">GitHub</a></nav>
    <div class="header-actions">
      <button class="search-trigger" type="button" data-search-open aria-label="Search the docs">${ICONS.search}<span>Search docs</span><kbd>⌘K</kbd></button>
      <button class="icon-btn theme-toggle" type="button" aria-label="Toggle dark mode"><span class="when-dark">${ICONS.sun}</span><span class="when-light">${ICONS.moon}</span></button>
      <a class="icon-btn gh-btn" href="https://github.com/edvin/orca" target="_blank" rel="noopener" aria-label="Orca on GitHub">${ICONS.github}${
        ctx.stars ? `<span class="gh-stars">${ctx.stars}</span>` : ""
      }</a>
      <a class="btn btn-primary btn-sm header-cta" href="/download/">Download</a>
      <button class="icon-btn menu-btn" type="button" aria-label="Open menu" aria-expanded="false" data-menu-open>${ICONS.menu}</button>
    </div>
  </div>
</header>`;
}

function mobileMenu(ctx) {
  const docLinks = NAV.map(
    (s) =>
      `<div class="mm-section"><div class="mm-title">${esc(s.title)}</div>${s.items
        .map((slug) => {
          const d = ctx.docs.find((x) => x.slug === slug);
          return d ? `<a href="/docs/${slug}/">${esc(d.nav)}</a>` : "";
        })
        .join("")}</div>`,
  ).join("");
  return `<div class="mobile-menu" hidden>
  <div class="mm-head">${logo}<button class="icon-btn" type="button" aria-label="Close menu" data-menu-close>${ICONS.close}</button></div>
  <div class="mm-body">
    <div class="mm-top">${TOP_NAV.map((l) => `<a href="${l.href}">${l.label}</a>`).join("")}<a href="https://github.com/edvin/orca">GitHub</a></div>
    ${docLinks}
  </div>
</div>`;
}

function footer() {
  const col = (title, links) =>
    `<div class="f-col"><div class="f-title">${title}</div>${links
      .map(([l, h]) => `<a href="${h}"${/^https?:/.test(h) ? ' target="_blank" rel="noopener"' : ""}>${l}</a>`)
      .join("")}</div>`;
  return `<footer class="site-footer">
  <div class="footer-inner">
    <div class="f-brand">${logo}<p>The open source container platform for local development. Free, MIT licensed, no telemetry.</p></div>
    ${col("Product", [["Download", "/download/"], ["Changelog", "/changelog/"], ["App Catalog", "/docs/templates/"], ["Releases", "https://github.com/edvin/orca/releases"]])}
    ${col("Docs", [["Quickstart", "/docs/quickstart/"], ["Gateway", "/docs/gateway/"], ["orca.yaml", "/docs/orca-yaml/"], ["Agents & MCP", "/docs/agents/"], ["CLI", "/docs/cli/"]])}
    ${col("Community", [["GitHub", "https://github.com/edvin/orca"], ["Issues", "https://github.com/edvin/orca/issues"], ["Contributing", "https://github.com/edvin/orca/blob/main/CONTRIBUTING.md"], ["Add a template", "https://github.com/edvin/orca/issues/new?template=app-template.yml"]])}
    ${col("Trust", [["Security", "/docs/security/"], ["Privacy", "https://github.com/edvin/orca/blob/main/PRIVACY.md"], ["License (MIT)", "https://github.com/edvin/orca/blob/main/LICENSE"]])}
  </div>
  <div class="footer-bottom"><span>© ${new Date().getFullYear()} Orca contributors</span><span>Packages hosted by <a href="https://cloudsmith.com" target="_blank" rel="noopener">Cloudsmith</a></span></div>
</footer>`;
}

const searchDialog = `<div class="search-dialog" hidden role="dialog" aria-modal="true" aria-label="Search the docs">
  <div class="search-panel">
    <div class="search-input">${ICONS.search}<input type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
    <div class="search-results" role="listbox"></div>
    <div class="search-foot"><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>↵</kbd> to open</span></div>
  </div>
</div>`;

export function layout(ctx, { path, title, description, body, page, canonical }) {
  const url = `${ctx.SITE}${canonical ?? path}`;
  return `<!doctype html>
<html lang="en" data-page="${page}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="theme-color" content="#07090d" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Orca">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ctx.SITE}/assets/img/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/img/favicon.png" type="image/png">
<link rel="apple-touch-icon" href="/assets/img/logo-tile.png">
<link rel="preload" href="/assets/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/site.css?v=${ctx.version}">
<script>(function(){try{var t=localStorage.getItem("theme");if(!t)t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="dark"}})()</script>
<script src="/assets/site.js?v=${ctx.version}" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${header(ctx, path)}
${mobileMenu(ctx)}
<main id="main">
${body}
</main>
${footer()}
${searchDialog}
</body>
</html>
`;
}

// --- Docs page --------------------------------------------------------------

function sidebar(ctx, current) {
  return NAV.map(
    (s) =>
      `<div class="sb-section"><div class="sb-title">${esc(s.title)}</div><ul>${s.items
        .map((slug) => {
          const d = ctx.docs.find((x) => x.slug === slug);
          if (!d) return "";
          return `<li><a href="/docs/${slug}/"${slug === current ? ' aria-current="page"' : ""}>${esc(d.nav)}</a></li>`;
        })
        .join("")}</ul></div>`,
  ).join("");
}

function toc(doc) {
  const items = doc.headings.filter((h) => h.depth === 2 || h.depth === 3);
  if (items.length < 2) return "";
  return `<nav class="toc" aria-label="On this page"><div class="toc-title">On this page</div><ul>${items
    .map((h) => `<li class="d${h.depth}"><a href="#${h.id}">${esc(h.text)}</a></li>`)
    .join("")}</ul></nav>`;
}

export function docPage(ctx, doc, prev, next) {
  const pager = `<nav class="pager" aria-label="Previous and next page">${
    prev
      ? `<a class="pager-prev" href="/docs/${prev.slug}/"><span class="pager-label">${ICONS.arrowLeft} Previous</span><span class="pager-title">${esc(prev.nav)}</span></a>`
      : "<span></span>"
  }${
    next
      ? `<a class="pager-next" href="/docs/${next.slug}/"><span class="pager-label">Next ${ICONS.arrow}</span><span class="pager-title">${esc(next.nav)}</span></a>`
      : "<span></span>"
  }</nav>`;
  return `<div class="docs-shell">
  <aside class="docs-sidebar" aria-label="Documentation">
    <div class="sb-inner">${sidebar(ctx, doc.slug)}</div>
  </aside>
  <article class="doc">
    <div class="doc-head">
      <div class="crumbs"><a href="/docs/introduction/">Docs</a><span>/</span><span>${esc(doc.section)}</span></div>
      <h1>${esc(doc.title)}</h1>
      ${doc.description ? `<p class="lede">${esc(doc.description)}</p>` : ""}
    </div>
    <div class="prose">${doc.html}</div>
    <div class="doc-foot">
      <a class="edit" href="https://github.com/edvin/orca/edit/main/${doc.source}" target="_blank" rel="noopener">${ICONS.edit} Edit this page on GitHub</a>
    </div>
    ${pager}
  </article>
  <aside class="docs-toc">${toc(doc)}</aside>
</div>`;
}
