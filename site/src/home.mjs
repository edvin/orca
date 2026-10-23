// The landing page.

import { ICONS, esc } from "./layout.mjs";

/** Screenshot files in assets/screens/, by role, so they can be swapped in one place. */
export const SHOTS = {
  hero: "dashboard",
  gateway: "gateway",
  landing: "landing-page",
  worktrees: "feature-worktrees",
  profiles: "feature-profiles",
  editor: "feature-editor",
  openFolder: "open-folder",
  workspace: "workspace",
  palette: "palette",
};

export const shot = (name, alt, cls = "") =>
  `<img class="${cls}" src="/assets/screens/${name}.webp" alt="${esc(alt)}" loading="lazy" decoding="async">`;

export const windowFrame = (inner, title = "Orca") =>
  `<div class="window"><div class="window-bar"><span class="dots"><i></i><i></i><i></i></span><span class="window-title">${esc(title)}</span></div>${inner}</div>`;

export const browserFrame = (inner, url) =>
  `<div class="window browser"><div class="window-bar"><span class="dots"><i></i><i></i><i></i></span><span class="url"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>${esc(url)}</span></div>${inner}</div>`;

export const F = {
  gateway: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  branch: '<svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-12 8"/></svg>',
  bot: '<svg viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/></svg>',
  helm: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  server: ICONS.server,
  rocket: '<svg viewBox="0 0 24 24"><path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2"/><path d="M14 4c3-1 6-1 6-1s0 3-1 6l-7 7-5-5z"/><path d="M9 11 5 11l3-4h4M13 15v4l4-3v-4"/></svg>',
  terminal: ICONS.terminal,
  sliders: '<svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  logs: '<svg viewBox="0 0 24 24"><path d="M4 5h16M4 10h10M4 15h16M4 20h8"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/></svg>',
  feather: '<svg viewBox="0 0 24 24"><path d="M20 4c-6 0-12 4-14 12l-2 4"/><path d="M8 14h7M11 10h6"/></svg>',
};

export function downloadButton(ctx, cls = "btn-lg") {
  const assets = ctx.latest?.assets ?? [];
  const find = (re) => assets.find((a) => re.test(a.name))?.url;
  const mac = find(/aarch64\.dmg$/) ?? find(/\.dmg$/);
  const win = find(/x64-setup\.exe$/) ?? find(/\.exe$/);
  const linux = find(/amd64\.AppImage$/) ?? find(/\.AppImage$/);
  return `<a class="btn btn-primary ${cls}" href="/download/" data-os-label="Download for {os}" data-os-href${
    mac ? ` data-href-mac="${mac}"` : ""
  }${win ? ` data-href-windows="${win}"` : ""}${linux ? ` data-href-linux="${linux}"` : ""}>${"Download"}</a>`;
}

