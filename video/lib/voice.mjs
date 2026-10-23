// Narration from ElevenLabs, with word timings for captions and pacing.
// Cached by voice + text, so re-rendering a video only pays for lines that
// changed. Needs ELEVENLABS_API_KEY.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CACHE = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".cache", "voice");

export const VOICE = {
  // George: warm, British, a storyteller. Daniel ("onwK4e9ZLuTAKqWW03F9") is
  // the crisper broadcaster alternative.
  id: process.env.ORCA_VIDEO_VOICE ?? "JBFqnCBsd6RMkjVDRZzb",
  model: "eleven_multilingual_v2",
  settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true },
};

/** { file, duration, words: [{ word, start, end }] } for a line of narration. */
export async function speak(text, voice = VOICE) {
  const key = crypto.createHash("sha1").update(JSON.stringify([voice, text])).digest("hex").slice(0, 16);
  const mp3 = path.join(CACHE, `${key}.mp3`);
  const meta = path.join(CACHE, `${key}.json`);
  if (fs.existsSync(mp3) && fs.existsSync(meta)) return { file: mp3, ...JSON.parse(fs.readFileSync(meta, "utf8")) };

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY isn't set");
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.id}/with-timestamps?output_format=mp3_44100_192`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: voice.model, voice_settings: voice.settings }),
  });
  if (!res.ok) throw new Error(`ElevenLabs: ${res.status} ${await res.text()}`);
  const body = await res.json();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(mp3, Buffer.from(body.audio_base64, "base64"));

  // Characters -> words.
  const a = body.alignment;
  const words = [];
  let cur = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) words.push(cur), (cur = null);
      return;
    }
    if (!cur) cur = { word: "", start: a.character_start_times_seconds[i], end: 0 };
    cur.word += ch;
    cur.end = a.character_end_times_seconds[i];
  });
  if (cur) words.push(cur);
  const duration = a.character_end_times_seconds.at(-1) ?? 0;
  fs.writeFileSync(meta, JSON.stringify({ text, duration, words }, null, 1));
  return { file: mp3, text, duration, words };
}
