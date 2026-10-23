---
title: Workspaces
nav: Workspaces
description: One repo with an orca-workspace.yaml sets up a team's whole local environment: shared services, network, gateway domain and certificate, and every project, ready to set up with one click or by asking an AI tool.
---

A workspace is one git repository with an `orca-workspace.yaml` file. It describes everything a developer needs to work on your team's projects locally:

- the **shared services** everyone uses, such as a mail catcher, dashboards, Temporal or object storage;
- the **Docker network** projects meet on;
- the **gateway's domain and certificate**, such as `*.local.example.dev`;
- the **projects**: where each one lives in git, how to set it up, and which secrets its `.env` needs.

A new developer installs Orca and joins the workspace. From then on, any project is one click away on the **Workspace** page, or one sentence in Claude: *"spin up billing"*.

![The Workspace page: shared services, and projects that are running, cloned or not set up yet](/assets/screens/workspace.webp)

## Join a workspace

Open **Workspace** in the sidebar, paste the workspace's git URL and click **Join**. Orca then:

1. clones the repository (to `~/code/<name>` unless you choose a folder), using your own git credentials;
2. creates the workspace's Docker network if it doesn't exist;
3. sets up the [gateway](/docs/gateway/) on the workspace's domain, with its certificate, and starts it;
4. starts the shared services;
5. adds the workspace's routes.

Teams can put a link in their wiki that opens Orca with the URL filled in:

```text
orca://workspace?repo=git@git.example.com:devops/dev-workspace.git
```

From a terminal:

```bash
orca workspace join git@git.example.com:devops/dev-workspace.git
```

Orca pulls the workspace (fast-forward only) every time it starts, so a project added to the file shows up for everyone. **Update** on the Workspace page pulls and applies it right away. **Leave** forgets the workspace and removes its routes; your clones and their `.env` files stay.

## Set up a project

Each project on the Workspace page shows whether it's running, cloned, or not cloned yet. **Set up** (or **Start**, once cloned) runs these steps, with their progress shown on the card:

