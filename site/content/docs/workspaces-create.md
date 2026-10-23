---
title: Create a workspace
nav: Create a workspace
description: A step-by-step guide for team leads: write orca-workspace.yaml, add shared services, a domain and certificate, and projects, test it and roll it out.
---

This guide walks a team lead through creating a workspace from nothing: the repository, the shared services, the network, the domain and certificate, and the projects, then testing it and rolling it out. It ends with a complete example you can copy. Plan on an hour for a first version with a few projects.

If your team already runs a reverse proxy stack that everyone clones, read [Migrate from a reverse proxy](/docs/workspaces-migrate/) alongside this page.

## Before you start

Collect what a new developer needs today, usually from your onboarding wiki:

- the services everyone runs locally, such as a mail catcher, Temporal or object storage;
- the local hostnames people use, and which container serves each;
- each project's repository, its setup steps, and which `.env` values come from your password manager;
- the image registries people have to log in to.

You'll also need Orca installed on your own machine.

## 1. Create the repository

Create an empty, **private** repository that everyone on the team can clone, for example `devops/dev-workspace`. Clone it:

```bash
git clone git@git.acme.dev:devops/dev-workspace.git ~/code/dev-workspace
cd ~/code/dev-workspace
```

Everything in this guide goes into this folder. A typical layout when you're done:

```text
dev-workspace/
├── orca-workspace.yaml     # the workspace
├── compose.yaml            # the shared services
├── orca.yaml               # links per environment and post-start hooks (optional)
├── certs/                  # the gateway certificate (optional)
│   ├── local.acme.dev.crt
│   └── local.acme.dev.key
├── grafana/                # config files the shared services mount
├── .gitignore
└── README.md               # the join link and a list of projects
```

Keep `compose.yaml` and `orca.yaml` at the root, next to each other: Orca reads the shared stack's `orca.yaml` from the folder its compose file is in.

## 2. Write a minimal file

Create `orca-workspace.yaml` with a name and one project:

```yaml title="orca-workspace.yaml"
name: acme
description: Everything you need to work on Acme's apps locally.

projects:
  billing:
    repo: git@git.acme.dev:finance/billing.git
    description: Invoices, payments and dunning
```

That's a valid workspace already. Each following step adds one part. The [file reference](/docs/workspaces-reference/) lists every key.

## 3. Add the network

Pick a Docker network name for the shared services and projects to meet on. If your projects already share one, use that.

```yaml title="orca-workspace.yaml"
network: local-dev
```

Orca creates the network when someone joins, and connects the gateway to it. It doesn't connect your containers to it: each compose file that should be on it, the shared services' and each project's, declares it as an external network:

```yaml title="compose.yaml (in a project)"
services:
  app:
    image: registry.acme.dev/billing/app:dev
    container_name: billing-app      # what routes target
    networks: [default, local-dev]

networks:
  local-dev:
    external: true
```

The gateway reaches containers on the network by their container name or network alias. That's what routes target.

## 4. Choose a domain and certificate

Every hostname in the workspace lives under one domain, such as `billing.local.acme.dev`. You have two good options.

| | A real wildcard certificate | Orca's certificate authority |
|---|---|---|
| **Domain** | One you own, such as `local.acme.dev` | One you own, or `acme.localhost` |
| **DNS** | A public wildcard record pointing to `127.0.0.1` | The same, or none for `*.localhost` |
| **Each developer** | Nothing to do | Trusts Orca's CA once: `orca ca install` |
| **Works in** | Every browser, `curl`, scripts and containers | Browsers after trusting; containers need the CA mounted |
| **Upkeep** | Renew the certificate and push it | None |
| **The repo** | Must stay private: it holds a private key | Holds nothing sensitive |

### A real wildcard certificate

This is the smoothest option for a team. Developers trust nothing extra, and every tool, including containers and test runners, accepts the names.

1. **Pick a subdomain of a domain you own**, such as `local.acme.dev`.
2. **Add public DNS records** pointing it and everything under it to your own machine:

   ```text
   local.acme.dev.      A   127.0.0.1
   *.local.acme.dev.    A   127.0.0.1
   ```

3. **Get a wildcard certificate** for `*.local.acme.dev` that also covers `local.acme.dev`, from your usual certificate authority. Since the names point at `127.0.0.1`, the authority can't check them over HTTP; use DNS validation, such as an ACME DNS-01 challenge with Let's Encrypt.
4. **Put both files in the repo**, in PEM format, the certificate with its chain:

   ```text
   certs/local.acme.dev.crt
   certs/local.acme.dev.key
   ```

