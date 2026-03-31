# Privacy Statement

**Last updated: March 31, 2026**

Orca Desktop is open source software that runs entirely on your machine. We believe container management tools should never phone home, collect telemetry, or require accounts. This document describes every network connection the app makes.

## TL;DR

- **No telemetry.** No analytics. No crash reporting. No tracking.
- **No accounts.** No sign-up. No login. No cloud service.
- **No data leaves your machine** unless you explicitly initiate it (e.g., pulling an image or asking the AI assistant a question).
- **All source code is open** — verify any claim yourself at [github.com/edvin/orca](https://github.com/edvin/orca).

## Network Connections

Orca Desktop makes the following network connections. Every single one is listed here — there are no hidden calls.

### Automatic

| Connection | Destination | Purpose | Data Sent |
|---|---|---|---|
| **Update check** | `github.com` | Check for new app versions | App version (via GitHub Releases API) |
| **Template catalog** | `orca-desktop.com/templates.json` | Fetch community app templates | None (plain GET request) |

The template catalog is fetched once per hour and cached locally. If you're offline, the cached version is used. The update check uses Tauri's built-in updater and can be disabled in settings.

### User-Initiated Only

These connections are **only made when you explicitly perform an action**:

| Connection | Destination | Purpose | When |
|---|---|---|---|
| **Image search** | `hub.docker.com` | Search Docker Hub for images | You type in the image search box |
| **Tag lookup** | `hub.docker.com` | Fetch available tags for an image | You open the tag dropdown |
| **Image pull** | Container registries | Download container images | You click "Pull" |
| **AI assistant** | Your configured AI provider | Send container context to AI | You click "Ask AI" |
| **Remote hosts** | Your configured Orca daemons | Manage containers on remote machines | You add a remote host |

### AI Assistant — Your Keys, Your Choice

The AI assistant is **entirely optional** and **off by default**. When enabled:

- You provide your own API key — we never see it
- You choose the provider: Anthropic, OpenAI, Google, Ollama (local), or any OpenAI-compatible endpoint
- Context sent to the AI includes only what you see on screen (container logs, error messages, your question)
- Use Ollama for **fully offline, private AI** — no data leaves your machine
- API keys are stored locally in your Orca config file, never transmitted anywhere except to the provider you chose

### What We Never Do

- Collect usage analytics or behavioral data
- Track which features you use
- Report crashes or errors to any service
- Fingerprint your system
- Phone home to any Orca-operated server (we don't have one)
- Access your containers, images, or files beyond what you see in the UI
- Store or transmit registry credentials anywhere except your local config file

## Local Data Storage

All data is stored locally on your machine:

| Data | Location |
|---|---|
| Configuration | `~/.config/orca/config.json` (Linux), `~/Library/Application Support/orca/config.json` (macOS), `%APPDATA%/orca/config.json` (Windows) |
| Daemon log | `~/.config/orca/daemon.log` |
| Stack files | `~/.config/orca/stacks/` |
| CA certificate & key | `~/.config/orca/ca/` |
| Gateway TLS certs | `~/.config/orca/ca/certs/` |
| API token | Generated locally, stored in config file |

Registry credentials are stored **base64-encoded** (not encrypted) in the config file, consistent with how Docker itself stores credentials in `~/.docker/config.json`.

## Network Security

- The daemon API listens on `127.0.0.1:9477` only — it is not accessible from the network
- All API calls (except health check) require a locally-generated bearer token
- Remote host connections support TLS verification
- Webhook endpoints use HMAC-SHA256 signature validation

## Open Source Guarantee

Orca Desktop is [MIT licensed](LICENSE). The complete source code is available on GitHub. You can:

- Audit every network call in the codebase
- Build from source to verify the published binaries match
- Fork and modify for your organization's needs

## Contact

Questions about privacy? [Open an issue](https://github.com/edvin/orca/issues).
