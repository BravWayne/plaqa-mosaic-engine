/**
 * Command-line runner for the PLAQA mosaic engine (no browser, no ML models).
 *
 *   npx tsx cli/convert.ts <image> [out.png] [--style colour|bold|mono|vintage] [--bg keep|soft|auto] [--kind portrait|subject|scene|graphic]
 *
 * Writes a preview PNG (32×32 pieces, rendered 20 px each) and prints the colour counts.
 * Note: in the browser the studio also feeds a subject mask (U²-Net) and a face box (RFB-320);
 * here they are absent, so "soft"/"auto" backgrounds behave like "keep" and face boosts are off.
 */
import sharp from "sharp";
import { PALETTE_SEED } from "../src/lib/palette-seed";
import { renderMosaicV5, type Kind } from "../src/lib/mosaic5";
import type { StyleId } from "../src/lib/mosaic";

const args = process.argv.slice(2);
const flag = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const [input, output = "out.png"] = pos;
if (!input) { console.error("usage: npx tsx cli/convert.ts <image> [out.png] [--style colour] [--bg keep] [--kind portrait]"); process.exit(1); }

const WORK = 320; // same working size as the studio
(async () => {
  // centre square crop, like the studio's default framing
  const img = sharp(input).rotate();
  const { width = 0, height = 0 } = await img.metadata();
  const side = Math.min(width, height);
  const raw = await img.extract({ left: Math.floor((width - side) / 2), top: Math.floor((height - side) / 2), width: side, height: side })
    .resize(WORK, WORK, { kernel: "lanczos3" }).removeAlpha().ensureAlpha().raw().toBuffer();
  const palette = PALETTE_SEED.map((c) => ({ code: c.code, hex: c.hex, nameEn: c.nameEn, nameAr: c.nameAr }));
  const t0 = performance.now();
  const r = renderMosaicV5(new Uint8ClampedArray(raw), WORK, palette, {
    style: (flag("--style", "colour") as StyleId), bgMode: flag("--bg", "keep") as "keep" | "soft" | "auto", kind: flag("--kind") as Kind | undefined,
  });
  const ms = performance.now() - t0;

  // preview: rounded square pieces on a dark plate
  const C = 20, S = 32 * C, hex = new Map(palette.map((p) => [p.code, p.hex]));
  const rects = r.pattern.map((code, i) => `<rect x="${(i % 32) * C + 1}" y="${Math.floor(i / 32) * C + 1}" width="${C - 2}" height="${C - 2}" rx="4" fill="${hex.get(code)}"/>`).join("");
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><rect width="${S}" height="${S}" fill="#161817"/>${rects}</svg>`)).png().toFile(output);

  const counts = new Map<string, number>(); r.pattern.forEach((c) => counts.set(c, (counts.get(c) ?? 0) + 1));
  console.log(`kind=${r.kind}  colours=${counts.size}  avgΔE=${r.averageDeltaE.toFixed(2)}  ${ms.toFixed(0)} ms  → ${output}`);
  for (const [c, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(6)} ${palette.find((p) => p.code === c)!.nameEn.padEnd(24)} ${n}`);
})();