5. **Reference them:**

   ```yaml title="orca-workspace.yaml"
   gateway:
     domain: local.acme.dev
     # Wildcard for *.local.acme.dev. Expires 2027-03-01: renew and replace both files.
     certificate:
       cert: certs/local.acme.dev.crt
       key: certs/local.acme.dev.key
   ```

> [!WARNING]
> Keep the repository private. A certificate authority must revoke a certificate whose private key becomes public, which breaks every developer's setup at once.

**Renewing.** Before the certificate expires, get a new one, replace both files and push. Everyone's Orca pulls and applies it when it next starts; **Update** on the **Workspace** page does it right away. A note with the expiry date in the file, as above, helps the next person. Certificates that last 90 days, like Let's Encrypt's, mean doing this every couple of months; a yearly certificate is less work.

### Orca's certificate authority

Leave out `certificate`:

```yaml title="orca-workspace.yaml"
gateway:
  domain: local.acme.dev
```

Each developer's Orca then signs every hostname with its own certificate authority, created on that machine. Developers trust it once with `orca ca install` (see [Trust the Orca CA](/docs/gateway/#trust-the-orca-ca)), and containers that call the hostnames need it mounted (see [Trust it inside containers](/docs/gateway/#trust-it-inside-containers)). Nothing secret is shared.

