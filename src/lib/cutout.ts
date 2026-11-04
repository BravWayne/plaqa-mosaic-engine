"use client";
// In-browser background removal with U²-Net (portable, 4.6 MB, Apache-2.0) on onnxruntime-web.
// Everything is self-hosted under /public and only downloaded when a customer turns the option on.

type Ort = {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  InferenceSession: { create(url: string, o?: object): Promise<Session> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
};
type Session = { inputNames: string[]; outputNames: string[]; run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>> };

export const CUT = 320; // model input size

// The wasm runtime runs one inference at a time: queue every call so they never overlap.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

let ortP: Promise<Ort> | null = null;
export function loadOrt(): Promise<Ort> {
  const w = window as unknown as { ort?: Ort };
  if (w.ort) return Promise.resolve(w.ort);
  return (ortP ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/ort/ort.wasm.min.js";
    s.onload = () => { const o = w.ort!; o.env.wasm.wasmPaths = "/ort/"; o.env.wasm.numThreads = 1; (o.env as { logLevel?: string }).logLevel = "error"; resolve(o); };
    s.onerror = () => { ortP = null; reject(new Error("Couldn't load the background tool")); };
    document.head.appendChild(s);
  }));
}

let sessionP: Promise<Session> | null = null;
async function session() {
  const ort = await loadOrt();
  return (sessionP ??= ort.InferenceSession.create("/models/u2netp.onnx", { executionProviders: ["wasm"], logSeverityLevel: 3 }).catch((e) => { sessionP = null; throw e; }));
}

/** Foreground probability (0..1) for a CUT×CUT RGBA image. */
export function foregroundMask(rgba: Uint8ClampedArray): Promise<Float32Array> {
  const copy = new Uint8ClampedArray(rgba);
  return serial(() => foregroundMaskNow(copy));
}
async function foregroundMaskNow(rgba: Uint8ClampedArray): Promise<Float32Array> {
  const ort = await loadOrt();
  const s = await session();
  const n = CUT * CUT;
  let max = 1;
  for (let i = 0; i < rgba.length; i += 4) max = Math.max(max, rgba[i], rgba[i + 1], rgba[i + 2]);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const input = new Float32Array(3 * n);
  for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) input[c * n + p] = (rgba[p * 4 + c] / max - mean[c]) / std[c];
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, CUT, CUT]) });
  const d = out[s.outputNames[0]].data;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) mask[i] = (d[i] - lo) / (hi - lo || 1);
  return mask;
}

/** Put the subject on a plain background colour. The edge is tightened so it reads crisply at 32×32. */
export function composite(rgba: Uint8ClampedArray, mask: Float32Array, hex: string) {
  const bg = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  const out = new Uint8ClampedArray(rgba);
  for (let p = 0; p < mask.length; p++) {
    const a = Math.min(1, Math.max(0, (mask[p] - 0.3) / 0.4));
    for (let c = 0; c < 3; c++) out[p * 4 + c] = rgba[p * 4 + c] * a + bg[c] * (1 - a);
    out[p * 4 + 3] = 255;
  }
  return out;
}

// ---------- face detection (Ultra-Light RFB-320, 1.2 MB, MIT) ----------
let faceP: Promise<Session> | null = null;
async function faceSession() {
  const ort = await loadOrt();
  return (faceP ??= ort.InferenceSession.create("/models/face-rfb320.onnx", { executionProviders: ["wasm"], logSeverityLevel: 3 }).catch((e) => { faceP = null; throw e; }));
}

export type Face = { x0: number; y0: number; x1: number; y1: number; score: number; count: number }; // normalised 0..1; count = faces found

/** Largest confident face in an image (or canvas), normalised to its width/height. */
export function detectFace(src: CanvasImageSource, w: number, h: number): Promise<Face | null> {
  // snapshot the pixels now; the source canvas may be redrawn before our turn in the queue
  const c = document.createElement("canvas"); c.width = 320; c.height = 240;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h, 0, 0, 320, 240);
  return serial(() => detectFaceNow(ctx));
}
async function detectFaceNow(ctx: CanvasRenderingContext2D): Promise<Face | null> {
  const ort = await loadOrt();
  const s = await faceSession();
  const px = ctx.getImageData(0, 0, 320, 240).data, n = 320 * 240;
  const input = new Float32Array(3 * n);
  for (let p = 0; p < n; p++) for (let ch = 0; ch < 3; ch++) input[ch * n + p] = (px[p * 4 + ch] - 127) / 128;
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, 240, 320]) });
  const scores = out[s.outputNames[0]].data, boxes = out[s.outputNames[1]].data;
  // confident boxes, then non-maximum suppression so each face counts once
  const cand: Omit<Face, "count">[] = [];
  for (let i = 0; i < scores.length / 2; i++) {
    const sc = scores[i * 2 + 1];
    if (sc >= 0.9) cand.push({ x0: boxes[i * 4], y0: boxes[i * 4 + 1], x1: boxes[i * 4 + 2], y1: boxes[i * 4 + 3], score: sc });
  }
  cand.sort((a, b) => b.score - a.score);
  const iou = (a: typeof cand[0], b: typeof cand[0]) => {
    const w = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), h = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const inter = w * h; return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter);
  };
  const kept: typeof cand = [];
  for (const c of cand) if (kept.every((k) => iou(k, c) < 0.35)) kept.push(c);
  if (!kept.length) return null;
  const big = kept.reduce((m, f) => ((f.x1 - f.x0) * (f.y1 - f.y0) > (m.x1 - m.x0) * (m.y1 - m.y0) ? f : m));
  const best: Face = { ...big, count: kept.length };
  return best;
}