export function homePage(ctx) {
  const v = ctx.latest?.tag ?? "";
  const yaml = `gateway:
  - hostname: shop          # https://shop.localhost
    service: web
    port: 3000
  - hostname: shop
    service: api
    port: 8080
    path: /api/*            # same host, another service

hooks:
  after_up:
    - "api: php artisan migrate --force"`;

  const client = (color, letter, name, state, action) =>
    `<div class="mcp-client${state === "Connected" ? " on" : ""}"><span class="mcp-tile" style="--c:${color}">${letter}</span><span class="mcp-name">${name}<small>${state}</small></span>${action}</div>`;
  const connected = `<span class="mcp-check">✓</span>`;
  const mcpPanel = `<div class="mcp-panel">
      <div class="mcp-panel-head"><b>Connect your AI tools</b><span>No API keys or tokens</span></div>
      ${client("#d97757", "C", "Claude Code", "Connected", connected)}
      ${client("#d97757", "C", "Claude Desktop", "Connected", connected)}
      ${client("#3b8eea", "VS", "VS Code", "Found on this computer", `<span class="mcp-btn">Connect</span>`)}
      ${client("#94a3b8", "Cu", "Cursor", "Found on this computer", `<span class="mcp-btn">Connect</span>`)}
    </div>`;
  const chat = `<div class="mcp-chat">
      <div class="mcp-msg you">Start ~/code/shop with the search profile and give me its URL</div>
      <div class="mcp-calls"><span>orca · deploy_project</span><span>orca · set_stack_profiles</span><span>orca · gateway_routes</span></div>
      <div class="mcp-msg ai">Shop is up with search on: <b>https://shop.localhost</b>, API on /api. All 5 services are healthy.</div>
    </div>`;

  const card = (icon, title, text, href) =>
    `<a class="bento-card reveal" href="${href}"><span class="bento-icon">${icon}</span><h3>${title}</h3><p>${text}</p><span class="bento-more">Learn more ${ICONS.arrow}</span></a>`;

  return `
<section class="hero">
  <div class="hero-bg" aria-hidden="true"><div class="hero-grid"></div><div class="hero-glow"></div></div>
  <div class="container hero-inner">
    ${v ? `<a class="pill" href="/changelog/"><span class="pill-tag">New</span><span>${esc(v)}: Open any project folder, and ⌘K finds everything</span>${ICONS.arrow}</a>` : ""}
    <h1>Local development,<br><span class="grad">without the duct tape.</span></h1>
    <p class="hero-sub">Orca is a free, open source desktop app for containers, compose stacks and Kubernetes. It gives every service an HTTPS hostname, runs a full copy of your app for each git worktree, and lets your AI agents drive it all. One file in your repo sets it up for the whole team.</p>
    <div class="hero-ctas">
      ${downloadButton(ctx)}
      <a class="btn btn-lg btn-ghost" href="/docs/quickstart/">Read the quickstart ${ICONS.arrow}</a>
    </div>
    <div class="hero-meta"><span>${ICONS.apple} macOS</span><span>${ICONS.windows} Windows</span><span>${ICONS.linux} Linux</span><span class="sep"></span><span>MIT licensed</span><span>No telemetry</span></div>
  </div>
  <div class="container hero-visual reveal">
    ${windowFrame(shot(SHOTS.hero, "The Orca dashboard: containers, stacks, CPU and memory at a glance", "hero-shot"), "Orca")}
    <div class="float float-url" aria-hidden="true"><span class="lock">${F.lock}</span>https://shop.localhost<span class="live"></span></div>
    <div class="float float-yaml" aria-hidden="true"><div class="float-title">orca.yaml</div><pre><span class="k">gateway</span>:
  - <span class="k">hostname</span>: shop
    <span class="k">service</span>: web
    <span class="k">port</span>: <span class="n">3000</span></pre></div>
  </div>
</section>

<section class="strip">
  <div class="container strip-inner">
    <p>One app instead of <strong>Docker Desktop</strong>, a reverse proxy you keep alive by hand, and a wiki page of setup steps.</p>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="section-head reveal">
      <span class="eyebrow">How it works</span>
      <h2>From <code>git clone</code> to HTTPS in a minute</h2>
      <p>Orca finds every compose project on your machine, however you start it. Add one file and it gets real hostnames, setup commands and links for everyone on the team.</p>
    </div>
    <div class="steps">
      <div class="step reveal">
        <div class="step-num">1</div>
        <h3>Start your project</h3>
        <p>Open the folder in Orca, drop it on the window, or start it the way you always do. Orca picks it up as a stack.</p>
        ${ctx.codeBlock("git clone git@github.com:acme/shop.git\ncd shop && docker compose up -d", "bash")}
      </div>
      <div class="step reveal">
        <div class="step-num">2</div>
        <h3>Describe it once</h3>
        <p>Commit an <code>orca.yaml</code> next to the compose file, or let Orca write it from what runs.</p>
        ${ctx.codeBlock("gateway:\n  - hostname: shop\n    service: web\n    port: 3000", "yaml", "orca.yaml")}
      </div>
      <div class="step reveal">
        <div class="step-num">3</div>
        <h3>Open it</h3>
        <p>Trusted HTTPS on a real name, with WebSockets and hot reload working as they should.</p>
        <div class="browser-pill"><span class="lock">${F.lock}</span><span>https://<b>shop</b>.localhost</span><span class="ok-dot"></span></div>
        <div class="step-note">Running · up 2 min · web:3000</div>
      </div>
    </div>
  </div>
</section>

<section class="section feature alt">
  <div class="container feature-grid reverse">
    <div class="feature-copy reveal">
      <span class="eyebrow">${F.rocket} Get going</span>
      <h2>Open a folder. It's running.</h2>
      <p>Point Orca at a project and it shows what's inside before it starts anything: the compose file, its services and profiles, the <code>orca.yaml</code>, and whether it's a git repository you can run per worktree.</p>
      <ul class="checks">
        <li>Open a folder, or drop it on Orca's window. No compose file yet? Orca writes a first one</li>
        <li>Jump to the code: open any stack in VS Code, Cursor or your terminal, or a shell in any service</li>
        <li>Press <kbd>⌘K</kbd> to find any stack, container, image or URL and run any action</li>
      </ul>
      <a class="link-arrow" href="/docs/quickstart/">Start your first project ${ICONS.arrow}</a>
    </div>
    <div class="feature-visual reveal stacked-shots">
      ${windowFrame(shot(SHOTS.openFolder, "Opening a project folder: Orca lists its compose file, services, profiles and orca.yaml before starting it"), "Orca — Open a project folder")}
      ${windowFrame(shot(SHOTS.palette, "The command palette finding the shop stack and its URLs"), "⌘K")}
    </div>
  </div>
</section>

<section class="section feature">
  <div class="container feature-grid">
    <div class="feature-copy reveal">
      <span class="eyebrow">${F.layers} Workspaces</span>
      <h2>A new developer, up and running in minutes</h2>
      <p>One repo describes your team's whole local setup: the shared services, the network, the gateway on your own domain with its certificate, and every project. Join it once, and any project is one click away, or one sentence in Claude: <em>"spin up billing"</em>.</p>
      <ul class="checks">
        <li>Clones the repo, creates the <code>.env</code>, runs the setup command and starts it, with progress you can follow</li>
        <li>Secrets come from Passbolt or 1Password: a direct link to each entry, or filled in automatically by their CLI</li>
        <li>Coming from a devproxy-style HAProxy? Import its routes; projects don't change</li>
      </ul>
      <a class="link-arrow" href="/workspaces/">How workspaces work ${ICONS.arrow}</a>
    </div>
    <div class="feature-visual reveal">
      ${windowFrame(shot(SHOTS.workspace, "The Workspace page: shared services, and projects that are running, cloned or ready to set up"), "Orca — Workspace")}
    </div>
  </div>
</section>

<section class="section feature alt">
  <div class="container feature-grid reverse">
    <div class="feature-copy reveal">
      <span class="eyebrow">${F.gateway} Gateway</span>
      <h2>Every service gets a real HTTPS name</h2>
      <p>A managed gateway routes <code>shop.localhost</code>, <code>api.localhost</code> or your team's own domain to the right container, with certificates from Orca's own certificate authority.</p>
      <ul class="checks">
        <li>Routes from <code>orca.yaml</code>, container labels, existing Traefik labels or one click</li>
        <li>Path routes, WebSockets, SSE and HTTP/2 on the same host</li>
        <li>The same names resolve inside containers, so OIDC and server-to-server calls just work</li>
        <li>A live landing page lists every service with its status, and its search box makes it a great start page</li>
      </ul>
      <a class="link-arrow" href="/docs/gateway/">How the gateway works ${ICONS.arrow}</a>
    </div>
    <div class="feature-visual reveal">
      ${browserFrame(shot(SHOTS.landing, "The gateway landing page listing every routed service with status and uptime"), "https://localhost")}
    </div>
  </div>
</section>

<section class="section feature">
  <div class="container feature-grid">
    <div class="feature-copy reveal">
      <span class="eyebrow">${F.branch} Worktree instances</span>
      <h2>A running copy of your app for every branch</h2>
      <p>Work on three branches at once, or let three AI agents do it. Each git worktree runs as its own instance with its own URLs and ports, while databases and other infrastructure run once and are shared.</p>
      <ul class="checks">
        <li>Hostnames per instance, like <code>web-feature-x-shop.localhost</code></li>
        <li>Shared data, a database of its own, or a private server, per service</li>
        <li><code>orca up</code> from the worktree; <code>eval $(orca env)</code> for tests</li>
        <li>Idle instances stop themselves and wake on the next request</li>
      </ul>
      <a class="link-arrow" href="/docs/worktrees/">Set up worktree instances ${ICONS.arrow}</a>
    </div>
    <div class="feature-visual reveal">
      ${windowFrame(shot(SHOTS.worktrees, "The Projects page with an instance per git worktree"), "Orca — Projects")}
    </div>
  </div>
</section>

<section class="section feature alt">
  <div class="container feature-grid reverse">
    <div class="feature-copy reveal">
      <span class="eyebrow">${F.code} orca.yaml</span>
      <h2>One file sets up the project for everyone</h2>
      <p>Routes, links to staging and production, build targets and setup commands live in the repo. Edit it as a form with the stack's real services and ports to pick from, or as YAML. Comments survive either way.</p>
      <ul class="checks">
        <li>Applied the moment it changes, however the stack was started</li>
        <li><code>orca.local.yaml</code> for what differs per machine</li>
        <li>Compose profiles switch optional services on and off, per developer</li>
      </ul>
      <a class="link-arrow" href="/docs/orca-yaml/">The orca.yaml reference ${ICONS.arrow}</a>
    </div>
    <div class="feature-visual reveal stack-visual">
      ${windowFrame(shot(SHOTS.editor, "The orca.yaml editor with routes, services and ports"), "Orca — shop")}
      <div class="code-float">${ctx.codeBlock(yaml, "yaml", "orca.yaml")}</div>
    </div>
  </div>
</section>

<section class="section feature" id="agents">
  <div class="container feature-grid">
    <div class="feature-copy reveal">
      <span class="eyebrow">${F.bot} Agents</span>
      <h2>Your AI runs Orca. One click to connect.</h2>
      <p>Connect Claude Code, Claude Desktop, Cursor, VS Code, Windsurf or Codex from Orca's settings. Then just ask: start a project from a folder, switch on a profile, find out why a container keeps restarting, or run a branch as its own instance and test against it.</p>
      <ul class="checks">
        <li>No tokens to copy: the AI tool runs <code>orca mcp</code>, which signs in by itself</li>
        <li>74 tools: workspace projects, stacks, profiles, gateway routes, builds, Kubernetes, worktrees</li>
        <li>Works with the AI subscription you already have. No API key needed</li>
      </ul>
      <a class="link-arrow" href="/docs/agents/">Connect your AI tools ${ICONS.arrow}</a>
    </div>
    <div class="feature-visual reveal mcp-visual">
      ${mcpPanel}
      ${chat}
    </div>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="section-head reveal">
      <span class="eyebrow">Everything else</span>
      <h2>The rest of your container workflow, too</h2>
      <p>Orca is a complete replacement for the desktop container tools you use today.</p>
    </div>
    <div class="bento">
      ${card(F.box, "Containers", "Run, inspect, edit limits live, open a terminal, browse files and follow logs with search.", "/docs/containers/")}
      ${card(F.layers, "Compose stacks", "Every compose project, however it was started, with profiles, editing and setup hooks.", "/docs/stacks/")}
      ${card(F.shield, "Images and scans", "Pull with tag search, build with live output, and scan for CVEs with Trivy.", "/docs/images-and-builds/")}
      ${card(F.helm, "Kubernetes", "A local k3s cluster in one click, with Helm, topology and a YAML editor, on its own context.", "/docs/kubernetes/")}
      ${card(F.grid, "App Catalog", "Databases, mail, monitoring and more in one click, with generated secrets and setup guides.", "/docs/templates/")}
      ${card(F.server, "Remote hosts", "Install the daemon on a Linux server and manage your whole fleet from one window.", "/docs/remote-hosts/")}
      ${card(F.rocket, "Push to deploy", "A webhook from GitHub or Docker Hub pulls the new image and redeploys, keeping your config.", "/docs/auto-deploy/")}
      ${card(F.terminal, "CLI and API", "Everything is scriptable: the orca command, a REST API and an event stream.", "/docs/cli/")}
    </div>
  </div>
</section>

<section class="section platforms-section">
  <div class="container">
    <div class="section-head reveal">
      <span class="eyebrow">Platforms</span>
      <h2>Native on every desktop</h2>
      <p>Orca sets up what each platform needs on first start. No Docker Desktop required.</p>
    </div>
    <div class="platforms">
      <div class="platform reveal" data-os-card="mac"><div class="platform-icon">${ICONS.apple}</div><h3>macOS</h3><p>A lightweight Linux VM with Lima and Apple's Virtualization framework, VirtioFS mounts that keep file permissions, and ports forwarded to your Mac.</p><span class="yours">Your platform</span></div>
      <div class="platform reveal" data-os-card="windows"><div class="platform-icon">${ICONS.windows}</div><h3>Windows</h3><p>Docker inside WSL2, installed and configured for you, with memory, CPU and swap settings in the app.</p><span class="yours">Your platform</span></div>
      <div class="platform reveal" data-os-card="linux"><div class="platform-icon">${ICONS.linux}</div><h3>Linux</h3><p>Talks to Docker or Podman directly, with no VM in between. AppImage and .deb packages.</p><span class="yours">Your platform</span></div>
    </div>
    <div class="server-line reveal">
      <div><strong>Servers too.</strong> Install the daemon on any Linux server and add it to Orca.</div>
      ${ctx.codeBlock("curl -fsSL https://orca-desktop.com/install-daemon.sh | sudo sh", "bash")}
    </div>
  </div>
</section>

<section class="section trust">
  <div class="container trust-grid">
    <div class="trust-item reveal">${F.code}<h3>Open source</h3><p>MIT licensed. Read the code, file issues, send pull requests.</p></div>
    <div class="trust-item reveal">${F.eye}<h3>No telemetry</h3><p>No analytics, no tracking. Orca only talks to the services you point it at.</p></div>
    <div class="trust-item reveal">${F.feather}<h3>Light</h3><p>A Rust daemon and a native Tauri window, not a bundled browser.</p></div>
    <div class="trust-item reveal">${F.lock}<h3>Local first</h3><p>The desktop daemon listens on localhost, and every request needs your token.</p></div>
  </div>
</section>


<section class="section faq-section">
  <div class="container faq-grid">
    <div class="section-head left reveal">
      <span class="eyebrow">Questions</span>
      <h2>Before you switch</h2>
      <p>Anything else? Ask on <a href="https://github.com/edvin/orca/issues" target="_blank" rel="noopener">GitHub</a>.</p>
    </div>
    <div class="faq reveal">
      ${[
        ["Is Orca free for my company?", "Yes. Orca is MIT licensed, for personal and commercial use, with no account and no seat limits."],
        ["Do I still need Docker Desktop?", "No. On macOS Orca runs Docker in its own Lima VM, on Windows inside WSL2, and on Linux it uses Docker or Podman directly. See <a href=\"/docs/install/\">Install</a> for running it next to an existing Docker setup."],
        ["Does it work with the compose files we already have?", "Yes. Any compose project you start shows up as a stack, and an <code>orca.yaml</code> is optional. Orca doesn't change your compose files; worktree instances use a generated override file instead."],
        ["What does Orca send over the network?", "No analytics or tracking. Orca checks GitHub for updates, pulls from the registries you use, and talks to an AI provider only if you set one up. <a href=\"/docs/security/\">Security and privacy</a> lists the details."],
        ["Which Macs are supported?", "The macOS build is for Apple Silicon."],
        ["Can my AI agent use it?", "Yes. Orca is an MCP server. Connect Claude Code, Claude Desktop, Cursor, VS Code, Windsurf or Codex with one click in Settings, without copying a token. <a href=\"/docs/agents/\">Agents and MCP</a> shows how."],
        ["Do I need an AI API key?", "No. Connected over MCP, Claude and the others use the subscription you already have. Orca's optional built-in assistant runs on a local model from Ollama, LM Studio or llama.cpp, for free; an API key is only needed if you want it to use a cloud model. See <a href=\"/docs/ai-assistant/\">Built-in assistant</a>."],
      ]
        .map(([q, a]) => `<details class="faq-item"><summary>${q}</summary><p>${a}</p></details>`)
        .join("")}
    </div>
  </div>
</section>

<section class="cta-band">
  <div class="container cta-inner reveal">
    <h2>Set it up in five minutes</h2>
    <p>Download Orca, open a project, and give it a hostname. The quickstart walks you through it.</p>
    <div class="hero-ctas">
      ${downloadButton(ctx)}
      <a class="btn btn-lg btn-ghost" href="/docs/quickstart/">Quickstart ${ICONS.arrow}</a>
    </div>
  </div>
</section>
`;
}
