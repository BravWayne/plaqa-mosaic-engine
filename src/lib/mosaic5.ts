/**
 * PLAQA engine v5 — "Auto".
 *
 * Reads the picture first, then draws it the way a pixel artist would:
 *  1. classify: graphic · portrait · subject (object / pet) · scene
 *  2. per-type framing of importance (face and eyes > subject > background)
 *  3. edge-preserving smoothing (bilateral, in Lab) — removes texture, keeps shapes
 *  4. cell sampling by 2-means per cell — every piece takes ONE side of an edge, no muddy blends;
 *     dark minorities (eyes, brows, outlines) win where they matter
 *  5. tone: subject levels, local contrast, gentle saturation; metal remapped to a silver ramp; eyes always drawn
 *  6. palette chosen per picture from the 52 factory colours, then Potts smoothing
 *  7. automatic plain background that contrasts the subject + optional contour
 *  8. island removal: lone pieces merge into their region unless they are a feature
 */
import {
  CELLS, GRID, type PaletteColor, type Pattern, type StyleId, type FocusBox, STYLES,
  hexToRgb, rgbToLab, labToRgb, deltaE2000, optimizePalette, toneMap, maskLooksUsable, maskCoverage,
  consolidate, buildLabPalette, unsharpMaskLinear, dynamicContrastStretch, adaptiveCellSampling, linearToSrgb,
} from "./mosaic";

export type Kind = "graphic" | "portrait" | "subject" | "scene";
export const KIND_LABEL: Record<Kind, { en: string; ar: string }> = {
  graphic: { en: "Graphic / logo", ar: "تصميم / شعار" },
  portrait: { en: "Portrait", ar: "صورة شخصية" },
  subject: { en: "Object / pet", ar: "غرض / حيوان" },
  scene: { en: "Scene", ar: "منظر" },
};

export type RenderOptionsV5 = {
  style: StyleId;
  mask?: Float32Array | null;
  face?: FocusBox | null;
  /** "auto" (engine decides) | "keep" | "soft" | "plain" */
  bgMode?: "auto" | "keep" | "soft" | "plain";
  bgCode?: string | null;
  /** undefined = engine decides */
  outline?: boolean;
  /** force a kind instead of detecting it */
  kind?: Kind;
};

export type ResultV5 = { pattern: Pattern; averageDeltaE: number; flat: boolean; kind: Kind; bgCode: string | null; outline?: boolean };

const clamp = (v: number, lo = 0, hi = 255) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------- colour helpers (fast Lab)
const CIE_EPSILON = 216 / 24389; // ≈ 0.00885645
const CIE_KAPPA = 24389 / 27;    // ≈ 903.296
const LIN = new Float32Array(256).map((_, i) => { const c = i / 255.0; return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92; });
const fLab = (t: number) => (t > CIE_EPSILON ? Math.cbrt(t) : (CIE_KAPPA * t + 16) / 116);

/** Convert linear or gamma sRGB buffer to CIELAB using exact standard D65 observer white point. */
function toLab(data: Uint8ClampedArray, n: number) {
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const r = LIN[data[p * 4]], g = LIN[data[p * 4 + 1]], b = LIN[data[p * 4 + 2]];
    const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    const Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    const x = fLab(X / 0.95047), y = fLab(Y / 1.00000), z = fLab(Z / 1.08883);
    L[p] = 116 * y - 16; A[p] = 500 * (x - y); B[p] = 200 * (y - z);
  }
  return { L, A, B };
}
type LabImg = ReturnType<typeof toLab>;

function boxBlur(src: Float32Array, size: number, r: number) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const pass = (a: Float32Array, b: Float32Array, horiz: boolean) => {
    for (let o = 0; o < size; o++) {
      let acc = 0, cnt = 0;
      const at = (i: number) => (horiz ? a[o * size + i] : a[i * size + o]);
      for (let i = -r; i <= r; i++) if (i >= 0 && i < size) { acc += at(i); cnt++; }
      for (let i = 0; i < size; i++) {
        (horiz ? (b[o * size + i] = acc / cnt) : (b[i * size + o] = acc / cnt));
        const add = i + r + 1, sub = i - r;
        if (add < size) { acc += at(add); cnt++; }
        if (sub >= 0) { acc -= at(sub); cnt--; }
      }
    }
  };
  pass(src, tmp, true); pass(tmp, out, false);
  return out;
}
const blur = (s: Float32Array, size: number, r: number) => boxBlur(boxBlur(s, size, r), size, r);

