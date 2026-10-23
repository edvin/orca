---
title: orca-workspace.yaml reference
nav: File reference
description: Every key of orca-workspace.yaml with its type, default and validation rules, the errors Orca reports, and the shared stack's orca.yaml.
---

This page lists every key of `orca-workspace.yaml`, with its type, default and the rules Orca checks. For a guided walk-through, see [Create a workspace](/docs/workspaces-create/). For routes in depth, see [Routes](/docs/workspaces-routes/).

## The file

Orca looks for `orca-workspace.yaml`, then `orca-workspace.yml`, at the root of the workspace folder. Paths in the file are relative to that folder, unless a key says otherwise.

The file is YAML. Every key is optional except `name`, and every project needs a `repo`. Orca rejects keys it doesn't know, so a typo such as `descripton:` is an error rather than silently ignored.

A complete file, with every key:

```yaml title="orca-workspace.yaml"
name: acme                                  # required
description: Everything you need to work on Acme's apps locally.

network: local-dev

gateway:
  domain: local.acme.dev
  certificate:
    cert: certs/local.acme.dev.crt
    key: certs/local.acme.dev.key

shared:
  compose: compose.yaml
  name: acme-shared

routes:
  - { hostname: mail, target: "mailpit:8025", title: Mailpit }
  - { hostname: "*", target: "soketi:6001", websocket: true }

clone_into: ~/code/acme

registries:
  - registry.acme.dev

secrets:
  passbolt:
    url: https://passbolt.acme.dev
  1password:
    account: acme.1password.com

projects:
  billing:
    repo: git@git.acme.dev:finance/billing.git   # required
    description: Invoices, payments and dunning
    path: billing
    branch: main
    uses: [mailpit, temporal]
    setup: just setup
    routes:
      - { hostname: billing, target: "billing-app:80", title: Billing }
    env:
      file: .env
      from: .env.example
      secrets:
        DB_PASSWORD: passbolt:7f3c91a2-5d0e-4c2b-9a51-2a9be1c3d4f0
        STRIPE_SECRET: op://Dev/Stripe/secret
    worktrees: true
```

## Top-level keys

