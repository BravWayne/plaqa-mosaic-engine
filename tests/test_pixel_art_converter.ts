import sharp from "sharp";
import fs from "fs";
import path from "path";
import { PALETTE_SEED } from "../src/lib/palette-seed";
import {
  createWarehousePalette,
  processImageToGrid,
  getQuadrants,
  generateQuadrantInstructionsHTML,
  IN_STOCK_PALETTE,
} from "../src/lib/PixelArtConverter";

async function testPixelArtConverter() {
  console.log("===============================================================================");
  console.log("TESTING UNIVERSAL MOSAIC ENGINE (UniversalMosaicEngine.ts / PixelArtConverter.ts)");
  console.log("===============================================================================\n");

  // 1. Build warehouse palette from IN_STOCK_PALETTE
  const warehousePalette = createWarehousePalette(PALETTE_SEED, 50);
  console.log(`[PASS] Loaded in-stock round-stud palette: ${warehousePalette.length} SKUs`);
  if (warehousePalette.length !== IN_STOCK_PALETTE.length) {
    throw new Error(`Expected ${IN_STOCK_PALETTE.length} SKUs, got ${warehousePalette.length}`);
  }

  // Verify White SKU exists
  const whiteSKU = warehousePalette.find((p) => p.sku === "1");
  if (!whiteSKU) throw new Error("White SKU 1 not found in palette");
  console.log(`[PASS] White SKU identified: ${whiteSKU.sku} (${whiteSKU.name}, ${whiteSKU.hex})`);

  // 2. Ingest test image
  const img = sharp("samples/assala.png").rotate();
  const { width = 320, height = 320 } = await img.metadata();
  const side = Math.min(width, height);
  const rawBuffer = await img
    .extract({ left: 0, top: 0, width: side, height: side })
    .removeAlpha()
    .ensureAlpha()
    .raw()
    .toBuffer();

  const src = {
    data: new Uint8ClampedArray(rawBuffer),
    width: side,
    height: side,
  };

  // 3. Process image to 32x32 grid with UniversalMosaicEngine
  const t0 = performance.now();
  const result = processImageToGrid(src, warehousePalette, {
    gridWidth: 32,
    gridHeight: 32,
    safetyBuffer: 0.05,
  });
  const elapsed = performance.now() - t0;
  console.log(`[PASS] Grid conversion completed in ${elapsed.toFixed(2)} ms`);

  // 4. Validate Matrix
  const { matrix, bom, serialized } = result;
  if (matrix.length !== 32 || matrix[0].length !== 32) {
    throw new Error(`Invalid matrix dimensions: ${matrix.length}x${matrix[0]?.length}`);
  }
  console.log(`[PASS] Matrix dimensions verified: 32x32 (${matrix.length * matrix[0].length} pieces)`);

  // 5. Validate Warehouse BOM & Safety Buffer
  let totalBOMCount = 0;
  for (const [sku, item] of Object.entries(bom)) {
    totalBOMCount += item.count;
    const expectedBuffer = Math.ceil(item.count * 1.05);
    if (item.countWithBuffer !== expectedBuffer) {
      throw new Error(`BOM buffer mismatch for ${sku}: got ${item.countWithBuffer}, expected ${expectedBuffer}`);
    }
    const expectedBags = Math.ceil(expectedBuffer / item.sku.bagSize);
    if (item.bags !== expectedBags) {
      throw new Error(`BOM bags mismatch for ${sku}: got ${item.bags}, expected ${expectedBags}`);
    }
  }
  if (totalBOMCount !== 1024) {
    throw new Error(`Total BOM piece count ${totalBOMCount} does not match grid area 1024`);
  }
  console.log(`[PASS] BOM verification passed: ${Object.keys(bom).length} unique SKUs, total pieces = ${totalBOMCount}`);

  // 6. Validate Serialized 2D JSON Structure
  if (!serialized.grid || serialized.grid.length !== 32 || serialized.grid[0].length !== 32) {
    throw new Error("Serialized 2D grid structure is invalid");
  }
  const sampleCell = serialized.grid[0][0];
  if (!sampleCell.sku || !sampleCell.symbol || !sampleCell.hex || !sampleCell.name) {
    throw new Error("Serialized cell missing required SKU metadata fields");
  }
  console.log(`[PASS] Serialized grid verified. Sample cell: ${JSON.stringify(sampleCell)}`);

  // 7. Validate Quadrants & Multi-Page HTML Generation
  const quadrants = getQuadrants(32, 32);
  if (quadrants.length !== 4) throw new Error("Expected 4 quadrants");
  console.log(`[PASS] Quadrants generated: 4 quadrants of 16x16 pieces each`);

  const html = generateQuadrantInstructionsHTML(matrix, bom, "Assala Album Art - 32x32");
  if (!html.includes("Warehouse Bill of Materials") || !html.includes("Quadrant 1 (Top-Left)")) {
    throw new Error("HTML instructions template missing expected headers");
  }
  const pageMatches = html.match(/class="page"/g);
  if (!pageMatches || pageMatches.length !== 5) {
    throw new Error(`Expected 5 pages (1 BOM + 4 Quadrants), found ${pageMatches?.length}`);
  }
  console.log(`[PASS] Generated 5-page print instruction sheet (A4 portrait)`);

  // Save artifacts
  const outDir = path.resolve(__dirname, "../test-output");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "instructions.html"), html, "utf-8");
  fs.writeFileSync(path.join(outDir, "matrix.json"), JSON.stringify(serialized, null, 2), "utf-8");

  console.log("\n===============================================================================");
  console.log("UNIVERSAL MOSAIC ENGINE VERIFICATION SUCCESSFUL!");
  console.log("===============================================================================\n");
}

testPixelArtConverter().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
