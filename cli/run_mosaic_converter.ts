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

async function convertWithMasterEngine(
  inputPath: string,
  outputPath: string,
  gridSize = 32
) {
  const img = sharp(inputPath).rotate();
  const meta = await img.metadata();
  const side = Math.min(meta.width || 320, meta.height || 320);

  const rawBuf = await img
    .extract({
      left: Math.floor(((meta.width || side) - side) / 2),
      top: Math.floor(((meta.height || side) - side) / 2),
      width: side,
      height: side,
    })
    .removeAlpha()
    .ensureAlpha()
    .raw()
    .toBuffer();

  // Run through the automatic decision gate (midtoneRatio < 0.08 -> graphic, else -> photo)
  const midtoneAnalysis = analyzeMidtones(rawBuf, 4);
  const modeUsed = midtoneAnalysis.isTwoColorGraphic ? "2-COLOR GRAPHIC" : "PHOTO (38% Error Diffusion)";

  let matrix: string[][];
  let bom: Record<string, number>;

  if (midtoneAnalysis.isTwoColorGraphic) {
    const res = renderCleanTwoColorMosaicBuffer(
      rawBuf,
      side,
      side,
      gridSize,
      4,
      midtoneAnalysis.bgSku,
      midtoneAnalysis.fgSku,
      0.50
    );
    matrix = res.matrix;
    bom = res.bom;
  } else {
    const downsampled = normalizeAndDownsampleBuffer(rawBuf, side, side, gridSize, 4);
    const res = convertDownsampledBufferToMasterMosaic(downsampled, gridSize, 4);
    matrix = res.matrix;
    bom = res.bom;
  }

  const paletteMap = new Map(ROUND_STUD_STOCK.map((p) => [p.sku, p]));

  // Render high-res round-stud preview
  const CELL = 24;
  const WIDTH = gridSize * CELL;
  const HEIGHT = gridSize * CELL;

  let svgElements = `<rect width="${WIDTH}" height="${HEIGHT}" fill="#18181b"/>`;
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const sku = matrix[y][x];
      const p = paletteMap.get(sku)!;
      const cx = x * CELL + CELL / 2;
      const cy = y * CELL + CELL + 0 - CELL / 2;
      const r = CELL / 2 - 1.5;
      const innerR = r * 0.45;
      svgElements += `
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="rgb(${p.r},${p.g},${p.b})" />
        <circle cx="${cx}" cy="${cy}" r="${innerR}" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="1.2" />
        <circle cx="${cx}" cy="${cy}" r="${innerR}" fill="rgba(0,0,0,0.12)" />
      `;
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${svgElements}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outputPath);

  const artifactDir = process.env.ARTIFACT_DIR;
  if (artifactDir && fs.existsSync(artifactDir)) {
    fs.copyFileSync(outputPath, path.join(artifactDir, path.basename(outputPath)));
  }

  console.log(`\nProcessed ${path.basename(inputPath)} (${gridSize}x${gridSize}) -> ${outputPath}`);
  console.log(`Midtone Ratio: ${(midtoneAnalysis.midtoneRatio * 100).toFixed(2)}% (Threshold: 8.00%) -> Mode: [${modeUsed}]`);
  console.log(`Active colors used: ${Object.keys(bom).length} / ${ROUND_STUD_STOCK.length}`);
  const sorted = Object.entries(bom).sort((a, b) => b[1] - a[1]);
  for (const [sku, count] of sorted) {
    const color = ROUND_STUD_STOCK.find((c) => c.sku === sku)!;
    console.log(`  SKU ${sku.padEnd(5)} | ${color.name.padEnd(24)} : ${count} pcs`);
  }

  return { matrix, bom };
}

async function main() {
  const outputDir = path.resolve(__dirname, "../test-output");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  await convertWithMasterEngine(
    path.resolve(__dirname, "../samples/woman.png"),
    path.resolve(outputDir, "woman-universal.png"),
    32
  );

  await convertWithMasterEngine(
    path.resolve(__dirname, "../samples/assala.png"),
    path.resolve(outputDir, "assala-universal.png"),
    32
  );

  await convertWithMasterEngine(
    path.resolve(__dirname, "../samples/coffee-src.jpg"),
    path.resolve(outputDir, "coffee-universal.png"),
    32
  );

  await convertWithMasterEngine(
    path.resolve(__dirname, "../samples/luca.png"),
    path.resolve(outputDir, "luca-universal.png"),
    32
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
