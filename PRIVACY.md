# Privacy Statement

**Last updated: October 22, 2026**

Orca Desktop is open source software that runs on your machine. It has no telemetry, no accounts and no Orca server. This document lists what it connects to and what it sends.

## Summary

- **No telemetry.** No analytics, no crash reporting, no tracking.
- **No accounts.** No sign-up, no login, no cloud service.
- **Data leaves your machine only for things you use:** checking for updates, pulling images, setting up tools, and the AI assistant if you configure one.
- **The source is open:** check any claim at [github.com/edvin/orca](https://github.com/edvin/orca).

## Network connections

Besides the remote hosts you add and the services your own containers use, Orca connects to:

| Destination | When | What is sent |
|---|---|---|
| `github.com` | Update check, shortly after start and every hour | A request for the latest release |
| `orca-desktop.com/templates.json` | When you open the App Catalog (cached for an hour) | A plain request |
| `hub.docker.com` | When you search for images or open an image's tags | Your search |
| Container registries | When you pull an image, and the Trivy image and database when you scan one | The image reference, and your registry login if you saved one |
| `github.com`, `raw.githubusercontent.com`, `get.docker.com`, `get.k3s.io` | When you ask Orca to set up Docker, Lima, Helm or Kubernetes | Requests for the installers |
| Your AI provider | When you use the AI assistant | See below |
| GitHub, Docker Hub (inbound) | Webhooks you configure for push to deploy | — |

## The AI assistant

The assistant is optional and does nothing until you configure a provider (Anthropic, OpenAI, Google, Ollama or any OpenAI-compatible endpoint). Requests go straight from your machine to that provider, never through an Orca server. With Ollama, nothing leaves your machine.

The provider receives your question, the conversation so far, and the results of the tools the assistant uses to answer, such as a container's details or recent log lines. Before anything is sent, Orca blanks out values that look secret: passwords, tokens and API keys in environment variables and other fields, passwords in URLs, and the data of Kubernetes Secrets. Log lines are sent as they are.

API keys are stored in Orca's config file and sent only to the provider you chose.

## Local data

Everything Orca stores is on your machine:

| Data | Location |
|---|---|
| Configuration, API token, registry logins, AI keys | `config.json` in `~/.config/orca/` (Linux), `~/Library/Application Support/orca/` (macOS) or `%APPDATA%\orca\` (Windows), readable only by you |
| Stack files | `orca/stacks/` in the same folder |
| Local certificate authority and gateway certificates | `orca/ca/` in the same folder |

Registry passwords are stored base64-encoded, not encrypted, like Docker's own `~/.docker/config.json`.

More detail: [Security and privacy](https://orca-desktop.com/docs/security/).
