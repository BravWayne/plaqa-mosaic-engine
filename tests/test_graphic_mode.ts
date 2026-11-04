import sharp from "sharp";
import {
  isGraphicOrPoster,
  detectGraphicOrPoster,
  convertDownsampledBufferSmart,
  renderPosterMosaicBuffer,
  analyzeMidtones,
  renderCleanTwoColorMosaicBuffer,
  ROUND_STUD_STOCK,
} from "../src/lib/MasterMosaicEngine";

async function testGraphicMode() {
  console.log("===============================================================================");
  console.log("TESTING GRAPHIC / POSTER MODE & AUTO-DETECTOR");
  console.log("===============================================================================");

  // 1. Synthesize a 32x32 poster buffer (90% Navy Blue background, 10% White text/logo)
  const size = 32;
  const posterBuffer = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      // White text / symbol in center rows
      if (y >= 10 && y <= 12 && x >= 8 && x <= 24) {
        posterBuffer[idx] = 255;
        posterBuffer[idx + 1] = 255;
        posterBuffer[idx + 2] = 255;
        posterBuffer[idx + 3] = 255;
      } else {
        // Navy Blue background RGB(16, 32, 68)
        posterBuffer[idx] = 16;
        posterBuffer[idx + 1] = 32;
        posterBuffer[idx + 2] = 68;
        posterBuffer[idx + 3] = 255;
      }
    }
  }

  // 2. Test Midtone Analysis
  const midtoneSynthetic = analyzeMidtones(posterBuffer, 4);
  console.log(`[TEST] Synthetic poster midtoneRatio: ${(midtoneSynthetic.midtoneRatio * 100).toFixed(2)}%`);
  if (!midtoneSynthetic.isTwoColorGraphic) {
    throw new Error("Synthetic poster midtoneRatio should trigger isTwoColorGraphic!");
  }
  if (midtoneSynthetic.bgSku !== "140") {
    throw new Error(`Expected bgSku 140, got ${midtoneSynthetic.bgSku}`);
  }
  if (midtoneSynthetic.fgSku !== "1") {
    throw new Error(`Expected fgSku 1, got ${midtoneSynthetic.fgSku}`);
  }
  console.log("[PASS] analyzeMidtones correctly identified 2-color graphic poster (SKU 140 & SKU 1)");

  // 3. Test Detection
  const detection = detectGraphicOrPoster(posterBuffer, 4);
  console.log(`[TEST] Detected dominantRatio: ${(detection.dominantRatio * 100).toFixed(1)}%`);
  console.log(`[TEST] Detected bgSku: ${detection.bgSku}, fgSku: ${detection.fgSku}`);

  if (!detection.isGraphic) {
    throw new Error("Failed: synthetic poster was not detected as graphic!");
  }
  if (detection.bgSku !== "140") {
    throw new Error(`Failed: expected bgSku 140 (Earth Blue), got ${detection.bgSku}`);
  }
  if (detection.fgSku !== "1") {
    throw new Error(`Failed: expected fgSku 1 (White), got ${detection.fgSku}`);
  }
  console.log("[PASS] Auto-detector correctly classified poster as GRAPHIC mode with Earth Blue 140 & White 1");

  // 4. Test renderCleanTwoColorMosaicBuffer with 50% area threshold
  const cleanResult = renderCleanTwoColorMosaicBuffer(posterBuffer, size, size, size, 4, "140", "1", 0.50);
  const cleanKeys = Object.keys(cleanResult.bom);
  if (cleanKeys.length !== 2 || !cleanResult.bom["140"] || !cleanResult.bom["1"]) {
    throw new Error(`Expected strictly 2 SKUs (140, 1), got ${cleanKeys.join(", ")}`);
  }
  console.log(`[PASS] renderCleanTwoColorMosaicBuffer: White (1) = ${cleanResult.bom["1"]} pcs, Earth Blue (140) = ${cleanResult.bom["140"]} pcs, 0 noise studs`);

  // 5. Test Real Image Benchmarks
  const assalaBuf = await sharp("samples/assala.png").ensureAlpha().raw().toBuffer();
  const assalaMidtones = analyzeMidtones(assalaBuf, 4);
  console.log(`[TEST] Assala album art midtoneRatio: ${(assalaMidtones.midtoneRatio * 100).toFixed(2)}% (Threshold: 8.00%)`);
  if (assalaMidtones.isTwoColorGraphic) {
    throw new Error("Assala should NOT be classified as 2-color graphic!");
  }
  console.log("[PASS] Assala correctly classified as PHOTO mode (midtoneRatio >= 0.08)");

  const womanBuf = await sharp("samples/woman.png").ensureAlpha().raw().toBuffer();
  const womanMidtones = analyzeMidtones(womanBuf, 4);
  console.log(`[TEST] Woman portrait midtoneRatio: ${(womanMidtones.midtoneRatio * 100).toFixed(2)}% (Threshold: 8.00%)`);
  if (womanMidtones.isTwoColorGraphic) {
    throw new Error("Woman portrait should NOT be classified as 2-color graphic!");
  }
  console.log("[PASS] Woman portrait correctly classified as PHOTO mode (midtoneRatio >= 0.08)");

  const keepCalmPath = "samples/keep-calm.png";
  const keepCalmBuf = await sharp(keepCalmPath).ensureAlpha().raw().toBuffer();
  const keepCalmMidtones = analyzeMidtones(keepCalmBuf, 4);
  console.log(`[TEST] Keep Calm poster midtoneRatio: ${(keepCalmMidtones.midtoneRatio * 100).toFixed(2)}% (Threshold: 8.00%)`);
  if (!keepCalmMidtones.isTwoColorGraphic) {
    throw new Error("Keep Calm poster MUST be classified as 2-color graphic!");
  }
  console.log("[PASS] Keep Calm poster correctly classified as 2-COLOR GRAPHIC mode (midtoneRatio < 0.08)");

  console.log("===============================================================================");
  console.log("ALL GRAPHIC / POSTER MODE TESTS PASSED SUCCESSFULLY!");
  console.log("===============================================================================");
}

testGraphicMode().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
