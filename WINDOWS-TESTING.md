# Windows: testing the engine clean cut

Branch `engine-clean-cut`. Orca now never uses Docker Desktop's engine, on any
platform. On Windows that means a new engine: Docker in a WSL distro of Orca's
own, `orca`. None of the Windows-only code has run on Windows yet. It was
written on a Mac, cross-checked with `cargo clippy --target
x86_64-pc-windows-gnu`, and its pure logic is unit-tested. This file is the
plan for trying it for real.

## What changed on Windows

| Before | Now |
|---|---|
| Docker installed into the user's **default** distro (`wsl -u root --`), via get.docker.com | A distro of Orca's own, `orca`, imported from Ubuntu 26.04's newest WSL image (sha256-checked) into `%LOCALAPPDATA%\orca-engine\distro` |
| dockerd on `tcp://127.0.0.1:2375`, no auth | dockerd on `tcp://127.0.0.1:2376`, mutual TLS with Orca's own CA (`%LOCALAPPDATA%\orca-engine\certs`) |
| Docker Desktop's named pipe tried first | Docker Desktop's engine is never used |
| Compose ran `docker.exe` on Windows (only Docker Desktop supplies one) | `docker`/`docker compose` run inside the distro via `wsl.exe -d orca -u root --exec env … docker …`, paths translated (`orca_backend_common::wsl::OnEngine`) |
| k3s, helm, GPU toolkit in the default distro | All in `orca` (`wsl -d orca -u root --`) |
| Reconnect never actually swapped the runtime on Windows | One code path for all platforms (`crates/orca-daemon/src/engine.rs`) |

Key code: `crates/orca-backend-common/src/wsl.rs` (distro creation, setup
script, TLS certs, path translation, keepalive, PowerShell and distro
integration), `crates/orca-daemon/src/engine.rs` (which engine),
`crates/orca-daemon/src/engine_proxy.rs` (the path-rewriting Docker API proxy
behind `\\.\pipe\orca_docker`), `crates/orca-daemon/src/host_relay.rs`
(localhost dev servers for containers), `crates/orca-daemon/src/desktop.rs`
(bringing things over).

## Before you start

- Rust (MSVC toolchain), Node 20+, WSL2 (`wsl --version` ≥ 2.4.10 is best: it
  installs `.wsl` images with `--install --from-file`; older falls back to
  `--import`).
- `npm ci` in `gui/`, then `cargo tauri dev` from the repo root, or run the
  daemon alone: `cargo build --bin orca-daemon` and `target\debug\orca-daemon.exe`.
- The daemon log says which engine it picked: look for `Engine:` lines.

To start over at any point:

```powershell
wsl --unregister orca
Remove-Item -Recurse $env:LOCALAPPDATA\orca-engine
```

## Checklist

Tick each, and note what happened where it didn't.

### 1. Setting up the engine
- [ ] With no `orca` distro, the app opens on **System Health**: **Docker Runtime** fails with "Orca runs Docker in a WSL distro of its own…". **Fix** streams: finding the image, downloading (percent), checksum, making the distro, setting up Docker, starting with systemd, "Docker … is running in the orca distro".
- [ ] `wsl -l -v` lists `orca`, version 2. Your own distros are unchanged (no Docker installed in them by this).
- [ ] `wsl -d orca -- docker version` works; `wsl -d orca -- cat /etc/orca-generation` prints `1`.
- [ ] No first-run user prompt appeared (`/etc/wsl-distribution.conf` is removed).
- [ ] TLS: `curl.exe -s https://127.0.0.1:2376/_ping` fails (no client cert). With the cert it says `OK`:
      `curl.exe --cacert %LOCALAPPDATA%\orca-engine\certs\ca.pem --cert %LOCALAPPDATA%\orca-engine\certs\cert.pem --key %LOCALAPPDATA%\orca-engine\certs\key.pem https://127.0.0.1:2376/_ping`
- [ ] Dashboard and Containers work; the header shows Docker connected.

### 2. Staying up
- [ ] `wsl --terminate orca`: within ~30 s the daemon brings it back and Docker answers again (keepalive in `crates/orca-daemon/src/main.rs`).
- [ ] `wsl --shutdown`: the same, and **Diagnose** on System Health reconnects.
- [ ] Quitting Orca and starting it again connects without a setup step.

### 3. Projects and paths
- [ ] A compose project in `C:\Users\<you>\code\app` (with a relative bind mount like `./src:/src`) starts from **Open folder**; the bind mount shows the files.
- [ ] A compose project inside your Ubuntu distro, opened as `\\wsl.localhost\Ubuntu\home\<you>\app`, starts too: the engine reaches it at `/mnt/wsl/orca/distros/Ubuntu/…` (`wsl -d orca -- ls /mnt/wsl/orca/distros`).
- [ ] A project using a shared database (COMPOSE_FILE with `.orca/databases.override.yaml`) starts: the `;` list becomes a Linux `:` list.
- [ ] Database snapshot, import and restore (`docker exec` piping) work.
- [ ] **Run container** with a Windows folder as a volume mounts it (`C:\…` becomes `/mnt/c/…`).

