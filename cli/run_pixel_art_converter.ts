import sharp from "sharp";
import fs from "fs";
import path from "path";
import { PALETTE_SEED } from "../src/lib/palette-seed";
import {
  createWarehousePalette,
  processImageToGrid,
  generateQuadrantInstructionsHTML,
} from "../src/lib/PixelArtConverter";

const ARTIFACT_DIR = process.env.ARTIFACT_DIR;
const OUT_DIR = path.resolve(__dirname, "../test-output");

async function renderGridToImage(
  grid: { sku: string; symbol: string; hex: string; name: string }[][],
  outputPath: string,
  artifactPath?: string
) {
  const C = 24; // cell size
  const W = grid[0].length * C;
  const H = grid.length * C;

  let svgRects = "";
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[0].length; x++) {
      const cell = grid[y][x];
      const px = x * C;
      const py = y * C;
      // Stud body with slight rounded corners and inner shadow/highlight
      svgRects += `
        <rect x="${px + 1}" y="${py + 1}" width="${C - 2}" height="${C - 2}" rx="4" fill="${cell.hex}"/>
        <circle cx="${px + C / 2}" cy="${py + C / 2}" r="${C / 4}" fill="${cell.hex}" stroke="rgba(255,255,255,0.25)" stroke-width="1.5"/>
      `;
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#111213"/>
    ${svgRects}
  </svg>`;

  const pngBuf = await sharp(Buffer.from(svg)).png().toBuffer();
  fs.writeFileSync(outputPath, pngBuf);
  if (artifactPath) {
    fs.writeFileSync(artifactPath, pngBuf);
  }
}

async function run() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const warehousePalette = createWarehousePalette(PALETTE_SEED, 50);

  const images = [
    { name: "assala", file: "samples/assala.png", label: "Assala Album Art (Calligraphy & Dark Contrast)" },
    { name: "woman", file: "samples/woman.png", label: "Woman Portrait (Facial Contours & Highlights)" },
    { name: "coffee", file: "samples/coffee-src.jpg", label: "Coffee Cup (Vibrant Palette & Fine Steam Details)" },
  ];

  console.log("===============================================================================");
  console.log("RUNNING PIXEL ART CONVERTER (PixelArtConverter.ts)");
  console.log("===============================================================================\n");

  for (const item of images) {
    const img = sharp(item.file).rotate();
    const { width = 320, height = 320 } = await img.metadata();
    const side = Math.min(width, height);
    const rawBuffer = await img
      .extract({ left: Math.floor((width - side) / 2), top: Math.floor((height - side) / 2), width: side, height: side })
      .resize(320, 320, { kernel: "lanczos3" })
      .removeAlpha()
      .ensureAlpha()
      .raw()
      .toBuffer();

    const t0 = performance.now();
    const result = processImageToGrid(
      { data: new Uint8ClampedArray(rawBuffer), width: 320, height: 320 },
      warehousePalette,
      {
        gridWidth: 32,
        gridHeight: 32,
        whiteThreshold: 205,
        whiteStrokeRatio: 0.10,
        contrastBoost: 1.0,
        saturationBoost: 1.0,
        sharpness: 0.25,
        safetyBuffer: 0.05,
      }
    );
    const ms = performance.now() - t0;

    const outPng = path.join(OUT_DIR, `${item.name}-pixelart.png`);
    const artPng = ARTIFACT_DIR && fs.existsSync(ARTIFACT_DIR) ? path.join(ARTIFACT_DIR, `pixelart-${item.name}.png`) : undefined;
    await renderGridToImage(result.serialized.grid, outPng, artPng);

    const html = generateQuadrantInstructionsHTML(result.matrix, result.bom, item.label);
    const outHtml = path.join(OUT_DIR, `${item.name}-instructions.html`);
    fs.writeFileSync(outHtml, html, "utf-8");

    const outJson = path.join(OUT_DIR, `${item.name}-matrix.json`);
    fs.writeFileSync(outJson, JSON.stringify(result.serialized, null, 2), "utf-8");

    // Output stats
    const sortedBOM = Object.values(result.bom).sort((a, b) => b.count - a.count);
    const totalPieces = sortedBOM.reduce((sum, b) => sum + b.count, 0);
    const totalBags = sortedBOM.reduce((sum, b) => sum + b.bags, 0);
    const whiteCount = result.bom["F1"]?.count || 0;

    console.log(`[OK] ${item.label}`);
    console.log(`     Processed in ${ms.toFixed(1)} ms | Average ΔE: ${result.averageDeltaE.toFixed(2)} | Output: ${outPng}`);
    console.log(`     Dimensions: 32x32 (${totalPieces} pieces) | Unique SKUs: ${sortedBOM.length} | Bags to Pick: ${totalBags}`);
    console.log(`     White (F1) Pieces: ${whiteCount} (Lettering / Highlights)`);
    console.log("     Top 5 Palette SKUs:");
    for (const b of sortedBOM.slice(0, 5)) {
      const displayName = b.sku.nameZh ? `${b.sku.name} (${b.sku.nameZh})` : b.sku.name;
      console.log(`       - ${b.sku.sku.padEnd(6)} ${displayName.padEnd(28)} Count: ${b.count.toString().padEnd(4)} (+5%: ${b.countWithBuffer}) => ${b.bags} bags`);
    }
    console.log();
  }

  console.log("All outputs successfully written to disk and artifact directory!");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
