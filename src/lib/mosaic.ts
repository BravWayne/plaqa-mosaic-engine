// PLAQA mosaic engine — pure TypeScript, runs in the browser and on the server.
// Photo pixels → 32×32 grid → nearest available colour (CIEDE2000 in Lab space).

export const GRID = 32;
export const CELLS = GRID * GRID;

export type PaletteColor = { code: string; hex: string; nameEn: string; nameAr: string };
export type Pattern = string[]; // length CELLS, row-major colour codes

export type Adjustments = {
  brightness: number; // -50..50
  contrast: number; // -50..50
  saturation: number; // -50..50
  dither: boolean;
};

export const DEFAULT_ADJUSTMENTS: Adjustments = { brightness: 0, contrast: 0, saturation: 0, dither: false };

// ---------- colour maths ----------
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// CIE standard constants (CIE 15:2004)
export const CIE_EPSILON = 216 / 24389; // ≈ 0.008856451679
export const CIE_KAPPA = 24389 / 27;     // ≈ 903.2962963

// Standard Illuminant D65 reference white point (2° standard observer)
export const D65_Xn = 0.95047;
export const D65_Yn = 1.00000;
export const D65_Zn = 1.08883;

// Precomputed sRGB -> Linear lookup table for exact physical photometric calculations
export const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255.0;
  SRGB_TO_LIN[i] = c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
}

export function srgbToLinear(c: number): number {
  const norm = Math.max(0, Math.min(255, c)) / 255.0;
  return norm > 0.04045 ? Math.pow((norm + 0.055) / 1.055, 2.4) : norm / 12.92;
}

export function linearToSrgb(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

export type PrecomputedPaletteColor = {
  code: string;
  hex: string;
  nameEn: string;
  nameAr: string;
  rgb: [number, number, number];
  lab: [number, number, number]; // [L*, a*, b*]
  L: number;
  C: number;
  h: number;
};

/** Pre-compute warehouse palette colors in CIELAB space with chroma and hue metrics for real-time matching. */
export function precomputePalette(palette: PaletteColor[]): PrecomputedPaletteColor[] {
  return palette.map((p) => {
    const rgb = hexToRgb(p.hex);
    const lab = rgbToLab(...rgb);
    const C = Math.hypot(lab[1], lab[2]);
    let h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
    if (h < 0) h += 360;
    return { code: p.code, hex: p.hex, nameEn: p.nameEn, nameAr: p.nameAr, rgb, lab, L: lab[0], C, h };
  });
}

/**
 * Convert standard non-linear sRGB (0..255) to CIELAB space.
 * Follows exact standard CIE D65 observer reference white point (Xn=0.95047, Yn=1.00000, Zn=1.08883)
 * and IEC 61966-2-1 transformation matrix. Scale normalization is performed BEFORE non-linear transforms.
 */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  // Scale RGB values (0..255) to 0.0 - 1.0 BEFORE any non-linear transformations
  let rn = Math.max(0, Math.min(255, r)) / 255.0;
  let gn = Math.max(0, Math.min(255, g)) / 255.0;
  let bn = Math.max(0, Math.min(255, b)) / 255.0;

  // Standard non-linear sRGB to linear conversion:
  rn = rn > 0.04045 ? Math.pow((rn + 0.055) / 1.055, 2.4) : rn / 12.92;
  gn = gn > 0.04045 ? Math.pow((gn + 0.055) / 1.055, 2.4) : gn / 12.92;
  bn = bn > 0.04045 ? Math.pow((bn + 0.055) / 1.055, 2.4) : bn / 12.92;

  // Linear sRGB to CIE XYZ under standard D65 illuminant
  const X = 0.4124564 * rn + 0.3575761 * gn + 0.1804375 * bn;
  const Y = 0.2126729 * rn + 0.7151522 * gn + 0.0721750 * bn;
  const Z = 0.0193339 * rn + 0.1191920 * gn + 0.9503041 * bn;

  // Normalize by D65 reference white point
  const xr = X / D65_Xn;
  const yr = Y / D65_Yn;
  const zr = Z / D65_Zn;

  // CIE f(t) transform
  const fx = xr > CIE_EPSILON ? Math.cbrt(xr) : (CIE_KAPPA * xr + 16) / 116;
  const fy = yr > CIE_EPSILON ? Math.cbrt(yr) : (CIE_KAPPA * yr + 16) / 116;
  const fz = zr > CIE_EPSILON ? Math.cbrt(zr) : (CIE_KAPPA * zr + 16) / 116;

  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const bVal = 200 * (fy - fz);
  return [L, a, bVal];
}

export function deltaE2000(a: [number, number, number], b: [number, number, number]): number {
  const [L1, a1, b1] = a, [L2, a2, b2] = b;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cm, 7) / (Math.pow(Cm, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (x: number, y: number) => { if (x === 0 && y === 0) return 0; const d = Math.atan2(y, x) / rad; return d < 0 ? d + 360 : d; };
  const h1p = h(a1p, b1), h2p = h(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lpm = (L1 + L2) / 2, Cpm = (C1p + C2p) / 2;
  let hpm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hpm += h1p + h2p < 360 ? 360 : -360;
    hpm /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hpm - 30) * rad) + 0.24 * Math.cos(2 * hpm * rad) + 0.32 * Math.cos((3 * hpm + 6) * rad) - 0.2 * Math.cos((4 * hpm - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hpm - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cpm, 7) / (Math.pow(Cpm, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lpm - 50, 2)) / Math.sqrt(20 + Math.pow(Lpm - 50, 2));
  const Sc = 1 + 0.045 * Cpm, Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh));
}

// ---------- image processing ----------
const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Apply brightness / contrast / saturation in place on RGBA data. */
export function adjustPixels(data: Uint8ClampedArray | number[], adj: Adjustments) {
  const br = adj.brightness * 2.55;
  const ct = adj.contrast * 2.55;
  const cf = (259 * (ct + 255)) / (255 * (259 - ct));
  const sat = 1 + adj.saturation / 50;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    r = cf * (r - 128) + 128 + br; g = cf * (g - 128) + 128 + br; b = cf * (b - 128) + 128 + br;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
    data[i] = clamp(r); data[i + 1] = clamp(g); data[i + 2] = clamp(b);
  }
}

/**
 * High-pass / unsharp mask applied in physical linear light prior to downsampling.
 * This prevents fine lines, typography strokes, and high-contrast edges from blurring
 * into adjacent background pixels during optical downsampling.
 */
