---
title: CLI reference
nav: CLI
description: Every orca command and flag, for containers, images, stacks, Kubernetes, the gateway, the CA, config and worktree instances.
---

The `orca` command talks to the Orca daemon, so you can script what the app does: run worktree instances, manage containers, stacks and the gateway, and install the CA certificate. This page lists every command and flag.

Run `orca --help` or `orca <command> --help` for the same information in your terminal.

## Install

The CLI ships with the desktop app, next to the daemon:

- **macOS**: `/Applications/Orca Desktop.app/Contents/MacOS/orca`. To use it as `orca`, link it into a folder on your `PATH`:

  ```bash
  sudo ln -s "/Applications/Orca Desktop.app/Contents/MacOS/orca" /usr/local/bin/orca
  ```

- **Windows**: the installer adds the install folder to your user `PATH`. Open a new terminal after installing.
- **Linux**: included in the `.deb` and AppImage bundles.

To build it from source:

```bash
cargo build --release --bin orca
./target/release/orca version
```

## Connect and authenticate

Every command except the `config` commands goes through the daemon API. Two global options control how:

| Option | Environment variable | Default | Purpose |
|--------|----------------------|---------|---------|
| `--token <TOKEN>` | `ORCA_TOKEN` | token from the config file | API token sent as a Bearer header |
| `--daemon-url <URL>` | `ORCA_DAEMON_URL` | `http://127.0.0.1:9477` | Daemon address |

Without `--token` or `ORCA_TOKEN`, the CLI reads `api_token` from Orca's config file (`~/Library/Application Support/orca/config.json` on macOS, `~/.config/orca/config.json` on Linux, `%APPDATA%\orca\config.json` on Windows). On the machine where the app runs you normally don't need to set anything.

To control a daemon on another machine:

```bash
ORCA_DAEMON_URL=http://build-box:9477 ORCA_TOKEN=... orca containers list
```

## Status and version

| Command | What it does |
|---------|--------------|
| `orca status` | Daemon health and version. Inside a registered project, also this worktree's instance: status, URLs and shared services. |
| `orca version` | CLI version and daemon version (or `daemon: not running`). |

`orca status` flags:

| Flag | Meaning |
|------|---------|
| `--all` | List every instance of the project. |
| `--json` | Machine-readable output, for the instance only. |

## Worktree instances

These commands work out the project and instance from the current folder, so you run them inside a git worktree of a registered project. Each worktree gets its own running copy of the app, while databases and other shared services run once.

### orca projects

```bash
orca projects add [PATH]      # register a git repo (default: current folder)
orca projects list [--json]   # registered projects, shared services and instances
orca projects remove <ID>     # unregister a project (stop its instances first)
```

Any worktree of a repo works for `add`.

### orca up

Start or rebuild this worktree's instance and wait until it's up. It prints each step, then the URLs and the path of the `.orca/env` file.

| Flag | Meaning |
|------|---------|
| `--profile <PROFILE>` | Compose profile to run as well. Repeat for several. Remembered for the next start; without it, the last choice is used. |
| `--no-build` | Don't rebuild images from this worktree's code. |
| `--json` | Print the finished job as JSON. |

### orca down

Stop this worktree's instance.

| Flag | Meaning |
|------|---------|
| `--remove` | Also delete its volumes, images, host ports and generated files. |
| `--json` | Print the finished job as JSON. |

### orca logs

```bash
orca logs [SERVICE] [--tail 200] [-f]
```

| Argument or flag | Meaning |
|------------------|---------|
| `SERVICE` | Only this service. Without it, all services. |
| `--tail <N>` | Lines per service. Default 200. |
| `-f`, `--follow` | Keep printing new lines. |

### orca env

Print the instance's URLs, ports and connection strings from `.orca/env` as shell exports:

```bash
eval $(orca env)
```

Run `orca up` first: the file doesn't exist until the instance has started.

### orca run

Run a command with the instance's environment. It starts the instance if it isn't running, loads `.orca/env` into the command's environment, and exits with the command's exit code.

```bash
orca run -- npm test
orca run --serve web -- npm run dev
```

