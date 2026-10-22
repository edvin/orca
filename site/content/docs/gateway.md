---
title: Gateway and HTTPS hostnames
nav: Gateway
description: Give containers trusted HTTPS hostnames like shop.localhost through Orca's gateway, from the UI, orca.yaml, container labels or worktree instances.
---

The gateway gives your containers real HTTPS addresses, such as `https://shop.localhost`, instead of `http://localhost:8095`. This page covers how it works, where routes come from, certificates, custom domains and the landing page that lists everything you run.

![The Gateway page with routes to running containers](/assets/screens/gateway.webp)

## How it works

The gateway is a Caddy container (`caddy:2-alpine`, named `orca-gateway`) that Orca creates and configures for you. It listens on ports 80 and 443 of your machine, matches each request's hostname (and optionally its path) and forwards it to a port inside a container. Port 80 only redirects to HTTPS.

Start it with **Start Gateway** on the **Gateway** page, or `orca gateway start`. The first start pulls the image. After that the container comes back when Docker restarts, until you stop it. Orca also starts the gateway on its own when a worktree instance needs it.

The gateway forwards to the container's internal port, so the container doesn't need to publish anything on your machine. Orca connects the gateway to each routed container's networks for you.

## Hostnames

The default domain is `localhost`. A route named `shop` becomes `shop.localhost`, and Chrome and Firefox send every `*.localhost` name to your own machine without any DNS setup.

Other programs (Safari, `curl`, scripts, test runners) use the system resolver, which may not resolve `*.localhost`. The **Projects** page warns when an instance hostname doesn't resolve on your computer.

### Use your own domain

To use names that resolve everywhere, pick a domain with a wildcard DNS record pointing at `127.0.0.1`, such as `*.local.yourcompany.dev`, and set it as the **Domain** on the **Configuration** tab of the Gateway page:

```bash
orca gateway config --domain local.yourcompany.dev
```

Routes from orca.yaml and labels follow the new domain. Routes you added by hand keep the full hostname they were given. Configuration changes are saved straight away; stop and start the gateway to apply them.

## Certificates

The **TLS Mode** on the **Configuration** tab decides where certificates come from.

| Mode | | |
|---|---|---|
| **Orca CA (automatic)** | `orca_ca` | The default. Orca runs its own certificate authority and issues a certificate for every routed hostname and for the domain itself. Works with any domain and any hostname depth. |
| **Custom Certificate** | `custom` | You paste a certificate and private key in PEM format. Every route uses that one certificate, so it must cover all of your hostnames. |

### Trust the Orca CA

Browsers trust Orca's certificates once the Orca CA is in your system trust store. Install it from the command line:

```bash
orca ca install
```

This runs `sudo security add-trusted-cert` into the System keychain on macOS, copies it to `/usr/local/share/ca-certificates/` and runs `update-ca-certificates` on Linux, and uses `certutil` on Windows. You can also download it from **Settings → Certificates** with **Download CA Certificate**, which shows install instructions too. `orca ca info` prints its subject, expiry and fingerprint.

The CA is created on first use and stored in Orca's config folder, under `orca/ca/`.

### Trust it inside containers

A container that calls a gateway hostname over HTTPS needs to trust the CA as well. Write it out and mount it into the container:

```bash
orca ca export > orca-ca.pem
```

The certificate is also served without authentication at `http://127.0.0.1:9477/api/v1/ca/certificate`, which is handy in setup scripts. How a container uses it depends on the runtime; Node.js, for example, reads `NODE_EXTRA_CA_CERTS=/path/to/orca-ca.pem`.

### Wildcard certificates

