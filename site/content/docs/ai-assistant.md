---
title: AI assistant
nav: AI assistant
description: Chat with Orca's built-in AI assistant about your containers and builds, using Anthropic, OpenAI, Gemini, a local Ollama model or any OpenAI-compatible API.
---

Orca has a built-in AI assistant that can look at your containers, images, stacks and Kubernetes cluster and act on them. This page covers choosing a provider, adding an API key, running a local model with Ollama, and asking about a specific container or failed build.

To connect an external agent such as Claude Code instead, see [AI agents and MCP](/docs/agents/).

## Open the assistant

Click the sparkle icon (**AI Assistant**) in the title bar. The assistant opens in its own window, **Orca Desktop AI**, so you can keep it next to the main window.

- Press Enter to send, Shift+Enter for a new line.
- **Compact conversation history** replaces a long conversation (six messages or more) with a short summary.
- **Clear conversation** starts over.

Each question is sent with the last 20 messages, so you can ask follow-ups.

## Choose a provider

Open **Settings → AI & Agents**. Under **AI Assistant**, pick a **Provider**:

| Provider | Endpoint used | Default model |
|----------|---------------|---------------|
| **Anthropic (Claude)** | Anthropic Messages API | `claude-sonnet-4-20250514` |
| **OpenAI (GPT)** | `https://api.openai.com/v1` | `gpt-4o` |
| **Google (Gemini)** | Gemini's OpenAI-compatible API | `gemini-2.0-flash` |
| **Ollama (Local)** | `http://localhost:11434/v1` | `qwen2.5:7b` |
| **Custom** | Any **API Base URL** that supports `/chat/completions` | none |

Enter the **API Key**, click **Save**, then pick a **Model** from the dropdown, which loads once a key is saved. **Test Connection** checks that the provider answers.

![The AI & Agents tab in Settings, with provider buttons, API key and model fields](/assets/screens/settings-ai.webp)

## API keys

**Get Key** next to the key field opens the provider's key page (console.anthropic.com, platform.openai.com or aistudio.google.com). Keys are saved in Orca's local config file and are only sent to the provider you chose.

Orca keeps two key slots: one for Anthropic, and one shared by OpenAI, Gemini, Ollama and Custom. Saving a key for one of those four replaces the saved key for the others.

You can also give the daemon a key through an environment variable instead. When it's set, it takes precedence over the saved key:

| Provider | Environment variable |
|----------|----------------------|
| Anthropic | `ANTHROPIC_API_KEY` |
| Gemini | `GOOGLE_API_KEY` |
| OpenAI, Ollama, Custom | `OPENAI_API_KEY` |

The variable must be set in the environment the daemon runs in. A key from a variable is enough to use the assistant; **Settings** then shows it as **configured (from ANTHROPIC_API_KEY)**, or whichever variable it came from. A custom endpoint such as Ollama needs no key at all.

## Run a local model with Ollama

You can run the assistant without an API key or cloud provider:

1. In **Settings → AI & Agents**, click **Ollama (Local)**.
2. In the **Run AI Locally with Ollama** box, click **Set up Ollama**.

Orca then:

- pulls `ollama/ollama:latest` and starts a container named `ollama` on port 11434, with models stored in the `ollama-models` volume and restart policy `unless-stopped`;
- downloads the `qwen2.5:7b` model (about 4.7 GB, and about 8 GB of RAM to run);
- switches the assistant to Ollama with that model.

If the machine has an NVIDIA GPU, Orca gives it to the container, and the model runs on it. Otherwise the model runs on the CPU. If the download is still going when setup finishes, wait for it or run `docker exec ollama ollama pull qwen2.5:7b`.

To use a different Ollama model, pull it into the container and pick it from **Model**.

## What the assistant can do

The assistant has the same 48 tools that Orca offers to external agents, listed in the [tool reference](/docs/agents/#tool-reference). It uses them to get real data instead of guessing, for example:

- "Why does the api container keep restarting?" (it runs `diagnose_container` and reads the logs)
- "Which container is using port 5432?"
- "Pull postgres:16 and start it with a volume for the data"
- "Scale the web deployment to 3 replicas"
- "Start my worktree instance at /Users/me/src/shop-feature"

When you name a container or image by part of its name and there's exactly one match, the assistant acts on it directly. It asks only when several resources match.

> [!WARNING]
> Tool calls run without a confirmation step, including ones that stop, remove or prune resources. Be explicit about what you want changed. Each message allows up to five rounds of tool calls.

Logs and errors attached with **Ask AI** are passed to the model marked as untrusted data, and the model is told not to follow instructions inside them.

Before a tool result goes to the provider, Orca blanks out secrets in it: values of keys and environment variables that look like passwords, tokens or keys, passwords in URLs, and the data of Kubernetes Secrets. See [Security](/docs/security/#the-ai-assistant).

## Ask about a container

On the **Containers** page, click the sparkle icon in a container's row (**Ask AI about this container**). The assistant window opens with that container as context: its name, image and the last 50 log lines. A banner above the input shows the attached context; click × to remove it.

Type your question, such as "Why did this exit?", and send it.

## Ask about a failed build

On the **Builds** page, open a failed build. Next to the error, click **Ask AI**, or **Ask AI to Debug** if the build failed without an error message. The assistant opens with the build's error and the last 50 lines of the build log, and a question asking what went wrong. Edit it if you like, then send.

## Related

- [AI agents and MCP](/docs/agents/): connect Claude Code or another agent to the same tools.
- [REST API](/docs/api/#ai-and-settings): the `/ai/ask` and `/settings/ai` endpoints.
