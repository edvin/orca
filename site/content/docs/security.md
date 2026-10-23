---
title: Security and privacy
nav: Security & privacy
description: How Orca protects its API, where tokens, keys and certificates live, which network connections it makes, and how to report a vulnerability.
---

This page explains how the Orca daemon authenticates requests, what it listens on, where secrets are stored, and which connections Orca makes to the outside world. Read it before exposing a daemon on a network or turning on the AI assistant.

## API authentication

Everything Orca does goes through the daemon's REST API. Every request needs the daemon's API token:

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9477/api/v1/containers
```

- The daemon generates the token on first start: 16 random bytes from the operating system's secure random number generator, written as 32 hex characters.
- Tokens are compared in constant time, so response timing doesn't reveal how much of a guess was right.
- WebSocket connections, used for terminals and the Kubernetes setup log, pass the token as a `token` query parameter instead of a header, and the daemon checks it the same way.

A few routes don't take the API token:

| Route | Why |
|---|---|
| `/api/v1/health` | Reports status and version, so the app can check the daemon is up. |
| `/api/v1/ca/certificate` | Returns the public certificate of the local CA, so you can trust it. |
| `/api/v1/webhooks/github`, `/api/v1/webhooks/dockerhub` | Authenticated with the webhook secret instead. See [Push to deploy](/docs/auto-deploy/). |

The `orca` CLI reads the token from the config file. Pass `--token` or set `ORCA_TOKEN` to use a different one.

### Where the token lives

The token is stored as `api_token` in Orca's `config.json`:

| System | Path |
|---|---|
| Linux | `~/.config/orca/config.json` |
| macOS | `~/Library/Application Support/orca/config.json` |
| Windows | `%APPDATA%\orca\config.json` |
| Linux server package | `/etc/orca/config.json` |

On Linux, `/etc/orca/config.json` takes precedence when it exists. On Linux and macOS the file is written with mode `600`, and the daemon logs a warning if it finds it readable by other users. To rotate the token, change or remove `api_token` and restart the daemon. A missing token is regenerated on start.

## Network exposure

The daemon listens on `127.0.0.1:9477` by default, so only programs on the same machine can reach it. The desktop app always starts it this way. The daemon speaks plain HTTP, which is fine on the loopback interface.

You can change this with flags when you run `orca-daemon` yourself:

- `--bind <ADDR>` listens on another address: an IPv4 or IPv6 address, or `localhost`. Any address that isn't a loopback address (`127.0.0.1`, `localhost`, `::1`) makes the daemon log `WARNING: Daemon binding to <ADDR> — the API will be network-accessible!`.
- `--socket <PATH>` listens on a Unix socket instead of TCP, created with mode `660`, so access follows file permissions. `--socket auto` uses `$XDG_RUNTIME_DIR/orca-daemon.sock`. The token is still required.

The server package for [remote hosts](/docs/remote-hosts/) binds to `0.0.0.0` so the desktop app can connect.

> [!WARNING]
> Anyone who has the token controls Docker on that machine, which is equivalent to root. Don't expose port 9477 to the internet without TLS. Put a reverse proxy in front of it, as described in [Remote hosts](/docs/remote-hosts/#add-tls-with-a-reverse-proxy), or reach it over an SSH tunnel.

### Remote host connections

Each remote host has its own token, saved in plain text in the desktop app's `config.json` and sent only to that host. **Verify TLS certificate** is on by default for `https://` hosts. Turn it off only for a self-signed certificate you trust.

## Local certificate authority

The [gateway](/docs/gateway/) serves your containers over HTTPS with certificates signed by a local certificate authority that Orca creates the first time it needs one.

- The CA certificate and key are stored in `orca/ca/` inside the config directory, for example `~/.config/orca/ca/` on Linux. The key is written with mode `600` and isn't encrypted.
- The CA is valid for 10 years. Certificates for gateway hostnames are stored in `orca/ca/certs/` and are valid for one year.
- Orca never adds the CA to your system's trust store by itself. You do that from **Settings**, **Certificates**, with **Download CA certificate** and the command shown for your system, or with `orca ca install`, which runs that command with `sudo`.

