# Windows: report on the engine clean cut

Branch `engine-clean-cut`, tested on 2026-10-25 on Windows 11 (build 26200),
WSL 2 (kernel 6.6.87), x64. The checklist in `WINDOWS-TESTING.md` is ticked
with notes. I ran the daemon from `target\debug` and drove it through the
API the GUI calls (`/environment/fix-stream`, `/stacks/deploy`,
`/docker-desktop/move`, `/engine/integration`, …), not through the GUI
itself: there's no Node on the Windows side, and I couldn't click.

The machine had what section 7 expects: Orca 0.65 installed, its Docker in
the default distro (`Ubuntu-24.04`) on 2375, and no Docker Desktop.

## What works

- **Setup** from nothing: Ubuntu 26.04.1's WSL image found, downloaded,
  checked, imported. Docker 29.9.2 set up with systemd, mutual TLS on 2376,
  no first-run prompt, no apt hang. **Repair** and **recreate** work too.
- **Staying up**: `wsl --terminate orca` comes back by itself (32 s, about
  1 s once the gateway runs). Restarting the daemon reconnects at once, and
  so does Diagnose.
- **Paths**: `C:\…` projects from Open folder, with relative binds; projects
  in `\\wsl.localhost\Ubuntu-24.04\…`; compose labels read back as `C:\…` and
  `\\wsl.localhost\…`; Run container with a `C:\` volume; a shared database
  through the override; snapshot, restore and import.
- **Gateway**: `https://app.localhost` from Windows. Dev servers on Windows'
  localhost only, IPv4 and IPv6-only, through the relay; the relay lets go
  of a port when the server stops or the route goes away.
- **docker.exe** through the pipe: `run`, `run -i` with stdin, `exec`, `-v
  ${PWD}`, `--mount`, `cp` (30 MB both ways, intact), `compose up` with
  binds, `logs -f`, `build` with BuildKit, the engine-down message.
- **A WSL distro's docker**: context, `compose up` in `~/…` with binds,
  containers seen and stopped from Orca, back to `default` with None.