export function unsharpMaskLinear(data: Uint8ClampedArray, size: number, amount = 1.3, radius = 1): Float32Array {
  const N = size * size;
  const lin = new Float32Array(N * 3);
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    const a = data[i + 3] / 255;
    // Transparent pixels blend with pure white in linear space
    lin[p * 3]     = SRGB_TO_LIN[data[i]] * a + (1 - a);
    lin[p * 3 + 1] = SRGB_TO_LIN[data[i + 1]] * a + (1 - a);
    lin[p * 3 + 2] = SRGB_TO_LIN[data[i + 2]] * a + (1 - a);
  }
  const tmp = new Float32Array(N * 3);
  const blurred = new Float32Array(N * 3);
  // Separable horizontal blur
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0, gSum = 0, bSum = 0, wSum = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < size) {
          const w = dx === 0 ? 2 : 1;
          const idx = (y * size + nx) * 3;
          rSum += lin[idx] * w; gSum += lin[idx + 1] * w; bSum += lin[idx + 2] * w; wSum += w;
        }
      }
      const outIdx = (y * size + x) * 3;
      tmp[outIdx]     = rSum / wSum;
      tmp[outIdx + 1] = gSum / wSum;
      tmp[outIdx + 2] = bSum / wSum;
    }
  }
  // Separable vertical blur
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0, gSum = 0, bSum = 0, wSum = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny >= 0 && ny < size) {
          const w = dy === 0 ? 2 : 1;
          const idx = (ny * size + x) * 3;
          rSum += tmp[idx] * w; gSum += tmp[idx + 1] * w; bSum += tmp[idx + 2] * w; wSum += w;
        }
      }
      const outIdx = (y * size + x) * 3;
      blurred[outIdx]     = rSum / wSum;
      blurred[outIdx + 1] = gSum / wSum;
      blurred[outIdx + 2] = bSum / wSum;
    }
  }
  const out = new Float32Array(N * 3);
  for (let i = 0; i < N * 3; i++) {
    out[i] = Math.max(0, Math.min(1, lin[i] + amount * (lin[i] - blurred[i])));
  }
  return out;
}

/**
 * Dynamic Contrast & Black/White Point Clamping:
 * Automatically normalizes the input luminance histogram so deep shadows clamp cleanly
 * to darks and highlights reach crisp whites, preventing dark backgrounds from bleeding into midtones.
 */
export function dynamicContrastStretch(
  linImg: Float32Array,
  size: number,
  blackPct = 0.015,
  whitePct = 0.985,
  sCurveBlend = 0.5
): Float32Array {
  const N = size * size;
  const Y = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    Y[p] = 0.2126 * linImg[p * 3] + 0.7152 * linImg[p * 3 + 1] + 0.0722 * linImg[p * 3 + 2];
  }
  const BINS = 1000;
  const hist = new Uint32Array(BINS);
  for (let p = 0; p < N; p++) {
    const b = Math.min(BINS - 1, Math.max(0, Math.floor(Y[p] * BINS)));
    hist[b]++;
  }
  let lo = 0, hi = 1, acc = 0;
  const targetLo = N * blackPct, targetHi = N * whitePct;
  for (let b = 0; b < BINS; b++) {
    acc += hist[b];
    if (acc >= targetLo) { lo = b / BINS; break; }
  }
  acc = 0;
  for (let b = BINS - 1; b >= 0; b--) {
    acc += hist[b];
    if (acc >= N - targetHi) { hi = (b + 1) / BINS; break; }
  }
  const span = Math.max(0.12, hi - lo);
  const out = new Float32Array(N * 3);
  for (let p = 0; p < N; p++) {
    for (let c = 0; c < 3; c++) {
      const val = linImg[p * 3 + c];
      const norm = Math.max(0, Math.min(1, (val - lo) / span));
      const sCurve = norm * norm * (3 - 2 * norm);
      out[p * 3 + c] = (1 - sCurveBlend) * norm + sCurveBlend * sCurve;
    }
  }
  return out;
}

/**
 * Adaptive High-Frequency Cell Downsampling:
 * Analyzes each mosaic cell window for high-contrast edges and thin strokes (e.g. calligraphy, white text,
 * eye pupils, sharp highlights). Rather than performing a naive area-average that washes fine strokes
 * into muddy midtones, it isolates and prioritizes the dominant stroke color and marks the cell as a protected feature.
 */
export function adaptiveCellSampling(
  contrastLin: Float32Array,
  size: number,
  importance?: Float32Array | null
): { cellLabs: [number, number, number][]; isFeature: Uint8Array; cellWeights: Float32Array } {
  const step = size / GRID;
  const cellLabs: [number, number, number][] = new Array(CELLS);
  const isFeature = new Uint8Array(CELLS);
  const cellWeights = new Float32Array(CELLS).fill(1.0);

  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const idx = gy * GRID + gx;
      const x0 = Math.floor(gx * step), x1 = Math.floor((gx + 1) * step);
      const y0 = Math.floor(gy * step), y1 = Math.floor((gy + 1) * step);

      const px: { lab: [number, number, number]; rLin: number; gLin: number; bLin: number }[] = [];
      let sumRLin = 0, sumGLin = 0, sumBLin = 0, sumImp = 0;
      let minL = 100, maxL = 0;

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = y * size + x;
          const p3 = p * 3;
          const rL = contrastLin[p3], gL = contrastLin[p3 + 1], bL = contrastLin[p3 + 2];
          sumRLin += rL; sumGLin += gL; sumBLin += bL;
          const rS = linearToSrgb(rL), gS = linearToSrgb(gL), bS = linearToSrgb(bL);
          const lab = rgbToLab(rS, gS, bS);
          if (lab[0] < minL) minL = lab[0];
          if (lab[0] > maxL) maxL = lab[0];
          sumImp += importance ? importance[p] : 1.0;
          px.push({ lab, rLin: rL, gLin: gL, bLin: bL });
        }
      }
      const count = px.length;
      cellWeights[idx] = sumImp / count;
      const dL = maxL - minL;

      if (dL > 26) {
        let c0 = px.reduce((m, p) => p.lab[0] < m.lab[0] ? p : m).lab;
        let c1 = px.reduce((m, p) => p.lab[0] > m.lab[0] ? p : m).lab;
        let grp0: typeof px = [], grp1: typeof px = [];

        for (let it = 0; it < 4; it++) {
          grp0 = []; grp1 = [];
          for (const p of px) {
            const d0 = (p.lab[0] - c0[0]) ** 2 + (p.lab[1] - c0[1]) ** 2 + (p.lab[2] - c0[2]) ** 2;
            const d1 = (p.lab[0] - c1[0]) ** 2 + (p.lab[1] - c1[1]) ** 2 + (p.lab[2] - c1[2]) ** 2;
            if (d0 <= d1) grp0.push(p); else grp1.push(p);
          }
          if (grp0.length) {
            c0 = [
              grp0.reduce((s, p) => s + p.lab[0], 0) / grp0.length,
              grp0.reduce((s, p) => s + p.lab[1], 0) / grp0.length,
              grp0.reduce((s, p) => s + p.lab[2], 0) / grp0.length,
            ];
          }
          if (grp1.length) {
            c1 = [
              grp1.reduce((s, p) => s + p.lab[0], 0) / grp1.length,
              grp1.reduce((s, p) => s + p.lab[1], 0) / grp1.length,
              grp1.reduce((s, p) => s + p.lab[2], 0) / grp1.length,
            ];
          }
        }

        const clusterSep = Math.hypot(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]);
        const lightFrac = grp1.length / count;
        const darkFrac = grp0.length / count;

        // A) High-contrast light stroke (text, calligraphy, jewelry, specular highlights)
        if (clusterSep > 28 && c1[0] > 58 && lightFrac >= 0.08 && lightFrac <= 0.65) {
          cellLabs[idx] = c1;
          isFeature[idx] = 1;
          cellWeights[idx] = Math.max(cellWeights[idx], 5.0);
        }
        // B) High-contrast dark stroke (pupils, brows, hair strands, dark contours)
        else if (clusterSep > 28 && c0[0] < 36 && darkFrac >= 0.10 && darkFrac <= 0.65) {
          cellLabs[idx] = c0;
          isFeature[idx] = 1;
          cellWeights[idx] = Math.max(cellWeights[idx], 4.0);
        }
        // C) Crisp boundary edge between two color fields: pick the dominant side without muddy mixing
        else if (clusterSep > 20 && Math.abs(lightFrac - 0.5) < 0.28) {
          cellLabs[idx] = grp1.length >= grp0.length ? c1 : c0;
          isFeature[idx] = 1;
          cellWeights[idx] = Math.max(cellWeights[idx], 2.5);
        } else {
          // Smooth cell: area average in linear light
          const avgR = linearToSrgb(sumRLin / count);
          const avgG = linearToSrgb(sumGLin / count);
          const avgB = linearToSrgb(sumBLin / count);
          cellLabs[idx] = rgbToLab(avgR, avgG, avgB);
        }
      } else {
        // Uniform cell: area average in linear light
        const avgR = linearToSrgb(sumRLin / count);
        const avgG = linearToSrgb(sumGLin / count);
        const avgB = linearToSrgb(sumBLin / count);
        cellLabs[idx] = rgbToLab(avgR, avgG, avgB);
      }
    }
  }
  return { cellLabs, isFeature, cellWeights };
}