/** Bilateral filter in Lab: flattens texture (skin pores, fabric, bokeh) while keeping edges. */
function bilateral(img: LabImg, size: number, r: number, sigmaC: number, iters: number) {
  let { L, A, B } = img;
  const sp: number[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) sp.push(Math.exp(-(dx * dx + dy * dy) / (2 * (r * 0.6) ** 2)));
  const inv = 1 / (2 * sigmaC * sigmaC);
  const LUT = new Float32Array(4096).map((_, i) => Math.exp(-i * 0.25 * inv)); // index = d² · 4
  for (let it = 0; it < iters; it++) {
    const L2 = new Float32Array(L.length), A2 = new Float32Array(L.length), B2 = new Float32Array(L.length);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const p = y * size + x, l0 = L[p], a0 = A[p], b0 = B[p];
      let wl = 0, sl = 0, sa = 0, sb = 0, k = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        for (let dx = -r; dx <= r; dx++, k++) {
          const xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= size || xx >= size) continue;
          const q = yy * size + xx, dl = L[q] - l0, da = A[q] - a0, db = B[q] - b0;
          const d2 = (dl * dl + da * da + db * db) * 4; const w = d2 >= 4096 ? 0 : sp[k] * LUT[d2 | 0];
          wl += w; sl += w * L[q]; sa += w * A[q]; sb += w * B[q];
        }
      }
      L2[p] = sl / wl; A2[p] = sa / wl; B2[p] = sb / wl;
    }
    L = L2; A = A2; B = B2;
  }
  return { L, A, B };
}

// ---------------------------------------------------------------- graphics (logos, typography, flat illustration)
/** colour distance for mapping onto factory pieces: CIEDE2000, but vivid colours must stay vivid */
function pieceDistance(src: number[], pal: number[]) {
  const cs = Math.hypot(src[1], src[2]), cp = Math.hypot(pal[1], pal[2]);
  let hue = 0;
  if (cs > 12 && cp > 12) { let dh = Math.abs(Math.atan2(src[2], src[1]) - Math.atan2(pal[2], pal[1])) * 180 / Math.PI; if (dh > 180) dh = 360 - dh; hue = dh * 0.4 * Math.min(1, Math.max(0.15, (Math.min(src[0], pal[0]) - 5) / 35)); } // hue matters less in the darks
  return deltaE2000(src as [number, number, number], pal as [number, number, number]) + Math.max(0, cs - cp - 10) * 0.6 + Math.max(0, cp - cs - 25) * 0.3 + hue;
}

/** Flat artwork: a few solid colours cover almost every pixel and there is little texture. */
export function looksGraphic(data: Uint8ClampedArray, size: number) {
  const lab = toLab(data, size * size);
  const samples: number[][] = [];
  for (let p = 0; p < size * size; p += 7) samples.push([lab.L[p], lab.A[p], lab.B[p]]);
  const cs = kmeansLab(samples, 6);
  let near = 0;
  for (const q of samples) { let d = Infinity; for (const c of cs) d = Math.min(d, Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2])); if (d < 9) near++; }
  // texture: share of neighbouring pixels that differ a little but not a lot (gradients, grain, skin)
  let soft = 0, n = 0;
  for (let y = 0; y < size; y += 2) for (let x = 0; x < size - 1; x += 2) { const p = y * size + x; const d = Math.abs(lab.L[p] - lab.L[p + 1]) + Math.abs(lab.A[p] - lab.A[p + 1]) + Math.abs(lab.B[p] - lab.B[p + 1]); if (d > 2.5 && d < 14) soft++; n++; }
  return near / samples.length > 0.86 && soft / n < 0.12;
}

