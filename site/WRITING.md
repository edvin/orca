# Writing the Orca docs

These pages become https://orca-desktop.com/docs/<slug>/. They are read by developers deciding whether to adopt Orca and by people using it daily. They must be accurate, scannable and calm.

## File format

One Markdown file per page in `site/content/docs/<slug>.md`, starting with front matter:

```markdown
---
title: Gateway and HTTPS hostnames
nav: Gateway            # short label for the sidebar (optional, defaults to title)
description: One sentence, under 160 characters, saying what the page covers. Used for SEO and search.
---

Opening paragraph (no H1: the title is rendered from front matter).

## First section
```

- Use `##` for sections and `###` for subsections. They build the "On this page" table of contents, so keep headings short (2–6 words) and descriptive.
- Code fences always carry a language: `bash`, `yaml`, `json`, `toml`, `text`. A fence can have a title shown as a file tab: ```` ```yaml title="orca.yaml" ````.
- Callouts use GitHub syntax, sparingly (at most two or three per page):
  ```markdown
  > [!NOTE]
  > Text.
  ```
  Kinds: `NOTE`, `TIP`, `WARNING`.
- Links to other docs pages: `/docs/<slug>/` (for example `/docs/gateway/`). Anchors: `/docs/orca-yaml/#hooks`.
- Screenshots: `![Alt text describing what is shown](/assets/screens/<name>.webp)`. Available names:
  `dashboard containers container-detail images stack-profiles orca-yaml-editor gateway landing-page worktrees start-dialog kubernetes k8s-topology app-catalog fleet settings-ai`.
  New ones come from `tools/capture-app.mjs` (the app with made-up demo data; no real names or paths), then `node tools/prep-images.mjs`.
  Use at most two per page, and only where they help.
- Tables are fine for reference material (flags, keys, endpoints).

## Accuracy is the top priority

- Every command, flag, key, path, port and menu name must exist in the code. Check `crates/orca-cli/src/main.rs` for CLI commands and flags, `crates/orca-daemon/src/api.rs` for endpoints, `crates/orca-core/src/agent_tools.rs` for agent tools, `gui/src/pages/` and `gui/src/components/` for UI labels, `crates/orca-core/src/config.rs` for config. The README is a good map but may be out of date: the code wins.
- If you can't verify something, leave it out. Never invent features, numbers or UI paths.
- Don't state counts that drift (number of tools, templates) unless you count them in the code right now.

## Voice

- Plain, direct, second person ("you"). Short paragraphs (1–3 sentences). Lead with what the reader can do, then how.
- Explain the why in one line where it helps; skip it where it doesn't.
- No marketing language ("blazing", "seamless", "powerful", "effortless", "simply", "just"), no exclamation marks, no emoji.
- Prefer commas, colons and full stops over em dashes.
- Name UI elements in **bold** exactly as the app shows them.
- Start each page with a short paragraph that says what the page covers and when you need it.
- End with a "Next steps" or "Related" list only when it adds real value.