/** Area-average a square RGBA image (size×size) down to GRID×GRID RGB cells, in linear light
 *  (averaging gamma-encoded values darkens highlights — metal, eyes, light backgrounds). */
export function downsample(data: Uint8ClampedArray, size: number): number[][] {
  const lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) lin[i] = srgbToLinear(i);
  const toSrgb = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const cells: number[][] = [];
  const step = size / GRID;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const x0 = Math.floor(gx * step), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * step));
      const y0 = Math.floor(gy * step), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * step));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * size + x) * 4;
        const a = data[i + 3] / 255;
        // transparent pixels read as white
        r += lin[data[i]] * a + (1 - a); g += lin[data[i + 1]] * a + (1 - a); b += lin[data[i + 2]] * a + (1 - a); n++;
      }
      cells.push([toSrgb(r / n), toSrgb(g / n), toSrgb(b / n)]);
    }
  }
  return cells;
}

/** Stretch luminance so the darkest 1% → black and the brightest 1% → white (keeps hue). */
export function autoLevels(data: Uint8ClampedArray, strength = 1) {
  const hist = new Uint32Array(256);
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) hist[Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += hist[lo]; if (acc > n * 0.01) break; }
  acc = 0;
  for (; hi > 0; hi--) { acc += hist[hi]; if (acc > n * 0.01) break; }
  if (hi - lo < 30) return;
  const scale = 1 + (255 / (hi - lo) - 1) * strength, off = lo * strength;
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = clamp((data[i + c] - off) * scale);
}

/** Unsharp mask on the 32×32 grid: restores edges that averaging softened. */
export function sharpenCells(cells: number[][], amount = 0.6): number[][] {
  return cells.map((c, i) => {
    const x = i % GRID, y = Math.floor(i / GRID);
    const nb: number[][] = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < GRID && ny < GRID) nb.push(cells[ny * GRID + nx]);
    }
    return c.map((v, k) => clamp(v + amount * (v - nb.reduce((s, q) => s + q[k], 0) / nb.length)));
  });
}

type LabPalette = { code: string; rgb: [number, number, number]; lab: [number, number, number] }[];

export function buildLabPalette(palette: PaletteColor[]): LabPalette {
  return palette.map((c) => { const rgb = hexToRgb(c.hex); return { code: c.code, rgb, lab: rgbToLab(...rgb) }; });
}

function nearest(lp: LabPalette, r: number, g: number, b: number) {
  const lab = rgbToLab(r, g, b);
  const c0 = Math.hypot(lab[1], lab[2]);
  let best = 0, bestD = Infinity, bestTrue = 0;
  for (let i = 0; i < lp.length; i++) {
    const d = deltaE2000(lab, lp[i].lab);
    // don't let a near-neutral tone (metal, shadow, grey sky) jump to a saturated piece
    const ci = Math.hypot(lp[i].lab[1], lp[i].lab[2]);
    const cost = d + Math.max(0, ci - c0 - 18) * 0.3;
    if (cost < bestD) { bestD = cost; best = i; bestTrue = d; }
  }
  return { idx: best, distance: bestTrue };
}

export type QuantizeResult = { pattern: Pattern; averageDeltaE: number; maxDeltaE: number };

/** Map GRID×GRID RGB cells to the palette using Perceptual Nearest Neighbor (Direct Match). Zero spatial error diffusion. */
export function quantize(cells: number[][], palette: PaletteColor[], _dither = false): QuantizeResult {
  if (palette.length === 0) throw new Error("Palette is empty");
  const lp = buildLabPalette(palette);
  const pattern: Pattern = new Array(cells.length);
  let sum = 0, max = 0;
  for (let i = 0; i < cells.length; i++) {
    const [r, g, b] = cells[i];
    const { idx, distance } = nearest(lp, r, g, b);
    pattern[i] = lp[idx].code;
    sum += distance;
    if (distance > max) max = distance;
  }
  return { pattern, averageDeltaE: sum / cells.length, maxDeltaE: max };
}

// ---------- pattern helpers ----------
export type ColorCount = { code: string; count: number };

