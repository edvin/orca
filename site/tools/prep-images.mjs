// Converts screenshots and brand images into web assets.
//   raw-screens/<name>.png  ->  assets/screens/<name>.webp  (max 1600 px wide)
//   the app icon            ->  assets/img/logo-tile.png, favicon.png

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(ROOT);
const raw = path.join(ROOT, "raw-screens");
const out = path.join(ROOT, "assets/screens");

for (const f of fs.readdirSync(raw).filter((f) => f.endsWith(".png"))) {
  const dest = path.join(out, f.replace(/\.png$/, ".webp"));
  const src = path.join(raw, f);
  if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs > fs.statSync(src).mtimeMs) continue;
  await sharp(src).resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 86, effort: 5 }).toFile(dest);
  console.log("screen", path.basename(dest));
}

// Focused crops of full screenshots for the landing page: [name, source, left, top, width, height] in source pixels.
const CROPS = [
  ["feature-worktrees", "worktrees", 0, 450, 2440, 860],
  ["feature-editor", "orca-yaml-editor", 0, 500, 2440, 1100],
  ["feature-profiles", "stack-profiles", 0, 370, 2440, 1000],
];
for (const [name, from, left, top, width, height] of CROPS) {
  const src = path.join(raw, `${from}.png`);
  if (!fs.existsSync(src)) continue;
  await sharp(src).extract({ left, top, width, height }).resize({ width: 1600 }).webp({ quality: 88, effort: 5 }).toFile(path.join(out, `${name}.webp`));
  console.log("crop", name);
}

const icon = path.join(REPO, "src-tauri/icons/icon.png");
await sharp(icon).resize(128, 128).png().toFile(path.join(ROOT, "assets/img/logo-tile.png"));
await sharp(icon).resize(64, 64).png().toFile(path.join(ROOT, "assets/img/favicon.png"));
console.log("brand images done");
