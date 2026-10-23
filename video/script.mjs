// The showcase video, scene by scene. `say` is the narration (George, via
// ElevenLabs); `run` drives the real app, a browser and Claude on the demo
// machine. A scene lasts at least as long as its narration.
//
// Edit freely: changed lines are re-voiced, the rest come from the cache.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const LOGO = "data:image/png;base64," + fs.readFileSync(path.join(ROOT, "../site/assets/img/logo-tile.png")).toString("base64");

/**
 * The first seconds: quick cuts of the best moments, from highlights the
 * scenes mark (`s.highlight()`, and Claude's own: claude-typing,
 * claude-asked, claude-working), under one line. Each cut starts `from`
 * seconds after its highlight; the cuts share the line's length.
 */
export const coldOpen = {
  say: "Ask for two apps, and moments later they're running on your machine, each at its own address. And when one breaks, it gets fixed.",
  cuts: [
    { scene: "ask", highlight: "claude-typing", from: 1.2 },
    { scene: "ask", highlight: "claude-working", from: 0.6 },
    { scene: "landing", highlight: "search", from: 0.4 },
    { scene: "fix", highlight: "claude-working", from: 1 },
    { scene: "fix", highlight: "fixed", from: 0.6 },
  ],
};

export default [
  {
    // Before the cold open: what you're about to see.
    id: "hook",
    prelude: true,
    say: "What if your AI could run your whole dev environment?",
    tail: 0.5,
    async run(s) {
      await s.layout("none");
      await s.card({ title: "What if your AI could run<br>your whole dev environment?", animate: true, size: "question" });
    },
  },
  {
    id: "intro",
    say: "This is Orca: your containers and dev environments, with an AI that runs them for you.",
    tail: 0.6,
    async run(s) {
      await s.layout("none");
      await s.card({ logo: LOGO, title: "<span>Orca</span>", text: "Your containers, your dev environments, and an AI that can run them.", animate: true });
    },
  },
  {
    id: "join",
    say: "Meet a new developer at Acme. Instead of a wiki page of setup steps, they paste one link: the team's workspace. Orca clones it, creates the network, puts every app on the team's own domain, and starts the services everyone shares.",
    async run(s) {
      await s.card(null);
      await s.layout("app");
      await s.sleep(1200);
      await s.open("Workspace");
      await s.lower({ n: "1", title: "Join your team's workspace", sub: "One repo describes everything" });
      await s.type("input[placeholder*='dev-workspace.git']", s.env.ORCA_DEMO_REPO);
      await s.click("button:has-text('Join')");
      await s.fast(() => s.see("text=Shared services", { timeout: 180000 }));
      await s.sleep(1500);
      await s.spot(".ws-shared");
      await s.sleep(2500);
      await s.spot(null);
    },
  },
  {
    id: "setup",
    say: "Every project the team works on is right here. One click clones it, prepares its environment, starts it, and hands you its address.",
    tail: 1.5,
    async run(s) {
      await s.lower({ n: "2", title: "Set up any project in one click", sub: "Clone, configure, start" });
      const card = (r) => r.locator(".ws-card", { hasText: "status" });
      await s.hover((r) => card(r).locator("b", { hasText: "status" }));
      await s.click((r) => card(r).locator("button", { hasText: "Set up" }));
      await s.fast(() => s.see((r) => card(r).locator(".ws-state", { hasText: "Running" }), { timeout: 240000 }));
      await s.sleep(800);
      await s.spot((r) => card(r));
      await s.sleep(2000);
      await s.spot(null);
    },
  },
  {
    id: "ask",
    say: "Or simply ask. Orca plugs into Claude, so your AI can see your whole environment, and run it.",
    tail: 1.5,
    async run(s) {
      await s.lower({ n: "3", title: "Or just ask Claude", sub: "Through Orca's MCP server" });
      await s.layout("split");
      await s.claude("Spin up analytics and notes for me, and tell me where to find them.");
      await s.say("Claude finds both projects in the workspace, sets them up, and hands back their addresses. And the app keeps up, the whole time.", { wait: true });
    },
  },
  {
    id: "landing",
    say: "Every app also lands on your start page, with live status and the right icon on every card. Type to find any service, or search the web.",
    tail: 1.5,
    async run(s) {
      await s.lower({ n: "4", title: "Your start page", sub: "https://acme.localhost" });
      await s.layout("browser");
      await s.browse("https://acme.localhost");
      await s.sleep(2500);
      s.highlight("search");
      await s.type("#q", "analy", { where: "site", delay: 140 });
      await s.sleep(1200);
      await s.press("Enter", { where: "site" });
      await s.say("Press enter, and you're there.");
      await s.sleep(3000);
    },
  },
  {
    id: "fix",
    say: "And when something breaks, just ask.",
    tail: 1.5,
    before: "docker stop $(docker ps -q --filter label=com.docker.compose.project=notes)",
    async run(s) {
      await s.lower({ n: "5", title: "Something broke?", sub: "Claude finds out why and fixes it" });
      await s.layout("split-browser");
      await s.browse("https://notes.acme.localhost");
      await s.sleep(2500);
      const fixing = s.claude("notes.acme.localhost isn't loading. Can you find out why and fix it?");
      await s.sleep(5000);
      await s.say("Claude checks the gateway, the workspace and the container itself, works out what happened, and fixes it.");
      await fixing;
      await s.browse("https://notes.acme.localhost");
      await s.see("text=Memos", { where: "site", timeout: 30000 }).catch(() => {});
      s.highlight("fixed");
      await s.say("The notes are back, and Claude explains exactly what it found.", { wait: true });
    },
  },
  {
    id: "dashboard",
    say: "Back in Orca, the dashboard groups every app by where it comes from, with its icon and its addresses one click away.",
    tail: 1.5,
    async run(s) {
      await s.lower({ n: "6", title: "Every app at a glance" });
      await s.layout("app");
      await s.open("Dashboard");
      await s.sleep(2000);
      await s.see(".apps-shared");
      await s.hover(".apps-shared");
      await s.hover((r) => r.locator(".app-card").nth(1));
      await s.hover((r) => r.locator(".app-card").nth(2));
      await s.sleep(1000);
    },
  },
  {
    id: "outro",
    say: "Orca is free and open source, for macOS, Linux and Windows. Get it at orca-desktop dot com.",
    tail: 2.5,
    async run(s) {
      await s.lower(null);
      await s.layout("none");
      await s.card({ logo: LOGO, title: "<span>Orca</span>", text: "Free and open source, for macOS, Linux and Windows.", url: "orca-desktop.com" });
    },
  },
];
