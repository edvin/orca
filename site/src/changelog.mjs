// The changelog: release notes from GitHub, fetched at build time.

import { esc } from "./layout.mjs";

export function changelogPage(ctx) {
  const date = (d) => new Date(d).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });
  const list = ctx.releases
    .map(
      (r) => `<article class="release" id="${esc(r.tag)}">
  <div class="release-meta"><a class="release-tag" href="#${esc(r.tag)}">${esc(r.tag)}</a><time datetime="${esc(r.date)}">${date(r.date)}</time></div>
  <div class="release-body prose">
    <h2 class="release-title">${esc((r.name ?? r.tag).replace(/^Release\s+/, "").replace(/^v[\d.]+:?\s*/, "") || r.tag)}</h2>
    ${r.html}
    <p class="release-link"><a href="${esc(r.url)}" target="_blank" rel="noopener">Downloads and full changelog on GitHub</a></p>
  </div>
</article>`,
    )
    .join("\n");
  return `
<section class="page-hero">
  <div class="container">
    <span class="eyebrow">Changelog</span>
    <h1>What's new</h1>
    <p>Every Orca release, newest first. Orca updates itself, so you get these as they ship.</p>
  </div>
</section>
<section class="container releases">${list || `<p>Release notes are on <a href="https://github.com/edvin/orca/releases">GitHub</a>.</p>`}</section>
`;
}
