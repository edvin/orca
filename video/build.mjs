// Puts the recorded scenes together: each scene's frames, timed in video
// time (fast spans shortened), its narration, and captions for YouTube.
//
//   node build.mjs                 out/orca-showcase.mp4 and out/orca-showcase.srt
//   node build.mjs intro join      a preview of just these scenes

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import SCENES from "./script.mjs";
import { outTime } from "./lib/timeline.mjs";
import { music } from "./lib/music.mjs";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(ROOT, "out");
const FPS = 30;
/** Narration starts this long into its scene. */
const VOICE_DELAY = 0.35;

const FINAL = process.argv.includes("--final");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const ids = (only.length ? only : SCENES.map((s) => s.id)).filter((id) => fs.existsSync(path.join(OUT, "scenes", id, "scene.json")));
if (!ids.length) throw new Error("Nothing recorded yet: run record.mjs first.");

const ff = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });

const clips = [];
const captions = [];
let offset = 0;
for (const id of ids) {
  const dir = path.join(OUT, "scenes", id);
  const scene = JSON.parse(fs.readFileSync(path.join(dir, "scene.json"), "utf8"));
  const t = (ms) => outTime(ms, scene.start, scene.marks);
  const length = t(scene.end);

  // Frames, each shown until the next one (in video time).
  const lines = ["ffconcat version 1.0"];
  const frames = scene.frames.filter((f) => f.t >= scene.start - 50);
  frames.forEach((f, i) => {
    const from = Math.max(0, t(f.t));
    const to = i + 1 < frames.length ? t(frames[i + 1].t) : length;
    lines.push(`file 'frames/${f.file}'`, `duration ${Math.max(0.001, to - from).toFixed(4)}`);
  });
  lines.push(`file 'frames/${frames.at(-1).file}'`);
  fs.writeFileSync(path.join(dir, "frames.txt"), lines.join("\n") + "\n");

  const clip = path.join(dir, "clip.mp4");
  const firstAt = Math.max(0, t(frames[0].t));
  const video = ["-f", "concat", "-safe", "0", "-i", path.join(dir, "frames.txt")];
  // The opening line, then any said later in the scene, each at its moment.
  const voices = [
    ...(scene.voice ? [{ ...scene.voice, at: VOICE_DELAY }] : []),
    ...(scene.cues ?? []).map((c) => ({ ...c, at: Math.max(0, t(c.t)) + 0.15 })),
  ];
  const inputs = voices.length ? voices.flatMap((v) => ["-i", v.file]) : ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"];
  const audio = voices.length
    ? voices.map((v, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(v.at * 1000)}|${Math.round(v.at * 1000)}[v${i}]`).join(";") +
      `;${voices.map((_, i) => `[v${i}]`).join("")}amix=inputs=${voices.length}:normalize=0:duration=longest,apad,atrim=duration=${length.toFixed(3)}[a]`
    : `[1:a]apad,atrim=duration=${length.toFixed(3)}[a]`;
  ff(
    ...video, ...inputs,
    "-filter_complex",
    `[0:v]tpad=start_duration=${firstAt.toFixed(3)}:start_mode=clone,fps=${FPS},scale=2560:1440:flags=lanczos,format=yuv420p,trim=duration=${length.toFixed(3)}[v];${audio}`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", FINAL ? "slow" : "veryfast", "-crf", FINAL ? "17" : "21", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    clip,
  );
  clips.push(clip);

  // Captions, a line at a time.
  for (const v of voices) {
    let line = [];
    const flush = () => {
      if (!line.length) return;
      captions.push({ from: offset + v.at + line[0].start, to: offset + v.at + line.at(-1).end, text: line.map((w) => w.word).join(" ") });
      line = [];
    };
    for (const w of v.words) {
      if (line.length && line.map((x) => x.word).join(" ").length + w.word.length > 46) flush();
      line.push(w);
      if (/[.,:;!?]$/.test(w.word) && line.map((x) => x.word).join(" ").length > 24) flush();
    }
    flush();
  }
  console.log(`  ${id}: ${length.toFixed(1)} s`);
  offset += length;
}

const name = only.length ? `preview-${ids.join("-")}` : "orca-showcase";
const list = path.join(OUT, `${name}.txt`);
fs.writeFileSync(list, clips.map((c) => `file '${c}'`).join("\n") + "\n");
const joined = path.join(OUT, `${name}.voice.mp4`);
ff("-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined);
if (process.argv.includes("--no-music")) {
  fs.renameSync(joined, path.join(OUT, `${name}.mp4`));
} else {
  // Music under the narration: quiet, and quieter still while someone speaks.
  const bed = await music(offset + 1);
  const L = offset.toFixed(3);
  const mix =
    `[0:a]asplit=2[voice][key];` +
    `[1:a]aresample=48000,volume=0.04,afade=t=in:d=1.5,afade=t=out:st=${(offset - 3).toFixed(3)}:d=3,atrim=duration=${L}[m];` +
    `[m][key]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=600[bed];` +
    `[voice][bed]amix=inputs=2:normalize=0:duration=first`;
  // Loudness for YouTube (-16 LUFS), as one gain for the whole video, so
  // the music stays as far under the voice as it was mixed.
  const pass1 = spawnSync("ffmpeg", ["-hide_banner", "-i", joined, "-i", bed, "-filter_complex", `${mix},loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"], { encoding: "utf8" });
  const m = JSON.parse(pass1.stderr.match(/\{[^{}]*"input_i"[^{}]*\}/)?.[0] ?? "null");
  if (!m) throw new Error("couldn't measure loudness:\n" + pass1.stderr.slice(-500));
  ff(
    "-i", joined, "-i", bed,
    "-filter_complex",
    `${mix},loudnorm=I=-16:TP=-1.5:LRA=11:linear=true:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset},aresample=48000[a]`,
    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    path.join(OUT, `${name}.mp4`),
  );
  fs.rmSync(joined);
}

const stamp = (s) => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
captions.sort((a, b) => a.from - b.from);
fs.writeFileSync(
  path.join(OUT, `${name}.srt`),
  captions.map((c, i) => `${i + 1}\n${stamp(c.from)} --> ${stamp(c.to)}\n${c.text}\n`).join("\n"),
);
console.log(`${path.join(OUT, name)}.mp4 · ${offset.toFixed(1)} s`);
