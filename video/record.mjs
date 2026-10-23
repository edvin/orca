// Records Orca's showcase video from the real app on the demo machine
// (demo-env.sh): the GUI in a browser against the demo daemon, a real Claude
// session, and the real apps it starts. Each scene of script.mjs becomes a
// clip of frames plus its narration; build.mjs puts them together.
//
//   ./demo-env.sh reset && node record.mjs            every scene
//   node record.mjs landing                           just these scenes (debugging)

import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { commandTable, bridgeScript } from "./lib/bridge.mjs";
import { runClaude } from "./lib/claude.mjs";
import { speak } from "./lib/voice.mjs";
import SCENES from "./script.mjs";
import { FAST, outTime } from "./lib/timeline.mjs";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(ROOT, "..");
const OUT = path.join(ROOT, "out");
const GUI_PORT = Number(process.env.ORCA_VIDEO_PORT ?? 5398);
/** How much faster than real time Claude's answers play. */
const CLAUDE_SPEED = 1.7;

const env = Object.fromEntries(
  execFileSync(path.join(ROOT, "demo-env.sh"), ["env"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.split(/=(.*)/s).slice(0, 2)),
);

const only = process.argv.slice(2);
const scenes = only.length ? SCENES.filter((s) => only.includes(s.id)) : SCENES;

// --- The GUI, served by Vite against the demo daemon -------------------------
// Never reuse whatever already answers on the port: that's someone else's.
if (await fetch(`http://localhost:${GUI_PORT}/`).then(() => true, () => false)) {
  console.error(`Port ${GUI_PORT} is in use by another program. Set ORCA_VIDEO_PORT to a free one.`);
  process.exit(1);
}
const vite = spawn("npx", ["vite", "--port", String(GUI_PORT), "--strictPort"], {
  cwd: path.join(REPO, "gui"),
  env: { ...process.env, ORCA_DAEMON_URL: env.ORCA_DEMO_URL },
  stdio: ["ignore", "pipe", "pipe"],
});
let viteLog = "";
vite.stdout.on("data", (d) => (viteLog += d));
vite.stderr.on("data", (d) => (viteLog += d));
for (let i = 0; ; i++) {
  if (await fetch(`http://localhost:${GUI_PORT}/`).then((r) => r.ok, () => false)) break;
  if (i > 60) throw new Error("vite didn't start:\n" + viteLog.slice(-800));
  await new Promise((r) => setTimeout(r, 500));
}
const cleanup = () => vite.kill();
process.on("exit", cleanup);

const browser = await chromium.launch({
  executablePath: process.env.HOME + "/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
});
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 4 / 3, // frames at 2560x1440
  ignoreHTTPSErrors: true,
  colorScheme: "dark",
});
// Apps open in the stage's browser window, an iframe: let them.
await context.route(/^https:\/\/([a-z0-9-]+\.)*acme\.localhost\//, async (route) => {
  try {
    const res = await route.fetch();
    const headers = { ...res.headers() };
    delete headers["x-frame-options"];
    if (headers["content-security-policy"]) headers["content-security-policy"] = headers["content-security-policy"].replace(/frame-ancestors[^;]*;?/g, "");
    await route.fulfill({ response: res, headers });
  } catch {
    await route.continue().catch(() => {});
  }
});
// The app and the sites a little larger than life, so they read well on video.
await context.addInitScript({
  content: `if (window !== window.top) document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.zoom = "${process.env.ORCA_VIDEO_ZOOM ?? 1.2}"; });`,
});
await context.addInitScript({
  content: `if (location.port === "${GUI_PORT}") {
    ${bridgeScript({
      token: env.ORCA_DEMO_TOKEN,
      table: commandTable(),
      extra: {
        get_status: "() => ({ daemon_running: true })",
        start_daemon: "() => ({})",
        get_version: `() => "${fs.readFileSync(path.join(REPO, "Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)[1]}"`,
        get_active_host: `() => ({ id: null, name: "Local", url: "${env.ORCA_DEMO_URL}/api/v1", is_remote: false })`,
        list_remote_hosts: "() => []",
        probe_all_hosts: "() => [{ id: null, name: 'Local', online: true }]",
        // The one thing not shown as it is: the host's disk, which is this
        // Mac's and not the demo's business.
        system_health: "(a, call) => call('GET', '/system/health').then((h) => ({ ...h, warnings: (h.warnings || []).filter((w) => !/disk|reclaimable/i.test(w)), system_resources: h.system_resources && { ...h.system_resources, disk_usage_percent: 38 } }))",
        folder_apps: "() => [{ id: 'vscode', label: 'VS Code', kind: 'editor' }, { id: 'terminal', label: 'Terminal', kind: 'terminal' }]",
        mcp_clients: "() => [{ id: 'claude-code', name: 'Claude Code', detected: true, connected: true, config_path: '~/.claude.json', after_connect: null }]",
        get_api_token: `() => "demo"`,
        // The native folder picker: the demo's blog, as if picked.
        pick_folder: `() => ${JSON.stringify(env.ORCA_DEMO_HOME + "/code/blog")}`,
        check_for_updates: "() => null",
      },
    })}
  }`,
});

// Labels are drawn on a page of their own, on a transparent background.
const labelPage = await context.newPage();
await labelPage.goto("file://" + path.join(ROOT, "lib/stage.html"));
await labelPage.addStyleTag({ content: "html, body { background: transparent !important; } body::before, body::after, #cursor { display: none !important; } .lower { transition: none !important; }" });
const labels = new Map();
async function renderLabel(o) {
  const key = JSON.stringify(o);
  if (labels.has(key)) return labels.get(key);
  await labelPage.evaluate((o) => window.stage.lower(o), o);
  const el = labelPage.locator("#lower");
  const box = await el.boundingBox();
  const dir = path.join(OUT, "labels");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `label-${labels.size}.png`);
  await el.screenshot({ path: file, omitBackground: true });
  const label = { file, x: box.x, y: box.y };
  labels.set(key, label);
  return label;
}
let currentLabel = null;
let currentLayout = null;

const page = await context.newPage();
page.on("pageerror", (e) => console.log("  [page error]", e.message));
await page.goto("file://" + path.join(ROOT, "lib/stage.html"));
await page.evaluate((port) => {
  try { localStorage.clear(); } catch {}
  window.stage.appUrl(`http://localhost:${port}/`);
}, GUI_PORT);

