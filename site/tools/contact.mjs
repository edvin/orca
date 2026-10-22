// Contact sheet of images for quick review: node tools/contact.mjs out.png a.png b.png ...
import sharp from "sharp";
const [out, ...files] = process.argv.slice(2);
const W = 900, H = 630, cols = 2;
const rows = Math.ceil(files.length / cols);
const tiles = await Promise.all(files.map((f) => sharp(f).resize(W, H, { fit: "contain", background: "#222" }).png().toBuffer()));
await sharp({ create: { width: W * cols, height: H * rows, channels: 3, background: "#111" } })
  .composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * W, top: Math.floor(i / cols) * H })))
  .png().toFile(out);