Because a trusted CA can sign a certificate for any hostname, treat `ca-key.pem` like a password. To stop trusting the CA, remove "Orca Desktop CA" from your system's trust store. Deleting the files alone doesn't do that.

## Updates

Orca Desktop checks for a new version shortly after it starts and then every hour, by fetching `latest.json` from the project's GitHub releases. When one is available, the status bar shows **Update available**. Nothing is installed until you click it and confirm.

Updates are signed. The updater checks each download against the public key built into the app and refuses an update whose signature doesn't match.

## No telemetry

Orca has no analytics, crash reporting or usage tracking, and no accounts. There is no Orca server that it reports to. The source code is MIT licensed at [github.com/edvin/orca](https://github.com/edvin/orca), so you can check this yourself.

Orca connects to these places, besides the hosts you add:

| Destination | When |
|---|---|
| `github.com`, `raw.githubusercontent.com` | The update check, and the Helm or Homebrew install scripts when you ask Orca to install them. |
| `api.github.com` | When an AI tool asks whether Orca is up to date (`check_for_update`), to read the release list. Cached for an hour. |
| `orca-desktop.com/templates.json` | When you open the templates catalog. Cached for an hour. |
| `hub.docker.com` | When you search for images or open the tag list for an image. |
| Container registries | When you pull an image. Image scanning also pulls the Trivy image and its vulnerability database. |
| `get.docker.com`, `get.k3s.io` and similar installers | When you ask Orca to set up Docker or [Kubernetes](/docs/kubernetes/). |
| Your AI provider | When you use the AI assistant. |
| GitHub or Docker Hub, inbound | Webhooks you've configured for push to deploy. |

## The AI assistant

The built-in AI assistant is optional and does nothing until you choose a model under **Settings → AI & agents → Built-in assistant**: a local model server (Ollama, LM Studio, llama.cpp), or a cloud API key for Anthropic, OpenAI, Google Gemini or another OpenAI-compatible endpoint.

Requests go straight from the daemon to the provider you chose, never through an Orca server. With a local model, nothing leaves your machine. On Linux and Windows, Orca can set Ollama up for you as a container.

What the provider receives:

- your question and the conversation so far
- for a container you ask about: its name, image, exit code, error text and the last 50 log lines
- the results of any Orca tools the assistant calls while answering, such as inspecting a container or listing resources

Secrets in tool results stay on your machine: before anything is sent, Orca blanks out values whose names look secret (passwords, tokens, API keys, `DATABASE_URL` and the like) in environment variables, labels and other fields, passwords inside URLs, and the data of Kubernetes Secrets. Other configuration and log lines are sent as they are, so don't ask the assistant about logs that print secrets, or use a local model.

The MCP endpoint and the other agent APIs return tool results unchanged: there, you run the agent and choose its provider.

Log output is marked as untrusted when it's sent to the model, which makes it harder for text in a log to pose as instructions.

API keys are saved in plain text in Orca's `config.json`, protected by the file's permissions, and are never returned by the API. You can set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GOOGLE_API_KEY` in the daemon's environment instead; a key there takes precedence over a saved one, and Settings shows which is in use.

The agent APIs, including the MCP endpoint at `/api/v1/agent/mcp`, require the API token like every other route.

## Report a vulnerability

Report security issues privately through [GitHub Security Advisories](https://github.com/edvin/orca/security/advisories/new), not as a public issue. Include:

1. a description of the vulnerability
2. steps to reproduce
3. the affected version of Orca Desktop
4. the impact as you see it

The project aims to acknowledge reports within 48 hours and assess them within a week, and credits reporters in the release notes unless you'd rather stay anonymous. Security fixes go into the latest release, and into the previous release when needed.

In scope are vulnerabilities in Orca's own code: the Rust daemon, the frontend and the Tauri bridge, including authentication bypasses, injection, credential leaks and insecure defaults. Vulnerabilities in Docker, Podman, Kubernetes or other tools Orca manages are out of scope, as are attacks that need physical access, social engineering, and denial of service against the local daemon.
