---
title: REST API
nav: REST API
description: Base URL, authentication, the event stream and a reference of every Orca daemon endpoint, with curl examples.
---

Everything the Orca app does goes through the daemon's REST API, so you can script it too. This page covers authentication, the event stream, and lists every endpoint grouped by area.

For AI agents, the [MCP and agent endpoints](/docs/agents/) are usually a better fit. For the shell, see the [CLI](/docs/cli/).

## Base URL

```text
http://127.0.0.1:9477/api/v1
```

The daemon listens on the loopback address only, unless it was started with a different `--bind` address.

## Authentication

Every request needs the daemon's API token as a Bearer header:

```text
Authorization: Bearer <token>
```

Find the token in **Settings → AI & Agents → Agent Integration**, or as `api_token` in the config file (`~/Library/Application Support/orca/config.json` on macOS, `~/.config/orca/config.json` on Linux, `%APPDATA%\orca\config.json` on Windows). A missing or wrong token returns `401`.

Exceptions:

- `GET /health` and `GET /ca/certificate` need no token.
- WebSocket endpoints (`/containers/{id}/terminal`, `/k8s/pods/{namespace}/{name}/terminal`, `/k8s/enable-stream`, `/tunnel`) take the token as a `?token=` query parameter.
- `/webhooks/github` and `/webhooks/dockerhub` are checked with the webhook secret instead.

Errors come back as JSON: `{"error": "message"}`. Authenticated responses carry an `x-orca-version` header with the daemon version.

## Examples

Check that the daemon runs:

```bash
curl -s http://127.0.0.1:9477/api/v1/health
# {"status":"ok","version":"..."}
```

List containers:

```bash
TOKEN=...   # from Settings or the config file
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9477/api/v1/containers
```

Read the last 50 log lines of a container without following:

```bash
curl -sN -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:9477/api/v1/containers/web/logs?tail=50&follow=false"
```

Run a command in a container:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://127.0.0.1:9477/api/v1/containers/web/exec \
  -d '{"command": ["ls", "-la", "/app"]}'
```

## Event stream

`GET /events` is a Server-Sent Events stream of changes in the engine. Each event has a type and a JSON `data` payload:

| Event | When |
|-------|------|
| `container.created`, `container.started`, `container.stopped`, `container.died`, `container.removed` | Container lifecycle |
| `image.pulled`, `image.removed` | Image changes |
| `volume.created`, `volume.removed` | Volume changes |
| `build.started`, `build.completed` | Image builds |
| `machine.started`, `machine.stopped`, `machine.error` | Machine state |
| `dev.instance` | Worktree instance changes |

A `keepalive` comment is sent every 15 seconds.

```bash
curl -sN -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9477/api/v1/events
```

## Endpoint reference

Paths are relative to `/api/v1`. `{id}` accepts a container or image ID or name.

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Status and daemon version. No token needed. |
| GET | `/events` | Server-Sent Events stream. |
| GET | `/system/health` | Engine connection, disk, memory, CPU and warnings. `?refresh=1` recomputes disk usage. |
| GET | `/system/host-uid` | Host UID:GID, for running containers as the host user. |
| GET | `/machines` | List machines. |
| GET | `/machines/{name}` | Inspect a machine. |

### Containers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/containers` | List all containers. |
| POST | `/containers` | Create a container. |
| GET | `/containers/stats` | Stats for all running containers. |
| GET | `/containers/{id}` | Inspect a container. |
| DELETE | `/containers/{id}` | Remove a container. |
| POST | `/containers/{id}/start` | Start. |
| POST | `/containers/{id}/stop` | Stop. |
| POST | `/containers/{id}/kill` | Kill. |
| POST | `/containers/{id}/update` | Change CPU and memory limits or restart policy. |
| POST | `/containers/{id}/rename` | Rename. |
| POST | `/containers/{id}/commit` | Commit the container to an image. |
| GET | `/containers/{id}/stats` | CPU, memory and network usage. |
| GET | `/containers/{id}/logs` | Logs as Server-Sent Events. `?tail=` (default 200), `?follow=` (default true). |
| POST | `/containers/{id}/exec` | Run a command and return its output. |
| GET | `/containers/{id}/terminal` | Interactive terminal (WebSocket). |
| GET | `/containers/{id}/files` | List files in the container. |
| GET | `/containers/{id}/file` | Read a file from the container. |
| GET | `/containers/{id}/export/run` | Equivalent `docker run` command. |
| GET | `/containers/{id}/export/compose` | Equivalent Compose service definition. |
| GET | `/containers/{id}/export/tar` | Export the container filesystem as a tar archive. |

