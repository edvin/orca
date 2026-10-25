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

## What still fails, or wasn't tested

- **Kubernetes (5): not tested, on purpose.** This machine's Ubuntu-24.04 runs
  its own k3s (`systemctl is-active k3s`: active), holding `*:6443` and
  `*:10250` and the `cni0` and `flannel.1` interfaces in the namespace `orca`
  shares. A k3s in `orca` would at best fail to bind 6443, and at worst
  rewire `cni0` under the user's cluster. Note that the `orca` kube context
  in `~/.kube/config` (see `CLAUDE.md`) points at 127.0.0.1:6443, which is
  that k3s.
- **The gateway can't start while an earlier Orca's Docker runs.** Its
  `orca-caddy` holds 80/443:
  `failed to bind host port 0.0.0.0:80/tcp: address already in use`.
  `port_conflicts` stays empty, because it binds on Windows, not in WSL's
  namespace. It works once the move's "Stop … when done" ran. The same goes
  for any port the user's own distro publishes.
- **Docker Desktop (6)**: not installed here, so not tested.
- **`wsl --shutdown`, cold boot, mirrored networking (2, 4)**: not tested.
  The session ran inside a WSL distro, and `--shutdown` would have ended it.
- **Uninstall (8)**: not run (no installer: `tauri-cli` isn't installed). The
  hook is right as far as it goes, but it leaves PowerShell's docker context
  on `orca`, whose pipe is gone, and `%LOCALAPPDATA%\orca-engine\cli` on the
  user PATH. So `docker` in PowerShell fails after uninstalling. A distro's
  `orca-wsl` context stays too, pointing at a port nothing answers.
- **Interactive `docker run -it` / `exec -it`, and Ctrl+C on `logs -f`**:
  these need a real console.
- **`redis:2`** didn't come over in the move: it's a layerless 7.94 kB stub in
  the old engine, and Docker Hub no longer serves its digest
  (`failed to resolve reference "docker.io/library/redis@sha256:7568…": not found`).
  It's reported as such, which is right.
- Cosmetic: every `wsl -d orca …` prints
  `wsl: Failed to start the systemd user session for 'root'`. systemd 259's
  `user@0.service` fails in WSL (`Failed to spawn executor: Device or
  resource busy`). Docker doesn't need it.
- Cosmetic: the move's steps still say "in Docker Desktop" when the source
  is the earlier Orca's Docker ("Stop what uses the volumes, in Docker
  Desktop").
- The CA isn't trusted by Windows until the user trusts it (a Windows
  prompt). `https://app.localhost` worked with `-k`.

## Decisions for you

1. **A k3s already in the user's distro.** Orca's k3s would share its ports
   and interfaces. Options: refuse with a clear message when 6443 answers
   from WSL; or run Orca's k3s with its own ports and CIDRs
   (`--https-listen-port`, `--cluster-cidr`, `--service-cidr`, a flannel
   interface of its own), plus a kubeconfig that follows.
2. **Ports the user's own distros hold** (80/443 above, or any service of
   theirs). The port check could also look from inside `orca`, e.g. `ss -ltn`
   in the distro. Your call whether that's worth it.
3. **The addresses**: `orca0` 10.213.0.0/24 and pool 10.214.0.0/16. They keep
   clear of k3s (10.42/10.43), WSL's NAT (172.16/12) and its DNS
   (10.255.255.254), but could meet a VPN's 10.x routes. Pick others if you
   know better ones. And `--live-restore` is now on for Orca's engine
   (containers keep running while dockerd restarts; no swarm).
4. **The distro's context name** `orca-wsl` (was `orca`). I updated
   `site/content/docs/platforms.md` and the checklist; the built `docs/`
   HTML isn't regenerated.
5. **Uninstall**: should it put PowerShell's context back to `default` and
   take `orca-engine\cli` off the PATH, and do the same in the integrated
   distro? I didn't write NSIS I couldn't run.
6. From the original list, still open:
   - *One distro at a time*: unchanged.
   - *`.wslconfig`*: fixed (`b37fa1a`).
   - *Windows on ARM*: unchanged.
   - *`crates/orca-backend-windows`*: the engine works without it, so it can
     go. I left it, as you asked to decide that.

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
- `curl.exe` can't test the engine's TLS port (Schannel won't load PEM
  keys). Use curl in a distro, or `docker --tlsverify -H tcp://127.0.0.1:2376`.

## State of the test machine

- The installed Orca 0.65 (GUI and daemon) is stopped. Its daemon was
  replaced by the branch's debug daemon, which still runs:
  `C:\Users\EdvinSyse\Projects\orca-ecc\target\debug\orca-daemon.exe`, PID in
  `C:\Users\EdvinSyse\Projects\orca-ecc-tools\daemon.pid`, logs next to it.
  Starting the installed 0.65 again would look for the Docker that the move
  disabled.
- Distro `orca` (Ubuntu 26.04.1) runs, with the moved images and volumes, the
  gateway, `orca-postgres-17`, and the test projects in
  `C:\Users\EdvinSyse\code\{app,dbapp,psapp}`.
- Ubuntu-24.04: its Docker is disabled (`systemctl disable --now docker
  docker.socket`, by the move) but installed; `systemctl enable --now docker`
  brings it back. Its docker context is `default` again. Its root stays
  bind-mounted at `/mnt/wsl/orca/distros/Ubuntu-24.04` until WSL shuts down.
- PowerShell: `docker.exe` in `%LOCALAPPDATA%\orca-engine\cli` (on the user
  PATH), compose and buildx in `%USERPROFILE%\.docker\cli-plugins`, context
  `orca` in use. Turn it off in Settings → Engine, or `docker context use
  default`.
- Windows Firewall has allow rules for the debug `orca-daemon.exe` (someone
  answered the prompt).
