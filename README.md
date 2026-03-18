# Orca

**Open source Docker Desktop alternative** — manage containers, images, compose stacks, and Kubernetes from a single desktop app.

Built with Rust, Tauri, and SolidJS. Works with Docker and Podman.

![Build](https://github.com/edvin/orca/actions/workflows/build.yml/badge.svg)
![License](https://img.shields.io/github/license/edvin/orca)

## Features

### Container Management
- List, inspect, start, stop, kill, remove containers
- **Run containers from images** with ports, volumes, env vars, restart policies
- Live CPU / memory / network stats
- **Log viewer** with search, tail size, auto-scroll
- **Exec terminal** — run commands inside containers with command history
- Real-time event streaming (instant UI updates on container state changes)

### Image Management
- Pull images with progress tracking
- **Build images** from Dockerfile with .dockerignore support and streaming build log
- Tag, remove, batch delete (multi-select with checkboxes)
- **Prune** unused images with space reclaimed reporting

### Compose Stacks
- **Auto-detects** docker-compose projects from container labels
- Groups services by project with status rollup (Running / Partial / Stopped)
- Start / Stop individual services or entire stacks
- **Compose Up / Down / Pull** — runs the actual `docker compose` CLI
- Per-service logs and actions within expanded stack view

### Kubernetes (k3s)
- One-click enable/disable with automatic k3s installation
- **Traefik** ingress controller with dashboard (bundled with k3s)
- Manage pods, deployments, services, ingresses
- **Persistent volume** and PVC management
- Scale deployments, restart rollouts, delete pods
- Pod logs with container selection
- Apply/delete YAML manifests
- Kubeconfig export

### Desktop App
- System tray with show/hide/quit
- Dark theme with polished UI
- Toast notifications for all actions
- Settings page with runtime info
- Auto-starts the daemon on launch

## Architecture

```
┌──────────────────────────────────┐
│     Tauri Desktop App (GUI)      │
│     SolidJS + TypeScript         │
├──────────────────────────────────┤
│          Orca Daemon             │
│     REST API + SSE events        │
│         (port 9477)              │
├──────────────────────────────────┤
│      Platform Backend            │
│  Linux: native Docker/Podman     │
│  macOS: Lima VM                  │
│  Windows: WSL2                   │
├──────────────────────────────────┤
│     Container Runtime            │
│   Docker or Podman (your choice) │
└──────────────────────────────────┘
```

The daemon talks to Docker/Podman via the standard API (bollard). On macOS it manages a Lima VM, on Windows a WSL2 distro. On Linux it talks directly to the runtime — no VM needed.

## Quick Start

### Prerequisites

- **Linux**: Docker or Podman installed
- **macOS**: [Lima](https://lima-vm.io/) installed (`brew install lima`)
- **Windows**: WSL2 enabled with Docker or Podman inside

### Run the daemon

```bash
# Clone and build
git clone https://github.com/edvin/orca.git
cd orca
cargo build --release --bin orca-daemon

# Run (TCP mode for development)
./target/release/orca-daemon

# Or with Unix socket
./target/release/orca-daemon --socket auto
```

The daemon listens on `http://127.0.0.1:9477` by default.

### Test with curl

```bash
# Health check
curl http://127.0.0.1:9477/api/v1/health

# List containers
curl http://127.0.0.1:9477/api/v1/containers

# List images
curl http://127.0.0.1:9477/api/v1/images

# List compose stacks
curl http://127.0.0.1:9477/api/v1/stacks

# Container stats
curl http://127.0.0.1:9477/api/v1/containers/<id>/stats

# Execute command in container
curl -X POST http://127.0.0.1:9477/api/v1/containers/<id>/exec \
  -H "Content-Type: application/json" \
  -d '{"command": ["uname", "-a"]}'
```

### Run the GUI

```bash
# Install frontend dependencies
cd gui && npm install && cd ..

# Development mode (daemon must be running)
cargo tauri dev

# Production build
cargo tauri build
```

### CLI

```bash
cargo build --release --bin orca

# Check daemon status
./target/release/orca status

# Machine management
./target/release/orca machine list
```

## Project Structure

```
orca/
├── crates/
│   ├── orca-core/              # Trait abstractions and types
│   ├── orca-backend-common/    # Shared bollard + k3s implementation
│   ├── orca-backend-native/    # Linux: direct Docker/Podman
│   ├── orca-backend-macos/     # macOS: Lima VM management
│   ├── orca-backend-windows/   # Windows: WSL2 management
│   ├── orca-daemon/            # REST API server (axum)
│   └── orca-cli/               # Command-line interface
├── src-tauri/                  # Tauri desktop app shell
├── gui/                        # SolidJS frontend
│   └── src/
│       ├── pages/              # Stacks, Containers, Images, Volumes,
│       │                       # Networks, Kubernetes, Machine, Settings
│       ├── components/         # LogViewer, ExecTerminal, Toast,
│       │                       # RunContainerDialog, Sidebar
│       └── lib/                # Types, formatters, event system
└── .github/workflows/          # CI/CD (Linux, macOS, Windows)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| GUI shell | Tauri 2 |
| Frontend | SolidJS + TypeScript |
| Daemon | Rust + Axum |
| Container API | Bollard (Docker-compatible) |
| Kubernetes | kube-rs + k3s |
| VM (macOS) | Lima (Apple Virtualization.framework) |
| VM (Windows) | WSL2 |

## API Reference

The daemon exposes a REST API at `http://127.0.0.1:9477/api/v1/`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Daemon health check |
| `/events` | GET | SSE event stream |
| `/containers` | GET, POST | List / create containers |
| `/containers/:id` | GET, DELETE | Inspect / remove |
| `/containers/:id/start` | POST | Start container |
| `/containers/:id/stop` | POST | Stop container |
| `/containers/:id/stats` | GET | Live resource stats |
| `/containers/:id/logs` | GET | SSE log stream |
| `/containers/:id/exec` | POST | Execute command |
| `/images` | GET | List images |
| `/images/pull` | POST | Pull image (SSE progress) |
| `/images/build` | POST | Build image (SSE log) |
| `/images/prune` | POST | Remove unused images |
| `/images/batch-delete` | POST | Delete multiple images |
| `/volumes` | GET | List volumes |
| `/networks` | GET | List networks |
| `/stacks` | GET | List compose stacks |
| `/stacks/:name/up` | POST | docker compose up |
| `/stacks/:name/down` | POST | docker compose down |
| `/machines` | GET | List machines |
| `/k8s/status` | GET | Kubernetes cluster status |
| `/k8s/enable` | POST | Enable Kubernetes |
| `/k8s/pods/:ns` | GET | List pods |
| `/k8s/deployments/:ns` | GET | List deployments |

See the full API in [`crates/orca-daemon/src/api.rs`](crates/orca-daemon/src/api.rs).

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