The names still have to resolve to `127.0.0.1`: use a domain with the wildcard DNS record from above, or a name under `localhost`, such as `acme.localhost`, which Chrome and Firefox resolve to your machine without DNS. Other programs may not; see [Hostnames](/docs/gateway/#hostnames).

Always set `gateway.domain`. Without a `gateway` section, each developer keeps whatever domain their gateway had, and hostnames differ from person to person.

## 5. Add the shared services

Write a compose file with the services every project uses:

```yaml title="compose.yaml"
name: acme-shared

services:
  mailpit:
    container_name: mailpit
    image: axllent/mailpit:v1.21
    networks: [local-dev]

  # Only started when switched on, or when a project lists it under `uses`.
  minio:
    profiles: ["minio"]
    container_name: minio
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    volumes:
      - minio-data:/data
    networks: [local-dev]

volumes:
  minio-data:

networks:
  local-dev:
    external: true
```

Then add it, and routes for the services people open in a browser:

```yaml title="orca-workspace.yaml"
shared:
  compose: compose.yaml
  name: acme-shared

routes:
  - { hostname: mail, target: "mailpit:8025", title: Mailpit }
  - { hostname: s3, target: "minio:9001", title: MinIO }
```

Some guidance:

- **Set `container_name`** on services other projects talk to, so their name on the network is stable and short. Routes and projects use it.
- **Set `shared.name`**, and keep it. It's the compose project name, which names the stack's volumes. Changing it later means fresh, empty volumes.
- **Put optional services behind a profile.** Joining starts only services without one. A project that needs one lists it under `uses`, and developers can switch profiles on for the shared stack on its stack page.
- **Pin image versions** where an upgrade could break projects, so everyone runs the same thing.

## 6. Add the projects

Add each project under `projects`, one at a time. A full entry:

```yaml title="orca-workspace.yaml"
clone_into: ~/code/acme

registries:
  - registry.acme.dev

secrets:
  passbolt:
    url: https://passbolt.acme.dev

projects:
  billing:
    repo: git@git.acme.dev:finance/billing.git
    description: Invoices, payments and dunning
    uses: [mailpit]
    setup: just setup
    routes:
      - { hostname: billing, target: "billing-app:80", title: Billing }
    env:
      from: .env.example
      secrets:
        DB_PASSWORD: passbolt:7f3c91a2-5d0e-4c2b-9a51-2a9be1c3d4f0
        STRIPE_SECRET: passbolt:0b6d2c4e-8a1f-4e3b-b7c2-5f9e1d3a6c80
```

Go through the keys for each project:

- **`repo`**: the URL people clone it with. SSH URLs work with each developer's own key.
- **`description`**: one line. AI tools match on it, so name what the project is, not only its codename: *"Invoices, payments and dunning"*.
- **`path`**: only if the folder should be named differently from the key.
- **`clone_into`** (top level): where projects go. If your team already keeps checkouts in one place, such as `~/code/acme`, use that: existing checkouts are picked up as they are.
- **`uses`**: the shared services it needs, by their service name in `compose.yaml`.
- **`setup`**: the one-time command a new developer runs today, such as `just setup`.
- **`routes`**: its hostnames. See [Routes](/docs/workspaces-routes/) for paths, patterns and WebSockets.
- **`env`**: the template its `.env` starts from, and each secret's reference. See [Secrets](/docs/workspaces-secrets/).
- **`worktrees: true`**: if the project has a `dev:` section in its `orca.yaml` for [worktree instances](/docs/worktrees/).

### Give projects an icon

Shared services usually get theirs from their image: Mailpit, Temporal, MinIO and most others are built in. For your own apps, put their logos in an `icons/` folder in the workspace repo and point at them:

```yaml
projects:
  shop:
    icon: icons/shop.svg        # SVG, PNG, WebP or JPEG, up to 64 KB
  billing:
    icon: api                   # or a built-in icon
```

A project's icon shows on its card on the **Workspace** page and the dashboard, and on the landing page for its routes. See [Icons](/docs/gateway/#icons).

### Prepare each project's repo

A few things in each project make setup reliable:

1. **Its compose file is at the root** of the repo (`compose.yaml` or `docker-compose.yml`), and its services that others reach are on the workspace network, with a `container_name` or alias.
2. **Its `.env.example` leaves secrets empty**: `DB_PASSWORD=`, not `DB_PASSWORD=changeme`. Orca treats any value as filled in.
3. **Its `.gitignore` covers `.env`.**
4. **Its setup command runs without questions.** It gets no input, so a prompt fails the setup. Use flags such as `--no-interaction` or `-y`.
5. **Its setup command doesn't need the project running.** Setup runs before the shared services it uses and before the project starts. Work that needs a running database, such as migrations, belongs in the project's own `orca.yaml` as an [`after_up` hook](/docs/orca-yaml/#hooks), which runs after every start.
6. **The tools its setup command calls are installed where Orca finds them**, such as `/opt/homebrew/bin` or `/usr/local/bin`. Orca doesn't read your shell's startup files. See [The PATH Orca uses](/docs/workspaces-secrets/#the-path-orca-uses).

## 7. Test it yourself

Commit nothing yet. Join the workspace from your folder, using its absolute path instead of a git URL:

```bash
orca workspace join ~/code/dev-workspace
```

Or paste the absolute path into the field on the **Workspace** page. Orca uses the folder as it is, without cloning.

Then check, in order:

1. **Every join step succeeds.** If one fails, the card shows why. See [Troubleshooting](/docs/workspaces-troubleshooting/).
2. **The shared services run**: the chip shows all of them running, and each button under **Shared services** opens its page.
3. **`https://local.acme.dev`** shows the landing page, with a trusted certificate.
4. **Each project sets up** from **Not cloned** to **Running**. Move your existing checkout aside first, or set `clone_into` to a scratch folder, to test a fresh clone.
5. **Secrets** are asked for, link to the right entries, and the app starts with them.
6. **Asking your AI tool** *"spin up billing"* works.

After changing the file, click **Update** to apply it again. Before the folder has a remote branch, **Update** skips the pull and applies the folder as it is.

## 8. Publish it

Commit and push:

```bash
git add .
git commit -m "Acme workspace for Orca"
git push -u origin main
```

Then write the join link: `orca://workspace?repo=` followed by the repository's clone URL.

```text
orca://workspace?repo=git@git.acme.dev:devops/dev-workspace.git
```

Put it in the workspace's README and your onboarding page, with the plain git URL next to it for tools that don't make `orca://` links clickable:

```text title="README.md"
# Acme workspace

1. Install Orca from https://orca-desktop.com/download/
2. [Join the workspace](orca://workspace?repo=git@git.acme.dev:devops/dev-workspace.git),
   or paste git@git.acme.dev:devops/dev-workspace.git on Orca's Workspace page.
3. Run `docker login registry.acme.dev` if Orca asks.
4. Set up a project with Set up, `orca workspace setup <project>`, or ask your AI tool.
```

## 9. Roll it out

1. **Pilot it** with one or two developers on different machines and operating systems. They'll find what works on yours by accident: a tool missing from `PATH`, a Passbolt entry not shared with their group, a setup command that prompts.
2. **Tell the team what changes.** Ports 80 and 443 must be free, so anything that used them, such as an old proxy stack, has to stop first. Say which hostnames, if any, change.
3. **Share the link**, and how to fill in secrets, by hand or with [the Passbolt CLI](/docs/workspaces-secrets/#passbolt-go-passbolt-cli).
4. **Collect problems in one place** for the first week, and fix them in the workspace file. Everyone gets the fixes on their next Orca start.

## Maintain it

Edit `orca-workspace.yaml`, push, and the change reaches everyone:

- **When Orca starts**, it pulls the workspace (fast-forward only) and refreshes the routes. New and changed projects and routes appear without anyone doing anything.
- **Changes reach everyone when their Orca next starts**, all of them: projects, routes, `compose.yaml`, the network, the domain and the certificate. To hurry it along, ask the team to click **Update** on the **Workspace** page, or to run `orca workspace update`.

Common changes:

| Change | What to do | What developers notice |
|---|---|---|
| Add a project | Add it under `projects`. | A new **Not cloned** card. |
| Add or change a route | Edit `routes`. | The hostname works on the next start. |
| Add a shared service | Add it to `compose.yaml`, and a route if it has a page. | It starts when each Orca next starts, or on **Update**. |
| Change a setup command | Edit `setup`. | It doesn't rerun by itself; tell people to click **Run setup again** if they need it. |
| Rename a project's key | Rename it, and set `path` to the old folder name. | Without `path`, the project looks **Not cloned** and setup would clone it again into a new folder. Its setup command also runs again once. |
| Remove a project | Delete its entry. | The card and its routes go away. Clones, `.env` files and containers stay on each machine. |
| Move routes into the project's `orca.yaml` | Remove them from the workspace file in the same change. | Nothing, if the hostnames stay the same. See [Conflicts](/docs/workspaces-routes/#conflicts). |
| Renew the certificate | Replace both files. | Nothing. |

Keep comments in the file: why a route exists, when the certificate expires, which secrets a project still lacks. It's the team's documentation of its local environment.

## Complete example

A workspace for a fictional company, Acme, with three projects: a storefront (`shop`) with a store per brand, a billing service (`billing`) and a CRM (`crm`).

```yaml title="orca-workspace.yaml"
# Acme local development, for Orca.
# Join: orca://workspace?repo=git@git.acme.dev:devops/dev-workspace.git
# Docs: https://orca-desktop.com/docs/workspaces/

name: Acme
description: Local development for the shop, billing and the CRM.

network: local-dev

gateway:
  domain: local.acme.dev
  # Wildcard for *.local.acme.dev and local.acme.dev, which resolve to 127.0.0.1.
  # Expires 2027-03-01: renew it and replace both files.
  certificate:
    cert: certs/local.acme.dev.crt
    key: certs/local.acme.dev.key

shared:
  compose: compose.yaml
  name: acme-shared

clone_into: ~/code/acme

registries:
  - registry.acme.dev

secrets:
  passbolt:
    url: https://passbolt.acme.dev

# --- Shared services ---------------------------------------------------------
routes:
  - { hostname: mail, target: "mailpit:8025", title: Mailpit }
  - { hostname: temporal, target: "temporal-ui:8080", title: Temporal }
  - { hostname: s3, target: "minio:9001", title: MinIO }
  - { hostname: soketi, target: "soketi:9601", title: Soketi metrics, icon: websocket }
  # Every WebSocket goes to soketi (Laravel Echo on each app's own hostname),
  # unless a project below routes its own.
  - { hostname: "*", target: "soketi:6001", websocket: true }

projects:
  # --- Shop: one store per brand on <brand>-shop.local.acme.dev ---------------
  shop:
    repo: git@git.acme.dev:shop/shop.git
    description: The storefront and checkout (Laravel and Vue), one store per brand
    icon: icons/shop.svg
    uses: [mailpit, soketi]
    setup: just setup
    worktrees: true
    env:
      from: .env.example
      secrets:
        STRIPE_SECRET: passbolt:0b6d2c4e-8a1f-4e3b-b7c2-5f9e1d3a6c80
        SEARCH_API_KEY: passbolt:a4e1c7d2-3b9f-4f6a-8c25-9d0e7b1f3a42
    routes:
      - { hostname: shop, target: "shop-web:80", title: Shop }
      - { hostname: "*-shop", target: "shop-web:80" }
      - { hostname: shop, path: "/api/*", target: "shop-api:8080", title: Shop API }
      - { hostname: "*-shop", path: "/api/*", target: "shop-api:8080" }
      # Vite's dev server and its hot reload socket.
      - { hostname: shop-vite, target: "shop-vite:5173", title: Shop Vite }
      - { hostname: shop-vite, target: "shop-vite:5173", websocket: true }

  # --- Billing -----------------------------------------------------------------
  billing:
    repo: git@git.acme.dev:finance/billing.git
    description: Invoices, payments and dunning (Laravel, Temporal workflows)
    uses: [mailpit, temporal]
    setup: just setup
    env:
      from: .env.example
      secrets:
        DB_PASSWORD: passbolt:7f3c91a2-5d0e-4c2b-9a51-2a9be1c3d4f0
        STRIPE_SECRET: passbolt:0b6d2c4e-8a1f-4e3b-b7c2-5f9e1d3a6c80
    routes:
      - { hostname: billing, target: "billing-app:80", title: Billing }
      # Reverb, on the app's own hostname.
      - { hostname: billing, target: "billing-reverb:8080", websocket: true }
      # The shop's checkout pages come from billing.
      - { hostname: shop, path: "/pay*", target: "billing-app:80", title: Payment pages }
      - { hostname: "*-shop", path: "/pay*", target: "billing-app:80" }

  # --- CRM ---------------------------------------------------------------------
  crm:
    repo: git@git.acme.dev:crm/crm.git
    path: acme-crm                # existing checkouts are called acme-crm
    description: Customer records and support tools
    uses: [mailpit, minio]
    setup: just setup
    worktrees: true
    env:
      from: .env.example
      secrets:
        DB_PASSWORD: passbolt:3c8f0e2a-7d14-4b9e-a6f3-1e5b2c9d7a08
        OIDC_CLIENT_SECRET: passbolt:e92b5a17-4c3d-4f80-9b1e-6a2d8c0f4b53
    routes:
      - { hostname: crm, target: "crm-app:80", title: CRM }
      - { hostname: crm-search, target: "crm-meilisearch:7700", title: CRM search }
```

The shared services, with optional ones behind profiles:

```yaml title="compose.yaml"
# Acme's shared services. Joining the workspace starts the services without a
# profile; a project starts the ones it lists under `uses`.
name: acme-shared

services:
  mailpit:
    container_name: mailpit
    image: axllent/mailpit:v1.21
    networks: [local-dev]

  # Pusher-compatible WebSockets for every app (see the "*" route).
  soketi:
    container_name: soketi
    image: quay.io/soketi/soketi:1.6-16-debian
    environment:
      METRICS_SERVER_PORT: "9601"
    networks: [local-dev]

  temporal-db:
    container_name: temporal-db
    image: postgres:16
    environment:
      POSTGRES_USER: temporal
      POSTGRES_PASSWORD: temporal
    volumes:
      - temporal-db:/var/lib/postgresql/data
    networks: [local-dev]

  temporal:
    container_name: temporal
    image: temporalio/auto-setup:1.25
    depends_on: [temporal-db]
    environment:
      DB: postgres12
      DB_PORT: "5432"
      POSTGRES_USER: temporal
      POSTGRES_PWD: temporal
      POSTGRES_SEEDS: temporal-db
    ports:
      - "127.0.0.1:7233:7233"   # for workers running outside Docker
    networks: [local-dev]

  temporal-admin-tools:
    container_name: temporal-admin-tools
    image: temporalio/admin-tools:1.25
    depends_on: [temporal]
    environment:
      TEMPORAL_ADDRESS: temporal:7233
    stdin_open: true
    tty: true
    networks: [local-dev]

  temporal-ui:
    container_name: temporal-ui
    image: temporalio/ui:2.31
    depends_on: [temporal]
    environment:
      TEMPORAL_ADDRESS: temporal:7233
    networks: [local-dev]

  minio:
    profiles: ["minio"]
    container_name: minio
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    volumes:
      - minio-data:/data
    networks: [local-dev]

volumes:
  temporal-db:
  minio-data:

networks:
  local-dev:
    external: true
```

Links per environment for the landing page, and a hook that runs after the shared services start:

```yaml title="orca.yaml"
links:
  shop:
    - name: Storefront
      local: shop
      staging: https://shop.staging.acme.dev
      production: https://shop.acme.com
  billing:
    - name: Billing
      local: billing
      staging: https://billing.staging.acme.dev
      production: https://billing.acme.dev
  crm:
    - name: CRM
      local: crm
      staging: https://crm.staging.acme.dev
      production: https://crm.acme.dev
  Shared services:
    - name: Temporal
      local: temporal
      staging: https://temporal.staging.acme.dev

hooks:
  after_up:
    # Search attributes billing's workflows filter on. Safe to repeat.
    - "temporal-admin-tools: temporal operator search-attribute create --name tenant --type Keyword || true"
```

And the repository's `.gitignore`:

```text title=".gitignore"
.env
*.local.yaml
```

With this, a new developer at Acme installs Orca, clicks the join link, runs `docker login registry.acme.dev` once, and clicks **Set up** on the projects they work on.

## Related

- [File reference](/docs/workspaces-reference/): every key and its rules.
- [Routes](/docs/workspaces-routes/): paths, patterns, WebSockets and precedence.
- [Secrets](/docs/workspaces-secrets/): references, and filling them in.
