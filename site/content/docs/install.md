---
title: Install Orca
nav: Install
description: Download Orca Desktop for macOS, Windows or Linux, let it set up a container runtime on first start, and keep it up to date.
---

This page covers installing Orca Desktop, what it sets up the first time you start it, how updates work, and how to remove it. If you want to manage a Linux server instead of your own machine, see [Install the daemon on a server](#install-the-daemon-on-a-server).

## Download

Get the latest release from GitHub: [github.com/edvin/orca/releases/latest](https://github.com/edvin/orca/releases/latest).

| Platform | File | What it is |
|---|---|---|
| macOS (Apple Silicon) | `.dmg` | Disk image with the signed and notarized app. Drag **Orca Desktop** to Applications. |
| Windows (x64) | `-setup.exe` | Installer. It also adds the install folder to your user `PATH`, so the `orca` CLI works in any new terminal. |
| Linux (x86_64) | `.AppImage` | Portable app. Make it executable and run it. |
| Linux (x86_64) | `.deb` | Package for Debian and Ubuntu. It depends on `libwebkit2gtk-4.1-0` and `libssl3`. |

Each download bundles the Orca daemon (`orca-daemon`) and the `orca` CLI. The app starts the daemon for you and stops it when you quit.

> [!NOTE]
> Release builds of the desktop app are made for Apple Silicon Macs, x64 Windows and x86_64 Linux. There is no Intel Mac build.

## First start

When Orca starts, it looks for a working container runtime. If it finds one, you go straight to the app. If not, it opens **System Health** with a **Container runtime setup** list: each missing piece has an **Install** button, and the setup log streams in a dialog while it runs.


### macOS

Orca runs Docker in a small Linux VM managed by [Lima](https://lima-vm.io). Setup does this, in five steps:

1. Installs Homebrew if it's missing.
2. Installs Lima, the Docker CLI, Docker Compose and Docker Buildx with Homebrew (only the ones you don't have). Lima older than 2.0 is upgraded.
3. Creates a VM named `orca` on Ubuntu 26.04 LTS using Apple's Virtualization.framework. The first time this downloads the Linux image and takes a few minutes.
4. Starts the VM and checks that it is reachable.
5. Creates a Docker context named `lima-orca` and switches to it, so the `docker` command in your terminal talks to the same engine as Orca.

The VM gets 4 CPUs and memory sized from your Mac: half of its RAM, between 4 and 16 GiB, always leaving at least 2 GiB for macOS. You can change this later. See [How Orca runs on macOS](/docs/platforms/#macos-a-lima-vm).

### Windows

Orca runs Docker in a WSL2 distro of its own, named `orca`. Your own distros aren't changed.

- If WSL2 is not active, the **WSL2** check offers to install it (`wsl --install`). You may need to restart Windows afterwards.
- The **Docker Runtime** step downloads Ubuntu 26.04 LTS's newest WSL image from releases.ubuntu.com, checks it against Ubuntu's published checksum, and makes the `orca` distro from it in `%LOCALAPPDATA%\orca-engine`. It then installs Docker Engine with the official script from get.docker.com. This takes a few minutes.
- Docker listens on `127.0.0.1:2376` with mutual TLS: only clients with Orca's certificate can use it.

### Linux

Orca talks to Docker or Podman on your machine directly, with no VM.

- If no runtime is found, the **Docker Runtime** step runs the get.docker.com script with `sudo`, adds you to the `docker` group and starts the service. If `sudo` asks for a password, Orca can't type it for you: the dialog prints the commands to run in a terminal instead.
- If Docker isn't installed, System Health also offers Podman as an alternative.
- After being added to the `docker` group, log out and back in for it to take effect.

## Requirements

What the release builds and setup need:

- **macOS**: an Apple Silicon Mac. Setup installs Homebrew and Lima 2.0 or newer, and needs internet access to download them and the Ubuntu image.
- **Windows**: x64 Windows with WSL2 and a WSL Linux distro.
- **Linux**: x86_64 with WebKitGTK 4.1, plus Docker or Podman (Orca can install either).

## Next to Docker Desktop

You don't have to uninstall Docker Desktop first.

- **macOS**: Orca runs Docker in its own VM and never uses Docker Desktop's engine. System Health offers to bring Docker Desktop's images, volumes and compose projects over, once, or to start fresh. See [Moving from Docker Desktop](/docs/docker-desktop/).
- **Windows**: Orca runs Docker in its own WSL distro and never uses Docker Desktop's engine. System Health offers to bring Docker Desktop's things over, and those of the Docker an earlier Orca installed in your default distro.
- **Linux**: Orca uses this computer's Docker or Podman, and never Docker Desktop's engine.

## Updates

Orca checks for a new version 5 seconds after it starts and then every hour. When one is available, the status bar at the bottom shows **Update available: v…**. Click it, confirm with **Update**, and Orca downloads the release, stops its daemon, installs the update and restarts. Updates are signed, and the app verifies the signature before installing.

**Settings** > **Privacy & security** > **Network connections** lists the update check along with every other connection Orca makes.

## Uninstall

First quit Orca from the tray or menu bar icon with **Quit Orca**. Closing the window only hides it.

### macOS

1. Delete **Orca Desktop** from Applications.
2. To remove the VM and everything in it, run:
   ```bash
   limactl stop orca
   limactl delete orca
   ```
3. Point the Docker CLI back at another engine, and remove Orca's context:
   ```bash
   docker context use default
   docker context rm lima-orca
   ```
4. Delete `~/Library/Application Support/orca` to remove settings, the API token and the local CA.

You can do steps 2 and 4 from the app before you quit it, in **Settings** > **About** > **Cleanup**: **Stop & remove VMs** stops and deletes the `orca` VM, and **Reset all** also deletes the settings folder. Other Lima VMs on the Mac are left alone.

Homebrew and the packages setup installed (`lima`, `docker`, `docker-compose`, `docker-buildx`) stay. Remove them with `brew uninstall` if you don't need them.

### Windows

Uninstall **Orca Desktop** from **Settings** > **Apps** in Windows. The uninstaller removes the `orca://` link handler, its `PATH` entry and `%LOCALAPPDATA%\orca`, and stops Orca's `orca` distro. It keeps your settings in `%APPDATA%\orca`; delete that folder to remove them too.

The `orca` distro, with your images and volumes, stays in `%LOCALAPPDATA%\orca-engine`. To remove it:

```bash
wsl --unregister orca
```

### Linux

Delete the AppImage, or remove the `.deb` package with your package manager. Then delete `~/.config/orca` (settings, API token, CA) and `~/.local/share/orca` if you want a clean slate. Docker or Podman stay installed.

On every platform the gateway runs as a container named `orca-gateway`. Remove it with `docker rm -f orca-gateway` if it's still there.

## Install the daemon on a server

To manage a Linux server from Orca Desktop, install only the daemon there. On Debian or Ubuntu:

```bash
curl -fsSL https://orca-desktop.com/install-daemon.sh | sudo sh
```

It adds Orca's apt repository, installs `orca-daemon` as a systemd service and prints the URL and API token to paste into **Settings** > **Remote hosts**. To remove it:

```bash
curl -fsSL https://orca-desktop.com/uninstall-daemon.sh | sudo sh
```

See [Remote hosts](/docs/remote-hosts/) for connecting to it and putting TLS in front.

## Next steps

- [Quickstart](/docs/quickstart/): open a project folder and give it an HTTPS hostname.
- [How Orca runs on each platform](/docs/platforms/)
- [Troubleshooting](/docs/troubleshooting/)
