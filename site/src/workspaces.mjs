// /workspaces/: the product page for workspaces, one repo that sets up a
// whole team's local environment.

import { ICONS, esc } from "./layout.mjs";
import { shot, windowFrame, downloadButton, F } from "./home.mjs";

export function workspacesPage(ctx) {
  const yaml = `name: acme
network: local-dev
gateway:
  domain: local.acme.dev
  certificate: { cert: certs/wildcard.crt, key: certs/wildcard.key }
shared:
  compose: compose.yaml        # mailpit, Temporal, MinIO…
routes:
  - { hostname: mail, target: "mailpit:8025" }
secrets:
  passbolt: { url: https://passbolt.acme.dev }

projects:
  billing:
    repo: git@git.acme.dev:finance/billing.git
    uses: [temporal]
    setup: just setup
    routes:
      - { hostname: billing, target: "billing-app:80" }
    env:
      from: .env.example
      secrets:
        DB_PASSWORD: passbolt:7f3c91a2-5d0e-4c2b-9a51-2a9be1c3d4f0`;

  const routes = `routes:
  # An app and its API on one hostname
  - { hostname: shop, target: "shop-web:3000" }
  - { hostname: shop, path: "/api/*", target: "shop-api:8080" }
  # Every tenant: north-shop, south-shop…
  - { hostname: "*-shop", target: "shop-web:3000" }
  # The app's own Reverb socket, and Pusher for every other WebSocket
  - { hostname: shop, target: "shop-reverb:8080", websocket: true }
  - { hostname: "*", target: "soketi:6001", websocket: true }`;

  const imported = `$ orca workspace import-haproxy haproxy.cfg --domain local.acme.dev
routes:
- hostname: billing
  target: billing-app:80
  title: Billing
- hostname: mail
  target: mailpit:8025
# … 38 more
# Not imported: these rules need a look by hand
#   use_backend reverb if hdr_connection_upgrade is_billing_ws`;

  const step = (n, title, text, code, lang) =>
    `<div class="step reveal"><div class="step-num">${n}</div><h3>${title}</h3><p>${text}</p>${code ? ctx.codeBlock(code, lang) : ""}</div>`;
  const card = (icon, title, text, href) =>
    `<a class="bento-card reveal" href="${href}"><span class="bento-icon">${icon}</span><h3>${title}</h3><p>${text}</p><span class="bento-more">Read more ${ICONS.arrow}</span></a>`;
  const li = (items) => items.map((t) => `<li>${t}</li>`).join("");

  return `
<section class="hero ws-hero-section">
  <div class="hero-bg" aria-hidden="true"><div class="hero-grid"></div><div class="hero-glow"></div></div>
  <div class="container hero-inner">
    <span class="eyebrow">${F.layers} Workspaces</span>
    <h1>Your team's local setup,<br><span class="grad">in one repo.</span></h1>
    <p class="hero-sub">The shared services, your own domain and certificate, and every project with its setup steps and secrets, described once. A new developer installs Orca, clicks one link, and has any project running in minutes. Or just asks Claude to spin it up.</p>
    <div class="hero-ctas">
      ${downloadButton(ctx)}
      <a class="btn btn-lg btn-ghost" href="/docs/workspaces/">Read the docs ${ICONS.arrow}</a>
    </div>
  </div>
  <div class="container hero-visual reveal">
    ${windowFrame(shot("workspace", "The Workspace page: shared services, and projects that are running, cloned or ready to set up", "hero-shot"), "Orca — Workspace")}
    <div class="float float-url ws-float-link" aria-hidden="true"><span class="lock">${F.lock}</span>orca://workspace?repo=git@git.acme.dev:devops/dev-workspace.git</div>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="section-head reveal">
      <span class="eyebrow">Day one</span>
      <h2>From a new laptop to a running project</h2>
      <p>Onboarding stops being a wiki page and a day of asking around.</p>
    </div>
    <div class="ws-compare reveal">
      <div class="ws-compare-col before">
        <div class="ws-compare-title">Without a workspace</div>
        <ol>${li([
          "Find the right wiki page, and hope it's current",
          "Clone the proxy repo, create the network, fight for ports 80 and 443",
          "Clone each project and copy <code>.env.example</code>",
          "Hunt for every secret in the password manager",
          "Ask in chat why a hostname doesn't resolve",
          "Do it all again for the next project",
        ])}</ol>
      </div>
      <div class="ws-compare-col after">
        <div class="ws-compare-title">With a workspace</div>
        <ol>${li([
          "Install Orca",
          "Click the workspace link: shared services, network and HTTPS are ready",
          "Click <b>Set up</b> on a project, or ask Claude to <em>spin up billing</em>",
          "Paste the secrets Orca links you to, or let it fetch them",
        ])}</ol>
        <div class="ws-compare-result">✓ Running at <b>https://billing.local.acme.dev</b></div>
      </div>
    </div>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="section-head reveal">
      <span class="eyebrow">How it works</span>
      <h2>Describe it once. Share one link.</h2>
    </div>
    <div class="steps ws-steps">
      ${step(1, "Describe your setup", "One <code>orca-workspace.yaml</code> in a repo: the shared services, the network, your domain and certificate, and every project.", "orca-workspace.yaml\ncompose.yaml\ncerts/\nREADME.md", "text")}
      ${step(2, "Share one link", "Put it in your wiki. It opens Orca with the workspace filled in, or use the CLI.", "orca://workspace?repo=git@git.acme.dev:devops/dev-workspace.git", "text")}
      ${step(3, "Set up anything", "One click per project: clone, <code>.env</code>, secrets, setup command, start. Or ask your AI tool.", "orca workspace setup billing\n→ https://billing.local.acme.dev", "bash")}
    </div>
  </div>
</section>

<section class="section feature">
  <div class="container feature-grid">
    <div class="feature-copy reveal">
      <span class="eyebrow">${F.sliders} One file</span>
      <h2>Everything a developer needs, in plain YAML</h2>
      <p>The workspace file lists what your team runs and how to get it going. Orca checks it as it reads it, and names the problem when something's off.</p>
      <ul class="checks">${li([
        "Shared services as a compose file, started on join and per project as needed",
        "Your own domain, with a real wildcard certificate or Orca's own",
        "Projects reuse an existing checkout, or clone with each developer's own git access",
        "Everyone's Orca pulls the workspace on start, so new projects show up by themselves",
      ])}</ul>
      <a class="link-arrow" href="/docs/workspaces-reference/">The file, key by key ${ICONS.arrow}</a>
    </div>
    <div class="feature-visual reveal">${ctx.codeBlock(yaml, "yaml", "orca-workspace.yaml")}</div>
  </div>
</section>

<section class="section feature alt">
  <div class="container feature-grid reverse">
    <div class="feature-copy reveal">
      <span class="eyebrow">${F.shield} Secrets</span>
      <h2>Secrets from your password manager, never from a chat</h2>
      <p>The workspace holds references, not secrets. When a project needs some, Orca lists them with a link straight to each entry in Passbolt, or fills them in itself with Passbolt's or 1Password's command-line tool.</p>
      <ul class="checks">${li([
        "<code>passbolt:&lt;id&gt;</code> or 1Password's <code>op://vault/item/field</code>",
        "Decrypted on the developer's machine, with their own credentials",
        "Written only to the project's <code>.env</code>, readable only by them",
      ])}</ul>
      <a class="link-arrow" href="/docs/workspaces-secrets/">How secrets work ${ICONS.arrow}</a>
    </div>
    <div class="feature-visual reveal">
      ${windowFrame(shot("workspace-secrets", "Filling in a project's secrets, each with a link to its entry in Passbolt"), "Secrets for billing")}
    </div>
  </div>
</section>

<section class="section feature">
  <div class="container feature-grid">
    <div class="feature-copy reveal">
      <span class="eyebrow">${F.bot} AI</span>
      <h2>"Spin up billing." Done.</h2>
      <p>With Orca connected to Claude, Cursor or any MCP client, an AI tool finds the project in the workspace, sets it up and hands back its URLs. It never asks for secrets: those are filled in on the Workspace page.</p>
      <a class="link-arrow" href="/docs/agents/">Connect your AI tool ${ICONS.arrow}</a>
    </div>
    <div class="feature-visual reveal">
      <div class="mcp-chat">
        <div class="mcp-msg you">Spin up billing, I need to look at the invoice run</div>
        <div class="mcp-calls"><span>orca · workspace_status</span><span>orca · setup_project</span></div>
        <div class="mcp-msg ai">Billing is running at <b>https://billing.local.acme.dev</b>. I cloned it to ~/code/billing, ran <code>just setup</code>, and started Temporal, which it uses.</div>
      </div>
    </div>
  </div>
</section>

<section class="section feature alt">
  <div class="container feature-grid reverse">
    <div class="feature-copy reveal">
      <span class="eyebrow">${F.gateway} Routing</span>
      <h2>The routing a real team needs</h2>
      <p>Paths to another app, a hostname per tenant, an app's own WebSocket server next to a shared one. The most specific route wins, so it does what you'd expect.</p>
      <ul class="checks">${li([
        "Targets are network aliases, so projects keep their compose files",
        "<code>*</code> in a hostname for tenants, docs sites or per-developer hosts",
        "<code>websocket: true</code> for Reverb, Vite HMR or Pusher",
        "The same hostnames work from inside containers",
      ])}</ul>
      <a class="link-arrow" href="/docs/workspaces-routes/">Routes in depth ${ICONS.arrow}</a>
    </div>
    <div class="feature-visual reveal">${ctx.codeBlock(routes, "yaml", "orca-workspace.yaml")}</div>
  </div>
</section>

<section class="section feature">
  <div class="container feature-grid">
    <div class="feature-copy reveal">
      <span class="eyebrow">${F.rocket} Moving over</span>
      <h2>Already running a shared dev proxy?</h2>
      <p>Point Orca at your HAProxy config and it writes the routes for you, with each backend's description as its title. The rules that need a person, such as WebSocket special cases, are listed for review instead of being guessed.</p>
      <a class="link-arrow" href="/docs/workspaces-migrate/">Migrate from a reverse proxy ${ICONS.arrow}</a>
    </div>
    <div class="feature-visual reveal">${ctx.codeBlock(imported, "bash")}</div>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="section-head reveal">
      <span class="eyebrow">Docs</span>
      <h2>Everything about workspaces</h2>
    </div>
    <div class="bento">
      ${card(ICONS.book, "Overview", "What a workspace is, and what happens when you join one and set up a project.", "/docs/workspaces/")}
      ${card(F.rocket, "Join and use", "The Workspace page, setting up projects, the CLI and your AI tool.", "/docs/workspaces-join/")}
      ${card(F.shield, "Secrets", "Passbolt and 1Password: by hand, or filled in by their CLIs.", "/docs/workspaces-secrets/")}
      ${card(F.sliders, "Create a workspace", "A step-by-step guide for the person setting one up for a team.", "/docs/workspaces-create/")}
      ${card(F.grid, "File reference", "Every key in orca-workspace.yaml, with defaults and checks.", "/docs/workspaces-reference/")}
      ${card(F.gateway, "Routes", "Targets, paths, patterns, WebSockets, and which route wins.", "/docs/workspaces-routes/")}
      ${card(F.server, "Migrate", "From a hand-run HAProxy, nginx or Traefik setup to a workspace.", "/docs/workspaces-migrate/")}
      ${card(F.terminal, "Troubleshooting", "Clones, ports, certificates, routes and secrets that don't work.", "/docs/workspaces-troubleshooting/")}
    </div>
  </div>
</section>

<section class="section faq-section">
  <div class="container faq-grid">
    <div class="section-head left reveal">
      <span class="eyebrow">FAQ</span>
      <h2>Questions teams ask</h2>
    </div>
    <div class="faq reveal">
      ${[
        ["Do our project repos have to change?", "No. Routes target the network aliases your compose files already have, and the workspace starts each project as a normal compose stack. Projects can later move their own routes into an <code>orca.yaml</code>."],
        ["Where do secrets end up?", "Only in each project's <code>.env</code> on the developer's own computer, created readable only by them. The workspace repo holds references to your password manager, never values."],
        ["Do we need a certificate?", "No. Without one, Orca's own certificate authority signs your domain's names, and Orca trusts it on first start. If your domain resolves to 127.0.0.1 in public DNS, a real wildcard certificate in the repo also works in tools that ignore the system's trust store."],
        ["Does it work without AI?", "Yes. The Workspace page and the <code>orca workspace</code> commands do everything; the AI tools use the same steps."],
        ["What does joining run on my machine?", "The shared services' compose file, and each project's setup command when you set it up. Only join workspaces from people you trust, as you would only run their scripts."],
        ["Which platforms?", "macOS, Windows and Linux, wherever Orca runs. Git uses each developer's own SSH keys or credential helper."],
      ]
        .map(([q, a]) => `<details class="faq-item"><summary>${esc(q)}</summary><p>${a}</p></details>`)
        .join("")}
    </div>
  </div>
</section>

<section class="cta-band">
  <div class="container cta-inner reveal">
    <h2>Give your team a one-click start</h2>
    <p>Install Orca, write one file, and share the link.</p>
    <div class="hero-ctas">
      ${downloadButton(ctx)}
      <a class="btn btn-lg btn-ghost" href="/docs/workspaces-create/">Create a workspace ${ICONS.arrow}</a>
    </div>
  </div>
</section>
`;
}
