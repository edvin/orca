// The download page: installers from the latest release, the server daemon,
// and what happens on first start.

import { ICONS, esc } from "./layout.mjs";

const mb = (n) => (n ? `${Math.round(n / 1048576)} MB` : "");

export function downloadPage(ctx) {
  const r = ctx.latest;
  const assets = r?.assets ?? [];
  const find = (re) => assets.find((a) => re.test(a.name));
  const releases = "https://github.com/edvin/orca/releases/latest";
  const mac = find(/aarch64\.dmg$/);
  const win = find(/x64-setup\.exe$/);
  const appimage = find(/amd64\.AppImage$/);
  const deb = find(/amd64\.deb$/);

  // data-asset lets site.js point the link at the newest release when the page is older than it.
  const fileBtn = (a, label, primary, pattern) =>
    `<a class="btn ${primary ? "btn-primary" : ""}" href="${a?.url ?? releases}" data-asset="${pattern}">${label}<span class="dl-size">${a ? mb(a.size) : ""}</span></a>`;

  return `
<section class="page-hero">
  <div class="container">
    <span class="eyebrow">Download${r ? ` · ${esc(r.tag)}` : ""}</span>
    <h1>Get Orca</h1>
    <p>Free and open source. Install it, start it, and Orca sets up the rest: a container runtime, its VM where your platform needs one, and the gateway.</p>
  </div>
</section>

<section class="container dl-grid">
  <div class="dl-card" data-os-card="mac">
    <div class="platform-icon">${ICONS.apple}</div>
    <h2>macOS</h2>
    <p>Apple Silicon. Orca installs Lima and runs Docker in a lightweight Linux VM; no Docker Desktop needed.</p>
    <div class="dl-actions">${fileBtn(mac, "Download .dmg", true, "aarch64\\.dmg$")}</div>
    <span class="yours">Your platform</span>
  </div>
  <div class="dl-card" data-os-card="windows">
    <div class="platform-icon">${ICONS.windows}</div>
    <h2>Windows</h2>
    <p>64-bit installer. Orca runs Docker inside WSL2 and sets it up on first start.</p>
    <div class="dl-actions">${fileBtn(win, "Download installer", true, "x64-setup\\.exe$")}</div>
    <span class="yours">Your platform</span>
  </div>
  <div class="dl-card" data-os-card="linux">
    <div class="platform-icon">${ICONS.linux}</div>
    <h2>Linux</h2>
    <p>x86-64. Talks to Docker or Podman directly. The AppImage updates itself.</p>
    <div class="dl-actions">${fileBtn(appimage, "AppImage", true, "amd64\\.AppImage$")}${fileBtn(deb, ".deb", false, "amd64\\.deb$")}</div>
    <span class="yours">Your platform</span>
  </div>
</section>

<section class="container dl-more">
  <div class="dl-split">
    <div>
      <h2>${ICONS.server} On a server</h2>
      <p>Run the Orca daemon on a Debian or Ubuntu server and manage it from the desktop app, next to your own machine.</p>
      ${ctx.codeBlock("curl -fsSL https://orca-desktop.com/install-daemon.sh | sudo sh", "bash")}
      <a class="link-arrow" href="/docs/remote-hosts/">Remote hosts guide ${ICONS.arrow}</a>
    </div>
    <div>
      <h2>${ICONS.book} After installing</h2>
      <ol class="dl-steps">
        <li><strong>Start Orca.</strong> The first start checks your system and offers to install anything missing.</li>
        <li><strong>Open a project.</strong> Anything you start with <code>docker compose up</code> shows up as a stack.</li>
        <li><strong>Give it a hostname.</strong> Start the gateway and open <code>https://&lt;name&gt;.localhost</code>.</li>
      </ol>
      <a class="link-arrow" href="/docs/quickstart/">Follow the quickstart ${ICONS.arrow}</a>
    </div>
  </div>
  <p class="dl-foot">All files, checksums and older versions are on <a href="https://github.com/edvin/orca/releases" target="_blank" rel="noopener">GitHub Releases</a>. Orca updates itself when a new version is out.${
    r ? ` Latest: <a href="/changelog/">${esc(r.tag)}</a>, ${new Date(r.date).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" })}.` : ""
  }</p>
</section>
`;
}
