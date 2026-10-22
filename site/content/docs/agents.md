---
title: AI agents and MCP
nav: Agents & MCP
description: Connect Claude Code and other MCP clients to Orca, use the OpenAI-compatible and direct tool endpoints, and see every agent tool.
---

Orca's daemon exposes its container, stack, Kubernetes and worktree operations as tools that AI agents can call. This page shows how to connect Claude Code or another MCP client, how to call the same tools over plain HTTP, and lists every tool.

All agent endpoints live on the local daemon at `http://127.0.0.1:9477/api/v1/agent/` and need the daemon's API token.

## Get your API token

Open **Settings → AI & Agents** and scroll to **Agent Integration**. It shows:

- **MCP Server Config**: a ready-made JSON block. The copy button fills in your real token.
- **OpenAI-Compatible Endpoint**: the endpoint URL and the **API Token**, with buttons to reveal and copy it.

The token is created the first time the daemon starts and stored as `api_token` in Orca's config file:

| Platform | Config file |
|----------|-------------|
| macOS | `~/Library/Application Support/orca/config.json` |
| Linux | `~/.config/orca/config.json` (or `/etc/orca/config.json` if it exists) |
| Windows | `%APPDATA%\orca\config.json` |

```bash
# macOS
python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/Library/Application Support/orca/config.json')))['api_token'])"
```

> [!WARNING]
> The token gives full control over your containers and clusters. Keep it out of files you commit, such as a shared `.mcp.json`.

## Connect Claude Code

Orca speaks MCP over HTTP at `http://127.0.0.1:9477/api/v1/agent/mcp`, with the token as a Bearer header. Add it with the `claude` CLI:

```bash
claude mcp add --transport http orca http://127.0.0.1:9477/api/v1/agent/mcp \
  --header "Authorization: Bearer YOUR_TOKEN_HERE"
```

Add `--scope user` to make it available in every project instead of only the current one.

Or put the server in a `.mcp.json` file in your project. This is the same block that **Agent Integration** copies for you:

```json title=".mcp.json"
{
  "mcpServers": {
    "orca": {
      "type": "http",
      "url": "http://127.0.0.1:9477/api/v1/agent/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}
```

When an agent connects, Orca sends instructions that tell it when to use the worktree tools. Each tool also carries hints: read-only tools (listing, logs, status) are marked `readOnlyHint`, and tools that delete things (`remove_*`, `prune_images`, `k8s_delete_pod`, `compose_down`, `instance_down`, `instance_db_reset`) are marked `destructiveHint`, so clients that respect these hints can ask before running them.

## Other MCP clients

Any MCP client that can connect to an HTTP server and send a custom header works with the same URL and `Authorization: Bearer <token>` header. The endpoint takes JSON-RPC over `POST` and supports `initialize`, `ping`, `tools/list` and `tools/call` (protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05`).

Clients that can only launch local stdio servers need a bridge that forwards to an HTTP server. Orca doesn't ship one.

## Agents working in git worktrees

If your project is registered with Orca, each git worktree can run its own instance of the app: its own URLs and ports, with databases and other shared services running once. An agent working in a worktree passes its worktree path to the `instance_*` tools:

1. `instance_up` starts or rebuilds this branch's instance and returns its URLs, host ports and the path of its `.orca/env` file.
2. `instance_status` or `instance_env` gives the URLs and ports to test against.
3. `instance_logs` shows what went wrong.
4. `instance_down` stops it when the work is done.

Before running migrations or writing test data, ask for an own copy of the database so other worktrees aren't affected, for example `"data": {"postgres": "own-database"}` on `instance_up`. The modes are `shared`, `own-database` and `own-server`.

When you set up a project for worktrees in Orca, the setup dialog can also add a short section to the project's `CLAUDE.md` or `AGENTS.md` that tells coding agents to use `orca up`, `.orca/env` and these MCP tools. The same commands are available from the shell: see [CLI reference](/docs/cli/#worktree-instances).

## OpenAI-compatible endpoint

Agent frameworks that use OpenAI-style function calling can send tool calls to:

```text
POST http://127.0.0.1:9477/api/v1/agent/openai/chat/completions
Authorization: Bearer YOUR_TOKEN_HERE
```

This endpoint doesn't run a model. It executes the tool calls you send and returns their results:

- It reads `tool_calls` from the last `assistant` message in `messages`, or from a top-level `tool_calls` array.
- Each result comes back in `tool_results` as a `role: "tool"` message with the matching `tool_call_id`.
- A request without tool calls returns the tool list in OpenAI function format.
- At most 16 tool calls are accepted per request.

```bash
curl -X POST http://127.0.0.1:9477/api/v1/agent/openai/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{
      "role": "assistant",
      "tool_calls": [{
        "id": "call_1",
        "type": "function",
        "function": { "name": "container_logs", "arguments": "{\"id\": \"web\", \"tail\": 50}" }
      }]
    }]
  }'
