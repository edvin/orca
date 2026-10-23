// Puts the recorded scenes together: each scene's frames, timed in video
// time (fast spans shortened), its narration, and captions for YouTube.
//
//   node build.mjs                 out/orca-showcase.mp4 and out/orca-showcase.srt
//   node build.mjs intro join      a preview of just these scenes

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import SCENES, { coldOpen } from "./script.mjs";
import { speak } from "./lib/voice.mjs";
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
// The cold open goes first, in a full build: its line sets its length.
const COLD = !only.length && coldOpen && !process.argv.includes("--no-cold");
const XFADE = 0.3;
const coldVoice = COLD ? await speak(coldOpen.say) : null;
const coldLength = COLD ? coldVoice.duration + 0.9 : 0;
let offset = 0;
// Seconds of prelude (the hook) before the cold open.
let preludeLength = 0;
let coldPlaced = !COLD;
for (const id of ids) {
  // The cold open goes after the preludes: leave room for it.
  if (!coldPlaced && !SCENES.find((x) => x.id === id)?.prelude) (coldPlaced = true), (preludeLength = offset), (offset += coldLength);
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
  const raw = path.join(dir, "raw.mp4");
  const firstAt = Math.max(0, t(frames[0].t));
  // The scene as recorded, without labels: the cold open cuts from this.
  ff(
    "-f", "concat", "-safe", "0", "-i", path.join(dir, "frames.txt"),
    "-vf", `tpad=start_duration=${firstAt.toFixed(3)}:start_mode=clone,fps=${FPS},scale=2560:1440:flags=lanczos,format=yuv420p,trim=duration=${length.toFixed(3)}`,
    "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-r", String(FPS), raw,
  );
  // The opening line, then any said later in the scene, each at its moment.
  const voices = [
    ...(scene.voice ? [{ ...scene.voice, at: VOICE_DELAY }] : []),
    ...(scene.cues ?? []).map((c) => ({ ...c, at: Math.max(0, t(c.t)) + 0.15 })),
  ];
  // Never two lines at once (takes recorded before the recorder knew that).
  for (let i = 1; i < voices.length; i++) voices[i].at = Math.max(voices[i].at, voices[i - 1].at + voices[i - 1].duration + 0.25);
  // Labels, each from its mark until the next (or the scene's end), fading.
  const labelMarks = scene.marks.filter((m) => m.kind === "label");
  const shown = labelMarks
    .map((m, i) => ({ ...m.label, from: Math.max(0, t(m.t)), to: i + 1 < labelMarks.length ? t(labelMarks[i + 1].t) : length }))
    .filter((l) => l.file && l.to - l.from > 0.2);
  const SCALE = 2560 / 1920;
  const inputs = [
    "-i", raw,
    ...voices.flatMap((v) => ["-i", v.file]),
    ...(voices.length ? [] : ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]),
    ...shown.flatMap((l) => ["-loop", "1", "-t", length.toFixed(3), "-i", l.file]),
  ];
  const audioInputs = voices.length || 1;
  let vchain = "[0:v]null[v0]";
  shown.forEach((l, i) => {
    const input = 1 + audioInputs + i;
    // A label carried over from the scene before is already up: no fade in.
    const fadeIn = l.from > 0.05 ? `,fade=t=in:st=${l.from.toFixed(3)}:d=0.5:alpha=1` : "";
    const fadeOut = l.to < length - 0.05 ? `,fade=t=out:st=${Math.max(l.from, l.to - 0.4).toFixed(3)}:d=0.4:alpha=1` : "";
    vchain += `;[${input}:v]format=rgba${fadeIn}${fadeOut}[l${i}];[v${i}][l${i}]overlay=x=${Math.round(l.x * SCALE)}:y=${Math.round(l.y * SCALE)}:enable='between(t,${l.from.toFixed(3)},${l.to.toFixed(3)})'[v${i + 1}]`;
  });
  vchain += `;[v${shown.length}]format=yuv420p[v]`;
  const audio = voices.length
    ? voices.map((v, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(v.at * 1000)}|${Math.round(v.at * 1000)}[a${i}]`).join(";") +
      `;${voices.map((_, i) => `[a${i}]`).join("")}amix=inputs=${voices.length}:normalize=0:duration=longest,apad,atrim=duration=${length.toFixed(3)}[a]`
    : `[1:a]apad,atrim=duration=${length.toFixed(3)}[a]`;
  ff(
    ...inputs,
    "-filter_complex", `${vchain};${audio}`,
    "-map", "[v]", "-map", "[a]", "-t", length.toFixed(3),
    "-c:v", "libx264", "-preset", FINAL ? "slow" : "veryfast", "-crf", FINAL ? "17" : "21", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    clip,
  );
  clips.push(clip);

  for (const v of voices) caption(v.words, offset + v.at);
  console.log(`  ${id}: ${length.toFixed(1)} s`);
  offset += length;
}

if (COLD) {
  // Prelude scenes (the hook) come before the cold open.
  const preludes = clips.filter((c) => SCENES.find((x) => x.prelude && c.includes(`/scenes/${x.id}/`))).length;
  clips.splice(preludes, 0, await buildColdOpen(preludeLength));
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

/** The cold open: a cut per highlight, crossfaded, under its line. Cut from
 *  the scenes as recorded, before their labels go on. */
async function buildColdOpen(at = 0) {
  const dir = path.join(OUT, "cold");
  fs.mkdirSync(dir, { recursive: true });
  const n = coldOpen.cuts.length;
  const each = (coldLength + XFADE * (n - 1)) / n;
  const parts = coldOpen.cuts.map((c, i) => {
    const scene = JSON.parse(fs.readFileSync(path.join(OUT, "scenes", c.scene, "scene.json"), "utf8"));
    const mark = scene.marks.find((m) => m.kind === "highlight" && m.name === c.highlight);
    if (!mark) throw new Error(`cold open: no highlight "${c.highlight}" in scene ${c.scene}`);
    const length = outTime(scene.end, scene.start, scene.marks);
    const at = Math.max(0, Math.min(outTime(mark.t, scene.start, scene.marks) + (c.from ?? 0), length - each));
    const out = path.join(dir, `cut${i}.mp4`);
    ff(
      "-ss", at.toFixed(3), "-t", each.toFixed(3), "-i", path.join(OUT, "scenes", c.scene, "raw.mp4"),
      "-vf", `fps=${FPS},format=yuv420p`,
      "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", out,
    );
    return out;
  });
  let chain = "[0:v]fade=t=in:d=0.35[x0]";
  for (let i = 1; i < n; i++) chain += `;[x${i - 1}][${i}:v]xfade=transition=fade:duration=${XFADE}:offset=${(i * (each - XFADE)).toFixed(3)}[x${i}]`;
  const out = path.join(dir, "cold.mp4");
  ff(
    ...parts.flatMap((p) => ["-i", p]), "-i", coldVoice.file,
    "-filter_complex", `${chain};[x${n - 1}]trim=duration=${coldLength.toFixed(3)},format=yuv420p[v];[${n}:a]aresample=48000,adelay=250|250,apad,atrim=duration=${coldLength.toFixed(3)}[a]`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", FINAL ? "slow" : "veryfast", "-crf", FINAL ? "17" : "21", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", out,
  );
  caption(coldVoice.words, at + 0.25);
  console.log(`  cold open: ${coldLength.toFixed(1)} s`);
  return out;
}

/** Captions, a line at a time, for words starting `at` seconds in. */
function caption(words, at) {
  let line = [];
  const flush = () => {
    if (!line.length) return;
    captions.push({ from: at + line[0].start, to: at + line.at(-1).end, text: line.map((w) => w.word).join(" ") });
    line = [];
  };
  for (const w of words) {
    if (line.length && line.map((x) => x.word).join(" ").length + w.word.length > 52) flush();
    line.push(w);
    if (/[.,:;!?]$/.test(w.word) && line.map((x) => x.word).join(" ").length > 24) flush();
  }
  flush();
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