| Key | Type | Default | Summary |
|---|---|---|---|
| [`name`](#name) | string | required | The workspace's name, shown in Orca. |
| [`description`](#description) | string | none | One line about the workspace. |
| [`network`](#network) | string | none | A Docker network the shared services and projects join. |
| [`gateway`](#gateway) | object | none | The gateway's domain and certificate. |
| [`shared`](#shared) | object | none | The shared services' compose file. |
| [`routes`](#routes) | list | `[]` | Gateway routes for the shared services. |
| [`clone_into`](#clone_into) | string | the workspace's parent folder | Where projects are cloned. |
| [`registries`](#registries) | list of strings | `[]` | Image registries developers must be logged in to. |
| [`secrets`](#secrets) | object | none | The secret managers that references point into. |
| [`projects`](#projects) | map | `{}` | The team's projects, by key. |

## name

**Required.** A string, shown on the **Workspace** page and by `orca workspace status`.

```yaml
name: acme
```

Error when missing or blank: *`name` is missing*.

## description

A string, shown under the name on the **Workspace** page.

## network

The name of a Docker network. On join and **Update**, Orca creates it as a `bridge` network if it doesn't exist, and connects the gateway to it so routes can target containers and network aliases on it.

```yaml
network: local-dev
```

- Letters, digits, dashes and underscores, at most 63 characters, not starting with a dash.
- Orca doesn't connect containers to it. The shared services and each project attach their services to it in their own compose files, as an external network. See [Create a workspace](/docs/workspaces-create/#3-add-the-network).

Error: *network '…' is not a valid Docker network name*.

## gateway

The [gateway](/docs/gateway/)'s domain and certificate, applied to Orca's gateway on join and **Update**.

```yaml
gateway:
  domain: local.acme.dev
  certificate:
    cert: certs/local.acme.dev.crt
    key: certs/local.acme.dev.key
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `domain` | string | the gateway's current domain | The domain every short hostname gets: `mail` becomes `mail.local.acme.dev`. The landing page is served at the domain itself. |
| `certificate.cert` | path | none | The certificate in PEM format, with its chain. |
| `certificate.key` | path | none | Its private key in PEM format. |

What Orca does with it:

- With `certificate`, the gateway uses that one certificate for every hostname (the **Custom certificate** TLS mode). It must cover `*.<domain>`, and the domain itself for the landing page.
- With a `gateway` section but no `certificate`, the gateway uses Orca's own certificate authority (the **Orca CA (automatic)** mode), which issues a certificate per hostname.
- Without a `gateway` section, Orca keeps the gateway's current domain and TLS mode, and only makes sure it runs.

These are the gateway's settings for the whole machine, not only for the workspace. Orca reads the certificate files when it applies the workspace, so a renewed certificate takes effect after **Update**. See [Choose a domain and certificate](/docs/workspaces-create/#4-choose-a-domain-and-certificate).

Rules:

- Each part of `domain` uses letters, digits, dashes and underscores, and doesn't start with a dash.
- `cert` and `key` are paths inside the workspace folder: relative, without `..`. Both are required when `certificate` is set.

Errors: *gateway domain '…' is not a valid domain*; *gateway certificate: '…' must be a path inside the folder*; on join, *can't read the certificate file …*.

## shared

The services every project shares, as a compose file in the workspace.

```yaml
shared:
  compose: compose.yaml
  name: acme-shared
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `compose` | path | required when `shared` is set | The compose file, inside the workspace folder. |
| `name` | string | the workspace folder's name | The compose project name the shared stack runs as. |

On join and **Update**, Orca runs the file with `docker compose -p <name> -f <compose> up -d`, so services without a compose profile start. Then it runs the `hooks` of an `orca.yaml` in the workspace folder (see [The shared stack's orca.yaml](#the-shared-stacks-orcayaml)). A failing hook is logged and doesn't stop the join.

Setting up a project starts the services it lists under [`uses`](#uses), including services behind a profile.

Keep `name` stable: it decides the names of the stack's volumes and, unless the compose file sets `container_name`, of its containers. Renaming it later starts a fresh stack with fresh volumes.

Keep the compose file at the root of the workspace, next to `orca.yaml`, so Orca finds the stack's links and hooks.

Errors: *shared.compose: '…' must be a path inside the folder*; on join, *… doesn't exist*.

## routes

Gateway routes for the shared services, or anything else on the workspace network. Each project has its own [`routes`](#project-routes) too. The [Routes](/docs/workspaces-routes/) page covers matching and precedence in depth.

```yaml
routes:
  - { hostname: mail, target: "mailpit:8025", title: Mailpit }
  - { hostname: grafana, target: "grafana:3000" }
  - { hostname: "*-docs", target: "docs-router:80" }
  - { hostname: "*", target: "soketi:6001", websocket: true }
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `hostname` | string | required | A short name such as `mail`, which gets the gateway domain, or a full hostname with a dot. A `*` in the first part matches many hostnames. |
| `target` | string | required | `alias:port`: a container name or network alias on the workspace network, and the port inside it. |
| `path` | string | none | Only requests for this path. `/api/*` matches everything under `/api/`; without `*`, only that exact path. |
| `title` | string | from the hostname | The card's title on the landing page. For shared routes, also the button's label on the **Workspace** page. |
| `websocket` | boolean | `false` | Only WebSocket connections take this route. |

Rules:

- `hostname`: every part after the first uses letters, digits, dashes and underscores. The first part may also contain `*`.
- `target`: a name of letters, digits, dashes and underscores (no dots), a colon, and a port number.
- `path` starts with `/`.

Errors: *routes: '…' is not a valid hostname*; *routes: '…': target must be alias:port, like mailpit:8025*; *routes: '…': path must start with /*.

## clone_into

The folder projects are cloned into. Each project goes to `<clone_into>/<path>`.

```yaml
clone_into: ~/code/acme
```

- `~/…` is your home folder, an absolute path is used as it is, and a relative path is relative to the workspace folder.
- **Default:** the folder that contains the workspace. With the workspace at `~/code/dev-workspace`, projects go to `~/code/<key>`.

If a project's folder already exists, setup uses it as it is. Point `clone_into` at the folder where your team already keeps its checkouts, and existing checkouts are picked up.

## registries

Image registries projects pull from, such as `registry.acme.dev` or `registry.acme.dev:5000`.

```yaml
registries:
  - registry.acme.dev
```

For each one, Orca checks your `~/.docker/config.json` for an `auths` or `credHelpers` entry for that host. If there's none, the **Workspace** page shows **Log in to registry.acme.dev** with the `docker login` command, and `orca workspace status` prints the same hint. Orca never logs in for you.

## secrets

The secret managers that projects' [`env.secrets`](#env) references point into. See [Secrets](/docs/workspaces-secrets/) for how filling in works.

```yaml
secrets:
  passbolt:
    url: https://passbolt.acme.dev
  1password:
    account: acme.1password.com
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `passbolt.url` | string | required when `passbolt` is set | Your Passbolt server. Orca links each secret to `<url>/app/passwords/view/<id>`. Must start with `https://`. |
| `1password.account` | string | none | The 1Password account to read from, passed to `op` as `--account`. Use `1password: {}` to enable 1Password without naming an account. |

Error: *secrets.passbolt.url must start with https://*.

## projects

The team's projects, as a map from a key to its settings. The key is how the project is named everywhere: on its card, in `orca workspace setup <key>`, to AI tools, and as the default folder name.

```yaml
projects:
  billing:
    repo: git@git.acme.dev:finance/billing.git
```

Keys use letters, digits, dashes and underscores, at most 63 characters, and don't start with a dash. Projects are listed in alphabetical order of their keys.

| Key | Type | Default | Summary |
|---|---|---|---|
| `repo` | string | required | What to `git clone`. |
| `description` | string | none | One line, shown on the card. AI tools match on it too. |
| `path` | path | the project's key | The folder under `clone_into`. |
| `branch` | string | the repo's default branch | The branch to check out when cloning. |
| [`uses`](#uses) | list of strings | `[]` | Shared services to start before the project. |
| [`setup`](#setup) | string | none | A command run once per machine after cloning. |
| [`routes`](#project-routes) | list | `[]` | Gateway routes for the project. |
| [`env`](#env) | object | none | The `.env` file and the secrets it needs. |
| [`worktrees`](#worktrees) | boolean | `false` | Also add the project to **Projects**, for worktree instances. |

Error: *project '…': use letters, digits and dashes*.

### repo, path and branch

`repo` is anything `git clone` accepts: an SSH URL (`git@git.acme.dev:finance/billing.git`), an HTTPS URL, or a local path. Orca clones with the developer's own git credentials, without prompts. It can't start with a dash.

`path` is a folder inside `clone_into`: relative, without `..`. Use it when the folder should be named differently from the key, for example when your team's existing checkouts are called `billing-service`.

`branch` is only used when cloning (`git clone --branch`). Orca never switches the branch of an existing checkout. It can't be empty or start with a dash.

Errors: *project '…': `repo` is missing*; *project '…': `repo` can't start with '-'*; *project '…': invalid branch '…'*; *project '…' path: '…' must be a path inside the folder*.

### uses

The shared services the project needs, by their **service name** in the shared compose file (the key under `services:`, not the container name).

```yaml
uses: [mailpit, temporal, minio]
```

When the project is set up or started, Orca runs `docker compose up -d` for exactly these services in the shared stack, which also starts services behind a compose profile. With no `shared` section, or an empty list, the step is skipped. A name that isn't a service in the shared compose file makes the step fail with Docker Compose's error.

Error: *project '…': empty entry in `uses`*.

### setup

A shell command run in the project's folder after cloning and creating the `.env`, such as `just setup`, `make bootstrap` or `npm ci && npm run db:seed`.

```yaml
setup: just setup
```

- It runs with `sh -c` (`cmd /C` on Windows), with no input, so it must not wait for an answer.
- It sees the `PATH` described in [The PATH Orca uses](/docs/workspaces-secrets/#the-path-orca-uses), not your shell's.
- It runs once per machine. Later starts skip it with *"Ran before"*. **Run setup again** or `orca workspace setup <key> --rerun-setup` runs it again.
- If it fails, setup stops with the last lines of its output as the error, and the project doesn't start.

### Project routes

The same format as the top-level [`routes`](#routes). On the landing page, a project's routes are grouped under its key.

```yaml
routes:
  - { hostname: billing, target: "billing-app:80", title: Billing }
  - { hostname: billing, target: "billing-reverb:8080", websocket: true }
```

All routes in the workspace file exist as soon as you join, whether or not the project is cloned or running. A route to a container that isn't running shows **Not running** on the landing page.

A project can also define routes in its own [orca.yaml](/docs/orca-yaml/#gateway), with service names instead of container names. Don't define the same hostname and path in both: see [Conflicts](/docs/workspaces-routes/#conflicts).

### env

The project's `.env` file and the secrets it needs.

```yaml
env:
  file: .env
  from: .env.example
  secrets:
    DB_PASSWORD: passbolt:7f3c91a2-5d0e-4c2b-9a51-2a9be1c3d4f0
    STRIPE_SECRET: op://Dev/Stripe/secret
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `file` | path | `.env` | The file to create and fill, relative to the project folder. |
| `from` | path | none | The template the file starts as a copy of, such as `.env.example`. Without it, the file starts empty. |
| `secrets` | map | `{}` | Variable name to secret reference: `passbolt:<resource id>` or `op://vault/item/field`. |

Without an `env` section, the **Create the .env file** and **Fill in secrets** steps are skipped.

Rules:

- `file` and `from` are paths inside the project folder: relative, without `..`.
- Variable names use letters, digits and underscores, and don't start with a digit.
- A reference must be `passbolt:` followed by letters, digits and dashes, or `op://` followed by at least three non-empty parts.
- A reference's secret manager must be set up under top-level [`secrets`](#secrets).

Errors: *project '…': '…' is not a valid variable name*; *project '…' DB_PASSWORD: '…' is not a Passbolt resource id (passbolt:&lt;uuid&gt;)*; *… is not a 1Password reference (op://vault/item/field)*; *… isn't a secret reference: use passbolt:&lt;id&gt; or op://vault/item/field*; *project '…' DB_PASSWORD uses passbolt, but the workspace's `secrets:` doesn't set it up*; *project '…' env.file: … must be a path inside the folder*; at setup, *.env.example doesn't exist*.

### worktrees

`true` adds the project to the **Projects** page when it's started, so each git worktree of it can run as its own copy with its own hostnames. The project needs a `dev:` section in its own `orca.yaml` for that. See [Worktree instances](/docs/worktrees/).

## Errors

Orca checks the whole file whenever it reads it: on join, on **Update**, when Orca starts, and each time the **Workspace** page or `orca workspace status` loads. The first problem it finds is reported, with the file's path in front:

- The **Workspace** page shows **The workspace file has a problem**, the error, and *Fix it in …, then click Update.*
- `orca workspace status` fails with *the workspace file has a problem: …*.
- Join and **Update** fail at the step after getting the workspace.

| Error | What to fix |
|---|---|
| *… has no orca-workspace.yaml* | The folder or repo has no workspace file at its root. |
| *unknown field `…`, expected one of …* | A key is misspelled, or in the wrong place. The message lists the keys allowed there. |
| *invalid type: …* or a line and column | YAML syntax, such as a missing quote or wrong indentation. Hostnames with `*` and targets with `:` are safest in quotes. |
| *`name` is missing* | Add `name:`. |
| *network '…' is not a valid Docker network name* | Use letters, digits, dashes and underscores. |
| *gateway domain '…' is not a valid domain* | Check for spaces, empty parts (`..`) or a leading dash. |
| *… must be a path inside the folder* | Use a relative path without `..`. |
| *secrets.passbolt.url must start with https://* | Use the HTTPS address of your Passbolt server. |
| *'…' is not a valid hostname* | Only the first part of a hostname may contain `*`. No spaces, slashes or ports. |
| *target must be alias:port, like mailpit:8025* | Add the port, and use a container name or alias without dots. |
| *path must start with /* | Write `/api/*`, not `api/*`. |
| *project '…': use letters, digits and dashes* | Rename the project's key. |
| *`repo` is missing* | Add the project's git URL. |
| *… is not a valid variable name* | Variable names: letters, digits and `_`, not starting with a digit. |
| *… isn't a secret reference* | Use `passbolt:<id>` or `op://vault/item/field`. |
| *… uses passbolt, but the workspace's `secrets:` doesn't set it up* | Add the secret manager under top-level `secrets`. |

## The shared stack's orca.yaml

The shared stack is a compose project like any other, so an [orca.yaml](/docs/orca-yaml/) next to its compose file works for it too. Two parts of it are especially useful in a workspace.

**`links`** put each app's addresses per environment on the [landing page](/docs/gateway/#the-landing-page), one tab per environment. This is how a team keeps one page with every app's local, staging and production URLs:

```yaml title="orca.yaml"
links:
  billing:                      # the section; a project's key merges with its routes
    - name: Billing
      local: billing            # a gateway hostname, optionally with a path
      staging: https://billing.staging.acme.dev
      production: https://billing.acme.dev
  shop:
    - name: Storefront
      local: shop
      staging: https://shop.staging.acme.dev
      production: https://shop.acme.com
    - name: Shop admin
      local: shop/admin
      production: https://shop.acme.com/admin
  Shared services:
    - name: Temporal
      local: temporal
      staging: https://temporal.staging.acme.dev
```

A link group with the same name as a project's key (or `Shared services`) shows in the same section as that project's route cards. A `local` link takes the place of the card for the route with that hostname.

**`hooks`** run commands inside the shared services after every start from Orca, including join and **Update**. Use them for one-time setup that must survive a reset, such as creating search attributes or buckets. Make them safe to repeat:

```yaml title="orca.yaml"
hooks:
  after_up:
    - "temporal-admin-tools: temporal operator search-attribute create --name tenant --type Keyword || true"
    - "minio-setup: mc mb --ignore-existing local/uploads"
```

A hook for a service that isn't running, such as one behind a profile that's off, is skipped. See the [orca.yaml reference](/docs/orca-yaml/#hooks).