export function renderGraphic(data: Uint8ClampedArray, size: number, pal: PaletteColor[]): { pattern: Pattern; averageDeltaE: number } {
  const N = size * size, lab = toLab(data, N);
  const samples: number[][] = [];
  for (let p = 0; p < N; p += 3) samples.push([lab.L[p], lab.A[p], lab.B[p]]);
  let cs = kmeansLab(samples, 10);
  // count, drop anti-aliasing blends (tiny clusters), merge near-duplicates
  const label = new Int16Array(N);
  const assign = () => { const cnt = new Array(cs.length).fill(0); for (let p = 0; p < N; p++) { let b = 0, bd = Infinity; for (let j = 0; j < cs.length; j++) { const c = cs[j], d = (lab.L[p] - c[0]) ** 2 + (lab.A[p] - c[1]) ** 2 + (lab.B[p] - c[2]) ** 2; if (d < bd) { bd = d; b = j; } } label[p] = b; cnt[b]++; } return cnt; };
  let cnt = assign();
  for (let pass = 0; pass < 3; pass++) {
    const keep = cs.map((c, j) => cnt[j] / N >= 0.006);
    for (let j = 0; j < cs.length; j++) for (let k = 0; k < j; k++) if (keep[j] && keep[k] && Math.hypot(cs[j][0] - cs[k][0], cs[j][1] - cs[k][1], cs[j][2] - cs[k][2]) < 7) { if (cnt[j] < cnt[k]) keep[j] = false; else keep[k] = false; }
    cs = cs.filter((_, j) => keep[j]); cnt = assign();
  }
  // background = the most common cluster
  const bg = cnt.indexOf(Math.max(...cnt));
  const step = size / GRID;
  const cellLabel = new Int16Array(CELLS);
  for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
    const votes = new Array(cs.length).fill(0); let tot = 0;
    for (let y = Math.floor(gy * step); y < Math.floor((gy + 1) * step); y++) for (let x = Math.floor(gx * step); x < Math.floor((gx + 1) * step); x++) { votes[label[y * size + x]]++; tot++; }
    const order = votes.map((v, j) => j).sort((a, b) => votes[b] - votes[a]);
    let pick = order[0];
    // strokes: thin lines and small dots must survive — a non-background colour with a fair share wins over background
    if (pick === bg) for (const j of order.slice(1, 3)) if (votes[j] / tot >= 0.18) { pick = j; break; }
    cellLabel[gy * GRID + gx] = pick;
  }
  // map clusters to pieces, biggest first; distinct artwork colours stay distinct when a close piece exists
  const plab = pal.map((p) => rgbToLab(...hexToRgb(p.hex)) as number[]);
  const area = new Array(cs.length).fill(0); for (let i = 0; i < CELLS; i++) area[cellLabel[i]]++;
  const order = cs.map((_, j) => j).sort((a, b) => area[b] - area[a]);
  const used = new Set<number>(), map = new Array<number>(cs.length);
  let err = 0;
  for (const j of order) {
    const ranked = plab.map((q, k) => [pieceDistance(cs[j], q), k]).sort((a, b) => a[0] - b[0]);
    let choice = ranked[0];
    if (used.has(choice[1])) { const alt = ranked.find((r) => !used.has(r[1])); if (alt && alt[0] - choice[0] < 12) choice = alt; }
    map[j] = choice[1]; used.add(choice[1]); err += choice[0] * area[j];
  }
  return { pattern: Array.from(cellLabel, (j) => pal[map[j]].code), averageDeltaE: err / CELLS };
}

// ---------------------------------------------------------------- classification
export function classify(data: Uint8ClampedArray, size: number, mask: Float32Array | null | undefined, face: FocusBox | null | undefined): Kind {
  const usable = !!mask && maskLooksUsable(mask);
  if (face) {
    const fw = (face.x1 - face.x0) / size;
    if (fw > 0.16) return "portrait"; // face big enough to be the subject
  }
  if (!(face && (face.x1 - face.x0) / size > 0.12) && looksGraphic(data, size)) return "graphic";
  if (usable) {
    let fg = 0; for (let i = 0; i < mask!.length; i++) if (mask![i] > 0.5) fg++;
    const f = fg / mask!.length;
    if (f > 0.05 && f < 0.88) return face ? "portrait" : "subject";
  }
  return face ? "portrait" : "scene";
}

// ---------------------------------------------------------------- per-type settings
type Tune = { r: number; sigma: number; iters: number; K: number; smooth: number; clarity: number; sat: number; feature: number };
const TUNE: Record<Exclude<Kind, "graphic">, Tune> = {
  portrait: { r: 3, sigma: 9, iters: 2, K: 10, smooth: 7, clarity: 0.45, sat: 1.12, feature: 13 },
  subject: { r: 3, sigma: 10, iters: 2, K: 11, smooth: 7, clarity: 0.5, sat: 1.15, feature: 16 },
  scene: { r: 4, sigma: 12, iters: 2, K: 12, smooth: 9, clarity: 0.35, sat: 1.12, feature: 22 },
};

