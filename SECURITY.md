# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| Latest release | Yes |
| Previous release | Security fixes only |
| Older releases | No |

We recommend always running the latest version. Orca Desktop includes a built-in updater that checks for new versions on startup and every hour.

## Reporting a Vulnerability

If you discover a security vulnerability in Orca Desktop, **please report it responsibly**.

Please use [GitHub Security Advisories](https://github.com/edvin/orca/security/advisories/new) to report vulnerabilities privately. Include:

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

- The desktop daemon binds to `127.0.0.1:9477`, so only programs on the same machine can reach it. The server package binds to `0.0.0.0` so the desktop app can connect; put TLS in front of it.
- Every API endpoint requires the bearer token except `/api/v1/health`, `/api/v1/ca/certificate` (the public CA certificate) and the webhook endpoints, which require the webhook secret.
- The API token is 16 random bytes generated on first start, stored in the config file (mode 600), and compared in constant time.

### Remote Host Security

- Remote host connections support TLS with certificate verification, on by default and configurable per host
- Each remote host uses its own API token, stored in the local config file (mode 600) and sent only to that host

### Webhook Security

- Webhooks are refused until a webhook secret is set
- GitHub webhooks are verified with HMAC-SHA256 signatures; Docker Hub, which can't sign, sends the secret as a token
- A deploy rule's own secret can only trigger that rule
- Webhooks only trigger configured deploy rules; they can't run commands

### AI Assistant Security

- AI is optional and does nothing until you configure a provider
- API keys are stored in the local config file and sent only to the provider you chose
- The assistant sends your question and what its tools read (container details, logs, configuration) to that provider. Values that look secret, such as passwords, tokens and keys in environment variables, passwords in URLs and Kubernetes Secret data, are blanked out first. Log lines are sent as they are.
- With Ollama, nothing leaves your machine

### Code Signing

- **macOS**: signed with a Developer ID and notarized by Apple
- **Updates** on every platform are signed, and the updater refuses a download whose signature doesn't match the key built into the app

### Supply Chain

- Dependencies are managed through Cargo (Rust) and npm (TypeScript), with lockfiles
- Release artifacts are built on GitHub's hosted runners, not on developer machines

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
2. **Rotate API tokens** — Remove `api_token` from the daemon's `config.json` and restart it; a new one is generated
3. **Use Ollama for AI** — Keep all AI processing local and air-gapped
4. **Review webhook rules** — Audit auto-deploy rules regularly
5. **Network segmentation** — Run Orca daemon behind your firewall; it should never be exposed to the public internet
