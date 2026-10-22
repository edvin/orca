# orca.yaml reference

`orca.yaml` tells Orca how to run a project. Put it next to the project's compose file and commit it: everyone who runs the project with Orca gets the same hostnames, links, build targets and setup commands.

The quickest way to start one is the **orca.yaml** tab on a stack's page in Orca: **Create orca.yaml** writes a first version from the stack's running services. For worktree instances, add the project on the **Projects** page instead; its setup wizard writes the `dev:` section.

## When Orca reads it

Docker Compose labels every container with the folder its project was started from. Orca reads the `orca.yaml` in that folder for every compose project it can see, however it was started: from Orca, or with `docker compose up` in a terminal. When the file changes, Orca applies the change straight away.

- A project is found once it has containers, so start it once.
- **Routes** exist while their service runs and go away when it stops.
- **Links** and **build targets** show up as soon as the project has containers, running or not.
- **Hooks** run after every start from Orca (the stack page, `orca deploy`, or an AI agent). Orca can't run them after a `docker compose up` in a terminal.

An `orca.local.yaml` next to it is merged on top, for settings that differ per machine. Keep it out of git.

An entry Orca can't read, such as a route without a port, is skipped and the rest of the file still applies. The stack's **orca.yaml** tab lists every skipped entry and why, and shows the status of each route.

## A complete example

```yaml
# Routes through the Orca gateway: https://<hostname>.<domain>
gateway:
  - hostname: shop            # shop.<domain>
    service: web
    port: 3000
  - hostname: shop
    service: api
    port: 8080
    path: /api/*              # same hostname, paths to another service
  - hostname: admin.{domain}  # {domain} works too
    service: admin
    port: 80

# Links shown on the Gateway page, one tab per environment.
links:
  Shop:
    - name: Storefront
      local: shop             # a gateway hostname
      staging: https://staging.shop.example.com
      production: https://shop.example.com
    - name: API docs
      local: shop/api/docs

# Build targets on the Builds page.
builds:
  - name: web
    context: ./web
    dockerfile: Dockerfile    # the default
    tag: shop-web:dev
    args:
      NODE_VERSION: 22

# Commands run after every start from Orca.
hooks:
  after_up:
    - "api: php artisan migrate --force"
    - "temporal: temporal operator search-attribute create --name tenant --type Keyword || true"

# Worktree instances: see below.
dev:
  shared:
    postgres:
      data: own-database
  instance:
    expose:
      web: 3000
```

## gateway

Each entry routes a hostname (and optionally a path) to a service's port inside the stack.

| Key | | |
|---|---|---|
| `hostname` | required | `shop` becomes `shop.<domain>`; a name with a dot is used as is. `{domain}` is replaced with the gateway's domain. |
| `service` | required | The compose service. With several replicas, a running one is used. |
| `port` | required | The port the service listens on inside its container, not a published host port. |
| `path` | optional | Only requests under this path, such as `/api/*`. Without a `*`, only that exact path matches. |

A hostname that a route added by hand on the Gateway page, or a worktree instance, already uses stays with that route. The orca.yaml tab and the Gateway page say which route has it.

Every routed hostname also resolves inside containers that share a network with a routed container, to the gateway. A backend can call `https://auth.<domain>` the way the browser does, which OIDC issuer URLs need. With Orca's own certificate authority, the calling container has to trust it: `orca ca export` writes it out.

**Instead of orca.yaml,** a container can ask for a route in its own labels:

```yaml
services:
  web:
    labels:
      orca.route: shop               # on the port the image exposes
      orca.route.port: "3000"        # when it exposes none or several
      orca.route.api: api.{domain}   # more routes, each with a name
      orca.route.api.port: "8080"
      orca.route.api.path: /v1*
```

Traefik labels work too: each `traefik.http.routers.<name>.rule` with `Host(...)`, and optionally `PathPrefix(...)`, becomes a route to the router's service port. `traefik.enable=false` opts out.

## links

Groups of links, each with a URL per environment. The Gateway page shows one tab per environment name you use. `local` names a gateway hostname, optionally with a path (`shop/api/docs`); the other environments are full URLs. A link needs a `name` and at least one URL.

## builds

| Key | | |
|---|---|---|
| `name` | required | Shown on the Builds page, and used by scheduled builds. |
| `context` | required | Relative to the folder with `orca.yaml`. |
| `tag` | required | The image tag to build. |
| `dockerfile` | optional | Defaults to `Dockerfile`. |
| `args` | optional | Build args; numbers and true/false are passed as text. |

## hooks

`after_up` is a list of `"service: command"` entries. After every start from Orca, each one runs in that service's container with `sh -c`, in order. A failing hook doesn't stop the others: the stack page shows its output and the Activity log keeps it. Hooks run on every start, so make them safe to repeat (`|| true`, `IF NOT EXISTS`, idempotent migrations).

## dev: worktree instances

With a `dev:` section, every git worktree of the project can run as its own copy of the app, with its own hostnames, ports and, if you want, its own database. Infrastructure runs once in a shared stack. Add the project on the **Projects** page to use it. Its editor has a form for all of this, with help on every key.

| Key | Default | |
|---|---|---|
| `dev.naming.instance` | `branch` | Name instances after the branch or the folder. |
| `dev.naming.hostname` | `{service}-{instance}-{project}.{domain}` | Hostname pattern. Also available: `{worktree}`. The nested form `{service}.{instance}.{project}.{domain}` gives each instance its own cookies. |
| `dev.start` | `manual` | `on-create` starts new worktrees on their own. |
| `dev.shared_project` | `<project>-shared` | Compose project name of the shared stack. Use an existing project's name to keep its data volumes. |
| `dev.shared.<service>.data` | `shared` | `shared`, `own-database` (a database per instance in the shared server) or `own-server` (a private copy of the service). |
| `dev.shared.<service>.database` | | The database the app uses. |
| `dev.shared.<service>.own_database.name` | `{database}_{instance}` | Name of an instance's own database. |
| `dev.shared.<service>.own_database.seed` | `clone-main` | `clone-main` copies the shared database; `empty` starts empty. |
| `dev.shared.<service>.host_port` | | Publish the shared service on this host port. |
| `dev.instance.expose.<service>` | | A port, or `{port, host, path}`, to reach through the gateway. |
| `dev.instance.host_ports.<service>` | | Container ports published on a free host port for each instance. |
| `dev.instance.env.<service>.<KEY>` | | Extra environment. Values can use `{url.<service>}`, `{port.<service>.<port>}` and `{db.<service>}`. |
| `dev.instance.hooks.after_up` | | `"service: command"`, after every start. |
| `dev.instance.hooks.after_own_database` | | `"service: command"`, when an instance gets its own database. |
| `dev.instance.presets` / `default_preset` | | Named sets of services to start. |
| `dev.instance.idle_stop` | off | Stop an instance after this long unused (`30m`, `2h`); the next request to its URL starts it again. |
| `dev.instance.max_running` | `6` | How many instances may run at once. |
| `dev.instance.limits` | | `memory` and `cpus` for each service in an instance. |

Each instance also gets `.orca/env` with `ORCA_PROJECT`, `ORCA_INSTANCE`, `ORCA_URL_<SERVICE>`, `ORCA_PORT_<SERVICE>_<PORT>`, `ORCA_DB_<SERVICE>` and `ORCA_SHARED_<SERVICE>`, for tests and scripts: `eval $(orca env)`.

## Other top-level keys

| Key | |
|---|---|
| `project` | Project name; defaults to the folder name. |
| `compose` | Compose file, or a list of them, if they aren't the ones `docker compose` finds on its own. |
