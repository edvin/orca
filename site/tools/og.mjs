// The social preview image: assets/img/og.png (1200x630).
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const W = 1200, H = 630;
const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="g" cx="78%" cy="85%" r="70%"><stop offset="0" stop-color="#1d4ed8" stop-opacity="0.55"/><stop offset="1" stop-color="#07090d" stop-opacity="0"/></radialGradient>
    <linearGradient id="t" x1="0" x2="1"><stop offset="0" stop-color="#4ea1ff"/><stop offset="1" stop-color="#2dd4ef"/></linearGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#ffffff" stroke-opacity="0.04"/></pattern>
  </defs>
  <rect width="100%" height="100%" fill="#07090d"/>
  <rect width="100%" height="100%" fill="url(#grid)"/>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <text x="72" y="160" font-family="Inter, Helvetica, Arial, sans-serif" font-size="62" font-weight="800" fill="#eef2f7" letter-spacing="-2">Local development,</text>
  <text x="72" y="236" font-family="Inter, Helvetica, Arial, sans-serif" font-size="62" font-weight="800" fill="url(#t)" letter-spacing="-2">without the duct tape.</text>
  <text x="72" y="298" font-family="Inter, Helvetica, Arial, sans-serif" font-size="25" fill="#9aa4b2">Containers, compose stacks and Kubernetes, with HTTPS</text>
  <text x="72" y="332" font-family="Inter, Helvetica, Arial, sans-serif" font-size="25" fill="#9aa4b2">hostnames, worktree instances and AI agents. Open source.</text>
  <text x="140" y="560" font-family="Inter, Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#eef2f7">Orca</text>
  <text x="230" y="560" font-family="Inter, Helvetica, Arial, sans-serif" font-size="22" fill="#6b7686">orca-desktop.com</text>
</svg>`);
const shot = await sharp(path.join(ROOT, "raw-screens/dashboard.png")).resize(720).extract({ left: 0, top: 0, width: 720, height: 300 }).toBuffer();
const frame = await sharp({ create: { width: 724, height: 304, channels: 4, background: "#2a3140" } }).composite([{ input: shot, left: 2, top: 2 }]).png().toBuffer();
const logo = await sharp(path.join(ROOT, "assets/img/logo-tile.png")).resize(52, 52).composite([{ input: Buffer.from('<svg width="52" height="52"><rect width="52" height="52" rx="12" fill="#fff"/></svg>'), blend: "dest-in" }]).png().toBuffer();
await sharp(bg)
  .composite([
    { input: frame, left: 600, top: 380 },
    { input: logo, left: 72, top: 520 },
  ])
  .png()
  .toFile(path.join(ROOT, "assets/img/og.png"));
console.log("og.png");
