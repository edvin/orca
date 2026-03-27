# Contributing to Orca

## Dev Environment Setup

You need:

- **Rust** (stable, latest) -- install via [rustup](https://rustup.rs/)
- **Node.js** (18+) and npm -- for the GUI frontend
- **Docker** or **Podman** -- a running container runtime for testing
- **Tauri 2 CLI** -- `cargo install tauri-cli@^2`

## Architecture

The project is organized as a Cargo workspace. Core crates live in `crates/`:

| Crate | Purpose |
|---|---|
| `orca-core` | Shared types, traits, and logic (runtime, images, volumes, networks, compose, k8s) |
| `orca-daemon` | HTTP API daemon (axum-based) that drives the container runtime |
| `orca-cli` | Command-line interface |
| `orca-backend-common` | Shared backend code (Bollard runtime, k3s manager) |
| `orca-backend-native` | Native Linux backend |
| `orca-backend-macos` | macOS backend (Lima-based) |
| `orca-backend-windows` | Windows backend (WSL2-based) |

The Tauri desktop app lives in `src-tauri/` with its frontend in `gui/`.

## Building

### Daemon

```sh
cargo build --bin orca-daemon
```

### Frontend

```sh
cd gui && npm install && npx vite build
```

### Tauri App

```sh
cargo tauri dev
```

This starts both the Vite dev server and the Tauri app with hot-reload.

## Running the Daemon for Testing

```sh
cargo run --bin orca-daemon
```

Make sure Docker or Podman is running. The daemon listens on `http://localhost:9090` by default.

## Tests

Run the Rust test suite:

```sh
cargo test
```

Run Kubernetes integration tests:

```sh
./scripts/test-k8s.sh
```

## Code Style

- Format code before committing: `cargo fmt`
- Fix lint warnings: `cargo clippy`
- The project should compile with zero warnings.

## Contributing App Templates

The App Catalog is powered by an online community template catalog at `docs/templates.json`. Anyone can contribute new templates via a pull request.

### How to add a template

1. Fork the repository
2. Edit `docs/templates.json` and add your template entry:

```json
{
  "id": "my-app",
  "name": "My App",
  "description": "Short description of what this app does.",
  "icon": "<svg ...>...</svg>",
  "category": "Database",
  "image": "myorg/myapp:latest",
  "default_ports": ["8080:80"],
  "default_env": ["KEY=value"],
  "default_volumes": ["appdata:/data"],
  "restart_policy": "unless-stopped",
  "notes": "Access at http://localhost:8080. Configuration tips here.",
  "is_builtin": true
}
```

3. Open a pull request

### Template guidelines

- **`id`**: Unique lowercase identifier (e.g., `my-app`)
- **`icon`**: Inline SVG string (24x24 viewBox, stroke-based Lucide style)
- **`category`**: Use an existing category or create a new one (Database, Web Server, Monitoring, Tools, AI, Development, Message Queue, Search, Storage, Analytics, Automation, Dev Tools)
- **`default_env`**: Use `changeme` for passwords — Orca auto-generates a unique password at deploy time
- **`notes`**: Include how to access the app and any first-run instructions
- **`restart_policy`**: Use `unless-stopped` for services, `no` for tools
- **`is_builtin`**: Set to `true` so it appears as a catalog template (not user-created)

The catalog is fetched by the app every hour and cached locally. New templates appear automatically — no app update needed.

## PR Process

1. Fork the repository and create a feature branch.
2. Make your changes with clear, focused commits.
3. Ensure `cargo fmt`, `cargo clippy`, and `cargo test` all pass.
4. Open a pull request against `main` with a description of what and why.
5. Address review feedback.