With a custom wildcard certificate such as `*.local.yourcompany.dev`, remember that a wildcard covers exactly one label. `web-feat-x-shop.local.yourcompany.dev` is covered; `web.feat-x.shop.local.yourcompany.dev` is not. Worktree instances use the flat form by default for this reason, and Orca warns when a planned instance hostname isn't covered by the gateway's certificate. See [hostnames per instance](/docs/worktrees/#hostnames).

```bash
orca gateway config --tls-mode custom \
  --cert-file wildcard.pem --key-file wildcard-key.pem
```

## Where routes come from

A route maps a hostname, and optionally a path, to a container and a port. The **Routes** tab lists all of them, with a badge saying where each comes from.

### Added by hand

On the Gateway page, **Add Route** asks for a hostname, an optional path, a container and the **Container Port** (the port the app listens on inside the container). On the **Containers** page and a container's detail page, **Expose via Gateway** does the same for that container. When the gateway runs, **Suggested Routes** lists containers with exposed ports that aren't routed yet.

From the command line, give the full hostname:

```bash
orca gateway add shop.localhost shop-web-1 3000
orca gateway routes
orca gateway remove shop.localhost
```

Routes you add by hand can be edited, paused and removed on the Routes tab.

### orca.yaml

A compose project can declare its routes in an `orca.yaml` next to its compose file. They exist while the service runs, whether the project was started from Orca or with `docker compose up`:

```yaml title="orca.yaml"
gateway:
  - hostname: shop
    service: web
    port: 3000
  - hostname: shop
    service: api
    port: 8080
    path: /api/*
```

The full key table is in the [orca.yaml reference](/docs/orca-yaml/#gateway).

### Container labels

A container can ask for routes in its own labels. A hostname without a dot gets the gateway's domain, and `{domain}` is replaced:

```yaml title="compose.yaml"
services:
  web:
    labels:
      orca.route: shop               # shop.<domain>, on the port the image exposes
      orca.route.port: "3000"        # when it exposes none or several
      orca.route.api: api.{domain}   # more routes, each with its own name
      orca.route.api.port: "8080"
      orca.route.api.path: /v1*
```

Traefik labels work as well. Each `traefik.http.routers.<name>.rule` with `Host(...)`, and optionally `PathPrefix(...)` or `Path(...)`, becomes a route to the router's `loadbalancer.server.port`. `traefik.enable=false` opts a container out. When neither the labels nor the image name a single port, Orca uses port 80.

Routes from orca.yaml and labels are added when the container starts and removed when it stops. To change one, change its source; you can still pause it on the Gateway page.

### Templates

Templates from the app catalog that define routes register them when you deploy them. The badge reads **stack**.

### Worktree instances

Every running [worktree instance](/docs/worktrees/) gets its own hostnames, registered when it starts and removed when it stops. The badge reads **worktree**.

## When two routes want one hostname

A hostname and path combination has one owner. The rules:

1. Routes added by hand, by templates and by worktree instances keep the hostname they have.
2. After those, orca.yaml wins over labels.
3. Between two of the same kind, the first one keeps it.

The route that loses is left out, not changed. The Routes tab says which container asked for which hostname and who already has it, and the stack's **orca.yaml** tab shows it too. A worktree instance whose hostname is taken starts without that URL and says so; give the service its own hostname in the instance's **Settings**.

## Paths

Several routes can share a hostname with different paths. Path routes are matched before the route for the whole hostname, so `/api/*` goes to the API and everything else to the app:

```yaml title="orca.yaml"
gateway:
  - hostname: shop
    service: web
    port: 3000
  - hostname: shop
    service: api
    port: 8080
    path: /api/*
```

A path with `*` matches everything under it. Without a `*`, only that exact path matches.

## WebSockets and streaming

WebSockets and server-sent events pass through every route unchanged. Hot reload, Laravel Reverb and GraphQL subscriptions need no extra setup.

For a Pusher-protocol server such as Soketi, route `/app/*` on the app's own hostname to it, so the browser talks to one host. The recipe, with the `.env` settings for Laravel Echo and pusher-js, is in the [orca.yaml reference](/docs/orca-yaml/#websockets).

## Hostnames inside containers

Inside a container, a name like `auth.localhost` would normally point at the container itself. Orca fixes this: the gateway joins the networks of every routed container and carries every routed hostname as a network alias. Containers on those networks reach `https://auth.localhost` through the gateway, exactly as the browser does.

This matters for OIDC issuer URLs and other server-to-server calls by public name. The calling container must [trust the Orca CA](#trust-it-inside-containers) for HTTPS to verify. The default `bridge` network has no DNS, so this works on compose and user-defined networks only.

## Environment links

`links:` in a project's orca.yaml lists the project's addresses per environment, such as local, staging and production. The Gateway page shows them under **Environment Links**, with one tab per environment, and the landing page shows them too. A `local` link names a gateway hostname, optionally with a path; the others are full URLs. See [links](/docs/orca-yaml/#links).

## The landing page

The gateway's own address, `https://localhost` by default, is a page that lists every routed service as a card. Cards are grouped by project, and each shows whether the service runs and for how long: running, starting, unhealthy (from the container's healthcheck), sleeping or stopped. The page updates when containers start or stop and refreshes itself while it's open.

Open it with **Open Gateway** at the top of the Gateway page. Its settings are on the **Landing page** tab:

- **Title** and **Subtitle** at the top of the page.
- **Show status and uptime**.
- **Show container and port** behind each card.

Each card's title, description, group and icon come from the route:

| Route from | Set it with |
|---|---|
| Added by hand | **Edit** on the Landing page tab (or the route's edit dialog): **Title**, **Description**, **Group**, **Icon URL**, and **Hide** |
| orca.yaml | `title`, `description`, `group`, `icon`, `hidden` on the gateway entry |
| Labels | `orca.route.title`, `.description`, `.group`, `.icon`, `.hidden` (for a named route, `orca.route.<name>.title` and so on) |

Without a title, the card is named after the hostname. The group defaults to the compose project. An icon is an image URL (`https:` or `data:image/`). A hidden route still routes; it's only left off the page.

> [!NOTE]
> Anyone who can reach the gateway can see the landing page. It lists hostnames and, unless you switch it off, the container and port behind each one.

## Sleeping routes

A worktree instance can stop itself after a period without use (`dev.instance.idle_stop` in orca.yaml). Its routes stay, marked as sleeping. Opening one of its URLs shows a page that says the instance is starting and reloads itself every few seconds; Orca starts the instance in the background and the page turns into the app. See [idle stop](/docs/worktrees/#stop-unused-instances).

## Ports 80 and 443

The gateway needs ports 80 and 443 on your machine. If another program holds one of them, the Gateway page shows **Port Conflict Detected** with the port. Stop that program, or move the gateway to other ports in **HTTP Port** and **HTTPS Port** on the Configuration tab. **Check Ports** tests them first.

```bash
orca gateway config --http-port 8080 --https-port 8443
```

With another HTTPS port, URLs carry it, such as `https://shop.localhost:8443`. Orca includes it in instance URLs, `.orca/env` and the landing page.

### Kubernetes ingress

When Kubernetes runs with Traefik, the **Kubernetes Integration** section of the Configuration tab decides how the two share the machine: **Gateway Only** (independent), **Separate Ports** (Traefik moves to its own ports) or **Gateway Proxies Traefik** (one entry point; ingress hostnames are routed through the gateway).

## CLI reference

| Command | |
|---|---|
| `orca gateway status` | Whether the gateway runs. |
| `orca gateway start` / `stop` | Start or stop the gateway container. |
| `orca gateway routes` | List routes. |
| `orca gateway add <host> <container> <port>` | Add a route. Give the full hostname, such as `app.localhost`. |
| `orca gateway remove <host>` | Remove a route added by hand. |
| `orca gateway config` | Show the configuration. With `--domain`, `--http-port`, `--https-port`, `--tls-mode orca_ca\|custom`, `--cert-file` and `--key-file`, change it. |
| `orca ca install` | Add the Orca CA to the system trust store. |
| `orca ca export` | Print the CA certificate (PEM). |
| `orca ca info` | Show the CA's subject, expiry and fingerprint. |

## Related

- [orca.yaml reference](/docs/orca-yaml/): routes, links and the WebSocket recipe.
- [Worktree instances](/docs/worktrees/): a set of hostnames for every branch.