// --- Frame capture -------------------------------------------------------------
const cdp = await context.newCDPSession(page);
let sink = null; // the scene being recorded
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  if (sink) sink.frame(data, metadata.timestamp * 1000);
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 2560, maxHeight: 1440, everyNthFrame: 1 });

// --- The scene API ---------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = () => page.frameLocator("#appframe");
const site = () => page.frameLocator("#browserframe");

function sceneApi(scene, rec) {
  const stage = (fn, ...args) => page.evaluate(([fn, args]) => {
    const parts = fn.split(".");
    let o = window.stage;
    for (const p of parts.slice(0, -1)) o = o[p];
    return o[parts.at(-1)](...args);
  }, [fn, args]);
  const target = (where, sel) => {
    const root = where === "site" ? site() : app();
    // A function of the frame's root, or a Playwright selector ("text=…", CSS).
    return typeof sel === "string" ? root.locator(sel).first() : sel(root);
  };
  const s = {
    env,
    stage,
    sleep,
    // Windows glide into place; wait for them before clicking in them.
    layout: async (name) => {
      if (currentLayout === name) return;
      currentLayout = name;
      await stage("layout", name);
      await sleep(1000);
    },
    card: (o) => stage("card", o),
    // Labels aren't recorded into the frames: the build lays them over the
    // scene, so the cold open can cut from clean footage.
    lower: async (o) => rec.label(o ? await renderLabel(o) : null),
    /** Go to a page in the app, the way its sidebar would. */
    async open(pageName) {
      await s.click((r) => r.locator(".nav-item", { hasText: pageName }).first(), { wait: 900 });
    },
    /** Glide the cursor to an element and click it. */
    async click(sel, { where = "app", wait = 350 } = {}) {
      const el = target(where, sel);
      await el.waitFor({ state: "visible", timeout: 30000 });
      await el.scrollIntoViewIfNeeded().catch(() => {});
      const b = await el.boundingBox();
      const x = b.x + Math.min(b.width / 2, 60), y = b.y + b.height / 2;
      await stage("cursor", x, y, 800);
      await sleep(850);
      await stage("ripple", x, y);
      await el.click();
      await sleep(wait);
    },
    async hover(sel, { where = "app" } = {}) {
      const b = await target(where, sel).boundingBox();
      await stage("cursor", b.x + Math.min(b.width / 2, 60), b.y + b.height / 2, 800);
      await sleep(900);
    },
    async type(sel, text, { where = "app", delay = 55 } = {}) {
      await s.click(sel, { where, wait: 150 });
      await target(where, sel).pressSequentially(text, { delay });
    },
    /** Type into a terminal in the app: click into it, then the keys. */
    async typeKeys(text, { delay = 80 } = {}) {
      await s.click(".xterm", { wait: 300 });
      await page.keyboard.type(text, { delay });
    },
    async press(key, { where = "app" } = {}) {
      const frame = page.frame({ url: where === "site" ? /acme\.localhost/ : new RegExp(`:${GUI_PORT}/`) });
      await frame.locator("body").press(key);
    },
    async see(text, { where = "app", timeout = 120000 } = {}) {
      await target(where, text).waitFor({ state: "visible", timeout });
    },
    async spot(sel, { where = "app" } = {}) {
      if (!sel) return stage("spot", null);
      const b = await target(where, sel).boundingBox();
      await stage("spot", { x: b.x, y: b.y, w: b.width, h: b.height });
    },
    async browse(url) {
      await stage("browse", url);
      await sleep(1500);
    },
    /** Narration from this moment on. With `wait`, until it's been said. */
    async say(text, { wait = false } = {}) {
      const v = await speak(text);
      // Never over another line: wait until whatever is being said is done.
      while (rec.videoTime() < rec.voiceFreeAt() + 0.25) await sleep(50);
      rec.voice(v);
      if (wait) await sleep(v.duration * 1000 + 300);
    },
    /** A moment the cold open can cut to (script.mjs `coldOpen`). */
    highlight: (name) => rec.mark("highlight", { name }),
    /** Waiting that isn't interesting plays faster in the video. */
    async fast(fn) {
      rec.mark("fast-start");
      try { return await fn(); } finally { rec.mark("fast-end"); }
    },
    /** Ask Claude, in the terminal pane, and show what it does. */
    async claude(prompt, { title = "claude · ~/code/acme", onWorking } = {}) {
      await stage("cursor", 1500, 1200, 600); // out of the way while Claude works
      await stage("term.title", title);
      await stage("term.clear");
      rec.mark("highlight", { name: "claude-typing" });
      // The prompt, typed.
      await page.evaluate(() => (window.__p = window.stage.term.line('<span class="prompt"><b>›</b> </span><span class="caret"></span>', "prompt")));
      for (const ch of prompt) {
        await page.evaluate((ch) => {
          const caret = window.__p.querySelector(".caret");
          caret.insertAdjacentText("beforebegin", ch);
        }, ch);
        await sleep(18 + Math.random() * 22);
      }
      await page.evaluate(() => window.__p.querySelector(".caret").remove());
      await sleep(500);
      rec.mark("highlight", { name: "claude-asked" });
      await page.evaluate(() => { window.__say = null; window.stage.term.line("✻ Thinking…", "spin"); });
      // Claude's answer plays a little faster than life; its tools at work, faster still.
      rec.speed(CLAUDE_SPEED);
      const pending = [];
      let inFlight = 0, sawTool = false;
      await runClaude(prompt, {
        daemonUrl: env.ORCA_DEMO_URL,
        token: env.ORCA_DEMO_TOKEN,
        cwd: env.ORCA_DEMO_HOME,
        model: process.env.ORCA_VIDEO_MODEL,
        on: (e) => {
          // Tools at work play faster; Claude's words at normal speed.
          if (e.tool && !sawTool) (sawTool = true), rec.mark("highlight", { name: "claude-working" }), onWorking?.();
          if (e.tool && inFlight++ === 0) rec.speed(FAST);
          if (e.result !== undefined && --inFlight === 0) rec.speed(CLAUDE_SPEED);
          pending.push(page.evaluate(([e]) => {
            const t = window.stage.term;
            document.querySelectorAll(".line.spin").forEach((x) => x.remove());
            if (e.turn) { window.__say = null; return; }
            if (e.text !== undefined) {
              if (!window.__say) window.__say = t.line("", "say");
              const raw = (window.__say.dataset.raw || "") + e.text;
              window.__say.dataset.raw = raw;
              t.set(window.__say, raw);
            } else if (e.tool) {
              window.__say = null;
              const args = Object.entries(e.input || {}).map(([k, v]) => typeof v === "string" ? v : JSON.stringify(v)).join(", ");
              window.__tool = t.line(`<span class="ok">⏺</span> <b>${e.tool}</b>(${args.slice(0, 60)})`, "tool");
            } else if (e.result !== undefined) {
              t.line(e.isError ? "⎿ error" : "⎿ " + e.summary, "result");
            }
          }, [{ ...e, summary: e.result !== undefined ? summarize(e.result) : undefined }, null]).catch(() => {}));
        },
      }).catch((err) => console.log("  claude:", err.message));
      await Promise.all(pending);
      rec.speed(1);
    },
  };
  return s;
}

