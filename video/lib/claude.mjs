// A real Claude Code session for the video: headless, with only the demo
// daemon's Orca MCP server, streaming what it says and does.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

/**
 * Run one prompt. `on` gets { text } for each piece of streamed text,
 * { tool, input } when it calls a tool, { result, isError } for the tool's
 * answer, and { done, cost } at the end. Resolves when Claude finishes.
 */
export function runClaude(prompt, { daemonUrl, token, cwd, model, on }) {
  const mcp = path.join(os.tmpdir(), `orca-video-mcp-${process.pid}.json`);
  fs.writeFileSync(
    mcp,
    JSON.stringify({
      mcpServers: {
        orca: {
          command: path.join(REPO, "target/debug/orca"),
          args: ["mcp"],
          env: { ORCA_DAEMON_URL: daemonUrl, ORCA_TOKEN: token },
        },
      },
    }),
  );
  const args = [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    ...(model ? ["--model", model] : []),
    "--mcp-config", mcp, "--strict-mcp-config",
    // Only Orca: no shell, no files. It works the way a developer's AI tool
    // would through Orca's MCP server, and nothing else.
    "--tools", "",
    "--allowedTools", "mcp__orca",
    "--setting-sources", "",
    "--no-session-persistence",
    "--append-system-prompt",
    "You're helping a developer at Acme on camera. Be brief and friendly: a sentence or two between tool calls, and a short summary at the end with the URLs as plain text. No headings, no tables.",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let err = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        handle(ev);
      }
    });
    child.stderr.on("data", (d) => (err += d));
    const handle = (ev) => {
      if (ev.type === "stream_event") {
        const e = ev.event;
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") on({ text: e.delta.text });
        if (e?.type === "message_start") on({ turn: true });
      } else if (ev.type === "assistant") {
        for (const b of ev.message?.content ?? []) if (b.type === "tool_use") on({ tool: b.name.replace(/^mcp__orca__/, ""), input: b.input });
      } else if (ev.type === "user") {
        for (const b of ev.message?.content ?? []) {
          if (b.type !== "tool_result") continue;
          const text = Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join("") : String(b.content ?? "");
          on({ result: text, isError: !!b.is_error });
        }
      } else if (ev.type === "result") {
        on({ done: true, cost: ev.total_cost_usd, isError: ev.is_error });
      }
    };
    child.on("close", (code) => {
      fs.rmSync(mcp, { force: true });
      code === 0 ? resolve() : reject(new Error(`claude exited ${code}: ${err.slice(-500)}`));
    });
  });
}