export function countColors(pattern: Pattern): ColorCount[] {
  const m = new Map<string, number>();
  for (const c of pattern) m.set(c, (m.get(c) ?? 0) + 1);
  return [...m.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
}

/** Spare pieces packed per colour: a percentage, never fewer than `min`. */
export function spareFor(count: number, sparePercent = 3, min = 2) {
  return Math.max(min, Math.ceil((count * sparePercent) / 100));
}

/**
 * Bag numbers for one kit: colours ordered light → dark so bag 1 is the lightest.
 * The same numbers appear in the build guide cells and on the pick sheet.
 */
export function bagNumbers(pattern: Pattern, palette: PaletteColor[]): Map<string, number> {
  const used = new Set(pattern);
  const byCode = new Map(palette.map((p) => [p.code, p]));
  const list = [...used].map((code) => {
    const hex = byCode.get(code)?.hex ?? "#808080";
    return { code, L: rgbToLab(...hexToRgb(hex))[0] };
  }).sort((a, b) => b.L - a.L);
  return new Map(list.map((c, i) => [c.code, i + 1]));
}

export function isValidPattern(p: unknown, validCodes: Set<string>): p is Pattern {
  return Array.isArray(p) && p.length === CELLS && p.every((c) => typeof c === "string" && validCodes.has(c));
}

/** Pick readable text colour (ink or cream) for a swatch. */
export function inkOn(hex: string) {
  return rgbToLab(...hexToRgb(hex))[0] > 62 ? "#242826" : "#FBF7EF";
}

/** Build-guide sections: sixteen 8×8 squares in reading order — big enough to read on a phone. */
export const SECTION = 8;
export const SECTIONS = Array.from({ length: (GRID / SECTION) ** 2 }, (_, i) => ({
  index: i,
  x0: (i % (GRID / SECTION)) * SECTION,
  y0: Math.floor(i / (GRID / SECTION)) * SECTION,
}));

export function sectionCounts(pattern: Pattern, s: { x0: number; y0: number }) {
  const m = new Map<string, number>();
  for (let y = s.y0; y < s.y0 + SECTION; y++) for (let x = s.x0; x < s.x0 + SECTION; x++) {
    const c = pattern[y * GRID + x]; m.set(c, (m.get(c) ?? 0) + 1);
  }
  return m;
}

/**
 * Fewer bags, faster packing: fold colours used by only a handful of pieces into the
 * nearest colour already in the artwork, and cap the total number of colours per kit.
 * Protected colors (e.g. high-contrast text strokes, highlights) are preserved.
 */
export function consolidate(
  pattern: Pattern,
  palette: PaletteColor[],
  minCount = 6,
  maxColors = 14,
  protectedCodes?: Set<string> | string[]
): Pattern {
  const lab = new Map(palette.map((p) => [p.code, rgbToLab(...hexToRgb(p.hex))]));
  const protectSet = protectedCodes ? new Set(protectedCodes) : new Set<string>();
  const out = [...pattern];
  for (;;) {
    const counts = countColors(out);
    const victim = [...counts].reverse().find((c) => c.count < minCount && !protectSet.has(c.code)) ??
      (counts.length > maxColors ? [...counts].reverse().find((c) => !protectSet.has(c.code)) : undefined);
    if (!victim || counts.length <= 1) break;
    const vLab = lab.get(victim.code)!;
    let best = "", bestD = Infinity;
    for (const c of counts) {
      if (c.code === victim.code) continue;
      const d = deltaE2000(vLab, lab.get(c.code)!);
      if (d < bestD) { bestD = d; best = c.code; }
    }
    for (let i = 0; i < out.length; i++) if (out[i] === victim.code) out[i] = best;
  }
  return out;
}

/** Remove lone stray pieces: a cell that matches none of its 4 neighbours takes the colour most
 *  of them share, if that colour is close to what the photo had there. */
export function despeckle(pattern: Pattern, cells: number[][], palette: PaletteColor[], maxDelta = 22): Pattern {
  const lab = new Map(palette.map((p) => [p.code, rgbToLab(...hexToRgb(p.hex))]));
  const out = [...pattern];
  for (let pass = 0; pass < 2; pass++) {
    const src = [...out];
    for (let i = 0; i < CELLS; i++) {
      const x = i % GRID, y = Math.floor(i / GRID);
      const nb: string[] = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < GRID && ny < GRID) nb.push(src[ny * GRID + nx]);
      }
      if (nb.includes(src[i])) continue;
      const tally = new Map<string, number>();
      for (const c of nb) tally.set(c, (tally.get(c) ?? 0) + 1);
      const [best, n] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
      if (n >= Math.min(3, nb.length) && deltaE2000(rgbToLab(...(cells[i] as [number, number, number])), lab.get(best)!) < maxDelta) out[i] = best;
    }
  }
  return out;
}

// ---------- flat graphics (logos, illustrations, screenshots) ----------
const key5 = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** True when a few flat colours cover most of the image — logos, posters, illustrations. */
export function isFlatGraphic(data: Uint8ClampedArray) {
  const m = new Map<number, number>();
  for (let i = 0; i < data.length; i += 16) { const k = key5(data[i], data[i + 1], data[i + 2]); m.set(k, (m.get(k) ?? 0) + 1); }
  const total = data.length / 16;
  const top = [...m.values()].sort((a, b) => b - a).slice(0, 10).reduce((n, v) => n + v, 0);
  return top / total > 0.8;
}

/**
 * Per-cell majority colour instead of averaging, so edges stay crisp and colours stay pure.
 * Thin strokes (text, outlines) win their cell when they cover ≥ 28% of it, so they don't vanish.
 */
export function sampleGraphic(data: Uint8ClampedArray, size: number): number[][] {
  const global = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) { const k = key5(data[i], data[i + 1], data[i + 2]); global.set(k, (global.get(k) ?? 0) + 1); }
  const bgKey = [...global.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const unkey = (k: number) => [((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4];
  const bgLab = rgbToLab(...(unkey(bgKey) as [number, number, number]));
  const step = size / GRID;
  const cells: number[][] = [];
  for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
    const x0 = Math.floor(gx * step), x1 = Math.floor((gx + 1) * step), y0 = Math.floor(gy * step), y1 = Math.floor((gy + 1) * step);
    const m = new Map<number, { n: number; r: number; g: number; b: number }>();
    let total = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * size + x) * 4, k = key5(data[i], data[i + 1], data[i + 2]);
      const e = m.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += data[i]; e.g += data[i + 1]; e.b += data[i + 2]; m.set(k, e); total++;
    }
    const ranked = [...m.entries()].sort((a, b) => b[1].n - a[1].n);
    let pick = ranked[0];
    // stroke emphasis: the most contrasting colour against the background takes the cell if it's substantial
    for (const cand of ranked.slice(1, 4)) {
      if (cand[1].n / total < 0.28) break;
      const cLab = rgbToLab(cand[1].r / cand[1].n, cand[1].g / cand[1].n, cand[1].b / cand[1].n);
      const pLab = rgbToLab(pick[1].r / pick[1].n, pick[1].g / pick[1].n, pick[1].b / pick[1].n);
      if (deltaE2000(cLab, bgLab) > deltaE2000(pLab, bgLab) + 10) { pick = cand; break; }
    }
    cells.push([pick[1].r / pick[1].n, pick[1].g / pick[1].n, pick[1].b / pick[1].n]);
  }
  return cells;
}

// ---------- styles ----------
export type StyleId = "colour" | "bold" | "mono" | "vintage";
export const STYLES: { id: StyleId; nameEn: string; nameAr: string; codes?: string[]; maxColors: number; minCount: number; saturation: number; contrast: number; mono?: boolean }[] = [
  { id: "colour", nameEn: "Colour", nameAr: "ملوّن", maxColors: 14, minCount: 8, saturation: 8, contrast: 6 },
  { id: "bold", nameEn: "Bold", nameAr: "جريء", maxColors: 8, minCount: 14, saturation: 12, contrast: 18 },
  { id: "mono", nameEn: "Black & white", nameAr: "أبيض وأسود", codes: ["01", "02", "03", "07", "08", "04", "05", "06"], maxColors: 8, minCount: 6, saturation: 0, contrast: 12, mono: true },
  { id: "vintage", nameEn: "Vintage", nameAr: "كلاسيكي", codes: ["01", "09", "10", "19", "11", "12", "20", "15", "17", "18", "05", "06"], maxColors: 9, minCount: 8, saturation: 0, contrast: 10, mono: true },
];

/**
 * The full photo → pattern pipeline used by the Custom studio.
 * `data` is a square RGBA crop (size×size) after the customer's own adjustments.
 */