// ---------------------------------------------------------------- background choice
// brand-friendly backgrounds, described by colour (not code) so they work with any supplier's range
const BG_TARGETS: { hex: string; pref: number; dark?: boolean }[] = [
  { hex: "#F1E2C4", pref: 14 }, { hex: "#F4F3EE", pref: 10 }, { hex: "#F4DE7C", pref: 9 }, { hex: "#9EC3E6", pref: 8 },
  { hex: "#7FA38B", pref: 8 }, { hex: "#F1A99A", pref: 4 }, { hex: "#B9A5D6", pref: 5 }, { hex: "#D9C59A", pref: 3 },
  { hex: "#22334F", pref: 12, dark: true }, { hex: "#1C1D1E", pref: 10, dark: true }, { hex: "#1F4A38", pref: 6, dark: true }, { hex: "#3E3F3C", pref: 4, dark: true },
];
function chooseBackground(pal: PaletteColor[], subjLabs: number[][], subjL: number, subjC: number) {
  const plab = pal.map((p) => rgbToLab(...hexToRgb(p.hex)));
  // each target → the closest piece in the range (skipped when the range has nothing close)
  const cands: { p: PaletteColor; lab: number[]; pref: number; dark: boolean }[] = [];
  for (const t of BG_TARGETS) {
    const tl = rgbToLab(...hexToRgb(t.hex)); let bi = 0, bd = Infinity;
    plab.forEach((q, i) => { const d = deltaE2000(tl, q); if (d < bd) { bd = d; bi = i; } });
    if (bd < 14 && !cands.some((c) => c.p.code === pal[bi].code)) cands.push({ p: pal[bi], lab: plab[bi], pref: t.pref, dark: !!t.dark });
  }
  if (!cands.length) plab.forEach((q, i) => cands.push({ p: pal[i], lab: q, pref: 0, dark: q[0] < 35 }));
  let best = cands[0], bestScore = -Infinity;
  for (const c of cands) {
    let minD = Infinity; for (const s of subjLabs) minD = Math.min(minD, deltaE2000(c.lab as [number, number, number], s as [number, number, number]));
    const ch = Math.hypot(c.lab[1], c.lab[2]), hh = ((Math.atan2(c.lab[2], c.lab[1]) * 180) / Math.PI + 360) % 360;
    const metal = subjC < 14 && c.dark && (ch < 12 || (hh > 200 && hh < 300)) ? 12 : 0; // silver and chrome shine on dark grounds
    const score = Math.min(minD, 40) + c.pref + Math.min(30, Math.abs(c.lab[0] - subjL)) * 0.6 + metal;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best.p;
}

/** The pieces a style may use, chosen by colour so it works with any range. */
export function stylePalette(styleId: StyleId, palette: PaletteColor[]) {
  const st = STYLES.find((s) => s.id === styleId) ?? STYLES[0];
  if (!st.mono) return palette;
  const withLab = palette.map((p) => ({ p, lab: rgbToLab(...hexToRgb(p.hex)) }));
  const neutral = withLab.filter(({ lab }) => { const C = Math.hypot(lab[1], lab[2]); return C < 6 || (lab[0] > 90 && C < 12 && Math.abs(lab[1]) < 3) || (lab[0] < 22 && C < 10); });
  let pick = neutral;
  if (styleId === "vintage") {
    const warm = withLab.filter(({ lab }) => { const C = Math.hypot(lab[1], lab[2]); let h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI; if (h < 0) h += 360; return C >= 9 && C < 42 && h > 40 && h < 95; });
    pick = [...warm, ...neutral.filter(({ lab }) => lab[0] < 30 || lab[0] > 90)];
  }
  const codes = pick.map(({ p }) => p.code);
  const legacy = st.codes ? palette.filter((p) => st.codes!.includes(p.code)) : [];
  return codes.length >= 5 ? palette.filter((p) => codes.includes(p.code)) : legacy.length ? legacy : palette;
}

// ---------------------------------------------------------------- main
export function renderMosaicV5(data: Uint8ClampedArray, size: number, palette: PaletteColor[], o: RenderOptionsV5): ResultV5 {
  const st = STYLES.find((s) => s.id === o.style) ?? STYLES[0];
  const pal = stylePalette(st.id, palette);
  if (pal.length === 0) throw new Error("No colours available for this style");
  const byCode = new Map(palette.map((p) => [p.code, p]));
  const usable = !!o.mask && maskLooksUsable(o.mask);
  const kind = o.kind ?? classify(data, size, o.mask, o.face);
  const N = size * size;

  // ---- graphics: flat colour regions, crisp strokes, each artwork colour mapped to its best piece
  if (kind === "graphic") {
    const g = renderGraphic(data, size, pal);
    return { pattern: islands(g.pattern, new Float32Array(CELLS).fill(1), pal, 1), averageDeltaE: g.averageDeltaE, flat: true, kind, bgCode: null };
  }

  const T = TUNE[kind];

  // ---- background decision
  let mode = o.bgMode ?? "auto";
  if (!usable || kind === "scene") mode = "keep";
  const mask = usable ? o.mask! : null;
  // keeping the whole picture (album covers, posters, scenes): the background is part of the art,
  // so it gets real colour budget — gradients keep their steps instead of collapsing to one flat colour
  const keepAll = mode === "keep";
  const K = Math.min(st.maxColors, st.id === "bold" ? 6 : T.K + (keepAll ? 4 : 0) + (palette.length > 70 ? 1 : 0));
  const smoothK = keepAll ? T.smooth * 0.6 : T.smooth;

  // 1. Linear-light unsharp mask: prevents fine lines/calligraphy/features from blurring into background
  const sharpLin = unsharpMaskLinear(data, size, 1.35, 1);

  // 2. Dynamic contrast & black/white point clamping: stretches dynamic range so shadows clamp cleanly
  // and highlights pop, eliminating the muddy, compressed look across all modes.
  const contrastLin = dynamicContrastStretch(sharpLin, size, 0.012, 0.988, 0.55);

  let lab = toLab(data, N);
  // Reconstruct working Lab from contrast-stretched linear pixels
  for (let p = 0; p < N; p++) {
    const p3 = p * 3;
    const r = linearToSrgb(contrastLin[p3]);
    const g = linearToSrgb(contrastLin[p3 + 1]);
    const b = linearToSrgb(contrastLin[p3 + 2]);
    const l = rgbToLab(r, g, b);
    lab.L[p] = l[0]; lab.A[p] = l[1]; lab.B[p] = l[2];
  }

  // importance map
  const imp = new Float32Array(N).fill(1);
  if (mask) for (let p = 0; p < N; p++) imp[p] = keepAll ? 0.85 + 0.35 * mask[p] : 0.4 + 0.8 * mask[p];
  let eyeBand: [number, number, number, number] | null = null;
  if (o.face) {
    const f = o.face, fw = f.x1 - f.x0, fh = f.y1 - f.y0, pad = fw * 0.2;
    for (let y = Math.max(0, Math.floor(f.y0 - pad)); y < Math.min(size, f.y1 + pad); y++)
      for (let x = Math.max(0, Math.floor(f.x0 - pad)); x < Math.min(size, f.x1 + pad); x++) imp[y * size + x] = 2.6;
    // eyes, brows and mouth live in the middle of the face box
    // small faces need help: eyes and mouth are only a piece or two, so dark details get priority.
    // Big faces (≥ 14 pieces wide) already have room for real eyes — forcing dark there makes black bars.
    if (fw / size * GRID < 14) {
      eyeBand = [f.x0 + fw * 0.08, f.y0 + fh * 0.22, f.x1 - fw * 0.08, f.y0 + fh * 0.88];
      for (let y = Math.max(0, Math.floor(eyeBand[1])); y < Math.min(size, eyeBand[3]); y++)
        for (let x = Math.max(0, Math.floor(eyeBand[0])); x < Math.min(size, eyeBand[2]); x++) imp[y * size + x] = 4;
    }
  }

  // subject statistics (used for levels and background choice)
  const sw = (p: number) => (mask && !keepAll ? mask[p] : 1);

  // ---- edge-preserving smoothing
  {
    const orig = lab;
    if (!keepAll) lab = bilateral(lab, size, T.r, T.sigma, T.iters);
    // eyes, brows and mouth keep most of their original detail
    for (let p = 0; p < N; p++) if (imp[p] >= 4) { const a = 0.55; lab.L[p] = lab.L[p] * (1 - a) + orig.L[p] * a; lab.A[p] = lab.A[p] * (1 - a) + orig.A[p] * a; lab.B[p] = lab.B[p] * (1 - a) + orig.B[p] * a; }
  }

  // portraits: skin drifts pink/red under studio light; nudge skin hues toward warm skin so it maps to skin pieces
  if (kind === "portrait" && !st.mono) for (let p = 0; p < N; p++) {
    const C = Math.hypot(lab.A[p], lab.B[p]); if (C < 8 || C > 60 || lab.L[p] < 20) continue;
    let h = (Math.atan2(lab.B[p], lab.A[p]) * 180) / Math.PI; if (h < 0) h += 360;
    if (h < 10 || h > 80) continue;
    const target = 60, k = (imp[p] >= 2.6 ? 0.55 : mask ? 0.35 * mask[p] : 0.2) * (keepAll ? 0.5 : 1);
    const nh = ((h + (target - h) * k) * Math.PI) / 180;
    lab.A[p] = C * Math.cos(nh); lab.B[p] = C * Math.sin(nh);
  }
  let metallic = false;
  // ---- 2. tone: levels on the subject, local contrast, saturation
  {
    const hist = new Float32Array(101); let tot = 0;
    for (let p = 0; p < N; p++) { const w = sw(p); hist[Math.max(0, Math.min(100, Math.round(lab.L[p])))] += w; tot += w; }
    const pct = (q: number) => { let a = 0; for (let i = 0; i <= 100; i++) { a += hist[i]; if (a >= q * tot) return i; } return 100; };
    // metal (silver, chrome, steel): mostly neutral or cool-tinted reflections
    let metalW = 0, cn = 0;
    for (let p = 0; p < N; p += 3) { const w = sw(p); if (w < 0.6) continue; cn++; const C = Math.hypot(lab.A[p], lab.B[p]); let h = (Math.atan2(lab.B[p], lab.A[p]) * 180) / Math.PI; if (h < 0) h += 360; if (C < 12 || (h > 200 && h < 290 && C < 22)) metalW++; }
    const spread = pct(0.9) - pct(0.1);
    metallic = kind === "subject" && !keepAll && !!mask && cn > 0 && metalW / cn > 0.72 && spread > 35;
    if (metallic) {
      // neutralise the reflections, then remap tones to a bright silver ramp (rank → light greys + white highlights)
      for (let p = 0; p < N; p++) if (sw(p) > 0.3) { lab.A[p] *= 0.25; lab.B[p] *= 0.25; }
      const cdf = new Float32Array(101); let acc = 0; for (let i = 0; i <= 100; i++) { acc += hist[i]; cdf[i] = acc / tot; }
      for (let p = 0; p < N; p++) { const w = Math.min(1, Math.max(0, (sw(p) - 0.3) / 0.4)); if (!w) continue; const r = cdf[Math.max(0, Math.min(100, Math.round(lab.L[p])))]; lab.L[p] = lab.L[p] * (1 - w) + (24 + 74 * Math.pow(r, 0.8)) * w; }
    }
    const bl = blur(lab.L, size, Math.round(size / 40));
    for (let p = 0; p < N; p++) { const k = T.clarity * (keepAll ? 0.35 : 1) * Math.min(1.4, imp[p] * 0.6); lab.L[p] = clamp(lab.L[p] + (lab.L[p] - bl[p]) * k, 0, 100); }
    if (!st.mono) for (let p = 0; p < N; p++) {
      const C = Math.hypot(lab.A[p], lab.B[p]); if (C < 12) continue;
      const k = 1 + ((keepAll ? 1.05 : T.sat) + st.saturation / 100 - 1) * Math.min(1, (C - 12) / 15); lab.A[p] *= k; lab.B[p] *= k;
    }
  }

  // ---- 3. plain background: composite before sampling so edges sample cleanly
  let bgCode: string | null = null;
  if (mask && (mode === "plain" || mode === "auto") && !st.mono) {
    if (mode === "plain" && o.bgCode && byCode.get(o.bgCode)) bgCode = o.bgCode;
    else {
      // dominant subject colours on its rim (that's what must stand out against the background)
      const samples: number[][] = []; let sl = 0, sc = 0, sn = 0;
      for (let p = 0; p < N; p += 3) if (mask[p] > 0.6) { sl += lab.L[p]; sc += Math.hypot(lab.A[p], lab.B[p]); sn++; if (samples.length < 500) samples.push([lab.L[p], lab.A[p], lab.B[p]]); }
      const reps = kmeansLab(samples, 5);
      bgCode = chooseBackground(pal, reps, sn ? sl / sn : 50, metallic ? 0 : sn ? sc / sn : 30).code;
    }
    const bgLab = rgbToLab(...hexToRgb(byCode.get(bgCode)!.hex));
    for (let p = 0; p < N; p++) {
      const a = Math.min(1, Math.max(0, (mask[p] - 0.3) / 0.4));
      lab.L[p] = lab.L[p] * a + bgLab[0] * (1 - a); lab.A[p] = lab.A[p] * a + bgLab[1] * (1 - a); lab.B[p] = lab.B[p] * a + bgLab[2] * (1 - a);
    }
  } else if (mask && mode === "soft") {
    // background: heavy blur + desaturation, keeps the mood without the noise
    const r = Math.round(size / 14);
    const bL = blur(lab.L, size, r), bA = blur(lab.A, size, r), bB = blur(lab.B, size, r);
    for (let p = 0; p < N; p++) { const a = Math.min(1, Math.max(0, (mask[p] - 0.25) / 0.5)); lab.L[p] = lab.L[p] * a + bL[p] * (1 - a); lab.A[p] = lab.A[p] * a + bA[p] * 0.7 * (1 - a); lab.B[p] = lab.B[p] * a + bB[p] * 0.7 * (1 - a); }
  }
  if (st.mono) for (let p = 0; p < N; p++) { lab.A[p] = 0; lab.B[p] = 0; }

  // ---- 4. Adaptive cell sampling in linear space with high-frequency stroke preservation
  const { cellLabs, isFeature, cellWeights } = adaptiveCellSampling(contrastLin, size, imp);
  const cellLab: number[][] = cellLabs.map(c => [c[0], c[1], c[2]]);
  const cellW = cellWeights;
  const feature = isFeature;
  const rimSubject = new Uint8Array(CELLS);
  const step = size / GRID;
  if (mask && bgCode) {
    for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
      const i = gy * GRID + gx;
      const x0 = Math.floor(gx * step), x1 = Math.floor((gx + 1) * step), y0 = Math.floor(gy * step), y1 = Math.floor((gy + 1) * step);
      let inS = 0, tot = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        if (mask[y * size + x] > 0.4) inS++;
        tot++;
      }
      const fr = inS / tot;
      if (fr >= 0.15 && fr < 0.6) {
        rimSubject[i] = 1;
      }
    }
  }

  // ---- portrait features: an artist always draws the eyes and the mouth
  if (o.face && kind === "portrait" && eyeBand) {
    const f = o.face, fw = f.x1 - f.x0, fh = f.y1 - f.y0;
    const L0 = toLab(data, N).L; // unsmoothed
    const cellOf = (x: number, y: number) => Math.min(GRID - 1, Math.floor(y / step)) * GRID + Math.min(GRID - 1, Math.floor(x / step));
    let skin = 0, sn = 0;
    for (let y = Math.floor(f.y0 + fh * 0.55); y < f.y0 + fh * 0.7; y++) for (let x = Math.floor(f.x0 + fw * 0.25); x < f.x1 - fw * 0.25; x++) { skin += L0[y * size + x]; sn++; }
    skin /= Math.max(1, sn);
    const darkest = (xa: number, xb: number, ya: number, yb: number) => {
      let best = Infinity, bx = 0, by = 0;
      for (let y = Math.max(1, Math.floor(ya)); y < Math.min(size - 1, yb); y++) for (let x = Math.max(1, Math.floor(xa)); x < Math.min(size - 1, xb); x++) {
        let m = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m += L0[(y + dy) * size + x + dx];
        if (m / 9 < best) { best = m / 9; bx = x; by = y; }
      }
      return { L: best, x: bx, y: by };
    };
    const eyes = [darkest(f.x0 + fw * 0.12, f.x0 + fw * 0.47, f.y0 + fh * 0.22, f.y0 + fh * 0.52), darkest(f.x0 + fw * 0.53, f.x1 - fw * 0.12, f.y0 + fh * 0.22, f.y0 + fh * 0.52)];
    if (eyes.every((e) => skin - e.L > 12) && Math.abs(eyes[0].y - eyes[1].y) < fh * 0.12) {
      const ink = Math.min(22, Math.min(eyes[0].L, eyes[1].L));
      for (const e of eyes) { const i = cellOf(e.x, e.y); cellLab[i] = [ink, cellLab[i][1] * 0.3, cellLab[i][2] * 0.3]; feature[i] = 1; }
    }
  }
  // features stay crisp: push them darker so the palette keeps a dark ink for them

  // metal / shadows: low-chroma cool tones go neutral so silver reads as silver
  if (kind !== "portrait" && !st.mono) for (let i = 0; i < CELLS; i++) {
    const [L, A, B] = cellLab[i], C = Math.hypot(A, B); let h = (Math.atan2(B, A) * 180) / Math.PI; if (h < 0) h += 360;
    if (C < 30 && h > 180 && h < 300 && (!mask || cellW[i] > 0.9)) { const k = C < 18 ? 0.25 : 0.25 + ((C - 18) / 12) * 0.75; cellLab[i] = [L, A * k, B * k]; }
  }
  // saliency: rare, vivid colours (eye colour, a red scarf) earn palette budget even when small
  { let ma = 0, mb = 0; for (const c of cellLab) { ma += c[1]; mb += c[2]; } ma /= CELLS; mb /= CELLS;
    for (let i = 0; i < CELLS; i++) { const d = Math.hypot(cellLab[i][1] - ma, cellLab[i][2] - mb); cellW[i] *= 1 + Math.min(1.5, Math.max(0, d - 12) / 25); } }
  const cells = cellLab.map(([L, A, B]) => labToRgb(L, A, B));
  for (let i = 0; i < CELLS; i++) if (feature[i]) cellW[i] = Math.max(cellW[i], 3);

  // ---- 6. palette per picture + Potts smoothing
  let pattern: Pattern, avg = 0;
  const lockBg = bgCode && pal.some((p) => p.code === bgCode) ? [bgCode] : [];
  if (st.mono) pattern = toneMap(cells, pal, cellW.map((w) => Math.min(1, w)));
  else {
    const q = optimizePalette(cells, pal, cellW, K + (lockBg.length ? 1 : 0), lockBg, smoothK, feature); pattern = q.pattern; avg = q.averageDeltaE;
  }

  // ---- 7. background cells + contour
  let outlined = false;
  if (mask && bgCode) {
    const bin = new Float32Array(N); for (let p = 0; p < N; p++) bin[p] = mask[p] > 0.4 ? 1 : 0;
    const cov = maskCoverage(bin, size);
    const subject = (i: number) => cov[i] >= 0.34 || rimSubject[i] === 1; // keeps thin parts (handles, ears, straps)
    for (let i = 0; i < CELLS; i++) if (!subject(i)) pattern[i] = bgCode;
    // contour when the subject's edge doesn't separate clearly from the background on its own
    const bgLab = rgbToLab(...hexToRgb(byCode.get(bgCode)!.hex));
    const rim: number[] = [];
    const nbs = (i: number) => { const x = i % GRID, y = Math.floor(i / GRID); return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [x + dx, y + dy]).filter(([a, b]) => a >= 0 && b >= 0 && a < GRID && b < GRID).map(([a, b]) => b * GRID + a); };
    for (let i = 0; i < CELLS; i++) if (subject(i) && nbs(i).some((j) => !subject(j))) rim.push(i);
    let weak = 0; for (const i of rim) if (deltaE2000(rgbToLab(...hexToRgb(byCode.get(pattern[i])!.hex)), bgLab) < 18) weak++;
    const wantOutline = o.outline ?? (kind === "subject" && rim.length > 0 && weak / rim.length > 0.25);
    if (wantOutline && bgLab[0] > 45) {
      outlined = true;
      const ranked = [...pal].sort((a, b) => rgbToLab(...hexToRgb(a.hex))[0] - rgbToLab(...hexToRgb(b.hex))[0]);
      const line = bgLab[0] > 45 ? ranked[0].code : ranked[ranked.length - 1].code;
      const src = [...pattern];
      for (let i = 0; i < CELLS; i++) if (!subject(i) && nbs(i).some((j) => subject(j) && src[j] !== bgCode)) pattern[i] = line;
    }
  }

  // ---- 8. clean-up
  if (!st.mono) pattern = islands(pattern, cellW, pal, 2, feature);
  const featCodes = new Set<string>();
  for (let i = 0; i < CELLS; i++) if (feature[i]) featCodes.add(pattern[i]);
  return { pattern: consolidate(pattern, pal, 3, K + 3, featCodes), averageDeltaE: avg, flat: false, kind, bgCode, outline: outlined };
}


