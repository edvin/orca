---
title: How Orca runs on macOS, Windows and Linux
nav: Platforms
description: Where Docker runs on each platform (a Lima VM on macOS, WSL2 on Windows, natively on Linux), how to size it, and where Orca keeps its files.
---

Orca has the same three parts everywhere: the desktop app, the Orca daemon, and a Docker (or Podman) engine. What differs per platform is where that engine runs. Read this page when you want to know what Orca set up on your machine, change the VM's resources, or find a config file.

## The daemon

The desktop app starts `orca-daemon` in the background and stops it when you quit with **Quit Orca**. The daemon serves a REST API on `http://127.0.0.1:9477/api/v1/`, only on the loopback interface. The app, the `orca` CLI and AI agents all go through it.

- Every request needs the API token from `config.json` as `Authorization: Bearer <token>`, except `GET /api/v1/health`.
- The daemon creates the token on its first start.
- If the daemon exits unexpectedly, the app restarts it, up to 3 times in 10 minutes.
- If a daemon of a different version is already running when the app starts (for example after an update), the app replaces it with its own.

Check that it's up and which version it runs:

```bash
curl -s http://127.0.0.1:9477/api/v1/health
```

```json
{"status":"ok","version":"0.50.0"}
```

## macOS: a Lima VM

Containers need a Linux kernel, so on macOS Docker runs in a VM named `orca`, managed by [Lima](https://lima-vm.io). Orca creates it during first-start setup (see [Install](/docs/install/#macos)).

| | |
|---|---|
| Hypervisor | Apple Virtualization.framework (`vmType: vz`) |
| Guest | Ubuntu 26.04 LTS, Docker from Lima's `docker` template |
| x86 images | Rosetta is enabled, so `linux/amd64` images run on Apple Silicon |
| File sharing | VirtioFS. Your home folder, `/Volumes` and `/private` are mounted writable |
| CPUs and memory | 4 CPUs; memory is half your Mac's RAM, between 4 and 16 GiB |
| Host to guest | SSH and the Docker socket travel over vsock |
| Docker socket | `~/.lima/orca/sock/docker.sock`, Docker context `lima-orca` |

### Ports

Any container port published on `0.0.0.0` in the VM is forwarded to `127.0.0.1` on your Mac, for all TCP ports. `docker run -p 8080:80 nginx` is reachable at `http://localhost:8080`, as with Docker Desktop.

### Bind mounts and file ownership

The Ubuntu 26.04 kernel supports idmapped mounts natively, which is what lets `chmod`, `chown` and non-root containers work on bind-mounted folders from your Mac. VMs created by older Orca versions run Ubuntu 24.04, where Orca installs the newer HWE kernel for the same reason.

### Why vsock

Lima normally reaches the VM over a virtual network. Behind a mesh VPN (NetBird, Tailscale, WireGuard), that path can break and the VM never becomes reachable. The current VM carries SSH and the Docker socket over vsock, a channel between the hypervisor and the guest that a VPN can't intercept, and gives the guest a fixed network address instead of asking for one over DHCP.

If System Health shows **Docker VM Base**, your VM was built on the older Ubuntu 24.04 base without vsock. It keeps working without a VPN. To move to the current base, use **Recreate VM** on System Health. Recreating deletes the VM, so containers, images and volumes in it are lost and you re-pull or rebuild them.

### Auto-reconciliation

Every time the daemon starts, it reads `~/.lima/orca/lima.yaml` and adds anything an older Orca version didn't set: the port forwarding rule, the `/Volumes` and `/private` mounts, vsock SSH (or the HWE kernel on older VMs), and a fix for Apple M4 and M5 chips. If something is missing, Orca stops the VM, applies it with `limactl edit` and starts it again. Upgrading Orca doesn't require recreating the VM.

On a running VM the daemon also makes sure IPv4 forwarding is on, so `docker compose up` networking works after a reboot.

If the VM is stopped when the daemon starts, the daemon starts it. If it doesn't come up, the daemon force-stops it, clears Lima's stale lock and socket files and tries again.

### VM resources

Change CPUs, memory and disk in **Settings** > **General** > **Virtual machine**, then click **Apply changes**. This restarts the VM and stops running containers. Memory must be at least 2 GB and no more than your Mac has; disk must be at least 10 GB.

## Windows: a WSL distro of Orca's own

On Windows, Docker runs in a WSL2 distro named `orca`, which Orca makes and looks after. Your own distros aren't changed, and Docker Desktop's engine is never used.

| | |
|---|---|
| Base | Ubuntu 26.04 LTS, from Ubuntu's newest WSL image, checked against its published checksum |
| Kernel | WSL's own (Microsoft's Linux kernel), shared by all distros |
| Where | `%LOCALAPPDATA%\orca-engine` (the distro's disk, the image, the engine's certificates) |
| Engine | Docker Engine from get.docker.com, run by systemd |
| Reached at | `127.0.0.1:2376`, mutual TLS: only clients with Orca's certificate get in |

