---
title: Migrate from a reverse proxy
nav: Migrate from a reverse proxy
description: Move a team from a hand-run HAProxy, nginx or Traefik stack to a workspace: import the routes, keep containers and volumes, and roll it out.
---

Many teams run their local environment from a repo everyone clones: a reverse proxy (HAProxy, nginx or Traefik) on ports 80 and 443 with a wildcard certificate, a shared Docker network, a few shared services, a static dashboard page and some scripts to keep it all current. A workspace replaces all of that with one file Orca applies for you.

This page shows how to move such a setup over without changing your projects: import the routes, translate the special cases, keep container names and volumes, and switch the team over.

## What maps to what

| In the proxy repo | In the workspace |
|---|---|
| The proxy container (HAProxy, nginx, Traefik) and its config | Orca's gateway, and `routes` in `orca-workspace.yaml` |
| Hostname rules, such as `acl` + `use_backend` | [Routes](/docs/workspaces-routes/) with `hostname`, `path` and `websocket` |
| The wildcard certificate, and scripts that concatenate it into one PEM | `gateway.certificate` with the `.crt` and `.key` as they are. No concatenation needed. |
| A script that creates the shared Docker network | `network`: created when someone joins |
| The shared services in the proxy's compose file | `shared.compose`: the same compose file, minus the proxy |
| A static dashboard page listing every app | The gateway's [landing page](/docs/gateway/#the-landing-page), built from the routes, with `links` per environment from the shared stack's `orca.yaml` |
| A JSON or YAML file the dashboard reads links from | `links` in the shared stack's `orca.yaml` |
| "Update" or version-watch scripts that pull the repo | Orca pulls the workspace on every start; **Update** applies it at once |
| Post-start scripts, such as creating Temporal search attributes | `hooks.after_up` in the shared stack's `orca.yaml` |
| The proxy's stats page | The **Gateway** page in Orca |
| Network aliases on the proxy so containers reach `https://app.<domain>` | Automatic: the gateway carries every route hostname as an alias on the workspace network |
| A wiki page with every project's setup steps | `projects` in the workspace file: repo, `setup`, `uses`, `env` |

## 1. Import the HAProxy routes

If your proxy is HAProxy, Orca can turn its config into workspace routes. Run this with Orca running:

```bash
orca workspace import-haproxy path/to/haproxy.cfg --domain local.acme.dev
```

It prints a `routes:` list to paste into `orca-workspace.yaml`. Nothing is changed on your machine.

**What it imports.** Rules that say "this hostname goes to that backend":

- an `acl` that matches the host header exactly: `hdr(host)` or `req.hdr(host)`, with one or more hostnames, with or without `-i`;
- a `use_backend <backend> if <acl>` with that single condition;
- the backend's first `server` line, whose `address:port` becomes the `target` (port 80 when there's none);
- the backend's `description`, which becomes the route's `title`.

With `--domain`, hostnames under that domain are shortened to their first part, `billing.local.acme.dev` to `billing`, and a rule for the domain itself is dropped, since that's the landing page now. A hostname that appears in several rules is imported once, from the first.

Given this config:

```text title="haproxy.cfg"
frontend https
    acl is_billing  req.hdr(host) -i billing.local.acme.dev
    acl is_mail     hdr(host) -i mail.local.acme.dev mailpit.local.acme.dev
    acl is_ws       hdr(Connection) -i upgrade
    acl is_shop_ws  req.hdr(host) -i shop.local.acme.dev
    acl is_any_docs req.hdr(host) -m end -- -docs.local.acme.dev
    use_backend billing if is_billing
    use_backend mailpit if is_mail
    use_backend shop-ws if is_ws is_shop_ws
    use_backend docs if is_any_docs

backend billing
    description Billing
    server app billing-app:80
backend mailpit
    server mailpit mailpit:8025
backend shop-ws
    server reverb shop-reverb:8080
backend docs
    server docs docs-router:80
```

The import prints:

```yaml
routes:
- hostname: billing
  target: billing-app:80
  title: Billing
- hostname: mail
  target: mailpit:8025
- hostname: mailpit
  target: mailpit:8025

# Not imported: these rules need a look by hand (WebSocket special cases,
# hostname patterns, several conditions).
#   use_backend shop-ws if is_ws is_shop_ws
#   use_backend docs if is_any_docs
```

**What it lists for review.** Rules it can't translate safely are printed as comments under the routes:

- **WebSocket special cases**: rules that combine a host match with a `Connection: upgrade` or `Upgrade` check;
- **pattern hostnames**: `-m end`, `-m beg`, `-m reg`, `-m sub`, `hdr_end(host)`, `hdr_beg(host)` or `hdr_dom(host)`;
- **rules with several conditions**, such as a host and a path.

Rules that don't test the host at all are ignored. Translate the listed ones by hand, as below.

### Other proxies

There's no importer for nginx or Traefik. Write the routes by hand from each `server_name` (nginx) or `Host(...)` rule (Traefik): the hostname, and the container and port it proxies to. `location` blocks and `PathPrefix(...)` become `path` routes. The rest of this page applies the same way.