/** Lone pieces (components of ≤ maxSize) join their surroundings unless they are a protected feature. */
function islands(pattern: Pattern, w: Float32Array, pal: PaletteColor[], maxSize: number, feature?: Uint8Array) {
  const labOf = new Map(pal.map((p) => [p.code, rgbToLab(...hexToRgb(p.hex))]));
  const out = [...pattern];
  const seen = new Uint8Array(CELLS);
  for (let s = 0; s < CELLS; s++) {
    if (seen[s]) continue;
    const comp = [s]; seen[s] = 1;
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k], x = i % GRID, y = Math.floor(i / GRID);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
        const j = ny * GRID + nx; if (!seen[j] && pattern[j] === pattern[s]) { seen[j] = 1; comp.push(j); }
      }
      if (comp.length > maxSize) break;
    }
    if (comp.length > maxSize) { for (const i of comp) seen[i] = 0; seen[s] = 1; continue; }
    if (feature && comp.some((i) => feature[i])) continue;
    // neighbour colour votes
    const votes = new Map<string, number>();
    for (const i of comp) {
      const x = i % GRID, y = Math.floor(i / GRID);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
        const c = pattern[ny * GRID + nx]; if (c !== pattern[s]) votes.set(c, (votes.get(c) ?? 0) + (dx && dy ? 0.5 : 1));
      }
    }
    let bestC: string | null = null, bv = 0; for (const [c, v] of votes) if (v > bv) { bv = v; bestC = c; }
    if (!bestC) continue;
    const d = deltaE2000(labOf.get(pattern[s])!, labOf.get(bestC)!);
    const wMax = Math.max(...comp.map((i) => w[i]));
    const limit = wMax >= 3 ? 14 : wMax >= 1.2 ? 26 : 40; // protect contrast where it matters
    if (bv >= 3 * comp.length && d < limit) for (const i of comp) out[i] = bestC;
  }
  return out;
}

