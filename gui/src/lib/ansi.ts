// ANSI colours in log lines (`ESC[36mINFO ESC[39m`), as spans: many apps
// colour their logs, and without this the codes show as `[36m`.

const FG: Record<number, string> = {
  30: "#6e7681", 31: "#ff7b72", 32: "#3fb950", 33: "#d29922", 34: "#58a6ff", 35: "#bc8cff", 36: "#39c5cf", 37: "#c9d1d9",
  90: "#8b949e", 91: "#ffa198", 92: "#56d364", 93: "#e3b341", 94: "#79c0ff", 95: "#d2a8ff", 96: "#56d4dd", 97: "#f0f6fc",
};

const SGR = /\x1b\[([0-9;]*)m/g;

/** Whether a line has colour codes at all (most don't: skip the work). */
export const hasAnsi = (line: string) => line.includes("\x1b[");

/** The line without its colour codes, for searching and copying. */
export const stripAnsi = (line: string) => line.replace(SGR, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/**
 * The line as HTML: each coloured run in a span, its text passed through
 * `text` (which must escape it).
 */
export function ansiToHtml(line: string, text: (s: string) => string): string {
  let out = "";
  let color: string | null = null;
  let bold = false;
  let dim = false;
  let last = 0;
  const emit = (s: string) => {
    if (!s) return;
    const style = [color && `color:${color}`, bold && "font-weight:600", dim && "opacity:.7"].filter(Boolean).join(";");
    out += style ? `<span style="${style}">${text(s)}</span>` : text(s);
  };
  for (const m of line.matchAll(SGR)) {
    emit(line.slice(last, m.index));
    last = m.index! + m[0].length;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        color = null;
        bold = false;
        dim = false;
      } else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) {
        bold = false;
        dim = false;
      }
      else if (c === 39) color = null;
      else if (FG[c]) color = FG[c];
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0; // 256/true colour: skip
    }
  }
  emit(stripAnsi(line.slice(last)));
  return out;
}
