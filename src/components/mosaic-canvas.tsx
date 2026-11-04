"use client";
import { useEffect, useRef } from "react";
import { GRID, type Pattern } from "@/lib/mosaic";

type Props = {
  pattern: Pattern;
  hex: Record<string, string>;
  className?: string;
  /** highlight one colour; others are dimmed */
  highlight?: string | null;
  /** only draw cells inside this rectangle (others shown as empty plate) */
  region?: { x0: number; y0: number; w: number; h: number } | null;
  /** draw bag numbers inside cells */
  numbers?: Map<string, number> | null;
  /** cells to draw, for the assembling animation; undefined = all */
  visible?: Uint8Array;
  label?: string;
  resolution?: number; // canvas pixels per cell
};

export function drawMosaic(ctx: CanvasRenderingContext2D, cell: number, p: Props, ox = 0, oy = 0, cols = GRID, rows = GRID) {
  const W = cols * cell, H = rows * cell;
  ctx.fillStyle = "#161817";
  ctx.fillRect(0, 0, W, H);
  const gap = Math.max(0.5, cell / 32);
  const r = cell * 0.16;
  const inner = cell - gap * 2;
  for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
    const x = ox + gx, y = oy + gy;
    const i = y * GRID + x;
    const code = p.pattern[i];
    const inRegion = !p.region || (x >= p.region.x0 && x < p.region.x0 + p.region.w && y >= p.region.y0 && y < p.region.y0 + p.region.h);
    const px = gx * cell + gap, py = gy * cell + gap;
    if (p.visible && !p.visible[i]) {
      // empty baseplate stud
      ctx.fillStyle = "#222524";
      ctx.beginPath(); ctx.arc(px + inner / 2, py + inner / 2, inner * 0.26, 0, Math.PI * 2); ctx.fill();
      continue;
    }
    const dim = (p.highlight && code !== p.highlight) || !inRegion;
    ctx.globalAlpha = dim ? (inRegion ? 0.16 : 0.1) : 1;
    ctx.fillStyle = p.hex[code] ?? "#888";
    ctx.beginPath(); ctx.roundRect(px, py, inner, inner, r); ctx.fill();
    // light from top-left
    const g = ctx.createLinearGradient(px, py, px + inner, py + inner);
    g.addColorStop(0, "rgba(255,255,255,0.16)"); g.addColorStop(0.5, "rgba(255,255,255,0)"); g.addColorStop(1, "rgba(0,0,0,0.12)");
    ctx.fillStyle = g; ctx.fill();
    ctx.globalAlpha = 1;
    if (p.numbers && !dim && cell >= 18) {
      const n = p.numbers.get(code);
      if (n !== undefined) {
        const hex = p.hex[code] ?? "#888";
        const rr = parseInt(hex.slice(1, 3), 16), gg = parseInt(hex.slice(3, 5), 16), bb = parseInt(hex.slice(5, 7), 16);
        ctx.fillStyle = 0.299 * rr + 0.587 * gg + 0.114 * bb > 150 ? "rgba(36,40,38,.85)" : "rgba(251,247,239,.92)";
        ctx.font = `600 ${Math.round(cell * 0.42)}px "DM Sans Variable", system-ui, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(String(n), px + inner / 2, py + inner / 2 + 1);
      }
    }
  }
}

export function MosaicCanvas(props: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cols = props.region && props.numbers ? props.region.w : GRID;
  const rows = props.region && props.numbers ? props.region.h : GRID;
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const cell = props.resolution ?? 24;
    c.width = cols * cell; c.height = rows * cell;
    const ctx = c.getContext("2d"); if (!ctx) return;
    // in numbered guide mode a region is cropped (zoomed), otherwise just dimmed
    if (props.region && props.numbers) drawMosaic(ctx, cell, { ...props, region: null }, props.region.x0, props.region.y0, cols, rows);
    else drawMosaic(ctx, cell, props);
  }, [props, cols, rows]);
  return <canvas ref={ref} role="img" aria-label={props.label ?? "Mosaic preview"} className={props.className} style={{ aspectRatio: `${cols} / ${rows}`, width: "100%", height: "auto", display: "block" }} />;
}