export function photoToPattern(data: Uint8ClampedArray, size: number, palette: PaletteColor[], style: StyleId, dither: boolean, graphic: "auto" | boolean = "auto") {
  const st = STYLES.find((s) => s.id === style) ?? STYLES[0];
  const pal = st.codes ? palette.filter((p) => st.codes!.includes(p.code)) : palette;
  if (pal.length === 0) throw new Error("No colours available for this style");
  const flat = graphic === "auto" ? isFlatGraphic(data) : graphic;
  if (flat && !st.mono) {
    // logos and illustrations: crisp majority sampling, no tonal processing, no dithering
    const cells = sampleGraphic(data, size);
    const q = quantize(cells, pal, false);
    return { pattern: consolidate(q.pattern, pal, 4, 16), averageDeltaE: q.averageDeltaE, flat: true };
  }
  const work = new Uint8ClampedArray(data);
  autoLevels(work, 0.5);
  if (st.mono) {
    // luminance only, then map by lightness so the tones read as a clean grey/sepia scale
    for (let i = 0; i < work.length; i += 4) { const l = 0.2126 * work[i] + 0.7152 * work[i + 1] + 0.0722 * work[i + 2]; work[i] = work[i + 1] = work[i + 2] = l; }
  }
  adjustPixels(work, { brightness: 0, contrast: st.contrast, saturation: st.saturation, dither: false });
  let cells = sharpenCells(downsample(work, size), 0.55);
  if (st.mono) {
    // tone-map onto the style palette by lightness rank, not hue
    const sorted = [...pal].sort((a, b) => rgbToLab(...hexToRgb(a.hex))[0] - rgbToLab(...hexToRgb(b.hex))[0]);
    const Ls = sorted.map((p) => rgbToLab(...hexToRgb(p.hex))[0]);
    const pattern = cells.map(([r]) => {
      const L = rgbToLab(r, r, r)[0];
      let best = 0; for (let k = 1; k < Ls.length; k++) if (Math.abs(Ls[k] - L) < Math.abs(Ls[best] - L)) best = k;
      return sorted[best].code;
    });
    return { pattern: consolidate(pattern, pal, st.minCount, st.maxColors), averageDeltaE: 0, flat };
  }
  const q = quantize(cells, pal, false);
  const cleaned = despeckle(q.pattern, cells, pal);
  return { pattern: consolidate(cleaned, pal, st.minCount, st.maxColors), averageDeltaE: q.averageDeltaE, flat };
}

// =====================================================================================
// Engine v3 — subject-aware rendering for 32×32
// =====================================================================================

/** Box blur of the luminance channel (separable, radius r) — used for local contrast. */
function blurLum(L: Float32Array, size: number, r: number) {
  const tmp = new Float32Array(L.length), out = new Float32Array(L.length);
  for (let y = 0; y < size; y++) {
    let acc = 0; const row = y * size;
    for (let x = -r; x <= r; x++) acc += L[row + Math.min(size - 1, Math.max(0, x))];
    for (let x = 0; x < size; x++) {
      tmp[row + x] = acc / (2 * r + 1);
      acc += L[row + Math.min(size - 1, x + r + 1)] - L[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < size; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(size - 1, Math.max(0, y)) * size + x];
    for (let y = 0; y < size; y++) {
      out[y * size + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(size - 1, y + r + 1) * size + x] - tmp[Math.max(0, y - r) * size + x];
    }
  }
  return out;
}

/** "Clarity": boosts mid-scale contrast so features (eyes, folds, edges) survive downsampling. */
export function clarity(data: Uint8ClampedArray, size: number, amount = 0.4, weight?: Float32Array) {
  const L = new Float32Array(size * size);
  for (let p = 0; p < L.length; p++) L[p] = 0.2126 * data[p * 4] + 0.7152 * data[p * 4 + 1] + 0.0722 * data[p * 4 + 2];
  const B = blurLum(L, size, Math.round(size / 14));
  for (let p = 0; p < L.length; p++) {
    const w = weight ? weight[p] : 1;
    const delta = (L[p] - B[p]) * amount * w;
    for (let c = 0; c < 3; c++) data[p * 4 + c] = clamp(data[p * 4 + c] + delta);
  }
}

/** Auto levels measured on the subject only (so a plain background doesn't skew it). */
function levelsOn(data: Uint8ClampedArray, weight: Float32Array | null, strength: number) {
  const hist = new Float64Array(256); let n = 0;
  for (let p = 0, i = 0; i < data.length; i += 4, p++) {
    const w = weight ? (weight[p] > 0.5 ? 1 : 0) : 1; if (!w) continue;
    hist[Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++; n++;
  }
  if (n < 50) return;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += hist[lo]; if (acc > n * 0.01) break; }
  acc = 0;
  for (; hi > 0; hi--) { acc += hist[hi]; if (acc > n * 0.01) break; }
  if (hi - lo < 30) return;
  const scale = 1 + (255 / (hi - lo) - 1) * strength, off = lo * strength;
  for (let p = 0, i = 0; i < data.length; i += 4, p++) {
    if (weight && weight[p] < 0.05) continue;
    for (let c = 0; c < 3; c++) data[i + c] = clamp((data[i + c] - off) * scale);
  }
}

/**
 * Feature-preserving downsample. Each cell is split into its two dominant tones (2-means in Lab).
 * Flat cells take their average; cells containing an edge take the tone that stands out from the
 * surrounding cells if it covers enough of the cell — this is what keeps eyes, outlines and handles.
 */
export function downsampleFeatures(data: Uint8ClampedArray, size: number): number[][] {
  const base = downsample(data, size);
  const baseLab = base.map((c) => rgbToLab(c[0], c[1], c[2]));
  const step = size / GRID;
  const out: number[][] = [];
  for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
    const idx = gy * GRID + gx;
    const x0 = Math.floor(gx * step), x1 = Math.floor((gx + 1) * step), y0 = Math.floor(gy * step), y1 = Math.floor((gy + 1) * step);
    const px: { lab: [number, number, number]; rgb: number[] }[] = [];
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * size + x) * 4;
      px.push({ lab: rgbToLab(data[i], data[i + 1], data[i + 2]), rgb: [data[i], data[i + 1], data[i + 2]] });
    }
    // 2-means seeded with the darkest and lightest pixels
    let a = px.reduce((m, p) => (p.lab[0] < m.lab[0] ? p : m)).lab, b = px.reduce((m, p) => (p.lab[0] > m.lab[0] ? p : m)).lab;
    let assign: boolean[] = [];
    for (let it = 0; it < 4; it++) {
      assign = px.map((p) => (p.lab[0] - a[0]) ** 2 + (p.lab[1] - a[1]) ** 2 + (p.lab[2] - a[2]) ** 2 <= (p.lab[0] - b[0]) ** 2 + (p.lab[1] - b[1]) ** 2 + (p.lab[2] - b[2]) ** 2);
      const mean = (sel: boolean) => { const s = px.filter((_, k) => assign[k] === sel); if (!s.length) return null; return [0, 1, 2].map((c) => s.reduce((t, p) => t + p.lab[c], 0) / s.length) as [number, number, number]; };
      a = mean(true) ?? a; b = mean(false) ?? b;
    }
    const nA = assign.filter(Boolean).length, nB = px.length - nA;
    if (deltaE2000(a, b) < 14 || !nA || !nB) { out.push(base[idx]); continue; }
    // context = the 8 neighbouring cells
    const ctx: number[] = [0, 0, 0]; let cn = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
      const l = baseLab[ny * GRID + nx]; ctx[0] += l[0]; ctx[1] += l[1]; ctx[2] += l[2]; cn++;
    }
    const c3 = [ctx[0] / cn, ctx[1] / cn, ctx[2] / cn] as [number, number, number];
    const featureIsA = deltaE2000(a, c3) > deltaE2000(b, c3);
    const fCov = (featureIsA ? nA : nB) / px.length;
    const useA = fCov >= 0.22 ? featureIsA : nA >= nB;
    const sel = px.filter((_, k) => assign[k] === useA);
    out.push([0, 1, 2].map((c) => sel.reduce((t, p) => t + p.rgb[c], 0) / sel.length));
  }
  return out;
}

