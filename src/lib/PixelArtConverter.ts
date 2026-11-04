/**
 * PixelArtConverter.ts
 *
 * Wrapper around MasterMosaicEngine.ts (38% Damped Error Diffusion & ROUND_STUD_STOCK)
 * for BOM & Printable A4 Quadrant Build Guides.
 */

import {
  FactoryStud,
  ROUND_STUD_STOCK,
  getLabDist,
  rgbToLab,
  convertToMasterMosaic,
  convertDownsampledBufferToMasterMosaic,
  ConversionOptions,
  GraphicDetectionResult,
  isGraphicOrPoster,
  detectGraphicOrPoster,
  renderPosterMosaicBuffer,
  renderPhotoMosaicBuffer,
  convertDownsampledBufferSmart,
  renderPhotoMosaic,
  renderPosterMosaic,
  convertImage,
  MidtoneAnalysisResult,
  analyzeMidtones,
  getTightContentBounds,
  renderCleanTwoColorMosaic,
  renderCleanTwoColorMosaicBuffer,
  renderApprovedPhotoMosaic,
  convertImageAutomatically,
} from "./MasterMosaicEngine";

export {
  ROUND_STUD_STOCK,
  ROUND_STUD_STOCK as FACTORY_ROUND_STOCK,
  ROUND_STUD_STOCK as IN_STOCK_ROUND_PALETTE,
  ROUND_STUD_STOCK as IN_STOCK_PALETTE,
  getLabDist,
  rgbToLab,
  convertToMasterMosaic,
  convertToMasterMosaic as convertAnyImageToMosaic,
  convertDownsampledBufferToMasterMosaic,
  convertDownsampledBufferToMasterMosaic as mapDownsampledBufferToMosaic,
  ConversionOptions,
  GraphicDetectionResult,
  isGraphicOrPoster,
  detectGraphicOrPoster,
  renderPosterMosaicBuffer,
  renderPhotoMosaicBuffer,
  convertDownsampledBufferSmart,
  renderPhotoMosaic,
  renderPosterMosaic,
  convertImage,
  MidtoneAnalysisResult,
  analyzeMidtones,
  getTightContentBounds,
  renderCleanTwoColorMosaic,
  renderCleanTwoColorMosaicBuffer,
  renderApprovedPhotoMosaic,
  convertImageAutomatically,
};

export interface WarehouseSKU extends FactoryStud {
  nameZh?: string;
  legoName?: string;
  hex: string;
  symbol: string;
  bagSize: number;
}

export interface ConversionConfig {
  gridWidth: number;
  gridHeight: number;
  safetyBuffer?: number;
  mode?: "auto" | "photo" | "graphic";
  threshold?: number;
  bgSku?: string;
  fgSku?: string;
  [key: string]: unknown;
}

export const DEFAULT_CONVERSION_CONFIG: ConversionConfig = {
  gridWidth: 32,
  gridHeight: 32,
  safetyBuffer: 0.05,
  mode: "auto",
};

export const FORBIDDEN_SKIN_SKUS = new Set<string>();
export const PASTEL_FRINGE_SKUS = new Set<string>();

export function colorDistanceLab(
  lab1: [number, number, number],
  lab2: [number, number, number]
): number {
  return getLabDist(lab1[0], lab1[1], lab1[2], lab2);
}

export const deltaE2000 = colorDistanceLab;

export interface BOMEntry {
  sku: WarehouseSKU;
  count: number;
  countWithBuffer: number;
  bags: number;
}

export interface GridConversionResult {
  matrix: WarehouseSKU[][];
  bom: Record<string, BOMEntry>;
  averageDeltaE: number;
  serialized: {
    grid: { sku: string; symbol: string; hex: string; name: string; nameZh?: string }[][];
    bom: Record<string, { sku: string; name: string; nameZh?: string; hex: string; symbol: string; count: number; countWithBuffer: number; bags: number }>;
  };
}

const SYMBOL_SET = [
  "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "N", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
];

function toHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * Applies brightness(112%) contrast(118%) saturate(110%) and downsamples directly to gridSize x gridSize via area averaging.
 */
