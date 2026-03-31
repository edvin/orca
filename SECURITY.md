# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| Latest release | Yes |
| Previous release | Security fixes only |
| Older releases | No |

We recommend always running the latest version. Orca Desktop includes a built-in updater that checks for new versions on startup.

## Reporting a Vulnerability

If you discover a security vulnerability in Orca Desktop, **please report it responsibly**.

**Do NOT open a public issue for security vulnerabilities.**

Instead, please email **security@orca-desktop.com** with:

1. A description of the vulnerability
2. Steps to reproduce
3. The version of Orca Desktop affected
4. Any potential impact assessment

### What to Expect

- **Acknowledgment** within 48 hours
- **Assessment** within 1 week
- **Fix** released as soon as possible, depending on severity
- **Credit** in the release notes (unless you prefer anonymity)

## Security Architecture

### Daemon Security

- The Orca daemon binds to `127.0.0.1:9477` — **localhost only**, not accessible from the network
- All API endpoints (except `/api/v1/health`) require a bearer token
- The API token is generated randomly on first start and stored in the local config file
- The daemon runs with the same permissions as the current user — no root/admin escalation

### Remote Host Security

- Remote host connections support TLS with certificate verification
- Each remote host uses its own API token
- Tokens are stored locally and transmitted only to the configured host
- TLS verification can be configured per-host (enabled by default)

### Webhook Security

- Incoming webhooks (GitHub, Docker Hub) are validated using HMAC-SHA256 signatures
- Webhook secrets are generated locally and never transmitted
- Webhook endpoints only trigger pre-configured deploy rules — arbitrary commands cannot be executed

### AI Assistant Security

- AI is entirely optional and disabled by default
- API keys are stored locally, never shared with Orca or any third party
- Only visible container context (logs, errors) is sent to the AI provider — never credentials, tokens, or config files
- Ollama support enables fully air-gapped AI with no external network access

### Code Signing

All official releases are code-signed:

- **macOS**: Signed with Developer ID and notarized by Apple
- **Windows**: Signed with an EV code certificate via SSL.com
- **Linux**: Distributed as `.deb` and `.AppImage`

### Supply Chain

- All dependencies are managed through Cargo (Rust) and npm (TypeScript)
- CI builds are reproducible via GitHub Actions
- Release artifacts are built in GitHub's hosted runners, not on developer machines
- The Tauri updater verifies release signatures before applying updates

## Dependency Updates

We regularly update dependencies to include security patches. If you notice an outdated dependency with a known vulnerability, please open an issue or submit a pull request.

## Scope

The following are **in scope** for security reports:

- Vulnerabilities in Orca Desktop code (Rust backend, TypeScript frontend, Tauri bridge)
- Authentication or authorization bypasses in the daemon API
- Injection vulnerabilities (command injection, XSS, path traversal)
- Credential exposure or leakage
- Insecure defaults

The following are **out of scope**:

- Vulnerabilities in Docker, Podman, Kubernetes, or other tools Orca manages
- Issues requiring physical access to the machine
- Social engineering
- Denial of service against the local daemon

## Security Hardening for Enterprise

For enterprise deployments, we recommend:

1. **Use TLS for remote hosts** — Always enable TLS verification when connecting to remote Orca daemons
2. **Rotate API tokens** — Regenerate tokens periodically via Settings > About > Reset
3. **Use Ollama for AI** — Keep all AI processing local and air-gapped
4. **Review webhook rules** — Audit auto-deploy rules regularly
5. **Network segmentation** — Run Orca daemon behind your firewall; it should never be exposed to the public internet