### 4. Gateway and networking
- [ ] The gateway starts and `https://<app>.localhost` (or your domain) opens from a Windows browser.
- [ ] A route to a dev server running on Windows itself that listens on **localhost only** (e.g. `npx vite`, port 5173) works: the daemon log says `Relaying <ip>:5173 to Windows' localhost:5173`. Windows may ask to allow Orca on the network once: allow it.
- [ ] The same for a server listening on all interfaces (the relay steps aside: the port is already reachable).
- [ ] With `.wslconfig` `networkingMode=mirrored`: what happens? (No NAT gateway, so no relay; the alias falls back to `host-gateway`. Note what works.)

### 4b. `docker` from PowerShell and from a distro
**Settings → General → Engine:**
- [ ] Tick **PowerShell and Command Prompt**, **Apply**. Without Docker Desktop installed, it downloads `docker.exe` into `%LOCALAPPDATA%\orca-engine\cli` (on your user PATH; open a new terminal) and the compose plugin into `%USERPROFILE%\.docker\cli-plugins`.
- [ ] In a new PowerShell: `docker context ls` shows `orca *` (`npipe:////./pipe/orca_docker`); `docker run --rm -v ${PWD}:/w alpine ls /w` lists the current folder (path rewritten by the proxy); `docker run -it --rm alpine sh` gives an interactive shell; `docker compose up` in a project with `./src:/src` works.
- [ ] Pick your Ubuntu distro, **Apply**: it installs `docker-ce-cli` and the compose plugin there if needed (replacing Docker Desktop's dangling `docker` link), and adds context `orca`.
- [ ] In Ubuntu: `docker context ls` shows `orca *`; `cd ~/code/app && docker compose up -d` works with bind mounts; `wsl -d orca -- ls /home` shows your Ubuntu home.
- [ ] Orca's Containers page shows those containers, and stopping the project from Orca works (its folder `/home/<you>/app` is the same path in Orca's distro).
- [ ] Switching back to **None** sets Ubuntu's context back to `default`.

### 5. Kubernetes
- [ ] Enabling Kubernetes installs k3s in `orca` (not in your default distro); pods list; a pod terminal opens.

### 6. Moving from Docker Desktop
With Docker Desktop installed and running, with a compose project started from PowerShell (`C:\…`), one started from Ubuntu through Docker Desktop's WSL integration (`/home/…`), a named volume with data (e.g. Postgres) and a `docker run` container:
- [ ] System Health shows the **Docker Desktop** card; **See what comes over** lists them, sizes and free space (free space = the least of the distro's and the Windows drive's).
- [ ] **Bring them over**: every step done; Postgres data is there in Orca; both projects are recreated and running (the `/home/…` one is found in your Ubuntu distro).
- [ ] Docker Desktop's data is untouched (its containers are stopped).
- [ ] **Quit Docker Desktop when done** quits it.
- [ ] Running it again skips what already came over.

### 7. Moving from an earlier Orca
On a machine that ran Orca 0.65 or older (Docker in the default distro on 2375):
- [ ] Upgrading to this build opens **System Health** with setup; after setup a second card, **Docker in Ubuntu**, offers to bring that Docker's things over, and does.
- [ ] **Stop … when done** disables that Docker in the default distro (not uninstalled).

### 8. Uninstall
- [ ] Uninstalling stops `orca` but keeps it (`wsl -l -v`), and `%LOCALAPPDATA%\orca-engine` stays.

## Known gaps to decide on

- **One distro at a time** for `docker`: only its `/home` is shared at the same path. Another distro's paths would need the proxy approach (a per-distro path-rewriting socket) if people need it.
- **`.wslconfig`.** **Settings → WSL2 resources** (`src-tauri/src/commands.rs` `save_wsl_config`) rewrites the whole `[wsl2]` section; the unused `orca-backend-windows` crate also wrote `networkingMode=mirrored` and friends there. Make sure saving resources doesn't drop keys the user set.
- **Windows on ARM** isn't covered: Ubuntu only publishes an amd64 WSL image for 26.04 (Orca's Windows build is x64 anyway).
- `crates/orca-backend-windows` is unused (it was an earlier attempt at a named distro, on Ubuntu 24.04). Delete it once this works.

## Not Windows: already tested on the Mac

- The move itself (images, volumes with owners and modes, networks, compose projects, verification, rerun, interrupted copies) was tested end to end on macOS between two Lima VMs, one standing in for Docker Desktop with the containerd image store.
- The Ubuntu 26.04 setup script and the mutual-TLS engine port were tested in an Ubuntu 26.04 VM, from the Mac, with Orca's own client.
- The path-rewriting proxy was tested with the real `docker` CLI and compose through it: binds via `-v` and `--mount`, `run -i` with stdin, `exec`, `logs -f`, a chunked `build`, `cp`, and a compose project with bind mounts and ports.
- The distro CLI install was tested in Ubuntu 26.04 and Debian 13 containers (also replacing Docker Desktop's dangling link), and the `orca` context against a mutual-TLS dockerd on 127.0.0.1:2376 sharing the network, as WSL distros do.