- **Moving from the earlier Orca**: the card, the plan (sizes, free space),
  the move (14/15 images, 4/4 volumes, MariaDB's data intact), the rerun
  (nothing left to copy), and "Stop … when done" (disabled, not removed).

## What I fixed

| Commit | Fix |
|---|---|
| `d9977e7` | The daemon built only with Perl on the PATH (vendored OpenSSL). OpenSSL is now a non-Windows dependency only: native-tls uses Schannel on Windows, and `/ca/info` reads the CA with `x509-parser` + `sha2`. |
| `a0082ed` | Tokio's sockets are inheritable on Windows, so every `wsl.exe` the daemon started held port 9477. The keepalive outlives the daemon, so a stopped daemon couldn't start again: `Port 127.0.0.1:9477 is already in use` until WSL shut down. Listeners are bound with std now; the host relay's too. |
| `53054f8` | **Orca's distro and the user's distros share one kernel and one network namespace.** (1) Both dockerds used `docker0` and 172.17.0.0/16: an Orca container got 172.17.0.2, the same address as one of the old engine's. Orca's engine now has its own bridge `orca0` (10.213.0.0/24), its own pool (10.214.0.0/16, /24 networks), and `--live-restore`, without which dockerd deletes `docker0` on every restart once pools are set (moby `daemon_unix.go`). k3s's Traefik is reached at `orca0`'s address. (2) **systemd 259's shutdown clears every binfmt_misc entry, `WSLInterop` included**: each time `orca` stopped (terminate, or idling out ~20 s after Orca quits), *every* distro lost running Windows programs (`cannot execute binary file: Exec format error`). A unit in `orca` unmounts binfmt_misc before systemd-shutdown gets there. |
| `7844d78` | `wsl --import` reads the image's `/etc/wsl-distribution.conf`, and Ubuntu's asks for a Start menu entry and a Terminal profile (WSL made both). Without the file WSL makes them anyway, so they're turned off in the unpacked tar, rewriting only that file in place. |
| `f0cbdf4` | On Windows `.env`'s `COMPOSE_FILE` is written with `;`, but compose now runs in Linux, which splits on `:`: `compose file "compose.yaml;.orca/databases.override.yaml" … is invalid` for compose run in a terminal. `COMPOSE_PATH_SEPARATOR=;` is written with the list and removed with it. |
| `16df226` | `docker run` and `docker exec` through the pipe printed **nothing** (`[hijack] End of stdout` at once). docker.exe ends an attach's input even without stdin, and the proxy passed that on as close_notify plus a TCP half-close. WSL's 127.0.0.1 forwarding closes the whole connection on a half-close. The engine side now gets close_notify only, as docker's own CLI sends over TLS. |
| `ecea36d` | The CLI zip's `dockerd.exe` (92 MB) was left in `orca-engine\cli\docker\`. |
| `5455c81` | No buildx was installed, so `docker build` used the deprecated legacy builder. buildx is downloaded now, checked against the digest from GitHub's release API (its `checksums.txt` has no Windows entries). |
| `d04536b` | With buildx, BuildKit failed through the pipe: `failed to receive status: rpc error: code = Unavailable desc = error reading from server: EOF`. On a pipe read in **message** mode, mio returns a message longer than its 4 KB buffer as an empty read and loses the 4 KB (`ERROR_MORE_DATA`, in `mio/src/sys/windows/named_pipe.rs`). The proxy took that for the end of input, and big writes lost data. The pipe stays a message pipe (that's how docker.exe knows it can `CloseWrite`), but its end reads as bytes (`SetNamedPipeHandleState`). stdin's end still arrives. |
| `335c239` | `cargo clippy --workspace --exclude orca-gui -- -D warnings` failed on Windows with 63 errors before any of this (`k8s.rs`'s `#[cfg(windows)]` early returns make the rest unreachable there). It passes now. |
| `70946a3` | After Docker Desktop's WSL integration, a distro's `~/.docker/contexts` is **a link to Windows' own** (it was here). The distro's context `orca` (TCP) replaced PowerShell's `orca` (the path-rewriting pipe): `docker run -v C:\…` in PowerShell then failed with `invalid mode: /w`. Switching the distro off would also have deleted PowerShell's context. The distro's context is `orca-wsl` now. |
| `b37fa1a` | **Settings → WSL2 resources** rewrote `[wsl2]` with only memory, processors and swap: here it would have dropped `nestedVirtualization=true`, and `networkingMode=mirrored` wherever it's set. Only those three keys are replaced now (case-insensitively: this file has `Memory=64GB`). |

### Second round (your decisions)

| Commit | Change |
|---|---|
| `58faf02` | CI's Linux job failed at **Rustfmt**: most of the branch's new code had never been through `cargo fmt` with the repo's `rustfmt.toml`. Formatting only. In a `rust:1` container on Orca's engine, Linux clippy is clean and all tests pass. PR #7's CI is green on Linux, Windows, macOS and Frontend (at `225d415`). |
| `79126d8` | **What another distro holds.** `ss -ltnHp` in `orca` lists every listener in WSL's shared namespace, but process names only for `orca`'s own, so a listener without one is another distro's. Kubernetes is refused while 6443 or 10250 is held that way (the distro named, via `pgrep -x k3s-server` in each). The gateway's port checks say `Port 80 (HTTP) is in use inside WSL (another distro)`. A compose/Docker error with `failed to bind host port …: address already in use` gets that line too, for every stack start. Dev projects don't pick such a port. |
| `525be84` | **Uninstall undoes the integrations.** The daemon keeps `%LOCALAPPDATA%\orca-engine\undo-integration.cmd` matching what's on (it's removed when nothing is), and the NSIS uninstall hook runs it if it exists. |
| `d46edc6` | **Firewall warning.** Each host relay is checked from inside `orca` (`bash -c '</dev/tcp/<windows ip>/<port>'`): when it starts, every minute, and every 5 s while blocked. Until it connects, System Health shows "Windows Firewall blocks containers from reaching dev servers on this computer (port …): allow Orca Desktop (orca-daemon.exe) on the WSL network…", with the steps. |

### Third round: Docker Desktop (section 6)

Docker Desktop 4.96.3 was installed for one user (`%LOCALAPPDATA%\Programs\DockerDesktop`),
with WSL integration on for Ubuntu-24.04. In it: a compose project from
PowerShell (`C:\Users\EdvinSyse\code\ddapp`: nginx with a `./src` bind, and
Postgres with a row in the `ddapp_pgdata` volume), one from Ubuntu
(`~/dd-ubuntu-app`, a `./src` bind), and a `docker run` container.

| Commit | Fix |
|---|---|
| `1924dea` | Orca looked for Docker Desktop in Program Files only, so a per-user install got **no Docker Desktop card at all** (`installed: false` while running), and Quit and Start couldn't find it. Both locations now. |
| `9421f8d` | Installing Docker Desktop makes its `desktop-linux` context current, and the move's "Point the docker command at Orca's engine" step did nothing on Windows, so PowerShell's `docker` still went to Docker Desktop after a move. It now switches from `desktop-linux` (or `default`) to `orca`, when PowerShell's integration made that context. |

The rest worked as the checklist says:
- **Skip:** skipping `ddapp` moved only `dd-ubuntu-app`, found at `/mnt/wsl/orca/distros/Ubuntu-24.04/…`. `ddapp` kept running in Docker Desktop, with its volume.
- **Volumes unticked:** `ddapp` stayed in Docker Desktop, running, and wasn't recreated.
- **The full move:** it copied the volume (`kept across the move` is in Orca's Postgres) and recreated `ddapp`. Docker Desktop's containers were stopped and its volume left alone.
- **A rerun:** 0 bytes needed, nothing done.
- **Quit:** Docker Desktop's processes are gone and `docker-desktop` is stopped, while Orca still serves both projects.
- **`docker run` container:** stays in Docker Desktop (the plan lists it apart).

How each was tested on this machine:

- **k3s**: with Ubuntu-24.04's k3s running, enabling Kubernetes stops at once with:
  `Another Kubernetes (k3s) is running in your WSL distro Ubuntu-24.04: it holds port 6443, and every WSL distro shares one network. Stop it to use Orca's: wsl -d Ubuntu-24.04 -u root -- systemctl disable --now k3s`.
  Nothing was installed in `orca`, and your k3s kept running.
- **Ports**: with `python3 -m http.server 18090` running in Ubuntu-24.04,
  `/gateway/port-check?http_port=18090` says
  `Port 18090 (HTTP) is in use inside WSL (another distro)`. A stack
  publishing 18090 fails with Docker's error and then
  `Port 18090 is in use inside WSL (another distro): stop what listens there in your other WSL distro, or change the port.`
- **Undo script**: both integrations on, then the script run exactly as the
  hook runs it (`cmd.exe /c ""%LOCALAPPDATA%\orca-engine\undo-integration.cmd""`):
  Windows' context `default`, `orca` gone, `orca-engine\cli` off the user
  PATH, Ubuntu-24.04's context `default`, and `orca-wsl` gone. A second run
  does no harm (exit 0). With Windows' context switched to `desktop-linux`
  first, it stays `desktop-linux`. Turning both off removes the script, and
  a PowerShell-only script has no `wsl.exe` line. The uninstaller itself
  wasn't run (no installer build here).
- **Firewall**: I couldn't switch the allow rule off (this session isn't
  elevated). Instead I ran a copy of the same daemon from another folder,
  which no rule allows. Its relay was blocked, and the log said
  `Containers can't reach the relay on 172.29.0.1:5174: Windows Firewall blocks it`.
  The warning appeared, and the gateway answered 502. Back on the allowed
  build, the warning cleared and the route answered 200. Windows showed a
  prompt for the copy; left unanswered, it added two **Block** rules for the
  copy's path, which is what Cancel does. Removing them needs admin (see the
  checklist below).
- **user@0 (8)**: masking `user@0.service` doesn't silence it. WSL still
  tries to start the session on the first command of each boot and prints
  the same line, now because the unit is masked. Unmasked again; left as is.

## What still fails, or wasn't tested

- **Kubernetes (5)**: refused here, as decided, because Ubuntu-24.04 runs
  its own k3s. Orca's k3s itself (pods, a pod terminal) is untested, as that
  would mean stopping your k3s. Note that the `orca` kube context in
  `~/.kube/config` (see `CLAUDE.md`) points at 127.0.0.1:6443, which is
  that k3s.
- **The gateway can't start while an earlier Orca's Docker runs** (its
  `orca-caddy` holds 80/443). It now says so, and works once the move's
  "Stop … when done" ran.
- The App Catalog's port check (`check_ports`) now also asks the daemon
  (`GET /ports/held-in-wsl`), and names ports another distro holds before
  deploying (`636fc24`). The endpoint was tested with a listener in
  Ubuntu-24.04; the Catalog dialog itself wasn't clicked through.
- **Docker Desktop in Windows-containers mode (6)**: not tested. The test
  install is per-user, and those can't switch ("windows containers have been
  disabled for this installation").
- **`wsl --shutdown`, cold boot, mirrored networking (2, 4)**: not tested.
  The session ran inside a WSL distro, and `--shutdown` would have ended it.
- **Uninstall (8)**: not run (no installer: `tauri-cli` isn't installed).
  The hook now runs `undo-integration.cmd`, which was tested on its own.
- **Interactive `docker run -it` / `exec -it`, and Ctrl+C on `logs -f`**:
  these need a real console.
- **`redis:2`** didn't come over in the move: it's a layerless 7.94 kB stub in
  the old engine, and Docker Hub no longer serves its digest
  (`failed to resolve reference "docker.io/library/redis@sha256:7568…": not found`).
  It's reported as such, which is right.
- Cosmetic: the first `wsl -d orca …` after each boot prints
  `wsl: Failed to start the systemd user session for 'root'`. systemd 259's
  `user@0.service` fails in WSL (`Failed to spawn executor: Device or
  resource busy`), and masking it doesn't help (see above). Docker doesn't
  need it.
- The CA isn't trusted by Windows until the user trusts it (a Windows
  prompt). `https://app.localhost` worked with `-k`.

## Decisions

Decided in the second round, and done: (1) refuse while another k3s runs;
(2) name ports held inside WSL; (3) keep `orca0`, the pool and
`--live-restore`; (4) keep `orca-wsl`; (5) uninstall undoes the
integrations; (6) "Stop … when done" keeps disabling the earlier Docker. You
removed `crates/orca-backend-windows`. Still open from the original list:
one distro at a time for `docker`, and Windows on ARM.

## For the core Orca agent

Things that cost time here and aren't visible from the code:

- **All WSL 2 distros share one kernel and one network namespace.** That
  means one `docker0`, one iptables, one binfmt_misc (on kernel 6.6), and
  one set of listening ports. Anything Orca does in `orca` at that level
  reaches the user's distros. `docker0` is a name, not a private bridge.
  `systemctl` units that touch kernel-wide state (binfmt, sysctl, modules)
  need a second look. Don't drop `orca-binfmt-guard.service`,
  `--bridge=orca0`, the address pool or `--live-restore` from the setup
  script without reading `53054f8`.
- **If Windows programs stop running in WSL** (`Exec format error` on any
  `.exe`), `WSLInterop` was unregistered. Without root in the distro, a
  privileged container can put it back:
  `docker run --rm --privileged --network host alpine sh -c 'mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc; echo ":WSLInterop:M::MZ::/init:P" > /proc/sys/fs/binfmt_misc/register'`
- **WSL's 127.0.0.1 forwarding doesn't carry a TCP half-close**: it closes
  the connection. Never `shutdown(Write)` a socket to Orca's engine from
  Windows; end input with TLS close_notify only (`engine_proxy::Engine`).
- **mio's named pipes lose data in message read mode** (messages over 4 KB).
  Keep `byte_reads` on every `orca_docker` instance.
- **Tokio sockets are inheritable on Windows.** Bind listeners with
  `crate::listen` (std), or a `wsl.exe` child will hold the port after the
  daemon exits.
- Building on Windows: `cargo build --bin orca-daemon` needs nothing extra
  now. `cargo check -p orca-gui` needs `gui/dist` and
  `src-tauri/binaries/orca-x86_64-pc-windows-msvc.exe` (copy of
  `target\debug\orca.exe`). Clippy on Windows is clean; please keep it so,
  as `#[cfg(windows)]` code only fails there.
- **Another distro's ports**: `wsl::ports_held_elsewhere()` (listeners with no
  process in `ss -ltnHp` from inside `orca`). Use it in any new port check on
  Windows; binding on Windows' side doesn't see WSL's namespace.