## 2. Translate the special cases

Each rule the importer lists becomes one or more routes. Common shapes:

**A WebSocket rule for one hostname**, a host match plus an upgrade check:

```text
use_backend shop-ws if is_ws is_shop_ws
```

```yaml
- { hostname: shop, target: "shop-reverb:8080", websocket: true }
```

**A suffix match**, such as every hostname ending in `-docs`:

```text
acl is_any_docs req.hdr(host) -m end -- -docs.local.acme.dev
```

```yaml
- { hostname: "*-docs", target: "docs-router:80" }
```

**A prefix match**, such as every hostname starting with `preview-`:

```yaml
- { hostname: "preview-*", target: "preview-router:80" }
```

**A host and a path**, such as `acl is_api path_beg /api` combined with a host match:

```yaml
- { hostname: shop, path: "/api*", target: "shop-api:8080" }
```

HAProxy's `path_beg /api` also matches `/apiary`; `/api*` does the same. Use `/api/*` if you only meant the folder.

**A default WebSocket backend**, a rule that sends every upgrade request not handled earlier to one server:

```text
use_backend soketi if is_ws
```

```yaml
- { hostname: "*", target: "soketi:6001", websocket: true }
```

**Regular expressions** have no direct equivalent. A `*` pattern covers "letters, digits and dashes in the first part of the name", which is what most local-dev regexes express. Anything more specific becomes a few exact routes.

You don't have to order the routes the way HAProxy needed its rules ordered. The gateway picks the most specific match itself: WebSocket routes, then exact hostnames, then patterns from most to least specific, with path routes before the rest of their hostname. See [Which route wins](/docs/workspaces-routes/#which-route-wins). Pattern rules that relied on HAProxy's order, such as a catch-all that comes last, usually work as they are.

## 3. Keep container names and volumes

Move the shared services' compose file into the workspace repo, minus the proxy and anything else Orca replaces (the dashboard container, update watchers). Keep everything else the same:

- **The compose project name.** Set it as `name:` in the compose file and as `shared.name` in the workspace file, with the old value, such as `devstack`. Compose names volumes after the project (`devstack_grafana-data`), so data such as dashboards, buckets and identity provider users carries over.
- **The container names.** Projects reach the shared services by name on the network (`devstack-mailpit`, `temporal`), in their `.env` files and compose files. Keep every `container_name` as it is, and route to the same names.
- **The network name.** Use the same `network:`; projects' compose files already join it as an external network.

```yaml title="orca-workspace.yaml"
network: local-dev
shared:
  compose: compose.yaml
  name: devstack        # the old compose project name, so its volumes are reused
```

With these kept, projects need no changes at all: the gateway joins the same network and routes to the same names the proxy did.

## 4. Stop the old proxy

The gateway needs ports 80 and 443, so the old proxy can't run next to it. Before joining, each developer stops it, from the old repo's folder:

```bash
docker compose down
```

This removes the old stack's containers but keeps its volumes, which the workspace's shared stack picks up when it has the same project name. Don't use `docker compose down -v`: `-v` deletes the volumes.

If the old proxy's containers restart by themselves (`restart: always`), `docker compose down` still removes them. A leftover proxy container that holds port 443 shows up as the gateway failing to start; see [Troubleshooting](/docs/workspaces-troubleshooting/#the-gateway-doesnt-start).

## 5. Roll it out

Running both side by side on one machine isn't possible, because both want ports 80 and 443. Plan a switch instead:

1. **Build the workspace** next to the old repo, following [Create a workspace](/docs/workspaces-create/), with the imported routes and the same names.
2. **Test it on your machine**: stop the old proxy, [join from the folder](/docs/workspaces-create/#7-test-it-yourself), and open every hostname on the landing page. Compare with the old dashboard. To go back, leave the workspace, stop the gateway on the **Gateway** page, and start the old proxy again.
3. **Pilot it** with a few developers for a week. Keep the old repo working meanwhile, so anyone can switch back the same way.
4. **Announce the switch**: the join link, the one command to stop the old proxy, and that projects and data stay as they are.
5. **Retire the old repo**: archive it, or leave a README that points to the workspace.

## A migration checklist

- [ ] Routes imported, special cases translated, landing page shows every app.
- [ ] Shared compose file moved, proxy and dashboard removed, project name and container names unchanged.
- [ ] Certificate files referenced under `gateway.certificate`, the repo private.
- [ ] Links per environment moved to the shared stack's `orca.yaml`, post-start scripts to its `hooks`.
- [ ] Each project listed with `repo`, `setup`, `uses`, `routes` and `env`.
- [ ] Tested on a machine with the old proxy stopped.
- [ ] Join link and the stop command shared with the team.

## Related

- [Create a workspace](/docs/workspaces-create/): every step in detail.
- [Routes](/docs/workspaces-routes/): patterns, paths, WebSockets and precedence.
- [Troubleshooting](/docs/workspaces-troubleshooting/): ports, certificates and routes.