/** One line for a tool result in the terminal. */
function summarize(text) {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
    if (v.status === "succeeded" && v.result?.urls) return `done · ${v.result.urls.join(" ")}`;
    if (v.status) return v.status + (v.error ? `: ${String(v.error).slice(0, 60)}` : "");
    if (v.projects) return `${v.projects.length} projects`;
    return Object.keys(v).slice(0, 4).join(", ");
  } catch {
    return text.replace(/\s+/g, " ").slice(0, 70);
  }
}

// The terminal's text uses markdown; the page renders it.
await page.evaluate(() => {
  const esc = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  window.stage.term.set = (el, raw) => {
    el.innerHTML = esc(raw).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
    el.parentElement.scrollTop = el.parentElement.scrollHeight;
  };
});

// --- Record ------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
for (const scene of scenes) {
  console.log(`● ${scene.id}`);
  const voice = scene.say ? await speak(scene.say) : null;
  const dir = path.join(OUT, "scenes", scene.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
  const frames = [];
  const marks = [];
  let n = 0;
  const rec = {
    frame(data, t) {
      const file = `${String(n++).padStart(6, "0")}.jpg`;
      fs.writeFileSync(path.join(dir, "frames", file), Buffer.from(data, "base64"));
      frames.push({ file, t });
    },
    mark(kind, extra = {}) { marks.push({ kind, t: Date.now(), ...extra }); },
    speed(factor) { marks.push({ kind: "speed", factor, t: Date.now() }); },
    voice(v) { cues.push({ ...v, t: Date.now() }); },
    label(l) { currentLabel = l; marks.push({ kind: "label", label: l, t: Date.now() }); },
    videoTime: () => outTime(Date.now(), start, marks),
    /** Video time when the last line started so far is done. */
    voiceFreeAt: () => Math.max(voice ? 0.35 + voice.duration : 0, ...cues.map((c) => outTime(c.t, start, marks) + 0.15 + c.duration)),
  };
  const cues = [];
  if (scene.before) {
    try {
      execFileSync("sh", ["-c", scene.before], { env: { ...process.env, DOCKER_HOST: `unix://${process.env.HOME}/.lima/orca-demo/sock/docker.sock` }, stdio: "ignore" });
    } catch (e) {
      console.log("  before:", e.message.split("\n")[0]);
    }
  }
  const start = Date.now();
  // A label from the scene before stays up.
  if (currentLabel) marks.push({ kind: "label", label: currentLabel, t: start });
  sink = rec;
  // A fresh frame at the start, even if nothing moves.
  await page.evaluate(() => document.body.style.setProperty("--tick", Math.random()));
  const s = sceneApi(scene, rec);
  try {
    await scene.run(s);
  } catch (e) {
    console.log(`  ✗ ${scene.id}: ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: path.join(dir, "failed.png") });
  }
  // Hold until the narration has finished (in video time) plus a breath.
  const videoTime = () => outTime(Date.now(), start, marks);
  const need = Math.max(voice?.duration ?? 0, ...cues.map((c) => outTime(c.t, start, marks) + c.duration)) + (scene.tail ?? 0.9);
  while (videoTime() < need) await sleep(100);
  rec.mark("end");
  await sleep(150);
  sink = null;
  fs.writeFileSync(path.join(dir, "scene.json"), JSON.stringify({ id: scene.id, start, end: marks.at(-1).t, frames, marks, voice, cues, fast: FAST }, null, 1));
  console.log(`  ${frames.length} frames, ${videoTime().toFixed(1)} s${voice ? `, voice ${voice.duration.toFixed(1)} s` : ""}`);
  const unknown = await page.frameLocator("#appframe").locator("body").evaluate(() => window.__orcaUnknown ?? []).catch(() => []);
  if (unknown.length) console.log("  bridge: not mapped:", [...new Set(unknown)].join(", "));
}

await browser.close();
cleanup();
process.exit(0);