- **The undo script**: anything new the integrations set up outside Orca
  also belongs in `wsl::undo_integration_script`, which the uninstaller runs.
- **Formatting**: CI's Linux job runs `cargo fmt --all -- --check`; run
  `cargo fmt --all` before pushing.
- `curl.exe` can't test the engine's TLS port (Schannel won't load PEM
  keys). Use curl in a distro, or `docker --tlsverify -H tcp://127.0.0.1:2376`.

## State of the test machine

Cleaned up after testing (2026-10-25):

- **Kept:** the `orca` distro (stopped), with what came over from the earlier
  Orca: its images, and the `mariadb-data`, `redisdata`, `caddyconfig` and
  `caddydata` volumes. Also `%LOCALAPPDATA%\orca-engine` (`certs`, `distro`,
  and the downloaded Ubuntu image in `images`), and the config's record of
  that move (`earlier_engine`).
- **Removed:**
  - The test projects, their volumes and folders.
  - Orca's PostgreSQL 17 server and its records in the config.
  - The test snapshots.
  - The gateway and its route.
  - The test and CI images and volumes.
  - The PowerShell integration: off; `orca-engine\cli` and
    `undo-integration.cmd` are gone.
  - The dev daemon and its keepalives.
  - The Windows clone and tools I built from.