/** Fraction of each cell covered by the subject. */
export function maskCoverage(mask: Float32Array, size: number) {
  const step = size / GRID, cov = new Float32Array(CELLS);
  for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
    let s = 0, n = 0;
    for (let y = Math.floor(gy * step); y < Math.floor((gy + 1) * step); y++) for (let x = Math.floor(gx * step); x < Math.floor((gx + 1) * step); x++) { s += mask[y * size + x]; n++; }
    cov[gy * GRID + gx] = s / n;
  }
  return cov;
}

/** Subject bounding box (in mask pixels) for auto-framing; null when nothing was found. */
export function subjectBox(mask: Float32Array, size: number) {
  let x0 = size, y0 = size, x1 = -1, y1 = -1;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mask[y * size + x] > 0.5) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export type RenderOptions = {
  style: StyleId;
  dither?: boolean;
  /** subject probability per pixel (size×size), from background removal */
  mask?: Float32Array | null;
  /** palette code for the plain background when a mask is used */
  bgCode?: string | null;
  /** draw a one-piece contour around the subject */
  outline?: boolean;
};

/** Engine v3: the full photo → pattern pipeline used by the Custom studio. */
export function renderMosaic(data: Uint8ClampedArray, size: number, palette: PaletteColor[], o: RenderOptions) {
  const st = STYLES.find((s) => s.id === o.style) ?? STYLES[0];
  const pal = st.codes ? palette.filter((p) => st.codes!.includes(p.code)) : palette;
  if (pal.length === 0) throw new Error("No colours available for this style");
  const byCode = new Map(palette.map((p) => [p.code, p]));
  const mask = o.mask && o.bgCode && byCode.get(o.bgCode) ? o.mask : null;
  const work = new Uint8ClampedArray(data);
  const flat = !mask && isFlatGraphic(work);

  if (flat && !st.mono) {
    const q = quantize(sampleGraphic(work, size), pal, false);
    return { pattern: consolidate(q.pattern, pal, 4, 16), averageDeltaE: q.averageDeltaE, flat: true };
  }

  // the background colour as it will appear in this style's palette
  let bgCode: string | null = null;
  if (mask) {
    const bgHex = byCode.get(o.bgCode!)!.hex;
    bgCode = pal.some((p) => p.code === o.bgCode) ? o.bgCode! : buildLabPalette(pal)[nearest(buildLabPalette(pal), ...hexToRgb(bgHex)).idx].code;
    const bg = hexToRgb(bgHex);
    for (let p = 0; p < mask.length; p++) {
      const a = Math.min(1, Math.max(0, (mask[p] - 0.3) / 0.4));
      for (let c = 0; c < 3; c++) work[p * 4 + c] = work[p * 4 + c] * a + bg[c] * (1 - a);
    }
  }

  levelsOn(work, mask, 0.6);
  if (st.mono) for (let i = 0; i < work.length; i += 4) { const l = 0.2126 * work[i] + 0.7152 * work[i + 1] + 0.0722 * work[i + 2]; work[i] = work[i + 1] = work[i + 2] = l; }
  adjustPixels(work, { brightness: 0, contrast: st.contrast, saturation: st.saturation, dither: false });
  clarity(work, size, 0.45, mask ?? undefined);
  const cells = downsampleFeatures(work, size);

  let pattern: Pattern;
  let avg = 0;
  if (st.mono) {
    // tonal styles: spread the subject's tones across every available shade (equalised), so an
    // 8-tone palette shows as much of the face/object as possible
    const sorted = [...pal].sort((a, b) => rgbToLab(...hexToRgb(a.hex))[0] - rgbToLab(...hexToRgb(b.hex))[0]);
    const Ls = cells.map(([r]) => rgbToLab(r, r, r)[0]);
    const cov = mask ? maskCoverage(mask, size) : null;
    const ref = Ls.filter((_, i) => !cov || cov[i] >= 0.42).sort((a, b) => a - b);
    const rank = (L: number) => { let lo = 0, hi = ref.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ref[m] < L) lo = m + 1; else hi = m; } return lo / Math.max(1, ref.length); };
    const palL = sorted.map((p) => rgbToLab(...hexToRgb(p.hex))[0]);
    pattern = Ls.map((L) => {
      // blend equalised position with true lightness so pure whites/blacks stay put
      const target = 0.55 * (palL[0] + rank(L) * (palL[palL.length - 1] - palL[0])) + 0.45 * L;
      let best = 0; for (let k = 1; k < palL.length; k++) if (Math.abs(palL[k] - target) < Math.abs(palL[best] - target)) best = k;
      return sorted[best].code;
    });
  } else {
    const q = quantize(cells, pal, false);
    pattern = q.pattern; avg = q.averageDeltaE;
  }

  if (mask && bgCode) {
    const cov = maskCoverage(mask, size);
    const subject = (i: number) => cov[i] >= 0.42;
    for (let i = 0; i < CELLS; i++) if (!subject(i)) pattern[i] = bgCode;
    if (o.outline) {
      // contrasting contour: dark on light backgrounds, light on dark ones
      const bgL = rgbToLab(...hexToRgb(byCode.get(bgCode)!.hex))[0];
      const ranked = [...pal].sort((a, b) => rgbToLab(...hexToRgb(a.hex))[0] - rgbToLab(...hexToRgb(b.hex))[0]);
      const line = bgL > 50 ? ranked[0].code : ranked[ranked.length - 1].code;
      const src = [...pattern];
      for (let i = 0; i < CELLS; i++) {
        if (subject(i)) continue;
        const x = i % GRID, y = Math.floor(i / GRID);
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const nx = x + dx, ny = y + dy; return nx >= 0 && ny >= 0 && nx < GRID && ny < GRID && subject(ny * GRID + nx); })) pattern[i] = line;
      }
      void src;
    }
  }
  const cleaned = st.mono ? pattern : despeckle(pattern, cells, pal);
  return { pattern: consolidate(cleaned, pal, st.minCount, st.maxColors), averageDeltaE: avg, flat: false };
}

/** Did background removal find a usable subject? (Close-ups and busy scenes often fail.) */
export function maskLooksUsable(mask: Float32Array) {
  let fg = 0, unsure = 0;
  for (let i = 0; i < mask.length; i++) { if (mask[i] > 0.5) fg++; if (mask[i] > 0.2 && mask[i] < 0.8) unsure++; }
  const f = fg / mask.length;
  return f > 0.06 && f < 0.9 && unsure / mask.length < 0.25;
}

// =====================================================================================
// Engine v4 — per-photo colour optimisation, importance weighting, background softening
// =====================================================================================

/**
 * Choose the best set of at most `maxColors` pieces for this picture.
 * Start from every colour any cell would pick, then repeatedly drop the colour whose removal
 * costs the least total (importance-weighted) error. Far better than merging the rarest colours.
 *
 * Feature cells (calligraphy, fine lettering, eyes, contours) receive priority on lightness separation
 * and are protected from Potts spatial smoothing coercion.
 */