export function normalizeAndDownsampleBuffer(
  data: Uint8ClampedArray | Buffer,
  srcW: number,
  srcH: number,
  gridSize: number = 32,
  channels: number = 4
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(gridSize * gridSize * 4);
  const brightness = 1.12;
  const contrast = 1.18;
  const sat = 1.10;
  const cellW = srcW / gridSize;
  const cellH = srcH / gridSize;

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const startX = Math.floor(gx * cellW);
      const startY = Math.floor(gy * cellH);
      const endX = Math.max(startX + 1, Math.floor((gx + 1) * cellW));
      const endY = Math.max(startY + 1, Math.floor((gy + 1) * cellH));

      let sumR = 0, sumG = 0, sumB = 0, total = 0;
      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const idx = (y * srcW + x) * channels;
          let r = data[idx] * brightness;
          let g = data[idx + 1] * brightness;
          let b = data[idx + 2] * brightness;

          // Contrast (118%)
          r = (r - 128) * contrast + 128;
          g = (g - 128) * contrast + 128;
          b = (b - 128) * contrast + 128;

          // Saturation (110%)
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          r = lum + (r - lum) * sat;
          g = lum + (g - lum) * sat;
          b = lum + (b - lum) * sat;

          r = Math.max(0, Math.min(255, r));
          g = Math.max(0, Math.min(255, g));
          b = Math.max(0, Math.min(255, b));

          sumR += r;
          sumG += g;
          sumB += b;
          total++;
        }
      }

      const outIdx = (gy * gridSize + gx) * 4;
      out[outIdx] = Math.round(sumR / total);
      out[outIdx + 1] = Math.round(sumG / total);
      out[outIdx + 2] = Math.round(sumB / total);
      out[outIdx + 3] = 255;
    }
  }

  return out;
}

export function createWarehousePalette(
  paletteSeed?: { code: string; nameEn: string; nameZh?: string; legoName?: string; hex: string; r?: number; g?: number; b?: number }[],
  bagSize = 50
): WarehouseSKU[] {
  return ROUND_STUD_STOCK.map((c, idx) => {
    const fCode = c.sku.startsWith("F") ? c.sku : `F${c.sku}`;
    const seedMatch = paletteSeed?.find((p) => p.code === fCode || p.code === c.sku);
    return {
      sku: c.sku,
      name: c.name,
      nameZh: seedMatch?.nameZh,
      legoName: seedMatch?.legoName || c.name,
      hex: toHex(c.r, c.g, c.b),
      r: c.r,
      g: c.g,
      b: c.b,
      symbol: c.sku === "1" ? "1" : SYMBOL_SET[idx % SYMBOL_SET.length],
      lab: c.lab,
      bagSize,
    };
  });
}

export function processImageToGrid(
  source: HTMLCanvasElement | { data: Uint8ClampedArray; width: number; height: number },
  palette?: WarehouseSKU[],
  config: Partial<ConversionConfig> = {}
): GridConversionResult {
  const fullConfig: ConversionConfig = { ...DEFAULT_CONVERSION_CONFIG, ...config };
  const { gridWidth, safetyBuffer = 0.05 } = fullConfig;

  let rawData: Uint8ClampedArray;
  let srcW: number;
  let srcH: number;

  if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement) {
    const ctx = source.getContext("2d", { willReadFrequently: true })!;
    srcW = source.width;
    srcH = source.height;
    const imgData = ctx.getImageData(0, 0, srcW, srcH);
    rawData = new Uint8ClampedArray(imgData.data);
  } else {
    const rawSrc = source as { data: Uint8ClampedArray; width: number; height: number };
    srcW = rawSrc.width;
    srcH = rawSrc.height;
    rawData = new Uint8ClampedArray(rawSrc.data);
  }

  let skuMatrix: string[][];
  let rawBom: Record<string, number>;

  // Check automatic midtone analysis: if midtoneRatio < 0.08, activate 2-color mode
  const midtoneCheck = analyzeMidtones(rawData, 4);
  const isPoster = fullConfig.mode === "graphic" || (fullConfig.mode !== "photo" && midtoneCheck.isTwoColorGraphic);

  if (isPoster) {
    const bgSku = fullConfig.bgSku || midtoneCheck.bgSku;
    const fgSku = fullConfig.fgSku || midtoneCheck.fgSku;
    const res = renderCleanTwoColorMosaicBuffer(
      rawData,
      srcW,
      srcH,
      gridWidth,
      4,
      bgSku,
      fgSku,
      0.50
    );
    skuMatrix = res.matrix;
    rawBom = res.bom;
  } else {
    // Normal photo/portrait: approved photo engine with 38% error diffusion
    const downsampled32 = normalizeAndDownsampleBuffer(rawData, srcW, srcH, gridWidth, 4);
    const res = convertDownsampledBufferToMasterMosaic(downsampled32, gridWidth, 4);
    skuMatrix = res.matrix;
    rawBom = res.bom;
  }

  const skuLookup = new Map<string, WarehouseSKU>();
  const defaultWarehouse = createWarehousePalette();
  for (const w of defaultWarehouse) {
    skuLookup.set(w.sku, w);
  }
  if (palette) {
    for (const p of palette) {
      const stripped = p.sku.startsWith("F") ? p.sku.slice(1) : p.sku;
      if (skuLookup.has(stripped)) {
        const base = skuLookup.get(stripped)!;
        skuLookup.set(stripped, { ...base, nameZh: p.nameZh || base.nameZh, bagSize: p.bagSize || 50 });
      }
    }
  }

  const matrix: WarehouseSKU[][] = skuMatrix.map((row) =>
    row.map((sku) => skuLookup.get(sku)!)
  );

  const bom: Record<string, BOMEntry> = {};
  const serializedBOM: Record<string, { sku: string; name: string; nameZh?: string; hex: string; symbol: string; count: number; countWithBuffer: number; bags: number }> = {};

  for (const [skuCode, count] of Object.entries(rawBom)) {
    const skuObj = skuLookup.get(skuCode)!;
    const countWithBuffer = Math.ceil(count * (1 + safetyBuffer));
    const bags = Math.ceil(countWithBuffer / (skuObj.bagSize || 50));
    bom[skuCode] = { sku: skuObj, count, countWithBuffer, bags };
    serializedBOM[skuCode] = {
      sku: skuObj.sku,
      name: skuObj.name,
      nameZh: skuObj.nameZh,
      hex: skuObj.hex,
      symbol: skuObj.symbol,
      count,
      countWithBuffer,
      bags,
    };
  }

  const serializedGrid = matrix.map((row) =>
    row.map((sku) => ({
      sku: sku.sku,
      symbol: sku.symbol,
      hex: sku.hex,
      name: sku.name,
      nameZh: sku.nameZh,
    }))
  );

  return {
    matrix,
    bom,
    averageDeltaE: 0,
    serialized: {
      grid: serializedGrid,
      bom: serializedBOM,
    },
  };
}

