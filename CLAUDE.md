# Orca Desktop — Development Guide

## Architecture

- **Rust workspace** with 6 crates plus the Tauri app (see `Cargo.toml`)
- **Frontend**: SolidJS + TypeScript in `gui/`
- **Desktop**: Tauri 2 in `src-tauri/`
- **Daemon**: Axum REST API at `http://127.0.0.1:9477/api/v1/`

## Running the daemon locally

The Tauri desktop app bundles and manages its own daemon, but for development
you need to run the daemon manually from the latest source:

```bash
# Kill any existing daemon (Tauri-managed or old dev instance)
pkill orca-daemon

# Build and run with debug logging
cargo run --bin orca-daemon

# Or build then run separately
cargo build --bin orca-daemon
./target/debug/orca-daemon
```

### Verify the daemon is running the correct version

```bash
curl -s http://127.0.0.1:9477/api/v1/health
# Should return: {"status":"ok","version":"0.7.5"}
```

The version must match `workspace.package.version` in `Cargo.toml`.

### Common issue: old daemon still running

If you see "Another Orca daemon is already running", kill it first:

```bash
pkill orca-daemon
# Or find and kill by PID:
lsof -i :9477
kill <PID>
```

## Running the frontend dev server

```bash
cd gui
npm run dev
# Runs at http://localhost:5173
```

The Vite config includes a proxy that forwards `/api/v1/*` to the daemon,
so the frontend can reach the daemon without CORS issues.

## API token

The daemon generates an API token on first start, stored in:
- Linux: `~/.config/orca/config.json`
- macOS: `~/Library/Application Support/orca/config.json`

All API calls require `Authorization: Bearer <token>` except `/api/v1/health`.

```bash
# Read the token
cat ~/.config/orca/config.json | python3 -c "import sys,json; print(json.load(sys.stdin)['api_token'])"

# Test an authenticated endpoint
TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.config/orca/config.json'))['api_token'])")
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9477/api/v1/containers
```

## Type checking

```bash
# Rust
cargo check

# TypeScript
cd gui && npx tsc --noEmit
```

## Screenshot test suite

Automated headless screenshots using Playwright + Tauri IPC mock:

```bash
cd gui

# Requires: daemon running + vite dev server running
DISPLAY= npx playwright test

# Run specific test
DISPLAY= npx playwright test -g "Dashboard"

# Screenshots saved to: screenshots/
```

The test mocks `window.__TAURI_INTERNALS__` and proxies API calls through Vite
to the real daemon, so screenshots show real Docker/K8s data.

## Kubernetes

Orca uses its own `orca` context in `~/.kube/config` — it never reads the
user's current-context to avoid connecting to remote clusters.

```bash
# Check if the orca context exists
kubectl config get-contexts | grep orca

# Use it manually
kubectl --context orca get pods -A
```

K3s is installed on this dev machine. The `orca` context was added via:
```bash
kubectl config set-cluster orca --server=https://127.0.0.1:6443
kubectl config set-context orca --cluster=orca --user=orca
# + certificate data from /etc/rancher/k3s/k3s.yaml
```

## Key files

| Path | Purpose |
|------|---------|
| `crates/orca-daemon/src/api.rs` | All REST API routes and handlers |
| `crates/orca-daemon/src/main.rs` | Daemon startup, Docker connection |
| `crates/orca-backend-common/src/k8s.rs` | Kubernetes operations |
| `crates/orca-core/src/config.rs` | Config persistence |
| `src-tauri/src/commands.rs` | Tauri IPC commands (frontend ↔ daemon bridge) |
| `src-tauri/src/daemon.rs` | Daemon lifecycle management |
| `src-tauri/src/lib.rs` | Command registration |
| `gui/src/pages/` | All frontend page components |
| `gui/src/components/` | Shared components |
| `gui/src/lib/types.ts` | TypeScript type definitions |
| `docs/index.html` | Landing page (orca-desktop.com) |

## Conventions