export function optimizePalette(
  cells: number[][],
  palette: PaletteColor[],
  weights: Float32Array,
  maxColors: number,
  locked: string[] = [],
  smooth = 0,
  features?: Uint8Array
) {
  const lp = buildLabPalette(palette);
  const n = cells.length, k = lp.length;
  const D = new Float32Array(n * k);
  for (let i = 0; i < n; i++) {
    const lab = rgbToLab(cells[i][0], cells[i][1], cells[i][2]);
    const c0 = Math.hypot(lab[1], lab[2]);
    const isFeat = features && features[i];
    for (let j = 0; j < k; j++) {
      const ci = Math.hypot(lp[j].lab[1], lp[j].lab[2]);
      // vivid colours must stay vivid (a crimson must not become a brownish red), and vice versa
      let dist = deltaE2000(lab, lp[j].lab) + Math.max(0, ci - c0 - 18) * 0.3 + Math.max(0, c0 - ci - 12) * 0.5;
      if (isFeat) {
        // Lightness priority for high-contrast features (prevents white strokes matching muted putty/creams)
        const dL = Math.abs(lab[0] - lp[j].lab[0]);
        dist += 1.2 * dL;
      }
      D[i * k + j] = dist;
    }
  }
  const active = new Set<number>();
  for (let i = 0; i < n; i++) { let b = 0; for (let j = 1; j < k; j++) if (D[i * k + j] < D[i * k + b]) b = j; active.add(b); }
  const lockedIdx = new Set(lp.map((p, j) => (locked.includes(p.code) ? j : -1)).filter((j) => j >= 0));

  // Protect high-contrast features (like white lettering L > 75 or deep ink L < 20)
  if (features) {
    for (let i = 0; i < n; i++) {
      if (features[i]) {
        const lab = rgbToLab(cells[i][0], cells[i][1], cells[i][2]);
        if (lab[0] > 75 || lab[0] < 20) {
          let b = 0;
          for (let j = 1; j < k; j++) if (D[i * k + j] < D[i * k + b]) b = j;
          lockedIdx.add(b);
        }
      }
    }
  }

  lockedIdx.forEach((j) => active.add(j));
  // track best and second-best active colour per cell; removal cost of c = Σ(second − best) over its cells
  const best = new Int32Array(n), second = new Int32Array(n);
  const rank = (i: number) => {
    let b = -1, s2 = -1;
    for (const j of active) { const d = D[i * k + j]; if (b < 0 || d < D[i * k + b]) { s2 = b; b = j; } else if (s2 < 0 || d < D[i * k + s2]) s2 = j; }
    best[i] = b; second[i] = s2 < 0 ? b : s2;
  };
  for (let i = 0; i < n; i++) rank(i);
  while (active.size > Math.max(maxColors, lockedIdx.size)) {
    const cost = new Map<number, number>();
    for (const c of active) if (!lockedIdx.has(c)) cost.set(c, 0);
    for (let i = 0; i < n; i++) if (cost.has(best[i])) cost.set(best[i], cost.get(best[i])! + (D[i * k + second[i]] - D[i * k + best[i]]) * weights[i]);
    let victim = -1, bestCost = Infinity;
    for (const [c, v] of cost) if (v < bestCost) { bestCost = v; victim = c; }
    if (victim < 0) break;
    active.delete(victim);
    for (let i = 0; i < n; i++) if (best[i] === victim || second[i] === victim) rank(i);
  }
  const assign = best;
  // Spatial coherence (Potts model, iterated conditional modes): a cell may switch to a neighbour's
  // colour when the colour error it adds is smaller than the "speckle" penalty it removes.
  // CRITICAL: Feature cells (calligraphy, fine lettering, eyes, contours) are skipped so they are NEVER coerced into the background!
  if (smooth > 0 && n === CELLS) {
    const act = [...active];
    for (let it = 0; it < 4; it++) {
      let changed = 0;
      for (let i = 0; i < n; i++) {
        if (features && features[i]) continue;
        const x = i % GRID, y = Math.floor(i / GRID);
        const nb: number[] = [];
        if (x > 0) nb.push(assign[i - 1]); if (x < GRID - 1) nb.push(assign[i + 1]);
        if (y > 0) nb.push(assign[i - GRID]); if (y < GRID - 1) nb.push(assign[i + GRID]);
        const lam = smooth / Math.max(0.5, weights[i]);
        let bestJ = assign[i], bestC = Infinity;
        for (const j of act) {
          let diff = 0; for (const q of nb) if (q !== j) diff++;
          const c = D[i * k + j] + lam * diff;
          if (c < bestC) { bestC = c; bestJ = j; }
        }
        if (bestJ !== assign[i]) { assign[i] = bestJ; changed++; }
      }
      if (!changed) break;
    }
  }
  let err = 0; for (let i = 0; i < n; i++) err += D[i * k + assign[i]];
  return { pattern: Array.from(assign, (j) => lp[j].code), averageDeltaE: err / n };
}

/** Heavy blur + slight desaturation of the background only: keeps the scene's colours, drops its noise. */
export function softenBackground(data: Uint8ClampedArray, size: number, mask: Float32Array) {
  const r = Math.round(size / 16);
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(size * size);
    for (let p = 0; p < ch.length; p++) ch[p] = data[p * 4 + c];
    const b = blurLum(ch, size, r);
    for (let p = 0; p < ch.length; p++) {
      const a = Math.min(1, Math.max(0, (mask[p] - 0.25) / 0.5)); // 1 = subject
      data[p * 4 + c] = clamp(ch[p] * a + b[p] * (1 - a));
    }
  }
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] > 0.5) continue;
    const i = p * 4, l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    for (let c = 0; c < 3; c++) data[i + c] = clamp(l + (data[i + c] - l) * 0.7);
  }
}

/** Map grey cells onto a tonal palette, equalised over the important cells. */
export function toneMap(cells: number[][], pal: PaletteColor[], weightCells?: Float32Array | null) {
  const sorted = [...pal].sort((a, b) => rgbToLab(...hexToRgb(a.hex))[0] - rgbToLab(...hexToRgb(b.hex))[0]);
  const Ls = cells.map(([r, g, b]) => rgbToLab(r, g, b)[0]);
  const ref = Ls.filter((_, i) => !weightCells || weightCells[i] >= 0.6).sort((a, b) => a - b);
  const rank = (L: number) => { let lo = 0, hi = ref.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ref[m] < L) lo = m + 1; else hi = m; } return lo / Math.max(1, ref.length); };
  const palL = sorted.map((p) => rgbToLab(...hexToRgb(p.hex))[0]);
  return Ls.map((L) => {
    const target = 0.55 * (palL[0] + rank(L) * (palL[palL.length - 1] - palL[0])) + 0.45 * L;
    let b = 0; for (let k = 1; k < palL.length; k++) if (Math.abs(palL[k] - target) < Math.abs(palL[b] - target)) b = k;
    return sorted[b].code;
  });
}

/**
 * Metal and shadows pick up a cool cast from the light around them. Low-chroma cool tones are
 * pulled toward neutral so silver reads as silver, not as blue speckle. Skin and true blues are untouched.
 */
export function neutraliseCoolCasts(cells: number[][]): number[][] {
  return cells.map(([r, g, b]) => {
    const [L, A, B] = rgbToLab(r, g, b);
    const C = Math.hypot(A, B);
    let h = (Math.atan2(B, A) * 180) / Math.PI; if (h < 0) h += 360;
    if (C > 34 || h < 185 || h > 300) return [r, g, b];
    const k = C < 22 ? 0.35 : 0.35 + ((C - 22) / 12) * 0.65; // fade out toward real blues
    return labToRgb(L, A * k, B * k);
  });
}

