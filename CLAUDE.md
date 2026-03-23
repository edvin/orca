# Orca Desktop — Development Guide

## Architecture

- **Rust workspace** with 7 crates (see `Cargo.toml`)
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
- Template icons are 2-letter text badges, not emoji