- **Docker Desktop:** you uninstalled it. Its leftovers are removed:
  - On Windows: `%LOCALAPPDATA%\Docker`, `%APPDATA%\Docker`,
    `%USERPROFILE%\.docker` and the `docker-desktop` Start menu folder.
  - In Ubuntu-24.04: `~/.docker/{desktop,run}`, its `contexts` and
    `features.json` links, `/root/.docker/desktop` and
    `/var/lib/docker-desktop`.
  - The config's record of the Docker Desktop move.
  - `C:\ProgramData\DockerDesktop` (install logs) needs admin; see below.
- **Ubuntu-24.04's Docker** (the earlier Orca's) is disabled by the move but
  installed: `sudo systemctl enable --now docker.socket docker` brings it
  back. Its `~/.docker/config.json` and `buildx` are left as they were.
- **The installed Orca 0.65** is stopped. Starting it looks for that Docker.

## For you to run: what I couldn't from inside WSL

In PowerShell, with the branch's Orca running (`cargo tauri dev`, or the
daemon from `target\debug`). Each step says what it should show.

**1. `wsl --shutdown` (section 2).**

```powershell
wsl --shutdown
Start-Sleep 40
wsl -l -v            # orca: Running (the daemon started it again)
docker ps            # lists the gateway and projects (context orca)
```