```

## Direct tool execution

For scripts and custom integrations, list the tools and call one at a time.

```bash
# Tool definitions in OpenAI function format
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:9477/api/v1/agent/tools

# Run one tool
curl -X POST http://127.0.0.1:9477/api/v1/agent/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool": "diagnose_container", "arguments": {"id": "web"}}'
```

A successful call returns `{"result": ...}`. A failed one returns HTTP 400 with `{"error": "..."}`.

## Tool reference

Orca has 48 agent tools. The same set is available over MCP, the OpenAI-compatible endpoint, direct execution, and to the built-in [AI assistant](/docs/ai-assistant/).

### Containers

| Tool | What it does |
|------|--------------|
| `list_containers` | List all containers with status, ports and resource usage. |
| `inspect_container` | Container details: env vars, mounts, network settings, exit code and errors. |
| `container_logs` | Recent log lines (`tail`, default 100). |
| `container_stats` | Current CPU, memory and network usage. |
| `start_container` | Start a stopped container. |
| `stop_container` | Stop a running container gracefully. |
| `restart_container` | Stop and start a container. |
| `exec_in_container` | Run a command inside a running container and return the output. |
| `create_and_run_container` | Create and start a container from an image, with ports, env, volumes and CPU/memory limits. |
| `remove_container` | Remove a stopped container (`force` to remove a running one). |

### Diagnostics

| Tool | What it does |
|------|--------------|
| `diagnose_container` | Inspect data, recent logs, resource stats and exit info in one call. |
| `check_port_availability` | Check whether a host port is free or which container uses it. |
| `system_health` | Docker connection, disk, memory, CPU and warnings. |
| `environment_status` | Whether the container runtime is installed and running. |

### Images

| Tool | What it does |
|------|--------------|
| `list_images` | List images with tags, sizes and creation dates. |
| `pull_image` | Pull an image from a registry. |
| `remove_image` | Remove an image. |
| `prune_images` | Remove all unused images. |

### Stacks

| Tool | What it does |
|------|--------------|
| `list_stacks` | List Compose stacks with their services and status. |
| `compose_up` | Run `docker compose up` for a stack. |
| `compose_down` | Run `docker compose down` for a stack. |

### Storage and networking

| Tool | What it does |
|------|--------------|
| `list_volumes` | List Docker volumes. |
| `list_networks` | List Docker networks. |
| `create_network` | Create a Docker network (`driver`, default `bridge`). |

### Templates

| Tool | What it does |
|------|--------------|
| `list_templates` | List the one-click app templates. |
| `deploy_template` | Deploy a template by ID, with optional name, port and env overrides. |

### Kubernetes

| Tool | What it does |
|------|--------------|
| `k8s_status` | Cluster version, node info and pod counts. |
| `k8s_list_namespaces` | List namespaces. |
| `k8s_list_pods` | List pods in a namespace. |
| `k8s_list_deployments` | List deployments in a namespace. |
| `k8s_list_services` | List services in a namespace. |
| `k8s_list_ingresses` | List ingresses in a namespace. |
| `k8s_list_configmaps` | List ConfigMaps in a namespace. |
| `k8s_list_secrets` | List Secrets in a namespace (names only, not values). |
| `k8s_list_events` | List recent events in a namespace. |
| `k8s_pod_logs` | Logs from a pod. |
| `k8s_get_yaml` | YAML manifest of a resource by kind, namespace and name. |
| `k8s_apply_yaml` | Apply a YAML manifest. |
| `k8s_scale_deployment` | Scale a deployment to a number of replicas. |
| `k8s_restart_deployment` | Rolling restart of a deployment. |
| `k8s_delete_pod` | Delete a pod so its controller recreates it. |
| `k8s_helm_list` | List installed Helm releases. |

### Worktree instances

Each of these takes `worktree`, the absolute path of the git worktree.

| Tool | What it does |
|------|--------------|
| `instance_status` | Whether the instance runs, its URLs, host ports, services, shared services and env file path. |
| `instance_up` | Start or rebuild the instance and wait until it's up. Options: `profiles`, `rebuild` (default true), `data` modes per shared service. |
| `instance_down` | Stop the instance. `remove: true` also deletes its volumes, images, own databases and generated files. |
| `instance_logs` | Recent logs, all services or one `service` (`tail`, default 200 per service). |
| `instance_env` | URLs, host ports and database names as key/value pairs (the contents of `.orca/env`). |
| `instance_db_reset` | Reset the worktree's own database in a shared service to a fresh copy of the shared data. |

## Related

- [AI assistant](/docs/ai-assistant/): the chat window built into Orca, which uses these tools.
- [REST API](/docs/api/): every daemon endpoint.
- [CLI reference](/docs/cli/): `orca up`, `orca env` and the rest from the shell.