| Flag | Meaning |
|------|---------|
| `--profile <PROFILE>` | Compose profile to run as well. Repeat for several. |
| `--serve <SERVICE>` | Run a dev server on your machine as `SERVICE`. The command gets a port in `$PORT`, `HOST=0.0.0.0` and the service's URL in `ORCA_URL_<SERVICE>`, and the service's URL routes to it through the gateway until the command ends. |
| `--down` | Stop the instance when the command ends. |
| `--no-up` | Don't start the instance; only pass its environment. |

Everything after `--` is the command and its arguments.

## Containers

```bash
orca containers list
orca containers start <ID>
orca containers stop <ID>
orca containers logs <ID> [--tail <N>]
orca containers exec <ID> -- <COMMAND> [ARGS...]
```

`<ID>` is a container ID or name. `exec` exits with the command's exit code.

## Images

```bash
orca images list
orca images pull <REFERENCE>    # for example nginx:alpine
orca images remove <ID>         # image ID or tag
orca images prune               # remove unused images
```

## Stacks

```bash
orca stacks list           # name, status, service count and directory
orca stacks up <NAME>      # docker compose up
orca stacks down <NAME>    # docker compose down
```

## Deploy

```bash
orca deploy <PATH>
orca deploy --template <ID>
```

| Argument or flag | Meaning |
|------------------|---------|
| `PATH` | A project folder with a compose file (`compose.yaml`, `compose.yml`, `docker-compose.yaml` or `docker-compose.yml`), or a `.yml` or `.yaml` compose file itself. A relative path is taken from the folder you run the command in. The stack is named after the folder. The daemon reads the files, so with `--daemon-url` pointing at a remote host, give an absolute path on that host. |
| `--template <ID>` | Deploy an app template by ID instead. Find IDs with `orca templates list`. |

## Templates

```bash
orca templates list
orca templates search <QUERY>   # matches name, description and category
```

## Kubernetes

```bash
orca k8s status              # enabled, running, version, node, pod counts
orca k8s enable
orca k8s disable
orca k8s runtime [VALUE]
```

`orca k8s runtime` without a value shows the cluster's container runtime. Set it to `docker` (the default, so images you build locally are usable without a push or import) or `containerd`.

## Machines

```bash
orca machine list
```

## Gateway

```bash
orca gateway status
orca gateway start
orca gateway stop
orca gateway routes
orca gateway add <HOST> <CONTAINER> <PORT>
orca gateway remove <HOST>
orca gateway config [flags]
```

`add` routes a hostname such as `app.localhost` to a container's port. `remove` deletes the route for a hostname.

`orca gateway config` shows the configuration when run without flags, or updates it:

| Flag | Meaning |
|------|---------|
| `--show` | Show the current config (the default with no flags). |
| `--domain <DOMAIN>` | Set the gateway domain. |
| `--http-port <PORT>` | Set the HTTP port. |
| `--https-port <PORT>` | Set the HTTPS port. |
| `--tls-mode <MODE>` | `orca_ca` or `custom`. |
| `--cert-file <PATH>` | PEM certificate file, for custom TLS. |
| `--key-file <PATH>` | PEM key file, for custom TLS. |

See [Gateway](/docs/gateway/) for how hostnames and certificates work.

## CA certificate

```bash
orca ca info      # subject, expiry and fingerprint
orca ca export    # print the CA certificate (PEM) to stdout
orca ca install   # add it to the system trust store
```

`orca ca install` uses `sudo security add-trusted-cert` on macOS, `sudo update-ca-certificates` on Linux and `certutil` on Windows, so expect a password prompt on macOS and Linux. If it fails, it prints the command to run by hand and where it saved the certificate.

## Config

These commands read and write Orca's config file directly, without going through the daemon. They cover the gateway settings.

```bash
orca config export [--include-secrets] > orca-config.yaml
orca config import orca-config.yaml
orca config get <KEY>
orca config set <KEY> <VALUE>
```

| Command | Meaning |
|---------|---------|
| `export` | Print the gateway domain, ports, TLS mode and routes as YAML. `--include-secrets` adds the custom certificate and key. |
| `import <FILE>` | Apply gateway settings and routes from a YAML file. |
| `get <KEY>` / `set <KEY> <VALUE>` | Read or change one value. |

Valid keys are `gateway.domain`, `gateway.http_port`, `gateway.https_port` and `gateway.tls_mode` (`orca_ca` or `custom`).