- `docker` and `docker compose` run inside the distro, so Orca needs no `docker.exe` on Windows.
- Folders on a drive (`C:\code\app`) are at `/mnt/c/code/app` in the distro.
- A folder inside another distro (`\\wsl.localhost\Ubuntu\home\me\app`) is reached through WSL's shared `/mnt/wsl`: Orca bind-mounts that distro's root at `/mnt/wsl/orca/distros/Ubuntu` while it runs. Nothing is installed or written in that distro.
- WSL stops a distro soon after its last program exits, so the daemon keeps one running in `orca`.
- Containers reach Windows at `host.docker.internal`. For each gateway route to a dev server on Windows, Orca also relays its port to Windows' `localhost`, so a server that only listens on `127.0.0.1` is reachable too. Windows may ask once whether to let Orca listen on the WSL network.

### The docker command on Windows

In **Settings** > **General** > **Engine**, let `docker` use Orca's engine:

- **PowerShell and Command Prompt.** Orca uses the `docker.exe` you have, or downloads Docker's own CLI and compose plugin, and adds a `docker context` named `orca`. It reaches the engine through Orca's named pipe, which rewrites Windows paths in bind mounts (`-v C:\code\app:/app`) to the engine's (`/mnt/c/code/app`), as Docker Desktop does.
- **One WSL distro.** Orca installs Docker's CLI there if it has none (Debian and Ubuntu), and adds a `docker` context named `orca-wsl` (not `orca`: after Docker Desktop's WSL integration a distro shares its contexts with Windows). That distro's `/home` is at the same path for the engine, so `docker compose up` in `~/code/app` and its bind mounts work as they did with Docker Desktop. Paths outside `/home` in that distro aren't shared.

**Rebuild engine** on System Health deletes the distro and makes it again from Ubuntu's newest image. Containers, images and volumes in it are lost.

### WSL2 resources

WSL2's limits apply to all your distros, not only Docker. Set them in **Settings** > **General** > **WSL2 resources**: **Memory**, **Processors** and **Swap** (for example `8GB`, `4`, `0`). Orca writes them to the `[wsl2]` section of `%USERPROFILE%\.wslconfig` and keeps your other settings in that file.

Changes take effect after WSL restarts:

```bash
wsl --shutdown
```

## Linux: native

On Linux there's no VM. Orca talks to the Docker or Podman socket on your machine, and container ports are on your host directly.

The daemon uses the first socket that responds, in this order:

1. `DOCKER_HOST`, when it's a `unix://` path
2. The active Docker context
3. `/var/run/docker.sock`
4. Rootless Podman at `/run/user/<uid>/podman/podman.sock`, then `/run/podman/podman.sock`

## Which engine

Orca never uses Docker Desktop's engine, on any platform. See [Moving from Docker Desktop](/docs/docker-desktop/).

- **macOS**: Orca's VM, or another engine picked in **Settings** > **General** > **Engine**.
- **Windows**: Orca's WSL distro.
- **Linux**: the first of the sockets above that answers, or another socket picked in **Settings** > **General** > **Engine**.

### macOS

On macOS, Orca uses its own VM, `orca`. To use another engine instead, such as OrbStack or Colima, pick it in **Settings** > **General** > **Engine**, or give its socket path there. Orca never uses Docker Desktop's engine: see [Moving from Docker Desktop](/docs/docker-desktop/).

An engine picked in Settings that isn't answering is reported on System Health; Orca doesn't fall back to another one. A `DOCKER_HOST` set in the daemon's own environment wins over the choice.

## Where files live

| | macOS | Windows | Linux |
|---|---|---|---|
| Config and API token | `~/Library/Application Support/orca/config.json` | `%APPDATA%\orca\config.json` | `~/.config/orca/config.json` |
| Daemon log | `~/Library/Application Support/orca/daemon.log` | `%APPDATA%\orca\daemon.log` | `~/.config/orca/daemon.log` |
| Data | `~/Library/Application Support/orca/` | `%APPDATA%\orca\` | `~/.local/share/orca/` |

The daemon log is written when the desktop app starts the daemon. The log from the previous run is kept next to it as `daemon.prev.log`, so after a crash you can still read why. **Settings** > **About** > **Paths** shows these paths with a copy button.

On a Linux server where the daemon was installed as a service, the config is `/etc/orca/config.json` and logs go to the journal (`journalctl -u orca-daemon`). If `/etc/orca/config.json` exists, the daemon uses it instead of the per-user file.

Read your token, for example on Linux:

```bash
python3 -c "import json; print(json.load(open('$HOME/.config/orca/config.json'))['api_token'])"
```

## Related

- [Install Orca](/docs/install/)
- [Troubleshooting](/docs/troubleshooting/)
- [Remote hosts](/docs/remote-hosts/)
