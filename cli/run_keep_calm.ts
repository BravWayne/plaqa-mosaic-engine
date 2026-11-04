import fs from "fs";
import path from "path";
import sharp from "sharp";
import {
  ROUND_STUD_STOCK,
  analyzeMidtones,
  renderCleanTwoColorMosaicBuffer,
  convertDownsampledBufferToMasterMosaic,
} from "../src/lib/MasterMosaicEngine";
import { normalizeAndDownsampleBuffer } from "../src/lib/PixelArtConverter";

async function processKeepCalm() {
  const inputPath = process.argv[2] || path.resolve(__dirname, "../samples/keep-calm.png");
  const outputDir = path.resolve(__dirname, "../test-output");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const artifactDir = process.env.ARTIFACT_DIR;

  const img = sharp(inputPath);
  const meta = await img.metadata();
  console.log("Input image size:", meta.width, "x", meta.height);

  const paletteMap = new Map(ROUND_STUD_STOCK.map((p) => [p.sku, p]));
  const gridSize = 48; // Standard resolution
  const srcW = meta.width || 650;
  const srcH = meta.height || 917;

  const rawBuf = await img
    .clone()
    .flatten({ background: { r: 16, g: 32, b: 68 } })
    .ensureAlpha()
    .raw()
    .toBuffer();

  // 1. FAST MATHEMATICAL CHECK: Analyze midtones
  const midtoneCheck = analyzeMidtones(rawBuf, 4);
  console.log(`Midtone analysis: ${(midtoneCheck.midtoneRatio * 100).toFixed(2)}% (isTwoColorGraphic: ${midtoneCheck.isTwoColorGraphic})`);

  let matrix: string[][];
  let bom: Record<string, number>;

  if (midtoneCheck.isTwoColorGraphic) {
    console.log(`[2-COLOR GRAPHIC MODE] Content-aware cropping + 50% majority rule (${midtoneCheck.bgSku} Earth Blue & ${midtoneCheck.fgSku} White)`);
    const res = renderCleanTwoColorMosaicBuffer(
      rawBuf,
      srcW,
      srcH,
      gridSize,
      4,
      midtoneCheck.bgSku,
      midtoneCheck.fgSku,
      0.50
    );
    matrix = res.matrix;
    bom = res.bom;
  } else {
    console.log("[PHOTO MODE] Approved 38% error diffusion pipeline");
    const downsampled = normalizeAndDownsampleBuffer(rawBuf, srcW, srcH, gridSize, 4);
    const res = convertDownsampledBufferToMasterMosaic(downsampled, gridSize, 4);
    matrix = res.matrix;
    bom = res.bom;
  }

  // Render Single Crisp Preview SVG & PNG
  const CELL = 16;
  const WIDTH = gridSize * CELL;
  const HEIGHT = gridSize * CELL;

  let svgElements = `<rect width="${WIDTH}" height="${HEIGHT}" fill="#101827"/>`;
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const sku = matrix[y][x];
      const p = paletteMap.get(sku) || { r: 0, g: 0, b: 0, sku, name: "Unknown" };
      const cx = x * CELL + CELL / 2;
      const cy = y * CELL + CELL / 2;
      const r = CELL / 2 - 1.2;
      const innerR = r * 0.45;
      svgElements += `
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="rgb(${p.r},${p.g},${p.b})" />
        <circle cx="${cx}" cy="${cy}" r="${innerR}" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="1.0" />
        <circle cx="${cx}" cy="${cy}" r="${innerR}" fill="rgba(0,0,0,0.12)" />
      `;
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${svgElements}</svg>`;
  const outPath = path.join(outputDir, "keep-calm-preview.png");
  await sharp(Buffer.from(svg)).png().toFile(outPath);

  if (artifactDir && fs.existsSync(artifactDir)) {
    fs.copyFileSync(outPath, path.join(artifactDir, "keep-calm-preview.png"));
  }

  console.log(`\n=== Single Preview Generated ===`);
  console.log(`Output: ${outPath}`);
  console.log(`Grid: ${gridSize}x${gridSize} (${gridSize * gridSize} pieces)`);
  console.log(`Unique SKUs: ${Object.keys(bom).length}`);
  const sorted = Object.entries(bom).sort((a, b) => b[1] - a[1]);
  for (const [sku, count] of sorted) {
    const color = paletteMap.get(sku);
    const totalPieces = gridSize * gridSize;
    console.log(`  SKU ${sku.padEnd(5)} | ${color?.name.padEnd(24)} : ${count} pcs (${((count / totalPieces) * 100).toFixed(1)}%)`);
  }
}

processKeepCalm().catch((err) => {
  console.error("Error processing Keep Calm:", err);
  process.exit(1);
});
