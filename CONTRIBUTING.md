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

#### Single container template

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

#### Compose stack template (multi-service)

For apps that need multiple services (e.g., WordPress + MySQL), use `compose_yaml` instead of `image`:

```json
{
  "id": "my-stack",
  "name": "My Stack",
  "description": "Full stack with app + database.",
  "icon": "<svg ...>...</svg>",
  "category": "Web Server",
  "image": "",
  "compose_yaml": "version: '3.8'\nservices:\n  app:\n    image: myapp:latest\n    ports:\n      - '8080:80'\n    environment:\n      DB_PASSWORD: changeme\n    depends_on:\n      - db\n  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_PASSWORD: changeme\n    volumes:\n      - db-data:/var/lib/postgresql/data\nvolumes:\n  db-data:\n",
  "default_ports": [],
  "default_env": [],
  "default_volumes": [],
  "restart_policy": "",
  "notes": "Access at http://localhost:8080. Database included.",
  "is_builtin": true
}
```

Compose stacks are saved to `~/.config/orca/stacks/<id>/docker-compose.yml` and can be edited later from the Stack Detail page.

#### Auto-generated environment variables

Use `generated_env` to auto-generate secrets, keys, or prompt the user for input at deploy time. Generated values are written to the stack's `.env` file.

```json
{
  "generated_env": {
    "SECRET_KEY": { "type": "random_hex", "length": 64 },
    "SESSION_SECRET": { "type": "random_base64", "length": 32 },
    "LAN_IP": { "type": "lan_ip" },
    "ADMIN_EMAIL": {
      "type": "user_input",
      "label": "Admin email address",
      "placeholder": "admin@example.com",
      "required": true
    }
  }
}
```

Available types:

| Type | Description |
|---|---|
| `random_hex` | Random hex string. `length` = number of hex chars (default: 32) |
| `random_base64` | Random base64 string. `length` = number of bytes (default: 32) |
| `lan_ip` | Auto-detect the machine's LAN IP address |
| `user_input` | Prompt the user during deploy. Fields: `label`, `placeholder`, `required`, `secret` |

#### Post-deploy setup guide

For complex stacks that need configuration after deployment, add a `setup_guide`. This shows a step-by-step wizard dialog after the stack is deployed.

```json
{
  "setup_guide": {
    "title": "My App Setup",
    "steps": [
      {
        "title": "Wait for services to start",
        "description": "The stack needs about 30 seconds to initialize."
      },
      {
        "title": "Open the admin panel",
        "description": "Create your admin account.",
        "type": "link",
        "url": "http://localhost:8080/admin"
      },
      {
        "title": "Check the logs for the initial password",
        "description": "The admin password is printed in the app container logs.",
        "type": "action",
        "action": "view_logs",
        "service": "app"
      },
      {
        "title": "Run database migrations",
        "description": "Initialize the database schema.",
        "type": "action",
        "action": "exec",
        "service": "app",
        "command": ["python", "manage.py", "migrate"]
      },
      {
        "title": "Set the API key",
        "description": "Paste the API key from the admin panel.",
        "type": "set_env",
        "env_key": "API_KEY",
        "label": "Paste the API key"
      },
      {
        "title": "Restart the app",
        "description": "Restart to pick up the new configuration.",
        "type": "action",
        "action": "restart_service",
        "service": "app"
      }
    ]
  }
}
```

**Step types:**

| Type | Fields | What it does |
|---|---|---|
| `info` (default) | — | Read-only instruction |
| `link` | `url` | Opens URL in system browser |
| `action` | `action`, `service` | Performs an action on a compose service |
| `set_env` | `env_key`, `label` | Text input that saves a value to the stack's `.env` file |

**Action types** (used with `"type": "action"`):

| Action | Fields | What it does |
|---|---|---|
| `view_logs` | `service` | Navigate to the service's container logs |
| `restart_service` | `service` | Stop and start the service container |
| `exec` | `service`, `command` | Run a command inside the container, show output |
| `terminal` | `service` | Open an interactive terminal in the container |

Steps show a numbered stepper UI with checkmarks. Users can mark steps as done to track their progress.

3. Open a pull request

### Template guidelines