export interface QuadrantDefinition {
  title: string;
  quadrantIndex: number;
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

export function getQuadrants(width = 32, height = 32): QuadrantDefinition[] {
  const midX = Math.floor(width / 2);
  const midY = Math.floor(height / 2);
  return [
    { title: "Quadrant 1 (Top-Left)", quadrantIndex: 1, rowStart: 0, rowEnd: midY - 1, colStart: 0, colEnd: midX - 1 },
    { title: "Quadrant 2 (Top-Right)", quadrantIndex: 2, rowStart: 0, rowEnd: midY - 1, colStart: midX, colEnd: width - 1 },
    { title: "Quadrant 3 (Bottom-Left)", quadrantIndex: 3, rowStart: midY, rowEnd: height - 1, colStart: 0, colEnd: midX - 1 },
    { title: "Quadrant 4 (Bottom-Right)", quadrantIndex: 4, rowStart: midY, rowEnd: height - 1, colStart: midX, colEnd: width - 1 },
  ];
}

export function generateQuadrantInstructionsHTML(
  matrix: WarehouseSKU[][],
  bom: Record<string, BOMEntry>,
  projectTitle = "Custom PLAQA Mosaic"
): string {
  const width = matrix[0].length;
  const height = matrix.length;
  const quadrants = getQuadrants(width, height);

  const totalPieces = Object.values(bom).reduce((s, e) => s + e.count, 0);
  const totalBags = Object.values(bom).reduce((s, e) => s + e.bags, 0);
  const sortedBOM = Object.values(bom).sort((a, b) => b.count - a.count);

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${projectTitle} - Build Guide</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a1a; background: #ffffff; margin: 0; padding: 0;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .page { width: 100%; page-break-after: always; display: flex; flex-direction: column; min-height: 270mm; }
  .page:last-child { page-break-after: avoid; }
  .header { border-bottom: 2px solid #222; padding-bottom: 8px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-end; }
  .header h1 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
  .header .meta { font-size: 13px; color: #666; font-weight: 600; }
  table.bom { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 12px; }
  table.bom th { background: #f0f0f0; text-align: left; padding: 6px 8px; border-bottom: 2px solid #ccc; font-weight: 700; }
  table.bom td { padding: 5px 8px; border-bottom: 1px solid #e5e5e5; }
  .swatch { display: inline-block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(0,0,0,0.2); vertical-align: middle; margin-right: 6px; }
  .symbol-badge { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; font-size: 11px; font-weight: 800; border-radius: 3px; background: #222; color: #fff; }
  .grid-container { display: flex; justify-content: center; margin: 10px 0; }
  table.mosaic-grid { border-collapse: collapse; }
  table.mosaic-grid td, table.mosaic-grid th { width: 28px; height: 28px; text-align: center; vertical-align: middle; padding: 0; }
  table.mosaic-grid th { font-size: 10px; color: #888; font-weight: 600; }
  .piece { width: 26px; height: 26px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; border: 1px solid rgba(0,0,0,0.18); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.25); }
  .legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; padding-top: 12px; border-top: 1px solid #ddd; font-size: 10px; }
  .legend-item { display: flex; align-items: center; gap: 4px; background: #f9f9f9; padding: 3px 6px; border-radius: 4px; border: 1px solid #eee; }
</style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div>
        <h1>${projectTitle}</h1>
        <div class="meta">${width} × ${height} Studs (${totalPieces} pieces) • Complete Build & Assembly Guide</div>
      </div>
      <div class="meta" style="text-align: right;">
        <div>Total Bags: <strong>${totalBags}</strong></div>
        <div>Unique Colors: <strong>${sortedBOM.length}</strong></div>
      </div>
    </div>
    <h2 style="font-size: 15px; margin: 8px 0;">Warehouse Bill of Materials (BOM)</h2>
    <table class="bom">
      <thead>
        <tr>
          <th>Symbol</th><th>SKU</th><th>Color Name (EN / 中文)</th><th>Hex</th>
          <th style="text-align: right;">Count</th><th style="text-align: right;">+5% Buffer</th>
          <th style="text-align: right;">Bag Size</th><th style="text-align: right;">Bags to Pick</th>
        </tr>
      </thead>
      <tbody>`;

  for (const item of sortedBOM) {
    const isDark = item.sku.lab[0] < 55;
    const badgeColor = isDark ? "#ffffff" : "#1a1a1a";
    const displayName = item.sku.nameZh ? `${item.sku.name} (${item.sku.nameZh})` : item.sku.name;
    html += `
        <tr>
          <td><span class="symbol-badge" style="background:${item.sku.hex}; color:${badgeColor}; border:1px solid rgba(0,0,0,0.25);">${item.sku.symbol}</span></td>
          <td><strong>${item.sku.sku}</strong></td>
          <td><span class="swatch" style="background:${item.sku.hex};"></span>${displayName}</td>
          <td><code>${item.sku.hex.toUpperCase()}</code></td>
          <td style="text-align: right; font-weight: 700;">${item.count}</td>
          <td style="text-align: right;">${item.countWithBuffer}</td>
          <td style="text-align: right;">${item.sku.bagSize} pcs</td>
          <td style="text-align: right; font-weight: 800; color: #0066cc;">${item.bags} bag${item.bags > 1 ? "s" : ""}</td>
        </tr>`;
  }

  html += `</tbody></table></div>`;

  for (const q of quadrants) {
    const qSKUs = new Map<string, WarehouseSKU>();
    for (let r = q.rowStart; r <= q.rowEnd; r++) {
      for (let c = q.colStart; c <= q.colEnd; c++) {
        qSKUs.set(matrix[r][c].sku, matrix[r][c]);
      }
    }
    html += `
  <div class="page">
    <div class="header">
      <div>
        <h1>${projectTitle} - ${q.title}</h1>
        <div class="meta">Rows ${q.rowStart + 1}–${q.rowEnd + 1}, Columns ${q.colStart + 1}–${q.colEnd + 1} (Page ${q.quadrantIndex + 1} of 5)</div>
      </div>
      <div class="meta">Quadrant ${q.quadrantIndex} / 4</div>
    </div>
    <div class="grid-container"><table class="mosaic-grid"><thead><tr><th></th>`;
    for (let c = q.colStart; c <= q.colEnd; c++) html += `<th>${c + 1}</th>`;
    html += `</tr></thead><tbody>`;
    for (let r = q.rowStart; r <= q.rowEnd; r++) {
      html += `<tr><th>${r + 1}</th>`;
      for (let c = q.colStart; c <= q.colEnd; c++) {
        const sku = matrix[r][c];
        const isDark = sku.lab[0] < 55;
        const textColor = isDark ? "#ffffff" : "#1a1a1a";
        html += `<td><div class="piece" style="background-color: ${sku.hex}; color: ${textColor};">${sku.symbol}</div></td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table></div><div class="legend"><div style="width: 100%; font-weight: 700; margin-bottom: 2px;">Quadrant Colors & Key:</div>`;
    for (const sku of qSKUs.values()) {
      const isDark = sku.lab[0] < 55;
      const badgeColor = isDark ? "#ffffff" : "#1a1a1a";
      const displayName = sku.nameZh ? `${sku.name} (${sku.nameZh})` : sku.name;
      html += `<div class="legend-item"><span class="symbol-badge" style="width:16px; height:16px; font-size:10px; background:${sku.hex}; color:${badgeColor}; border:1px solid rgba(0,0,0,0.2);">${sku.symbol}</span><span><strong>${sku.sku}</strong> ${displayName}</span></div>`;
    }
    html += `</div></div>`;
  }

  html += `</body></html>`;
  return html;
}
