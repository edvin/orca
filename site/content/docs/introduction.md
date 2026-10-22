---
title: What is Orca?
nav: Introduction
description: Orca is a free, open source desktop app for containers, compose stacks and Kubernetes, built for local development with real HTTPS hostnames, worktree instances and AI agents.
---

Orca runs your containers, compose stacks and a local Kubernetes cluster, and adds what local development usually needs on top: real HTTPS hostnames for every service, one file in the repo that sets a project up for the whole team, and a running copy of the app for every git worktree. AI agents can drive all of it through MCP.

It runs on macOS, Windows and Linux, and replaces Docker Desktop on all three.

![The Orca dashboard with containers, stacks, worktree instances, the gateway and live CPU and memory](/assets/screens/dashboard.webp)

## Who it's for

- **Developers** who run a project's services locally with Docker Compose and want them on proper hostnames instead of a list of ports.
- **Teams** that want a new colleague to clone a repository and have everything work the same way on their machine.
- **People working with AI agents** who want several branches running side by side, each with its own URLs and data, and an agent that can start, inspect and test them.
- **Anyone running a few servers** who wants to see and manage those containers from the same window.

## How it fits together

Orca has three parts:

| Part | What it does |
|---|---|
| **The desktop app** | The window you work in: containers, stacks, the gateway, projects, Kubernetes, settings. |
| **The daemon** (`orca-daemon`) | A small background service on `127.0.0.1:9477` that talks to Docker or Podman. The app, the `orca` CLI and AI agents all use its API. The app starts and updates it for you. |
| **The container runtime** | Docker or Podman. On macOS Orca runs it in a Linux VM with Lima; on Windows inside WSL2; on Linux directly. |

The same daemon can run on a Linux server, and the app can switch between your machine and any number of servers.

## The ideas worth knowing

**Stacks.** Every Docker Compose project Orca can see is a stack, however it was started: from Orca, from a terminal, or by a script. You don't import anything. See [Compose stacks](/docs/stacks/).

**The gateway.** A managed reverse proxy that gives services HTTPS hostnames like `https://shop.localhost`, with certificates from Orca's own certificate authority. Routes come from `orca.yaml`, container labels or a click. See [Gateway](/docs/gateway/).

**orca.yaml.** One file next to your compose file, committed to the repo, that holds the project's routes, links to its other environments, build targets, setup commands and worktree settings. Orca applies it the moment it changes. See the [orca.yaml reference](/docs/orca-yaml/).

**Profiles.** Compose's own `profiles:` mark optional services. Orca lets each developer switch them on and off and remembers the choice. See [Profiles](/docs/profiles/).

**Worktree instances.** Each git worktree of a project can run as its own copy of the app, with its own hostnames and ports, while databases and other infrastructure run once and are shared. See [Worktree instances](/docs/worktrees/).

**Agents.** The daemon is an MCP server. Claude Code and other agents can list containers, read logs, start stacks and run their own worktree instance to test a change. See [Agents and MCP](/docs/agents/).

## Where to start

1. [Install Orca](/docs/install/) for your platform.
2. Follow the [quickstart](/docs/quickstart/): run something, give it a hostname, and add an `orca.yaml`.
3. If you work on several branches at once, set up [worktree instances](/docs/worktrees/).
4. If you use an AI coding agent, [connect it](/docs/agents/).

Orca is MIT licensed and developed in the open at [github.com/edvin/orca](https://github.com/edvin/orca). Questions, bugs and ideas are welcome as [issues](https://github.com/edvin/orca/issues).