- Never use native `<select>` elements — use the custom `Dropdown` component
- Use `validate_k8s_name()` on all K8s name/namespace inputs in Tauri commands
- K8s operations: WSL kubectl on Windows, kube client on Linux/macOS
- All inline styles matching dark theme (#0a0e14 bg, #e6edf3 text, #58a6ff accent)
- Template icons are inline SVG strings rendered via innerHTML, not text or emoji

## Windows: Orca's engine in WSL

Orca runs Docker in a WSL distro of its own, `orca` (Ubuntu 26.04's WSL
image), reached over mutual TLS on `127.0.0.1:2376`; see
`crates/orca-backend-common/src/wsl.rs`. `docker`/compose run inside the
distro (`wsl::OnEngine`), `docker.exe` in PowerShell goes through the
path-rewriting proxy on `\\.\pipe\orca_docker` (`engine_proxy.rs`), and
`host_relay.rs` lets containers reach dev servers on Windows' localhost.
Docker Desktop's engine is never used, on any platform (`engine.rs`).

Things that cost time and aren't visible from the code:

- **All WSL 2 distros share one kernel and one network namespace**: one
  `docker0`, one iptables, one binfmt_misc, one set of listening ports.
  Anything Orca does in `orca` at that level reaches the user's distros.
  Don't drop `orca-binfmt-guard.service`, `--bridge=orca0`, the address
  pool or `--live-restore` from the setup script without reading `53054f8`.
- **If Windows programs stop running in WSL** (`Exec format error` on any
  `.exe`), `WSLInterop` was unregistered. A privileged container can put it
  back: `docker run --rm --privileged --network host alpine sh -c 'mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc; echo ":WSLInterop:M::MZ::/init:P" > /proc/sys/fs/binfmt_misc/register'`
- **WSL's 127.0.0.1 forwarding doesn't carry a TCP half-close**: it closes
  the connection. Never `shutdown(Write)` a socket to Orca's engine from
  Windows; end input with TLS close_notify only (`engine_proxy::Engine`).
- **A Windows named pipe can't half-close**: the proxy closes the client
  pipe when the engine ends an attached stream.
- **mio's named pipes lose data in message read mode** (messages over 4 KB).
  Keep `byte_reads` on every `orca_docker` instance; the pipe itself stays
  message mode so `docker.exe` can signal stdin's end.
- **Tokio sockets are inheritable on Windows.** Bind listeners with
  `crate::listen` (std), or a `wsl.exe` child holds the port after the
  daemon exits.
- **Compose records Linux paths** (`/mnt/c/…`) in its labels; Orca reads
  them back as Windows paths (`wsl::host_labels`, in `containers.rs`).
- **Another distro's ports**: `wsl::ports_held_elsewhere()`. Use it in any
  new port check on Windows; binding on Windows' side doesn't see WSL's.
- **The undo script**: anything the integrations set up outside Orca also
  belongs in `wsl::undo_integration_script`, which the uninstaller runs.
- **Building on Windows**: `cargo build --bin orca-daemon` needs nothing
  extra. `cargo check -p orca-gui` needs `gui/dist` and
  `src-tauri/binaries/orca-x86_64-pc-windows-msvc.exe`. Keep clippy clean on
  Windows: `#[cfg(windows)]` code only fails there. From a Mac,
  `cargo clippy --target x86_64-pc-windows-gnu -p orca-daemon` (mingw-w64)
  checks it.
- `curl.exe` can't test the engine's TLS port (Schannel won't load PEM
  keys). Use curl in a distro, or `docker --tlsverify -H tcp://127.0.0.1:2376`.

## Pending macOS Debugging

These issues only reproduce on macOS and need debugging with dev tools:

### 1. Terminal cursor not visible
- Block cursor is set (`cursorStyle: "block"`, `cursorAccent`) but doesn't render
- Font loaded via FontFace API from `/fonts/JetBrainsMonoNerdFont-Regular.ttf`
- Suspect: font fails to load in Tauri webview → xterm falls back to system font with wrong metrics → cursor renders off-screen
- **Debug**: Open dev tools → Console → check for font loading errors. Inspect `.xterm-cursor-layer` canvas.

### 2. Terminal font size +/- only changes line height
- `term.options.fontSize = next` followed by `fitAddon.fit()` doesn't re-render text
- Tried `_renderService.clear()` — untested on macOS
- **Debug**: In console, try `term.options.fontSize = 20` manually. Check if canvas redraws.

### 3. Monaco YAML editor jumbles on scroll
- Sticky scroll disabled, conflicting CSS removed, vite-plugin-monaco-editor added
- Text overlaps/jumbles when scrolling in modal dialogs
- **Debug**: Inspect `.monaco-editor` DOM. Check if `.overflow-guard` and `.view-overlays` are positioned correctly. Try `editor.layout()` manually.

### Likely root cause (found in v0.64.1)
Tauri adds a nonce to `index.html`'s inline `<style>` and to the CSP's `style-src`, and with a nonce present browsers ignore `'unsafe-inline'`: every `<style>` element a library adds at runtime was blocked. CodeMirror (the YAML editor: line numbers, no text) and xterm (cursor, font size) both inject them. Reproduced in Chromium with the same CSP. `security.dangerousDisableAssetCspModification: ["style-src"]` in `tauri.conf.json` keeps `style-src` as written. Recheck the three issues above on macOS once that release is installed.

### How to debug
```bash
cd ~/projects/orca
cargo tauri dev  # Opens app with dev tools
# Right-click → Inspect Element → Console/Elements
```
