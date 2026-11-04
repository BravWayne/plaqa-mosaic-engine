"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  adjustPixels, countColors, maskLooksUsable, subjectBox, DEFAULT_ADJUSTMENTS, STYLES,
  type Adjustments, type FocusBox, type PaletteColor, type Pattern, type StyleId,
} from "@/lib/mosaic";
import { CUT, detectFace, foregroundMask } from "@/lib/cutout";
import { renderMosaicV5, KIND_LABEL, type Kind } from "@/lib/mosaic5";
import { formatMoney } from "@/lib/money";
import { MosaicCanvas } from "./mosaic-canvas";
import { PixelCanvas, PixelTools } from "./pixel-editor";
import { useCart } from "./cart";
import { useLocale, useT } from "./i18n-provider";

const WORK = CUT; // working resolution of the cropped square (= the cut-out model's input)
// Plain backgrounds offered when the photo's background is removed (factory colour codes)
const BG_CODES = ["F1", "F5", "F151", "F102", "F140", "F26", "F220", "F226"];
const CROP_VIEW = 280; // on-screen size of the framing box
export const ACCEPTANCE_TEXT_VERSION = "custom-approval-v1";

type Crop = { x: number; y: number; zoom: number }; // x/y = centre in image px

export function CustomStudio({ palette, price }: { palette: PaletteColor[]; price: number }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const { add } = useCart();
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, zoom: 1 });
  const [adj, setAdj] = useState<Adjustments>(DEFAULT_ADJUSTMENTS);
  const [result, setResult] = useState<{ pattern: Pattern; avg: number; flat: boolean; kind: Kind; outline: boolean } | null>(null);
  const [previews, setPreviews] = useState<Partial<Record<StyleId, Pattern>>>({});
  const [style, setStyle] = useState<StyleId>("colour");
  // background: keep it, soften it, or replace it with a plain colour (palette code)
  const [bg, setBg] = useState<string>("keep");
  // what the AI sees in the current framing: subject mask + face, recomputed after each change
  const [analysis, setAnalysis] = useState<{ key: string; mask: Float32Array; usable: boolean; face: FocusBox | null } | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [aiError, setAiError] = useState(false);
  const [faceFramed, setFaceFramed] = useState<Crop | null>(null);
  const [faceSuggest, setFaceSuggest] = useState<Crop | null>(null); // offered, never forced: covers and posters keep their composition
  const [crowd, setCrowd] = useState(0); // number of faces when it's a group photo
  const [outline, setOutline] = useState(true);
  const [outlineTouched, setOutlineTouched] = useState(false);
  const framedFor = useRef<string | null>(null); // image we've already auto-framed on its subject
  const [showOriginal, setShowOriginal] = useState(false);
  // fine-tune: per-piece overrides painted by the customer on top of the generated artwork
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Map<number, string>>(new Map());
  const [history, setHistory] = useState<Map<number, string>[]>([]);
  const [brush, setBrush] = useState<string>("F26");
  const [tool, setTool] = useState<"paint" | "pick">("paint");
  const strokeStart = useRef<Map<number, string> | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const workCanvas = useRef<HTMLCanvasElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const hex = useMemo(() => Object.fromEntries(palette.map((p) => [p.code, p.hex])), [palette]);
  const byCode = useMemo(() => new Map(palette.map((p) => [p.code, p])), [palette]);

  const loadFile = useCallback((file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError(locale === "ar" ? "الملف لازم يكون صورة." : "That file isn't an image. Choose a JPG or PNG."); return; }
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      const centre = { x: im.naturalWidth / 2, y: im.naturalHeight / 2, zoom: 1 };
      setImg(im); setCrop(centre); setAdj(DEFAULT_ADJUSTMENTS); setAgreed(false);
      setAnalysis(null); setBg("keep"); setFaceFramed(null); setFaceSuggest(null); setPreviews({}); setAiError(false); setCrowd(0); setOutlineTouched(false);
      // portraits: find the face and frame head-and-shoulders automatically
      detectFace(im, im.naturalWidth, im.naturalHeight).then((f) => {
        if (!f) return;
        if (f.count > 2) { setCrowd(f.count); return; } // group photo: don't pick one person
        const W = im.naturalWidth, H = im.naturalHeight, full = Math.min(W, H);
        const fw = (f.x1 - f.x0) * W;
        const sideWanted = Math.min(full, fw / 0.46);
        const zoom = full / sideWanted;
        if (zoom < 1.15) return; // face already large
        const c = { zoom: Math.min(4, zoom), x: ((f.x0 + f.x1) / 2) * W, y: ((f.y0 + f.y1) / 2) * H + sideWanted * 0.08 };
        const s2 = full / c.zoom;
        const framed = { zoom: c.zoom, x: Math.min(W - s2 / 2, Math.max(s2 / 2, c.x)), y: Math.min(H - s2 / 2, Math.max(s2 / 2, c.y)) };
        setFaceSuggest(framed);
      }).catch(() => setAiError(true));
    };
    im.onerror = () => setError(locale === "ar" ? "ما قدرنا نفتح الصورة. جرّب تصدّرها JPG." : "We couldn't open that photo. Try exporting it as a JPG.");
    im.src = url;
  }, [locale]);

  // side of the square crop in image pixels at the current zoom
  const side = img ? Math.min(img.naturalWidth, img.naturalHeight) / crop.zoom : 0;
  const clampCrop = useCallback((c: Crop): Crop => {
    if (!img) return c;
    const s = Math.min(img.naturalWidth, img.naturalHeight) / c.zoom;
    return {
      zoom: c.zoom,
      x: Math.min(img.naturalWidth - s / 2, Math.max(s / 2, c.x)),
      y: Math.min(img.naturalHeight - s / 2, Math.max(s / 2, c.y)),
    };
  }, [img]);

  const cropKey = img ? `${img.src}|${crop.x.toFixed(1)}|${crop.y.toFixed(1)}|${crop.zoom.toFixed(3)}` : "";
  const cropPixels = useCallback(() => {
    const c = workCanvas.current ?? (workCanvas.current = document.createElement("canvas"));
    c.width = WORK; c.height = WORK;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, WORK, WORK);
    ctx.drawImage(img!, crop.x - side / 2, crop.y - side / 2, side, side, 0, 0, WORK, WORK);
    return ctx.getImageData(0, 0, WORK, WORK);
  }, [img, crop, side]);

  // Analyse the current framing in the browser (subject + face), debounced while the customer drags.
  useEffect(() => {
    if (!img || analysis?.key === cropKey || aiError) return;
    let cancelled = false;
    const id = setTimeout(async () => {
      setAnalysing(true);
      try {
        const px = cropPixels();
        // one model at a time: the runtime is single-threaded
        const m = await foregroundMask(px.data);
        const f = await detectFace(workCanvas.current!, WORK, WORK);
        if (cancelled) return;
        const usable = maskLooksUsable(m);
        // first plain-colour background for a photo without a face: zoom to the subject so it fills the plate
        if (usable && !f && bg !== "keep" && bg !== "soft" && framedFor.current !== img.src) {
          framedFor.current = img.src;
          const box = subjectBox(m, WORK);
          if (box) {
            const k = side / WORK;
            const want = Math.max(box.x1 - box.x0 + 1, box.y1 - box.y0 + 1) * k * 1.14;
            const zoom = Math.min(4, Math.max(1, Math.min(img.naturalWidth, img.naturalHeight) / want));
            if (zoom > 1.08 * crop.zoom) {
              setCrop(clampCrop({ zoom, x: crop.x - side / 2 + ((box.x0 + box.x1) / 2) * k, y: crop.y - side / 2 + ((box.y0 + box.y1) / 2) * k }));
              return;
            }
          }
        }
        setAnalysis({ key: cropKey, mask: m, usable, face: f ? { x0: f.x0 * WORK, y0: f.y0 * WORK, x1: f.x1 * WORK, y1: f.y1 * WORK } : null });
      } catch (e) { console.warn("analysis failed", e); if (!cancelled) setAiError(true); }
      finally { if (!cancelled) setAnalysing(false); }
    }, 300);
    return () => { cancelled = true; clearTimeout(id); };
  }, [img, cropKey, analysis?.key, aiError, cropPixels, bg, crop, side, clampCrop]);

  const options = useCallback((st: StyleId) => {
    const a = analysis?.key === cropKey ? analysis : null;
    const plain = bg !== "keep" && bg !== "soft" && bg !== "auto";
    return {
      style: st, mask: a?.mask ?? null, face: a?.face ?? null, outline: outlineTouched ? outline : undefined,
      bgMode: (plain ? "plain" : bg) as "auto" | "keep" | "soft" | "plain",
      bgCode: plain ? bg : null,
    };
  }, [analysis, cropKey, bg, outline, outlineTouched]);

  // Main render: immediate on every change (uses the latest analysis once it's ready).
  useEffect(() => {
    if (!img || palette.length === 0) return;
    // short debounce: dragging a slider re-renders once it pauses, not on every pixel of travel
    const raf = setTimeout(() => {
      const work = new Uint8ClampedArray(cropPixels().data);
      adjustPixels(work, adj);
      try {
        const r = renderMosaicV5(work, WORK, palette, options(style));
        setResult({ pattern: r.pattern, avg: r.averageDeltaE, flat: !!r.flat, kind: r.kind, outline: !!r.outline });
      } catch { /* style has no colours in stock */ }
    }, 70);
    return () => clearTimeout(raf);
  }, [img, cropKey, cropPixels, adj, palette, style, options]);

  // Style thumbnails: rendered once things settle, so the customer can compare looks at a glance.
  useEffect(() => {
    if (!img || analysing) return;
    const id = setTimeout(() => {
      const work = new Uint8ClampedArray(cropPixels().data);
      adjustPixels(work, adj);
      const next: Partial<Record<StyleId, Pattern>> = {};
      for (const st of STYLES) { try { next[st.id] = renderMosaicV5(work, WORK, palette, options(st.id)).pattern; } catch {} }
      setPreviews(next);
    }, 450);
    return () => clearTimeout(id);
  }, [img, cropKey, cropPixels, adj, palette, options, analysing]);

  const subjectFound = analysis?.key === cropKey ? analysis.usable : null;

  // ---- framing box drag ----
  const drag = useRef<{ px: number; py: number; cx: number; cy: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, cx: crop.x, cy: crop.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !img) return;
    const scale = side / CROP_VIEW; // image px per screen px
    setCrop(clampCrop({ zoom: crop.zoom, x: drag.current.cx - (e.clientX - drag.current.px) * scale, y: drag.current.cy - (e.clientY - drag.current.py) * scale }));
  };
  const onPointerUp = () => { drag.current = null; };

  const approve = () => {
    if (!result || !img || !agreed) return;
    // keep a small copy of the framed photo with the order (for support and reprints)
    const thumb = document.createElement("canvas");
    thumb.width = 256; thumb.height = 256;
    thumb.getContext("2d")!.drawImage(img, crop.x - side / 2, crop.y - side / 2, side, side, 0, 0, 256, 256);
    add({
      key: `cu:${Date.now()}`, kind: "CUSTOM", title: "Custom PLAQA", titleAr: "لوحة مخصصة", price, qty: 1,
      pattern: finalPattern ?? result.pattern, sourceImage: thumb.toDataURL("image/jpeg", 0.82), acceptedAt: new Date().toISOString(),
    });
    router.push("/cart");
  };

  const finalPattern = useMemo(() => {
    if (!result) return null;
    if (!edits.size) return result.pattern;
    const p = [...result.pattern]; edits.forEach((c, i) => { p[i] = c; }); return p;
  }, [result, edits]);
  // changing the photo settings regenerates the artwork, so touch-ups no longer line up: clear them
  const settingsKey = `${cropKey}|${style}|${bg}|${JSON.stringify(adj)}|${outline}|${outlineTouched}`;
  const lastSettings = useRef(settingsKey);
  useEffect(() => {
    if (lastSettings.current !== settingsKey) { lastSettings.current = settingsKey; if (edits.size) { setEdits(new Map()); setHistory([]); } }
  }, [settingsKey, edits.size]);
  const paint = (i: number, code: string) => {
    if (!strokeStart.current) strokeStart.current = new Map(edits);
    setEdits((prev) => { const n = new Map(prev); if (result && result.pattern[i] === code) n.delete(i); else n.set(i, code); return n; });
    setAgreed(false);
  };
  const endStroke = () => { const before = strokeStart.current; strokeStart.current = null; if (before) setHistory((h) => [...h.slice(-49), before]); };
  const undo = () => { if (!history.length) return; setEdits(history[history.length - 1]); setHistory(history.slice(0, -1)); };

  const reset = () => { setImg(null); setResult(null); setAgreed(false); setEdits(new Map()); setHistory([]); setEditing(false); if (fileInput.current) fileInput.current.value = ""; };
  const counts = finalPattern ? countColors(finalPattern) : [];
  // A visibly lossy conversion gets an honest note before approval.
  const substituted = !!result && !result.flat && style === "colour" && result.avg > 14;

  // ---------- upload state ----------
  if (!img) {
    return (
      <div className="mx-auto max-w-[1320px] px-5 pt-14 md:px-8 md:pt-20">
        <div className="max-w-2xl">
          <h1 className="text-[clamp(40px,6vw,76px)] font-semibold">{t("custom.title")}</h1>
          <p className="mt-5 text-lg text-ink-soft">{t("custom.lede")}</p>
        </div>
        <label
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); loadFile(e.dataTransfer.files?.[0]); }}
          className={`grid-paper mt-12 flex min-h-[420px] cursor-pointer flex-col items-center justify-center rounded-[4px] border-2 border-dashed px-6 text-center transition-colors ${dragOver ? "border-ink bg-powder/40" : "border-ink/20 bg-linen hover:border-ink/40"}`}
        >
          <input ref={fileInput} type="file" accept="image/*" className="sr-only" onChange={(e) => loadFile(e.target.files?.[0])} />
          <UploadGlyph />
          <span className="mt-6 font-display text-2xl">{t("custom.drop")}</span>
          <span className="mt-2 max-w-sm text-ink-soft">{t("custom.dropHint")}</span>
          <span className="btn btn-ink mt-8">{t("custom.choose")}</span>
        </label>
        {error && <p role="alert" className="mt-4 text-danger">{error}</p>}
        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          {(["custom.tip1", "custom.tip2", "custom.tip3"] as const).map((k, i) => (
            <div key={k} className="border-t border-ink pt-4">
              <p className="font-medium">{t(`custom.tip${i + 1}t` as "custom.tip1t")}</p>
              <p className="mt-1 text-sm text-ink-soft">{t(k)}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 text-sm text-ink-mute">{formatMoney(price, "KWD", locale)} · 1,024 · 26 × 26 cm</p>
      </div>
    );
  }

  // ---------- studio state ----------
  const scale = CROP_VIEW / side;
  return (
    <div className="mx-auto max-w-[1320px] px-5 pt-8 md:px-8 md:pt-12">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-14">
        {/* Preview */}
        <section aria-label={t("custom.preview")} className="self-start lg:sticky lg:top-24">
          <div className="grid-paper relative flex aspect-square items-center justify-center rounded-[4px] bg-linen">
            <div className={`frame ${editing ? "w-[88%]" : "w-[70%]"}`}>
              {finalPattern && editing && <PixelCanvas pattern={finalPattern} hex={hex} color={brush} tool={tool} onPaint={paint} onPick={(c) => { setBrush(c); setTool("paint"); }} onStrokeEnd={endStroke} />}
              {finalPattern && !editing && !showOriginal && <MosaicCanvas pattern={finalPattern} hex={hex} resolution={24} label={t("custom.preview")} />}
              {showOriginal && <OriginalCrop img={img} crop={crop} side={side} />}
            </div>
            {!editing && <div className="absolute bottom-4 start-4 flex rounded-full bg-paper p-1 text-sm shadow-[inset_0_0_0_1px_var(--color-stone)]" role="group">
              <button onClick={() => setShowOriginal(false)} aria-pressed={!showOriginal} className={`rounded-full px-4 py-1.5 ${!showOriginal ? "bg-ink text-cream" : ""}`}>{t("custom.preview")}</button>
              <button onClick={() => setShowOriginal(true)} aria-pressed={showOriginal} className={`rounded-full px-4 py-1.5 ${showOriginal ? "bg-ink text-cream" : ""}`}>{t("custom.original")}</button>
            </div>}
          </div>
          {result && (
            <ul className="mt-4 flex h-6 gap-1" aria-label={`${counts.length} ${t("custom.colorsUsed")}`}>
              {counts.map(({ code, count }) => (
                <li key={code} title={`${locale === "ar" ? byCode.get(code)?.nameAr : byCode.get(code)?.nameEn} · ${count}`}
                  className="h-full min-w-[6px] rounded-[4px]" style={{ background: hex[code], flexGrow: count }} />
              ))}
            </ul>
          )}
        </section>

        {/* Controls */}
        {editing && finalPattern ? (
          <section className="self-start lg:sticky lg:top-24">
            <PixelTools pattern={finalPattern} palette={palette} color={brush} setColor={setBrush} tool={tool} setTool={setTool}
              canUndo={history.length > 0} onUndo={undo} onReset={() => { setEdits(new Map()); setHistory([]); }} edits={edits.size} onDone={() => setEditing(false)} />
          </section>
        ) : (
        <section className="flex flex-col gap-10">
          <div>
            <div className="flex items-baseline justify-between gap-4">
              <h1 className="text-[clamp(32px,4vw,48px)] font-semibold">{t("custom.preview")}</h1>
              <span className="text-lg tabular-nums">{formatMoney(price, "KWD", locale)}</span>
            </div>
            <p className="mt-2 text-ink-soft">1,024 · {counts.length} {t("custom.colorsUsed")} · 26 × 26 cm</p>
          </div>

          <div>
            <h2 className="text-lg font-medium">{t("custom.crop")}</h2>
            <p className="mt-1 text-sm text-ink-soft">{t("custom.cropHint")}</p>
            <div className="mt-4 flex flex-wrap items-end gap-6">
              <div
                className="relative shrink-0 cursor-grab touch-none overflow-hidden rounded-[6px] bg-stone active:cursor-grabbing"
                style={{ width: CROP_VIEW, height: CROP_VIEW }}
                onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
                role="application" aria-label={t("custom.crop")}
                tabIndex={0}
                onKeyDown={(e) => {
                  const step = side * 0.04;
                  const k: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
                  if (k[e.key]) { e.preventDefault(); setCrop(clampCrop({ ...crop, x: crop.x + k[e.key][0], y: crop.y + k[e.key][1] })); }
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.src} alt="" draggable={false} className="pointer-events-none absolute max-w-none select-none"
                  style={{ width: img.naturalWidth * scale, height: img.naturalHeight * scale, left: CROP_VIEW / 2 - crop.x * scale, top: CROP_VIEW / 2 - crop.y * scale }} />
                <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,.6)]" style={{ backgroundImage: "linear-gradient(to right, rgba(255,255,255,.35) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,.35) 1px, transparent 1px)", backgroundSize: `${CROP_VIEW / 4}px ${CROP_VIEW / 4}px` }} />
              </div>
              <div className="min-w-[200px] flex-1">
                <Slider label={t("custom.zoom")} min={1} max={4} step={0.01} value={crop.zoom}
                  onChange={(v) => setCrop(clampCrop({ ...crop, zoom: v }))} display={`${crop.zoom.toFixed(1)}×`} />
                {crowd > 2 && <p className="mt-4 rounded-[8px] bg-butter/40 p-3 text-sm">{t("custom.crowd").replace("{n}", String(crowd))}</p>}
                {faceSuggest && !faceFramed && (
                  <p className="mt-4 text-sm">
                    <button className="rounded-full bg-sage/60 px-3 py-1 hover:bg-sage" onClick={() => { setFaceFramed(crop); setCrop(faceSuggest); setFaceSuggest(null); }}>{t("custom.faceZoom")}</button>
                  </p>
                )}
                {faceFramed && (
                  <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="rounded-full bg-sage/60 px-3 py-1">{t("custom.faceFramed")}</span>
                    <button className="text-ink-soft underline underline-offset-4" onClick={() => { setFaceSuggest(crop); setCrop(faceFramed); setFaceFramed(null); }}>{t("custom.faceUndo")}</button>
                  </p>
                )}
              </div>
            </div>
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-medium">{t("custom.style")}</h2>
              {result && !analysing && <span className="rounded-full bg-powder/60 px-3 py-1 text-sm">{t("custom.detected")} · {locale === "ar" ? KIND_LABEL[result.kind].ar : KIND_LABEL[result.kind].en}</span>}
            </div>
            <div className="mt-3 grid grid-cols-4 gap-3" role="radiogroup" aria-label={t("custom.style")}>
              {STYLES.map((st) => (
                <button key={st.id} role="radio" aria-checked={style === st.id} onClick={() => setStyle(st.id)}
                  className={`group flex flex-col gap-2 rounded-[10px] p-1.5 text-start transition-shadow ${style === st.id ? "shadow-[0_0_0_2px_var(--color-ink)]" : "shadow-[inset_0_0_0_1px_var(--color-stone)] hover:shadow-[inset_0_0_0_1px_var(--color-ink-mute)]"}`}>
                  <span className="block overflow-hidden rounded-[6px] bg-linen">
                    {previews[st.id] ? <MosaicCanvas pattern={previews[st.id]!} hex={hex} resolution={5} label={st.nameEn} /> : <span className="block aspect-square animate-pulse bg-stone/60" />}
                  </span>
                  <span className="px-1 pb-0.5 text-sm">{locale === "ar" ? st.nameAr : st.nameEn}</span>
                </button>
              ))}
            </div>
            {result?.flat && style !== "mono" && style !== "vintage" && <p className="mt-3 text-sm text-ink-soft">{t("custom.flatNote")}</p>}
          </div>

          <div>
            <h2 className="text-lg font-medium">{t("custom.background")}</h2>
            <p className="mt-1 text-sm text-ink-soft">{t("custom.bgHint")}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t("custom.background")}>
              {(["auto", "keep", "soft"] as const).map((m) => (
                <button key={m} role="radio" aria-checked={bg === m} onClick={() => setBg(m)}
                  className={`h-10 rounded-full px-4 text-[15px] ${bg === m ? "bg-ink text-cream" : "bg-paper shadow-[inset_0_0_0_1px_var(--color-stone)] hover:bg-linen"}`}>{t(m === "auto" ? "custom.bgAuto" : m === "keep" ? "custom.bgKeep" : "custom.bgSoft")}</button>
              ))}
              {BG_CODES.filter((c) => hex[c]).map((c) => (
                <button key={c} role="radio" aria-checked={bg === c} onClick={() => setBg(c)} title={locale === "ar" ? byCode.get(c)?.nameAr : byCode.get(c)?.nameEn}
                  aria-label={locale === "ar" ? byCode.get(c)?.nameAr : byCode.get(c)?.nameEn}
                  className={`h-10 w-10 rounded-full transition-shadow ${bg === c ? "shadow-[0_0_0_2px_var(--color-cream),0_0_0_4px_var(--color-ink)]" : "shadow-[inset_0_0_0_1px_rgba(0,0,0,.12)]"}`}
                  style={{ background: hex[c] }} />
              ))}
            </div>
            {analysing && <p className="mt-3 text-sm text-ink-soft" role="status">{t("custom.analysing")}</p>}
            {aiError && <p className="mt-3 text-sm text-danger" role="alert">{t("custom.bgError")}</p>}
            {!analysing && subjectFound === false && bg !== "keep" && <p className="mt-3 text-sm text-ink-soft" role="status">{t("custom.bgUnusable")}</p>}
            {bg !== "keep" && bg !== "soft" && subjectFound && (
              <label className="mt-4 flex cursor-pointer items-start justify-between gap-6">
                <span><span className="block">{t("custom.outline")}</span><span className="text-sm text-ink-soft">{t("custom.outlineHint")}</span></span>
                <Toggle checked={outlineTouched ? outline : !!result?.outline} onChange={(v) => { setOutline(v); setOutlineTouched(true); }} label={t("custom.outline")} />
              </label>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">{t("custom.adjust")}</h2>
              {(adj.brightness !== DEFAULT_ADJUSTMENTS.brightness || adj.contrast !== DEFAULT_ADJUSTMENTS.contrast || adj.saturation !== DEFAULT_ADJUSTMENTS.saturation) && (
                <button className="flex items-center gap-1.5 rounded-full bg-paper px-3 py-1.5 text-sm shadow-[inset_0_0_0_1px_var(--color-stone)] hover:bg-linen" onClick={() => setAdj(DEFAULT_ADJUSTMENTS)}>
                  <span aria-hidden>↺</span>{t("custom.reset")}
                </button>
              )}
            </div>
            <div className="mt-4 grid gap-5">
              <Slider label={t("custom.brightness")} min={-50} max={50} step={1} value={adj.brightness} onChange={(v) => setAdj({ ...adj, brightness: v })} />
              <Slider label={t("custom.contrast")} min={-50} max={50} step={1} value={adj.contrast} onChange={(v) => setAdj({ ...adj, contrast: v })} />
              <Slider label={t("custom.saturation")} min={-50} max={50} step={1} value={adj.saturation} onChange={(v) => setAdj({ ...adj, saturation: v })} />
            </div>
          </div>

          {/* Approval: the customer signs off on this exact artwork */}
          <div className="rounded-[4px] bg-paper p-6 shadow-[inset_0_0_0_1px_var(--color-stone)] md:p-8">
            <h2 className="text-xl font-medium">{t("custom.acceptTitle")}</h2>
            {substituted && <p className="mt-3 rounded-[6px] bg-butter/40 p-3 text-sm">{t("custom.substituted")}</p>}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[8px] bg-linen p-4">
              <span className="text-sm">{t("custom.tuneHint")}{edits.size ? ` · ${edits.size} ${t("custom.tuneCount")}` : ""}</span>
              <button className="btn btn-line btn-sm" onClick={() => { setEditing(true); setShowOriginal(false); if (finalPattern) setBrush(countColors(finalPattern)[0]?.code ?? "F26"); }}>{t("custom.tune")}</button>
            </div>
            <p className="mt-4 text-ink-soft">{t("custom.acceptBody")}</p>
            <label className="mt-5 flex cursor-pointer items-start gap-3">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[#242826]" />
              <span>{t("custom.acceptCheck")}</span>
            </label>
            <div className="mt-6 flex flex-wrap gap-3">
              <button className="btn btn-ink flex-1" disabled={!agreed || !result} onClick={approve}>{t("custom.accept")}</button>
              <button className="btn btn-line" onClick={reset}>{t("custom.reject")}</button>
            </div>
          </div>
        </section>
        )}
      </div>
    </div>
  );
}

