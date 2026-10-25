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
| k3s, helm, GPU toolkit in the default distro | All in `orca` (`wsl -d orca -u root --exec …`) |
| Compose labels (`working_dir`, `config_files`) | Recorded by compose in the distro as `/mnt/c/…`; translated back to `C:\…` where Orca reads them (`wsl::host_labels`, in `containers.rs`) |
| Reconnect never actually swapped the runtime on Windows | One code path for all platforms (`crates/orca-daemon/src/engine.rs`) |

Key code: `crates/orca-backend-common/src/wsl.rs` (distro creation, setup
script, TLS certs, path translation, keepalive, PowerShell and distro
integration), `crates/orca-daemon/src/engine.rs` (which engine),
`crates/orca-daemon/src/engine_proxy.rs` (the path-rewriting Docker API proxy
behind `\\.\pipe\orca_docker`), `crates/orca-daemon/src/host_relay.rs`
(localhost dev servers for containers), `crates/orca-daemon/src/desktop.rs`
(bringing things over).

## Before you start

- Rust (MSVC toolchain), Node 20+, WSL2 (any WSL 2: the image is unpacked and
  `wsl --import`ed as a plain tar, so it adds no Start menu entry or first-run
  setup).
- `npm ci` in `gui/`, then `cargo tauri dev` from the repo root, or run the
  daemon alone: `cargo build --bin orca-daemon` and `target\debug\orca-daemon.exe`.
- The daemon log says which engine it picked: look for `Engine:` lines.

To start over at any point:

```powershell
wsl --unregister orca
Remove-Item -Recurse $env:LOCALAPPDATA\orca-engine
```

## Checklist

Tested on Windows 11 (26200) with WSL 2 on kernel 6.6, 2026-10-25; results and fixes in `WINDOWS-REPORT.md`. The daemon was driven through the API the GUI calls, not the GUI itself.

Tick each, and note what happened where it didn't.