function kmeansLab(samples: number[][], k: number) {
  if (samples.length <= k) return samples.length ? samples : [[50, 0, 0]];
  // farthest-first initialisation: small but distinct colours (a logo's text, an eye) always get a centre
  const cs: number[][] = [[...samples[Math.floor(samples.length / 2)]]];
  const dmin = samples.map((p) => (p[0] - cs[0][0]) ** 2 + (p[1] - cs[0][1]) ** 2 + (p[2] - cs[0][2]) ** 2);
  while (cs.length < k) {
    let bi = 0; for (let i = 1; i < samples.length; i++) if (dmin[i] > dmin[bi]) bi = i;
    if (dmin[bi] < 4) break;
    const c = [...samples[bi]]; cs.push(c);
    for (let i = 0; i < samples.length; i++) { const p = samples[i], d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < dmin[i]) dmin[i] = d; }
  }
  for (let it = 0; it < 8; it++) {
    const s = cs.map(() => [0, 0, 0, 0]);
    for (const p of samples) { let b = 0, bd = Infinity; cs.forEach((c, j) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; b = j; } }); s[b][0] += p[0]; s[b][1] += p[1]; s[b][2] += p[2]; s[b][3]++; }
    s.forEach((v, j) => { if (v[3]) cs[j] = [v[0] / v[3], v[1] / v[3], v[2] / v[3]]; });
  }
  return cs;
}

void buildLabPalette;