### Images

| Method | Path | Description |
|--------|------|-------------|
| GET | `/images` | List images. |
| GET | `/images/{id}` | Inspect an image. |
| DELETE | `/images/{id}` | Remove an image. |
| POST | `/images/pull` | Pull an image. |
| POST | `/images/build` | Build an image. |
| POST | `/images/prune` | Remove unused images. |
| POST | `/images/batch-delete` | Remove several images. |
| GET | `/images/search` | Search Docker Hub. |
| POST | `/images/{source}/tag` | Tag an image. |
| POST | `/images/import` | Load an image from a tar file on disk. |
| GET | `/images/{id}/save` | Download an image as a tar archive. |
| GET | `/images/{id}/files` | List files in an image. |
| GET | `/images/{id}/file` | Read a file from an image. |
| GET | `/images/{id}/history` | Layer history. |
| GET | `/images/{id}/scan` | Vulnerability scan. |

### Builds

| Method | Path | Description |
|--------|------|-------------|
| GET | `/builds` | List builds. |
| POST | `/builds` | Start a build. |
| POST | `/builds/from-url` | Build from a Git or HTTP(S) URL. |
| GET | `/builds/stats` | Build statistics. |
| POST | `/builds/compare` | Compare two builds. |
| GET | `/builds/targets` | List build targets from stacks' `orca.yaml` files. |
| POST | `/builds/targets/{name}` | Start a build from a named target. |
| GET | `/builds/{id}` | Build details. |
| DELETE | `/builds/{id}` | Delete a build record. |
| GET | `/builds/{id}/logs` | Build log. |
| POST | `/builds/{id}/cancel` | Cancel a running build. |

### Registries

| Method | Path | Description |
|--------|------|-------------|
| GET | `/registries` | List saved registry credentials. |
| POST | `/registries` | Add registry credentials. |
| DELETE | `/registries/{server}` | Remove registry credentials. |

### Volumes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/volumes` | List volumes. |
| POST | `/volumes` | Create a volume. |
| GET | `/volumes/sizes` | Disk usage per volume. `?refresh=1` recomputes. |
| GET | `/volumes/{name}` | Inspect a volume. |
| DELETE | `/volumes/{name}` | Remove a volume. |
| GET | `/volumes/{name}/files` | List files in a volume. |
| GET | `/volumes/{name}/file` | Read a file from a volume. |
| GET | `/volumes/{name}/containers` | Containers using the volume. |

### Networks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/networks` | List networks. |
| POST | `/networks` | Create a network. |
| GET | `/networks/topology` | Containers and networks as a graph. |
| GET | `/networks/{name}` | Inspect a network. |
| DELETE | `/networks/{name}` | Remove a network. |

### Stacks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/stacks` | List Compose stacks. |
| GET | `/stacks/{name}` | Stack details. |
| POST | `/stacks/{name}/start` | Start the stack's containers. |
| POST | `/stacks/{name}/stop` | Stop the stack's containers. |
| POST | `/stacks/{name}/restart` | Restart the stack's containers. |
| POST | `/stacks/{name}/up` | `docker compose up`. |
| POST | `/stacks/{name}/down` | `docker compose down`. |
| POST | `/stacks/{name}/pull` | `docker compose pull`. |
| PATCH | `/stacks/{name}/env` | Set one variable in the stack's `.env` file. |
| GET, PUT | `/stacks/{name}/profiles` | Read or set the Compose profiles to run. |
| GET, PUT | `/stacks/{name}/orca-yaml` | Read or save the stack's `orca.yaml`. |
| GET | `/stacks/{name}/dir` | The stack's directory. |
| POST | `/stacks/deploy` | Bring up a stack from a folder in Orca's stacks directory. |
| POST | `/stacks/validate` | Validate a Compose file. |
| POST | `/orca-yaml/validate` | Validate `orca.yaml` content. |

