// A music bed from ElevenLabs Music, the length of the video. Cached by
// prompt and length (to the second), like the narration.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CACHE = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".cache", "music");

export const MUSIC_PROMPT =
  "Calm, modern, minimal electronic background music for a software product demo video. Soft pulsing synths, light percussion, warm pads, optimistic and focused, steady from start to end with a gentle ending. No vocals.";

export async function music(seconds, prompt = MUSIC_PROMPT) {
  const ms = Math.ceil(seconds) * 1000;
  const key = crypto.createHash("sha1").update(JSON.stringify([prompt, ms])).digest("hex").slice(0, 16);
  const file = path.join(CACHE, `${key}.mp3`);
  if (fs.existsSync(file)) return file;
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY isn't set");
  const res = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192", {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, music_length_ms: ms }),
  });
  if (!res.ok) throw new Error(`ElevenLabs music: ${res.status} ${await res.text()}`);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}
