---
title: Troubleshooting
nav: Troubleshooting
description: Fixes for common Orca problems: the daemon not starting, Docker not found, the macOS VM, gateway port conflicts, untrusted certificates, and where logs are.
---

Most problems show up on the **System Health** page, and most of them have a button there that fixes them. This page explains those buttons, then covers specific symptoms. If nothing here helps, see [Report a bug](#report-a-bug).

## Start with System Health

Open **System Health** in the sidebar. Each check shows its status, and a failing check has a **Fix** button that runs the repair and streams its output in a dialog. The buttons at the top:

| Button | What it does |
|---|---|
| **Set up Docker** | Runs first-start setup again for your platform. Shown when Orca can't reach Docker. |
| **Recreate VM** | macOS only. Deletes the Lima VM and builds a fresh one on the current base. Containers, images and volumes in it are lost. |
| **Restart Docker & Orca** | Restarts Docker, then restarts the Orca daemon so it reconnects. On macOS it stops and starts the Lima VM; on Windows it starts Docker in WSL2; on Linux it starts the Docker service with `systemctl`. |
| **Diagnose** | Tries every way Orca knows to reach Docker and shows the log in **Connection Diagnostics**. If it finds a working connection, Orca switches to it without a restart. |
| **Re-check** | Runs the checks again. |


## Orca daemon is not running

The app shows **Orca daemon is not running** when it can't reach the daemon on `127.0.0.1:9477`.

1. Click **Start Daemon**, then **Retry Connection**.
2. If it doesn't start, read the daemon log (see [Logs](#logs)). The screen also shows where the app looked for the `orca-daemon` binary.
3. Check whether something else holds port 9477. On macOS and Linux:
   ```bash
   lsof -i :9477
   ```
   If it's another program, stop it. The daemon reports `Port 127.0.0.1:9477 is already in use by another process` in that case.

The app restarts a crashed daemon by itself, up to 3 times in 10 minutes. After that it leaves it to you, so a daemon that keeps crashing ends up on this screen.

## "Another Orca daemon is already running"

You see this when you start `orca-daemon` by hand while one is already serving on port 9477, usually the one the desktop app started. The new process exits and the running daemon keeps serving, so nothing is broken.

To run your own daemon instead, quit the app with **Quit Orca** from the tray or menu bar icon first. Closing the window isn't enough: it only hides it, and the daemon keeps running. Then check that the port is free with `lsof -i :9477` before starting yours.

> [!TIP]
> To see which version is answering, run `curl -s http://127.0.0.1:9477/api/v1/health`. When the app starts and finds a daemon of a different version, it replaces it with its own.

## Pages show 401 Unauthorized on first start

In versions before 0.49.0, the very first start could leave the app without the daemon's API token: pages stayed empty, **System Health** kept loading, and **Projects** showed `401 Unauthorized`. This is fixed in 0.49.0.

If you're on an older version, quit Orca fully with **Quit Orca** from the tray or menu bar icon and open it again; the token is read on the next start. Then update to the latest release.

## Docker not found

System Health shows **Docker Runtime** failing with **No container runtime found** (Linux), **Docker not found in WSL2** (Windows) or **Docker is not running** (macOS, before setup). Click **Install** or **Fix** to run setup for your platform. What it does is described in [Install Orca](/docs/install/#first-start).

Platform-specific cases:

- **Linux, sudo asks for a password.** Orca can't enter it, so setup stops and prints the commands. Run them in a terminal, then restart Orca:
  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker $USER
  sudo systemctl start docker
  ```
- **Linux, Docker Group check fails.** After **Fix** adds you to the `docker` group, log out and back in for it to apply.
- **Windows, no WSL distro.** Install Ubuntu from the Microsoft Store and launch it once to create your Linux user, then click **Re-check**.
- **Windows, WSL2 not enabled.** **Fix** runs `wsl --install`. Restart Windows when it asks you to.
- **Windows, Docker Service not running.** **Fix** starts Docker in WSL2 with the TCP listener Orca uses.

## macOS: the Docker VM won't come up

If the VM exists but Docker is unreachable, **Docker Runtime** shows `Lima VM 'orca' is … Docker is unreachable` with a **Fix** button. It repairs the VM: force-stops it, removes Lima's stale lock and socket files, starts it again and waits for Docker. Your containers and images are kept.

If repair doesn't help, **Recreate VM** builds a new one. It deletes everything in the old VM.

### Behind a VPN

If setup or a restart ends with "The VM started but its network never came up", a mesh VPN (NetBird, Tailscale, WireGuard) or a content filter is in the way.

- Disconnect the VPN, start Orca so the VM boots, then reconnect.
- If System Health shows **Docker VM Base**, the VM predates the vsock base that avoids this problem. Use **Recreate VM** to rebuild it. See [Why vsock](/docs/platforms/#why-vsock).
- On a managed Mac, security software can block the VM's network. List system extensions with `systemextensionsctl list` and ask IT to allow Lima and Virtualization.framework.

### Docker Engine Update

If System Health shows **Docker Engine Update**, the Docker Engine in the VM has a memory leak that eventually gets Docker killed. Click **Update**: Orca updates Docker in the VM, restarts it and starts the containers that were running. Containers, images and volumes are kept.

## Gateway: port 80 or 443 is in use

The gateway needs ports 80 and 443 on your machine. If another program already uses one, the **Gateway** page shows **Port Conflict Detected** with `Port 80 (HTTP) is already in use` or `Port 443 (HTTPS) is already in use`.

Either stop the other program, or move the gateway to other ports:

1. On **Gateway** > **Configuration**, change **HTTP Port** and **HTTPS Port** (for example `8080` and `8443`). **Check Ports** tells you whether they're free.
2. Click **Save Configuration**.
3. Click **Stop Gateway**, then **Start Gateway**, so the gateway container is created with the new ports.

From a terminal, `orca gateway config --http-port 8080 --https-port 8443` saves the same setting.

With a non-standard HTTPS port, URLs include it: `https://myapp.localhost:8443`.

If starting fails with **Failed to Start Gateway** and a message about `caddy:2-alpine`, Orca couldn't download the gateway image. Check your internet connection and try again.

## Browser says the certificate isn't trusted

Gateway hostnames use certificates from Orca's local certificate authority. Your system has to trust that CA once.

Run:

```bash
orca ca install
```

It needs the `orca` CLI on your `PATH` (the Windows installer adds it) and asks for your password on macOS and Linux. Without the CLI, go to **Settings** > **Certificates**, click **Download CA Certificate** and run the command shown there for your platform.

`orca ca info` shows the CA's subject, expiry and fingerprint, the same details as the **Certificates** tab, so you can check you trusted the right one.

## Logs

| Platform | Daemon log |
|---|---|
| macOS | `~/Library/Application Support/orca/daemon.log` |
| Windows | `%APPDATA%\orca\daemon.log` |
| Linux | `~/.config/orca/daemon.log` |

The log is recreated each time the app starts the daemon. The previous run's log is kept as `daemon.prev.log` in the same folder, which is the one to read after a crash. **Settings** > **About** > **Paths** shows the exact path with a copy button.

For a daemon installed as a service on a Linux server:

```bash
journalctl -u orca-daemon -f
```

Errors from actions in the app also appear on the **Activity** page.

## Report a bug

Open an issue at [github.com/edvin/orca/issues](https://github.com/edvin/orca/issues). Include:

- Your platform and Orca version (shown at the right of the status bar, or run `orca version`, which prints both the CLI and daemon versions).
- What you did, what you expected, and what happened.
- The relevant part of `daemon.log` or `daemon.prev.log`, and the output of **Diagnose** if the problem is connecting to Docker.

The log can contain container names and paths, so look it over before posting. Report security problems privately through [GitHub Security Advisories](https://github.com/edvin/orca/security/advisories/new) instead.