- **`id`**: Unique lowercase identifier (e.g., `my-app`)
- **`icon`**: Inline SVG string (24x24 viewBox, stroke-based Lucide style)
- **`category`**: Use an existing category or create a new one (Database, Web Server, Monitoring, Tools, AI, Development, Message Queue, Search, Storage, Analytics, Automation, Communication)
- **`default_env`**: Use `changeme` for passwords — Orca auto-generates a unique password at deploy time
- **`compose_yaml`**: For multi-service stacks. Use `changeme` for passwords. Newlines as `\n`.
- **`generated_env`**: Auto-generate secrets or prompt the user for values. Written to `.env` at deploy time.
- **`setup_guide`**: Post-deploy wizard for complex stacks. See step types above.
- **`gateway_routes`**: Auto-register hostnames with the Orca Gateway on deploy. See below.
- **`notes`**: Short text shown as a toast after deploy (skipped if `setup_guide` is present)
- **`restart_policy`**: Use `unless-stopped` for services, `no` for tools (single container only)
- **`is_builtin`**: Set to `true` so it appears as a catalog template (not user-created)

#### Gateway routes

Templates can auto-register hostnames with the Orca Gateway on deploy:

```json
{
  "gateway_routes": [
    { "hostname": "app", "service": "frontend", "port": 3000 },
    { "hostname": "api", "service": "backend", "port": 8080 }
  ]
}
```

With the default domain `localhost`, these become `https://app.localhost` and `https://api.localhost`. Users can change the base domain in Settings > Gateway.

### `orca.yaml` — Project-level config

Any project with a `docker-compose.yml` can include an `orca.yaml` in the same directory. When the stack is deployed through Orca, gateway routes are auto-registered and environment links become available in the Gateway dashboard.

#### Gateway routes

```yaml
# orca.yaml — checked into git, shared with the team
gateway:
  - hostname: app
    service: frontend
    port: 3000
  - hostname: api
    service: backend
    port: 8080
  - hostname: admin
    service: admin-panel
    port: 3001
```

Routes are auto-registered when the stack is deployed. Hostnames are editable during deploy and overrides are saved per-user in Orca's config.

#### Environment links

Add a `links` section to organize URLs by group and environment. This turns the Gateway dashboard into a developer portal for your project:

```yaml
links:
  Storefront:
    - name: Web App
      local: app                              # references gateway hostname above
      staging: https://staging.example.com
      production: https://www.example.com
    - name: Storybook
      local: app/storybook
      staging: https://staging.example.com/storybook

  Admin:
    - name: Admin Panel
      local: admin
      staging: https://staging-admin.example.com
      production: https://admin.example.com
    - name: API Docs
      local: api/docs
      staging: https://staging-api.example.com/docs
      production: https://api.example.com/docs

  Infrastructure:
    - name: Grafana
      staging: https://grafana.staging.example.com
      production: https://grafana.example.com
    - name: Sentry
      production: https://sentry.example.com
```

**How it works:**
- Top-level keys under `links:` are group names (shown as sections in the UI)
- Each link has a `name` and one or more environment URLs
- `local` values reference gateway hostnames — auto-resolved to `https://{hostname}.{domain}`
- Other keys (`staging`, `production`, etc.) are full URLs — environment names are freeform
- Links without a `local` value only show up in non-local environments
- The Gateway landing page and Orca UI show environment tabs to switch between them

#### Full `orca.yaml` example

```yaml
# orca.yaml — complete example
gateway:
  - hostname: app
    service: frontend
    port: 3000
  - hostname: api
    service: backend
    port: 8080

links:
  Frontend:
    - name: Web App
      local: app
      staging: https://staging.example.com
      production: https://www.example.com

  Backend:
    - name: API
      local: api
      staging: https://staging-api.example.com
      production: https://api.example.com
    - name: API Docs
      local: api/docs
```

### Team setup

For teams using a shared domain (e.g., `*.dev.example.com`), create a setup repo with:

```
team-devtools/
  wildcard.pem          # wildcard cert for *.dev.example.com
  wildcard-key.pem      # private key
  team-config.yaml      # orca config export
  setup.sh              # one-liner for new devs
```

`setup.sh`:
```bash
#!/bin/bash
orca gateway config \
  --domain dev.example.com \
  --tls-mode custom \
  --cert-file wildcard.pem \
  --key-file wildcard-key.pem
orca gateway start
echo "Done! Deploy any project with orca.yaml to get started."
```

New dev onboarding: clone the setup repo, run `./setup.sh`, then deploy projects normally. Every project's `orca.yaml` routes and links auto-register with the team domain.

The catalog is fetched by the app every hour and cached locally. New templates appear automatically — no app update needed.

## PR Process

1. Fork the repository and create a feature branch.
2. Make your changes with clear, focused commits.
3. Ensure `cargo fmt`, `cargo clippy`, and `cargo test` all pass.
4. Open a pull request against `main` with a description of what and why.
5. Address review feedback.