1. **Clone** the repository into the workspace's projects folder.
2. **Create the `.env` file** from its template, such as `.env.example`, if it doesn't exist yet. Orca warns you if the file isn't ignored by git.
3. **Fill in secrets** the project needs. See [secrets](#secrets) below.
4. **Run the setup command**, such as `just setup`. It runs once per machine; **Run setup again** runs it again.
5. **Start the shared services** the project uses.
6. **Start the project** as a stack, as [Open a project folder](/docs/stacks/#open-a-project-folder) does, and show its URLs.

If secrets are still missing, setup stops before starting the project and asks for them.

From a terminal:

```bash
orca workspace status            # the projects and their state
orca workspace setup billing     # set one up and start it
```

### With an AI tool

With Orca [connected to your AI tool](/docs/agents/), ask it to *"spin up billing"* or *"set up the CRM project"*. It looks the project up in the workspace (`workspace_status`), sets it up (`setup_project`) and gives you its URLs. If secrets are missing, it tells you which and where to fill them in. Orca's instructions tell it never to ask for secrets in the chat.

## Secrets

Values for the `.env` file come from your team's secret manager. The workspace file only holds references to them, never the secrets themselves.

When a project needs secrets, its card shows **N secrets to fill in**. That opens a dialog with each one:

![Filling in a project's secrets, each with a link to its entry in Passbolt](/assets/screens/workspace-secrets.webp)

- **Open in Passbolt** opens that exact entry in your browser, so you can copy the value and paste it into the field.
- **Fill in automatically** appears when your secret manager's command-line tool is set up on this computer. Orca then fetches every value itself.

The values are written to the project's `.env` file on your computer (created readable only by you), and nowhere else.

| Secret manager | Reference in the workspace file | By hand | Automatically |
|---|---|---|---|
| Passbolt | `passbolt:<resource id>` | A link to the entry | With [go-passbolt-cli](https://github.com/speatzle/go-passbolt-cli), set up with `passbolt configure` |
| 1Password | `op://vault/item/field` | The reference, to look up | With the [1Password CLI](https://developer.1password.com/docs/cli/) (`op`), signed in |

To find a Passbolt resource id, open the entry in Passbolt: it's the last part of the address, `…/app/passwords/view/<id>`.

## Create a workspace

Put an `orca-workspace.yaml` in a repository your team can clone, next to the shared services' compose file:

```yaml title="orca-workspace.yaml"
name: acme
description: Everything you need to work on Acme's apps locally.

# The Docker network every project joins. Created when missing.
network: local-dev

gateway:
  domain: local.acme.dev
  # A certificate for *.local.acme.dev, paths in this repo. Without one,
  # Orca's own certificate authority signs the names.
  certificate:
    cert: certs/wildcard.crt
    key: certs/wildcard.key

# The services everyone shares, as a compose file in this repo.
shared:
  compose: compose.yaml

# HTTPS names for them. A target is a container name or network alias, and a port.
routes:
  - { hostname: mail, target: "mailpit:8025", title: Mailpit }
  - { hostname: grafana, target: "grafana:3000", title: Grafana }

# Where projects are cloned. Default: next to this repo.
clone_into: ~/code/acme

# Registries projects pull images from: Orca reminds you to `docker login`.
registries: [registry.acme.dev]

secrets:
  passbolt: { url: https://passbolt.acme.dev }
  # 1password: { account: acme.1password.com }

projects:
  billing:
    repo: git@git.acme.dev:finance/billing.git
    description: Invoices, payments and dunning
    uses: [temporal]              # shared services it needs
    setup: just setup             # run once after cloning
    routes:                       # until the project's own orca.yaml has them
      - { hostname: billing, target: "billing-app:80" }
    env:
      from: .env.example          # .env starts as a copy of this
      secrets:
        DB_PASSWORD: passbolt:7f3c91a2-5d0e-4c2b-9a51-2a9be1c3d4f0
        STRIPE_SECRET: op://Dev/Stripe/secret
  crm:
    repo: git@git.acme.dev:crm/crm.git
    branch: main
    worktrees: true               # also add it to Projects, for worktree instances
```

| Key | What it does |
|---|---|
| `name` | Shown in Orca. Required. |
| `network` | A Docker network every project joins; Orca creates it, and the gateway joins it so routes can target network aliases. |
| `gateway.domain` | The domain hostnames get. A name without a dot, like `mail`, becomes `mail.local.acme.dev`. |
| `gateway.certificate` | `cert` and `key` files (PEM) for `*.<domain>`. Without them, Orca's certificate authority is used. |
| `shared.compose` | The shared services' compose file. Started on join, and per project as `uses` lists them. `shared.name` sets the compose project name. |
| `routes` | Gateway routes: `hostname`, `target` (`alias:port`), optional `path` and `title`. |
| `clone_into` | Where projects are cloned; `~/…`, absolute, or relative to the workspace. |
| `registries` | Image registries; Orca checks `docker login` was done for each. |
| `secrets` | The secret managers references point into: `passbolt.url`, `1password.account`. |
| `projects.<key>.repo` | What to `git clone`. Required. |
| `projects.<key>.path`, `branch` | The folder under `clone_into` (default: the key) and the branch to check out. |
| `projects.<key>.uses` | Shared services to start before the project. |
| `projects.<key>.setup` | A command run once in the project folder after cloning, such as `just setup`. |
| `projects.<key>.routes` | Routes for the project, like the workspace's. A project's own [orca.yaml](/docs/orca-yaml/) can take over later. |
| `projects.<key>.env` | `from` (template), `file` (default `.env`), and `secrets`: variable → reference. |
| `projects.<key>.worktrees` | Also add the project to **Projects**, so each git worktree can run as its own instance. |

Orca checks the file when it reads it and names what's wrong, such as a target without a port or a secret whose manager isn't listed under `secrets`.

> [!NOTE]
> Only join workspaces you trust. Joining runs the shared services' compose file, and setting up a project runs its `setup` command on your computer.

### The certificate

If your team's domain resolves to `127.0.0.1` in public DNS, a real certificate for it works in every browser and tool without trusting anything extra. Keeping it in the workspace repo is the smoothest option. Keep that repo private: a certificate authority revokes a certificate whose private key is made public.

Without a certificate in the workspace, Orca's own certificate authority signs the names. Each developer trusts it once (Orca does that on first start), and nothing secret is shared.

### Coming from a reverse proxy

If your team already routes hostnames with HAProxy, such as a shared "devproxy" stack, Orca can turn its config into workspace routes:

```bash
orca workspace import-haproxy haproxy.cfg --domain local.acme.dev
```

It prints a `routes:` list to paste into the workspace file. Projects keep their compose files, network and aliases as they are: the gateway joins the workspace network and routes to the same aliases.

## Related

- [Gateway](/docs/gateway/): domains, certificates and the landing page.
- [AI agents and MCP](/docs/agents/): connect Claude so it can set up projects for you.
- [Worktrees](/docs/worktrees/): run every branch of a project side by side.