function OriginalCrop({ img, crop, side }: { img: HTMLImageElement; crop: Crop; side: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    c.width = 768; c.height = 768;
    c.getContext("2d")!.drawImage(img, crop.x - side / 2, crop.y - side / 2, side, side, 0, 0, 768, 768);
  }, [img, crop, side]);
  return <canvas ref={ref} className="block aspect-square w-full" aria-label="Original photo" />;
}

function Slider({ label, min, max, step, value, onChange, display }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; display?: string }) {
  return (
    <label className="block">
      <span className="flex justify-between text-sm"><span>{label}</span><span className="tabular-nums text-ink-mute">{display ?? (value > 0 ? `+${value}` : value)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-[#242826]" />
    </label>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${checked ? "bg-ink" : "bg-stone"}`}>
      <span className={`absolute top-1 h-5 w-5 rounded-full bg-cream transition-all ${checked ? "start-6" : "start-1"}`} />
    </button>
  );
}

function UploadGlyph() {
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden>
      {[0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => (
        <rect key={`${i}${j}`} x={10 + i * 18} y={10 + j * 18} width="15" height="15" rx="4"
          fill={["#B8D6A5", "#B8D5F0", "#F3D58B", "#A8D2C1", "#242826", "#B8D5F0", "#F3D58B", "#B8D6A5", "#EF98A8"][i * 3 + j]} />
      )))}
    </svg>
  );
}