On System Health, **Diagnose** should end with "Connected successfully — no
restart needed." Then, in Ubuntu, `cmd.exe /c ver` should print the Windows
version: interop survived `orca`'s shutdown.

**2. Cold start (section 2).** Reboot, then open Orca at once:

```powershell
Measure-Command { curl.exe -s http://127.0.0.1:9477/api/v1/health } | Select-Object TotalSeconds
# well under a second once the window is up; {"status":"ok",...}
```

System Health's **Docker Runtime** should turn green within about a minute
and a half, with no setup step.

**3. Mirrored networking (section 4).**

```powershell
Copy-Item $env:USERPROFILE\.wslconfig $env:USERPROFILE\.wslconfig.bak
Add-Content $env:USERPROFILE\.wslconfig "`nnetworkingMode=mirrored"   # under [wsl2]: check the file
wsl --shutdown; Start-Sleep 40
wsl -d orca -- wslinfo --networking-mode      # mirrored
docker run --rm alpine getent hosts host.docker.internal   # the engine's host-gateway address, not 172.x
```

With a route to a dev server on Windows (`npx vite`, port 5173): it should
open through the gateway, and the daemon log should have **no**
`Relaying …` line for it. Note what doesn't work. Then put it back:

```powershell
Move-Item -Force $env:USERPROFILE\.wslconfig.bak $env:USERPROFILE\.wslconfig
wsl --shutdown
```

**4. Interactive docker (section 4b).**

```powershell
docker run -it --rm alpine sh        # a "/ #" prompt; type: echo hi, then exit
docker run -d --name it-test alpine sleep 300
docker exec -it it-test sh           # a prompt; exit returns
docker rm -f it-test
cd C:\Users\EdvinSyse\code\psapp
docker compose logs -f               # follows; Ctrl+C returns to the prompt within a second
```

**5. Windows Terminal.** Open it and look at the new-tab dropdown: there
should be no `orca` profile. (WSL's own fragment isn't made any more, but
Terminal's built-in WSL generator lists every distro unless hidden.)

**6. Uninstall (section 8)**, with an installer built from this branch:

```powershell
wsl -l -v                                         # orca: Stopped, still listed
Test-Path $env:LOCALAPPDATA\orca-engine           # True
docker context show                               # default (if docker.exe is still on your PATH)
[Environment]::GetEnvironmentVariable('Path','User') -split ';' | Select-String orca-engine   # nothing
```

**7. Leftovers that need admin** (admin PowerShell): the firewall rules for
the dev build and its test copy (both folders are deleted), and Docker
Desktop's install logs.

```powershell
Get-NetFirewallApplicationFilter | Where-Object Program -like '*\projects\orca-ecc*' | Get-NetFirewallRule | Remove-NetFirewallRule
Remove-Item -Recurse -Force C:\ProgramData\DockerDesktop
```

Steps 1–6 need the branch's Orca, from a fresh build (the debug build used
here is deleted).

