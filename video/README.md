# Orca's showcase video

A video of Orca doing real work, recorded from the real app: nothing on screen
is mocked. The app runs against its own daemon on a demo machine, the apps it
starts are real open-source projects, and the AI parts are a real Claude Code
session talking to Orca over MCP. It's re-recorded with one command as Orca
changes.

```bash
cd video
npm install                    # Playwright, once
./demo-env.sh up               # the demo machine, once (VM, images, daemon)
./demo-env.sh reset            # a fresh machine before each take
node record.mjs                # every scene, into out/scenes
node build.mjs                 # a quick preview: out/orca-showcase.mp4 and .srt
node build.mjs --final         # the same, encoded for upload
```

`node record.mjs ask landing` and `node build.mjs ask landing` record and
preview just those scenes while you work on them (scenes after the first build
on the state the earlier ones left).

Needs `ELEVENLABS_API_KEY` for the narration and music, Lima, ffmpeg, Node and
the `claude` CLI signed in.

## How it fits together

| File | What it does |
|---|---|
| `script.mjs` | The scenes: what's said (`say`, `s.say()`) and what happens (`run`). Start here. |
| `demo-env.sh` | The demo machine: its own Lima VM (`orca-demo`), its own Orca daemon on port 9478 with its config in `~/.orca-demo`, and the `acme` workspace from `demo/` served as `https://git.acme.dev/acme/*.git`. Your own Orca, its daemon and containers are never touched. |
| `demo/` | The made-up company: a workspace (Mailpit, Grafana, Adminer) and six projects that are real open-source apps (WordPress, Gitea, n8n, Umami, Uptime Kuma, Memos). |
| `record.mjs` | Serves the GUI with Vite, runs it in Chromium inside `lib/stage.html` (window frames, cursor, terminal pane, title cards) and captures frames at 2560×1440. |
| `lib/bridge.mjs` | Turns the GUI's Tauri `invoke()` calls into the daemon REST calls the Tauri commands make, read from `src-tauri/src/commands.rs` each time. A command it can't map is listed after the scene. |
| `lib/claude.mjs` | A headless Claude Code session with only the demo daemon's Orca MCP server (`--strict-mcp-config`, no other tools), streamed into the terminal pane. |
| `lib/voice.mjs`, `lib/music.mjs` | Narration (George, a British voice) with word timings, and a music bed, from ElevenLabs. Both cached in `.cache/`, so only changed lines cost anything. |
| `lib/timeline.mjs` | Video time: waiting (`s.fast()`), Claude's tools at work (4×) and Claude's answers (1.7×) play faster than real time. |
| `build.mjs` | Cuts the cold open from the scenes' highlights, times the frames, lays each scene's narration over it, ducks the music under the voice, normalises to −16 LUFS for YouTube and writes captions (`.srt`). |

## What isn't shown as it is

- The status bar's disk figure and its disk warnings: they're the recording
  Mac's, not the demo's (`system_health` in `record.mjs`).
- The app and sites are zoomed to 120% so they read well on video
  (`ORCA_VIDEO_ZOOM`).
- Time: see `lib/timeline.mjs`.

## Changing it

- **A line of narration:** edit it in `script.mjs`; `node build.mjs` re-voices
  only that line. Write it the way it should sound: "web address" reads better
  than "HTTPS URL".
- **The voice:** `ORCA_VIDEO_VOICE=<ElevenLabs voice id>`.
- **The cold open:** `coldOpen` in `script.mjs`: one line, and the moments it
  cuts to, by highlights the scenes mark (`s.highlight("name")`; Claude's
  sessions mark `claude-typing`, `claude-asked` and `claude-working`). The cuts
  follow the highlights from take to take. `node build.mjs --no-cold` leaves it
  out.
- **Two lines never overlap:** a line said mid-scene waits for the one before.
- **A new scene:** add it to `script.mjs`. The scene API (`s.click`, `s.type`,
  `s.see`, `s.open`, `s.browse`, `s.claude`, `s.say`, `s.fast`, `s.layout`,
  `s.lower`, `s.card`) is in `record.mjs`.
- **Claude's model:** `ORCA_VIDEO_MODEL`. Claude's answers differ a little from
  take to take; record again if one rambles.