### Templates

| Method | Path | Description |
|--------|------|-------------|
| GET | `/templates` | List app templates. |
| POST | `/templates/refresh` | Refresh the community template catalog. |
| POST, DELETE | `/templates/user` | Save or delete a user template. |
| POST | `/templates/{id}/deploy` | Deploy a template. |

### Worktree projects and instances

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dev/projects` | List registered projects. |
| POST | `/dev/projects` | Register a git repo. |
| GET | `/dev/projects/{id}` | Project details and instances. |
| DELETE | `/dev/projects/{id}` | Unregister a project. |
| GET | `/dev/projects/{id}/setup` | Analyse the repo for worktree setup. |
| PUT | `/dev/projects/{id}/orca-yaml` | Write the project's `orca.yaml`. |
| POST | `/dev/projects/{id}/orca-yaml/validate` | Validate `orca.yaml` for the project. |
| POST | `/dev/projects/{id}/agents-snippet` | Add the Orca section to `CLAUDE.md` or `AGENTS.md`. |
| POST | `/dev/projects/{id}/adopt` | Take over an existing Compose stack's data as the shared services. |
| POST | `/dev/projects/{id}/shared/up` | Start the shared services. |
| POST | `/dev/projects/{id}/shared/down` | Stop the shared services. |
| PUT | `/dev/projects/{id}/instances/{name}` | Change an instance's settings. |
| GET | `/dev/projects/{id}/instances/{name}/plan` | Preview what `up` would do. |
| POST | `/dev/projects/{id}/instances/{name}/up` | Start or rebuild an instance (returns a job). |
| POST | `/dev/projects/{id}/instances/{name}/down` | Stop an instance (returns a job). |
| POST | `/dev/projects/{id}/instances/{name}/remove` | Stop an instance and delete its volumes, images and generated files (returns a job). |
| GET | `/dev/projects/{id}/instances/{name}/logs` | Instance logs. |
| GET | `/dev/projects/{id}/instances/{name}/data` | Data mode per shared service. |
| POST | `/dev/projects/{id}/instances/{name}/data/{service}/reset` | Reset the instance's own database. |
| POST, DELETE | `/dev/projects/{id}/instances/{name}/host-routes/{service}` | Route a service to a dev server on the host, or remove that route. |
| GET | `/dev/jobs` | List jobs. |
| GET | `/dev/jobs/{id}` | Job status and steps. |
| POST | `/dev/resolve` | Find the project and instance for a path. |
| GET | `/dev/candidates` | Git repos with running Compose stacks that aren't registered yet. |

### Gateway

| Method | Path | Description |
|--------|------|-------------|
| GET | `/gateway/status` | Running state, domain, ports and route count. |
| POST | `/gateway/start` | Start the gateway. |
| POST | `/gateway/stop` | Stop the gateway. |
| GET | `/gateway/routes` | List routes. |
| POST | `/gateway/routes` | Add a route. |
| PUT | `/gateway/routes/{hostname}` | Update a route. |
| DELETE | `/gateway/routes/{hostname}` | Remove a route. |
| GET, PUT | `/gateway/config` | Read or update domain, ports and TLS settings. |
| GET, PUT | `/gateway/landing` | Read or update the landing page settings. |
| GET, PUT | `/gateway/links` | Read or update stack link groups. |
| GET | `/gateway/port-check` | Check whether the HTTP and HTTPS ports are free. |
| GET | `/gateway/traefik-status` | Status of the k3s Traefik integration. |
| PUT | `/gateway/traefik-mode` | Set how the gateway works with k3s Traefik. |
| POST | `/gateway/dismiss-suggestion` | Dismiss a route suggestion. |
| POST | `/gateway/clear-dismissed` | Clear dismissed suggestions. |
| GET | `/gateway/dismissed-suggestions` | List dismissed suggestions. |

### CA

| Method | Path | Description |
|--------|------|-------------|
| GET | `/ca/certificate` | The Orca CA certificate (PEM). No token needed. |
| GET | `/ca/info` | Subject, expiry and fingerprint. |

### Kubernetes cluster

| Method | Path | Description |
|--------|------|-------------|
| GET | `/k8s/status` | Cluster status. |
| POST | `/k8s/enable` | Enable Kubernetes. |
| GET | `/k8s/enable-stream` | Enable with progress output (WebSocket). |
| POST | `/k8s/disable` | Disable Kubernetes. |
| POST | `/k8s/start` | Start the cluster. |
| POST | `/k8s/reset` | Reset the cluster. |
| GET, PUT | `/k8s/runtime` | Read or set the container runtime (`docker` or `containerd`). |
| GET | `/k8s/kubeconfig` | Kubeconfig for the cluster. |
| POST | `/k8s/apply` | Apply a YAML manifest. |
| GET | `/k8s/yaml/{kind}/{namespace}/{name}` | YAML of a resource. |
| GET | `/k8s/events/{namespace}` | Recent events. |
| GET | `/k8s/metrics/{namespace}` | Pod CPU and memory metrics. |
| GET | `/k8s/storage-classes` | List storage classes. |
| GET | `/k8s/crds` | List custom resource definitions. |
| GET | `/k8s/pvs` | List persistent volumes. |

### Kubernetes workloads

| Method | Path | Description |
|--------|------|-------------|
| GET | `/k8s/namespaces` | List namespaces. |
| POST | `/k8s/namespaces` | Create a namespace. |
| DELETE | `/k8s/namespaces/{name}` | Delete a namespace. |
| GET | `/k8s/pods/{namespace}` | List pods. |
| DELETE | `/k8s/pods/{namespace}/{name}` | Delete a pod. |
| GET | `/k8s/pods/{namespace}/{name}/logs` | Pod logs. |
| GET | `/k8s/pods/{namespace}/{name}/terminal` | Interactive shell in a pod (WebSocket). |
| GET | `/k8s/deployments/{namespace}` | List deployments. |
| POST | `/k8s/deployments/{namespace}/{name}/scale` | Scale a deployment. |
| POST | `/k8s/deployments/{namespace}/{name}/restart` | Rolling restart. |
| GET | `/k8s/deployments/{namespace}/{name}/history` | Rollout history. |
| POST | `/k8s/deployments/{namespace}/{name}/rollback` | Roll back a deployment. |
| GET | `/k8s/statefulsets/{namespace}` | List StatefulSets. |
| POST | `/k8s/statefulsets/{namespace}/{name}/scale` | Scale a StatefulSet. |
| POST | `/k8s/statefulsets/{namespace}/{name}/restart` | Restart a StatefulSet. |
| DELETE | `/k8s/statefulsets/{namespace}/{name}` | Delete a StatefulSet. |
| GET | `/k8s/daemonsets/{namespace}` | List DaemonSets. |
| DELETE | `/k8s/daemonsets/{namespace}/{name}` | Delete a DaemonSet. |
| GET | `/k8s/replicasets/{namespace}` | List ReplicaSets. |
| DELETE | `/k8s/replicasets/{namespace}/{name}` | Delete a ReplicaSet. |
| GET | `/k8s/jobs/{namespace}` | List Jobs. |
| DELETE | `/k8s/jobs/{namespace}/{name}` | Delete a Job. |
| GET | `/k8s/cronjobs/{namespace}` | List CronJobs. |
| POST | `/k8s/cronjobs/{namespace}/{name}/trigger` | Run a CronJob now. |
| PUT | `/k8s/cronjobs/{namespace}/{name}/suspend` | Suspend or resume a CronJob. |
| DELETE | `/k8s/cronjobs/{namespace}/{name}` | Delete a CronJob. |
| GET | `/k8s/hpas/{namespace}` | List HorizontalPodAutoscalers. |
| POST | `/k8s/hpas/{namespace}` | Create a HorizontalPodAutoscaler. |
| DELETE | `/k8s/hpas/{namespace}/{name}` | Delete a HorizontalPodAutoscaler. |

### Kubernetes networking, config and storage

| Method | Path | Description |
|--------|------|-------------|
| GET | `/k8s/services/{namespace}` | List services. |
| GET | `/k8s/ingresses/{namespace}` | List ingresses. |
| GET | `/k8s/network-policies/{namespace}` | List network policies. |
| DELETE | `/k8s/network-policies/{namespace}/{name}` | Delete a network policy. |
| GET | `/k8s/configmaps/{namespace}` | List ConfigMaps. |
| GET | `/k8s/secrets/{namespace}` | List Secrets. |
| POST | `/k8s/secrets/{namespace}` | Create a Secret. |
| PUT | `/k8s/secrets/{namespace}/{name}` | Update a Secret. |
| DELETE | `/k8s/secrets/{namespace}/{name}` | Delete a Secret. |
| GET | `/k8s/pvcs/{namespace}` | List PersistentVolumeClaims. |
| POST | `/k8s/pvcs/{namespace}` | Create a PersistentVolumeClaim. |
| DELETE | `/k8s/pvcs/{namespace}/{name}` | Delete a PersistentVolumeClaim. |

### Helm

| Method | Path | Description |
|--------|------|-------------|
| GET | `/k8s/helm/releases` | List installed releases. |
| GET | `/k8s/helm/available` | Whether Helm is available. |
| POST | `/k8s/helm/install` | Install a chart. |
| POST | `/k8s/helm/uninstall` | Uninstall a release. |

### Deploy rules and schedules

| Method | Path | Description |
|--------|------|-------------|
| GET | `/deploy/rules` | List auto-deploy rules. |
| POST | `/deploy/rules` | Save a rule. |
| DELETE | `/deploy/rules/{id}` | Delete a rule. |
| GET | `/deploy/history` | Deploy history. |
| POST | `/deploy/test` | Dry run: which rules a webhook would trigger. |
| POST | `/deploy/webhook-secret` | Set the webhook secret. |
| POST | `/webhooks/github` | GitHub webhook receiver (signed with the webhook secret). |
| POST | `/webhooks/dockerhub` | Docker Hub webhook receiver. |
| GET | `/schedules` | List scheduled actions. |
| POST | `/schedules` | Save a scheduled action (cron expression). |
| DELETE | `/schedules/{id}` | Delete a scheduled action. |

### Environment

| Method | Path | Description |
|--------|------|-------------|
| GET | `/environment/status` | Runtime environment checks. |
| POST | `/environment/fix` | Run a fix action. |
| POST | `/environment/fix-stream` | Run a fix action with streamed output. |
| GET | `/environment/docker-desktop-status` | Whether Docker Desktop is installed or running. |
| POST | `/environment/switch-to-orca` | Switch the Docker CLI to Orca's runtime. |
| POST | `/environment/stop-docker-desktop` | Stop Docker Desktop. |

### AI and settings

| Method | Path | Description |
|--------|------|-------------|
| POST | `/ai/ask` | Ask the built-in assistant (`query`, optional `context` and `history`). |
| GET, POST | `/settings/ai` | Read or save the AI provider, key, model and URL. |
| GET | `/settings/ai/models` | Models available from the configured provider. |
| GET, POST | `/settings/general` | Read or save general settings (start on login, tray icon, telemetry, Docker Desktop URL handling). |
| GET, POST | `/settings/lima` | Read or change the Lima VM's CPUs, memory and disk (macOS). |
| POST | `/settings/cleanup` | Clean up config, VMs, templates or Docker resources. |
| POST | `/settings/reconnect` | Reconnect to the container runtime. |

### Agents

| Method | Path | Description |
|--------|------|-------------|
| POST | `/agent/mcp` | MCP JSON-RPC endpoint. |
| GET | `/agent/tools` | Agent tool definitions in OpenAI function format. |
| POST | `/agent/execute` | Run one tool: `{"tool": "...", "arguments": {...}}`. |
| POST | `/agent/openai/chat/completions` | Execute OpenAI-style tool calls. |

See [AI agents and MCP](/docs/agents/) for request formats and the tool list.

### Tunnel

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tunnel` | TCP port forwarding over WebSocket (`?host=`, `?port=`, `?token=`). |
