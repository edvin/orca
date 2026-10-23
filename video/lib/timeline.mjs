// Video time: real time, played faster where a scene says so. The recorder
// holds a scene until its narration fits; the build times frames the same
// way.
//
// Marks: { kind: "speed", factor, t } from then on; "fast-start"/"fast-end"
// are speed FAST and back to what it was before; "end" closes the scene.

/** Waiting marked with s.fast() plays this many times faster in the video. */
export const FAST = 4;

/** Seconds of video from `start` until `now`. */
export function outTime(now, start, marks) {
  let t = 0, last = start, factor = 1;
  const stack = [];
  for (const m of [...marks, { kind: "now", t: now }]) {
    const at = Math.min(m.t, now);
    t += (at - last) / 1000 / factor;
    last = at;
    if (m.t >= now) break;
    if (m.kind === "speed") factor = m.factor;
    if (m.kind === "fast-start") stack.push(factor), (factor = Math.max(factor, FAST));
    if (m.kind === "fast-end") factor = stack.pop() ?? 1;
  }
  return t;
}