/**
 * Convert CIELAB to standard sRGB (0..255).
 * Follows exact standard CIE D65 observer reference white point (Xn=0.95047, Yn=1.00000, Zn=1.08883)
 * and inverse IEC 61966-2-1 transformation matrix.
 */
export function labToRgb(L: number, A: number, B: number): number[] {
  const fy = (L + 16) / 116;
  const fx = fy + A / 500;
  const fz = fy - B / 200;

  const xr = Math.pow(fx, 3) > CIE_EPSILON ? Math.pow(fx, 3) : (116 * fx - 16) / CIE_KAPPA;
  const yr = L > CIE_KAPPA * CIE_EPSILON ? Math.pow((L + 16) / 116, 3) : L / CIE_KAPPA;
  const zr = Math.pow(fz, 3) > CIE_EPSILON ? Math.pow(fz, 3) : (116 * fz - 16) / CIE_KAPPA;

  // Denormalize by standard D65 reference white
  const X = xr * D65_Xn;
  const Y = yr * D65_Yn;
  const Z = zr * D65_Zn;

  // Standard IEC 61966-2-1 inverse matrix (CIE XYZ to Linear sRGB)
  const rLin = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const gLin = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  const bLin = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;

  // Linear to standard non-linear sRGB (gamma)
  const toSrgb = (c: number) => {
    const v = Math.max(0, Math.min(1, c));
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(s * 255)));
  };

  return [toSrgb(rLin), toSrgb(gLin), toSrgb(bLin)];
}

export type FocusBox = { x0: number; y0: number; x1: number; y1: number }; // in work pixels

export type RenderOptionsV4 = RenderOptions & {
  /** "keep" | "soft" | "plain" — what to do with the background when a mask exists */
  bgMode?: "keep" | "soft" | "plain";
  /** a detected face, gets the most colour budget and extra clarity */
  face?: FocusBox | null;
  /** speckle penalty for the Potts smoothing (0 = off) */
  smooth?: number;
};

/** Engine v4: everything in v3 plus colour optimisation, importance map and background softening. */
export function renderMosaicV4(data: Uint8ClampedArray, size: number, palette: PaletteColor[], o: RenderOptionsV4) {
  const st = STYLES.find((s) => s.id === o.style) ?? STYLES[0];
  const pal = st.codes ? palette.filter((p) => st.codes!.includes(p.code)) : palette;
  if (pal.length === 0) throw new Error("No colours available for this style");
  const byCode = new Map(palette.map((p) => [p.code, p]));
  const usable = !!o.mask && maskLooksUsable(o.mask);
  const mode = usable ? (o.bgMode ?? (o.bgCode ? "plain" : "keep")) : "keep";
  const mask = mode !== "keep" ? o.mask! : null;
  const plain = mode === "plain" && o.bgCode && byCode.get(o.bgCode) ? o.bgCode : null;
  const work = new Uint8ClampedArray(data);

  if (!usable && isFlatGraphic(work) && !st.mono) {
    const q = quantize(sampleGraphic(work, size), pal, false);
    return { pattern: consolidate(q.pattern, pal, 4, 16), averageDeltaE: q.averageDeltaE, flat: true };
  }

  let bgCode: string | null = null;
  if (plain && mask) {
    const bgHex = byCode.get(plain)!.hex;
    bgCode = pal.some((p) => p.code === plain) ? plain : buildLabPalette(pal)[nearest(buildLabPalette(pal), ...hexToRgb(bgHex)).idx].code;
    const bg = hexToRgb(bgHex);
    for (let p = 0; p < mask.length; p++) {
      const a = Math.min(1, Math.max(0, (mask[p] - 0.3) / 0.4));
      for (let c = 0; c < 3; c++) work[p * 4 + c] = work[p * 4 + c] * a + bg[c] * (1 - a);
    }
  } else if (mode === "soft" && mask) {
    softenBackground(work, size, mask);
  }

  // importance per pixel: subject > background, face > everything
  const imp = new Float32Array(size * size).fill(1);
  if (usable) for (let p = 0; p < imp.length; p++) imp[p] = 0.35 + 0.65 * o.mask![p];
  if (o.face) {
    const f = o.face, pad = (f.x1 - f.x0) * 0.25;
    for (let y = Math.max(0, Math.floor(f.y0 - pad)); y < Math.min(size, f.y1 + pad); y++)
      for (let x = Math.max(0, Math.floor(f.x0 - pad)); x < Math.min(size, f.x1 + pad); x++) imp[y * size + x] = 2.5;
  }

  levelsOn(work, usable ? o.mask! : null, 0.6);
  if (st.mono) for (let i = 0; i < work.length; i += 4) { const l = 0.2126 * work[i] + 0.7152 * work[i + 1] + 0.0722 * work[i + 2]; work[i] = work[i + 1] = work[i + 2] = l; }
  adjustPixels(work, { brightness: 0, contrast: st.contrast, saturation: st.saturation, dither: false });
  // clarity follows importance: strongest on the face, gentle on the background
  const clarW = new Float32Array(imp.length);
  for (let p = 0; p < imp.length; p++) clarW[p] = Math.min(1.6, imp[p] * 0.7);
  clarity(work, size, 0.45, clarW);
  const cells = st.mono ? downsampleFeatures(work, size) : neutraliseCoolCasts(downsampleFeatures(work, size));
  // per-cell importance
  const cellW = new Float32Array(CELLS);
  { const step = size / GRID;
    for (let i = 0; i < CELLS; i++) { const gx = i % GRID, gy = Math.floor(i / GRID); let s = 0, n = 0;
      for (let y = Math.floor(gy * step); y < Math.floor((gy + 1) * step); y += 2) for (let x = Math.floor(gx * step); x < Math.floor((gx + 1) * step); x += 2) { s += imp[y * size + x]; n++; }
      cellW[i] = s / n; } }

  let pattern: Pattern, avg = 0;
  if (st.mono) {
    pattern = toneMap(cells, pal, cellW.map((w) => Math.min(1, w)));
  } else {
    const q = optimizePalette(cells, pal, cellW, st.maxColors, bgCode ? [bgCode] : [], o.smooth ?? 8);
    pattern = q.pattern; avg = q.averageDeltaE;
  }

  if (plain && mask && bgCode) {
    const cov = maskCoverage(mask, size);
    const subject = (i: number) => cov[i] >= 0.42;
    for (let i = 0; i < CELLS; i++) if (!subject(i)) pattern[i] = bgCode;
    if (o.outline) {
      const bgL = rgbToLab(...hexToRgb(byCode.get(bgCode)!.hex))[0];
      const ranked = [...pal].sort((a, b) => rgbToLab(...hexToRgb(a.hex))[0] - rgbToLab(...hexToRgb(b.hex))[0]);
      const line = bgL > 50 ? ranked[0].code : ranked[ranked.length - 1].code;
      const src = [...pattern];
      for (let i = 0; i < CELLS; i++) {
        if (subject(i)) continue;
        const x = i % GRID, y = Math.floor(i / GRID);
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const nx = x + dx, ny = y + dy; return nx >= 0 && ny >= 0 && nx < GRID && ny < GRID && subject(ny * GRID + nx); })) pattern[i] = line;
      }
      void src;
    }
  }
  const cleaned = st.mono ? pattern : despeckle(pattern, cells, pal, 18);
  return { pattern: consolidate(cleaned, pal, 3, st.maxColors + 2), averageDeltaE: avg, flat: false };
}
