// Screenshots of the built site for visual review.
//   node tools/shoot.mjs <outdir> [path ...]
import { chromium } from "playwright";
import path from "node:path";

const out = process.argv[2];
const paths = process.argv.slice(3).length ? process.argv.slice(3) : ["/"];
const exe = process.env.HOME + "/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const browser = await chromium.launch({ executablePath: exe });
const only = process.env.VARIANT;
const variants = [
  { name: "desk-dark", viewport: { width: 1440, height: 900 }, theme: "dark" },
  { name: "desk-light", viewport: { width: 1440, height: 900 }, theme: "light" },
  { name: "mobile-dark", viewport: { width: 390, height: 844 }, theme: "dark", mobile: true },
];
for (const v of variants.filter((x) => !only || x.name === only)) {
  const ctx = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: v.mobile ? 2 : 1, isMobile: !!v.mobile, hasTouch: !!v.mobile });
  await ctx.addInitScript((t) => localStorage.setItem("theme", t), v.theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  for (const p of paths) {
    await page.goto("http://127.0.0.1:4400" + p, { waitUntil: "networkidle" });
    // Reveal everything for full-page shots.
    await page.evaluate(() => document.querySelectorAll(".reveal").forEach((e) => e.classList.add("in")));
    await page.waitForTimeout(900);
    const base = `${p.replace(/\W+/g, "_") || "home"}-${v.name}`;
    if (process.env.SEGMENTS) {
      const h = await page.evaluate(() => document.body.scrollHeight);
      for (let y = 0, i = 0; y < h && i < 14; y += v.viewport.height, i++) {
        await page.evaluate((y) => window.scrollTo(0, y), y);
        await page.waitForTimeout(500);
        const file = path.join(out, `${base}-${String(i).padStart(2, "0")}.png`);
        await page.screenshot({ path: file });
        console.log(file);
      }
    } else {
      await page.evaluate(() => document.querySelectorAll("img[loading=lazy]").forEach((i) => (i.loading = "eager")));
      await page.waitForTimeout(800);
      const file = path.join(out, `${base}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(file);
    }
  }
  if (errors.length) console.log("ERRORS", v.name, errors.slice(0, 5));
  await ctx.close();
}
await browser.close();