### 1. Setting up the engine
- [x] With no `orca` distro, the app opens on **System Health**: **Docker Runtime** fails with "Orca runs Docker in a WSL distro of its own…". **Fix** streams: finding the image, downloading (percent), checksum, making the distro, setting up Docker, starting with systemd, "Docker … is running in the orca distro".
- [x] `wsl -l -v` lists `orca`, version 2. Your own distros are unchanged (no Docker installed in them by this).
- [x] `wsl -d orca -- docker version` works; `wsl -d orca -- cat /etc/orca-generation` prints `1`.
- [x] No first-run user prompt appeared, and there's no "Ubuntu" Start menu entry or Windows Terminal profile for `orca`. *Failed at first: `wsl --import` reads the image's `/etc/wsl-distribution.conf` and made both (`orca.lnk`, a `Microsoft.WSL` Terminal fragment); removing the file after import is too late. Fixed. Not checked: whether Windows Terminal's own WSL profile generator lists `orca` next time it starts.*
- [x] Setup didn't hang on apt: cloud-init is waited for, apt waits for its lock, and `systemd-networkd-wait-online` is masked. If it did hang, note the last lines.
- [x] Docker's TLS flags are in `/etc/systemd/system/docker.service.d/orca.conf`, not `daemon.json` (`wsl -d orca -- cat /etc/docker/daemon.json` may not exist).
- [x] TLS: without a client cert the engine refuses; with it, `_ping` says `OK`. *`curl.exe` can't show the second half: Windows' curl (and Git's) use Schannel, which can't load PEM keys (`schannel: Failed to import cert file`). From a WSL distro:*
      `C=/mnt/c/Users/<you>/AppData/Local/orca-engine/certs; curl --cacert $C/ca.pem --cert $C/cert.pem --key $C/key.pem https://127.0.0.1:2376/_ping`
- [x] Dashboard and Containers work; the header shows Docker connected. *(Through their API: `/system/health`, `/containers`, `/engine`.)*

### 2. Staying up
- [x] `wsl --terminate orca`: within ~30 s the daemon brings it back and Docker answers again (keepalive in `crates/orca-daemon/src/main.rs`). *32 s; with the gateway running, about a second.*
- [ ] `wsl --shutdown`: the same, and **Diagnose** on System Health reconnects. *Not tested: the session testing this ran inside a WSL distro, which `--shutdown` would have ended. Diagnose (`/settings/reconnect`) itself works.*
- [x] Quitting Orca and starting it again connects without a setup step.
- [ ] Cold start (after `wsl --shutdown`, or a reboot): the app opens at once (the daemon answers within seconds) and connects to the engine in the background within about a minute and a half. *Only with `orca` stopped and the WSL VM running: the daemon listened and was connected about 4 s after it started.*

### 3. Projects and paths
- [x] A compose project in `C:\Users\<you>\code\app` (with a relative bind mount like `./src:/src`) starts from **Open folder**; the bind mount shows the files.
- [x] Its stack page shows the compose file (the editor isn't empty), and its `orca.yaml` is found: Orca reads the project's folder back as `C:\…` from compose's labels.
- [x] A compose project inside your Ubuntu distro, opened as `\\wsl.localhost\Ubuntu\home\<you>\app`, starts too: the engine reaches it at `/mnt/wsl/orca/distros/Ubuntu/…` (`wsl -d orca -- ls /mnt/wsl/orca/distros`).
- [x] A project using a shared database (COMPOSE_FILE with `.orca/databases.override.yaml`) starts: the `;` list becomes a Linux `:` list. *Orca's own start passes `-f`; but compose run in Linux that reads the `.env` itself (a WSL terminal) took `compose.yaml;.orca/…` for one file. Fixed: `COMPOSE_PATH_SEPARATOR=;` goes with the list.*
- [x] Database snapshot, import and restore (`docker exec` piping) work.
- [x] **Run container** with a Windows folder as a volume mounts it (`C:\…` becomes `/mnt/c/…`).

### 4. Gateway and networking
- [x] The gateway starts and `https://<app>.localhost` (or your domain) opens from a Windows browser. *From Windows with `curl.exe -k`; the CA wasn't in Windows' store yet (trusting it is a separate step that shows a Windows prompt). While an earlier Orca's Docker still runs in the default distro, the gateway can't start: its `orca-caddy` holds 80/443 in the namespace both share. The gateway's port check now says `Port 80 (HTTP) is in use inside WSL (another distro)`, and a stack whose port another distro holds says so in its error (tested with a listener in Ubuntu-24.04). The move's "Stop … when done" clears it.*
- [x] A route to a dev server running on Windows itself that listens on **localhost only** works, both IPv4 (`127.0.0.1`) and IPv6-only (`npx vite` often binds `::1` only, port 5173): the daemon log says `Relaying <ip>:5173 to Windows' localhost:5173`. Windows may ask to allow `orca-daemon.exe` on the network once: allow it. **If you click Cancel, note what happens**: the relay can't tell, containers just can't connect. *Firewall allow rules for the dev build's `orca-daemon.exe` exist, so a prompt was answered. Blocked (a copy of the daemon no rule allows, whose prompt was left unanswered, so Windows added Block rules as Cancel does): containers get a 502, and System Health now says "Windows Firewall blocks containers from reaching dev servers on this computer (port …)" with the steps, until it works again.*
- [x] Stop the dev server: within ~5 s the relay lets the port go (log), so a server started next on `0.0.0.0` gets the port.
- [x] A server listening on all interfaces: no relay (it's reachable directly).
- [ ] With `.wslconfig` `networkingMode=mirrored` (then `wsl --shutdown`): `wsl -d orca -- wslinfo --networking-mode` says `mirrored`; there's no relay and the alias is `host-gateway`. Note what works. *Not tested: needs `wsl --shutdown` (see 2).*

### 4b. `docker` from PowerShell and from a distro
**Settings → General → Engine:**
- [x] Tick **PowerShell and Command Prompt**, **Apply**. Without Docker Desktop installed, it downloads `docker.exe` into `%LOCALAPPDATA%\orca-engine\cli` (on your user PATH; open a new terminal) and the compose plugin into `%USERPROFILE%\.docker\cli-plugins`. *Now buildx too, and the zip's unused `dockerd.exe` (92 MB) isn't kept.*
- [x] In a new PowerShell: `docker context ls` shows `orca *` (`npipe:////./pipe/orca_docker`), and:
  - `docker run --rm alpine echo hi` prints `hi` **and returns**. *Printed nothing at first (see the report).*
  - `echo hi | docker run --rm -i alpine cat` prints `hi` and returns (stdin's end reaches the container: the pipe is in message mode).
  - `docker run -it --rm alpine sh` gives an interactive shell; `exit` returns. Same for `docker exec -it <container> sh`. *Not tested: needs a real console.*
  - `docker run --rm -v ${PWD}:/w alpine ls /w` lists the current folder (path rewritten by the proxy). *Also `-v ${PWD}\src:/s` and `--mount`; a 30 MB `docker cp` both ways is intact.*
  - `docker compose up` in a project with `./src:/src` works; `docker compose logs -f` follows and Ctrl+C returns. *Ctrl+C not tested.*
  - `docker build .` (BuildKit) works. *Failed twice: no buildx (the legacy builder ran), then BuildKit's streams ended through the pipe. Both fixed.*
  - With Orca's engine stopped (`wsl --terminate orca`, quickly): `docker ps` says "Orca's engine isn't running…". *`orca` comes back within a second, so tested with dockerd stopped in it.*
- [x] Pick your Ubuntu distro, **Apply**: it installs `docker-ce-cli` and the compose plugin there if needed (replacing Docker Desktop's dangling `docker` link), and adds context `orca-wsl`. *Was `orca`, which replaced PowerShell's (see the report).*
- [x] In Ubuntu: `docker context ls` shows `orca-wsl *`; `cd ~/code/app && docker compose up -d` works with bind mounts; `wsl -d orca -- ls /home` shows your Ubuntu home.
- [x] Orca's Containers page shows those containers, and stopping the project from Orca works (its folder `/home/<you>/app` is the same path in Orca's distro).
- [x] Switching back to **None** sets Ubuntu's context back to `default`.

### 5. Kubernetes
- [ ] Enabling Kubernetes installs k3s in `orca` (not in your default distro); pods list; a pod terminal opens. *Not tested: this machine's Ubuntu-24.04 runs its own k3s. Orca now refuses while another k3s holds 6443 or 10250, naming the distro (tested here); Orca's own k3s would need that one stopped.*

### 6. Moving from Docker Desktop
*Not tested: Docker Desktop isn't installed on the test machine.*

With Docker Desktop installed and running, with a compose project started from PowerShell (`C:\…`), one started from Ubuntu through Docker Desktop's WSL integration (`/home/…`), a named volume with data (e.g. Postgres) and a `docker run` container:
- [ ] System Health shows the **Docker Desktop** card; **See what comes over** lists them, sizes and free space (free space = the least of the distro's and the Windows drive's).
- [ ] **Bring them over**: every step done; Postgres data is there in Orca; both projects are recreated and running (the `/home/…` one is found in your Ubuntu distro).
- [ ] Docker Desktop's data is untouched (its containers are stopped).
- [ ] **Quit Docker Desktop when done** quits it (it tries `docker desktop stop`, then asks its window to close).
- [ ] Running it again skips what already came over.
- [ ] Skipping a project (untick it) leaves it running in Docker Desktop with its volume; unticking **Volumes** leaves projects that need them in Docker Desktop, running (none are recreated on empty volumes).
- [ ] Docker Desktop in **Windows containers** mode isn't taken for a source (only its Linux engine is).

### 7. Moving from an earlier Orca
On a machine that ran Orca 0.65 or older (Docker in the default distro on 2375):
- [x] Upgrading to this build opens **System Health** with setup; after setup a second card, **Docker in Ubuntu**, offers to bring that Docker's things over, and does. *("Docker in Ubuntu-24.04".) 14 of 15 images, all 4 volumes (MariaDB's 149 MB intact), free space the least of the two. `redis:2` didn't come over: it's a layerless 8 kB stub there, and Docker Hub no longer has its digest. A rerun needs 0 bytes. The steps still say "in Docker Desktop" for this source.*
- [x] **Stop … when done** disables that Docker in the default distro (not uninstalled).

### 8. Uninstall
- [ ] Uninstalling stops `orca` but keeps it (`wsl -l -v`), and `%LOCALAPPDATA%\orca-engine` stays. *Not run (no installer build here: `tauri-cli` isn't installed). The hook now also runs `%LOCALAPPDATA%\orca-engine\undo-integration.cmd`, tested directly: contexts back to `default`, `orca`/`orca-wsl` removed, the CLI off the PATH. Steps for you at the end of the report.*

## Found by review and fixed before testing (worth checking)

An adversarial review of this branch found these; all are fixed, but they're
the riskiest parts:

- The proxy closes the client pipe when the engine ends an attached stream, and serves the pipe in message mode for `CloseWrite` (stdin's end). *Its end now reads the pipe as bytes: read as messages, mio lost data (see the report).*
- Compose labels hold Linux paths; Orca translates them back (`host_labels`).
- `\\?\` paths from `canonicalize()` are understood.
- Daemon startup doesn't wait on WSL; every `wsl.exe` call has a time limit.
- The fallback runtime (no engine yet) can't reach Docker Desktop's pipe.
- The daemon's `DOCKER_HOST` is ignored on Windows (the CLI in the distro wouldn't see it).
- The keepalive is stopped before every `--terminate`, and keeps a piped stdin.
- Certificates are written atomically, once, and backdated a day for clock drift.
- A move only removes a volume it recorded as half-copied itself; images are re-pulled by digest, not tag.

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
