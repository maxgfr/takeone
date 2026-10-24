/**
 * The compositor: one function draws any instant of the edit on a canvas, for
 * the preview and for every export. The output is a background with, on it,
 * the screen (zoomed on a region, with blurred areas) and the camera, placed
 * by the layout of the moment; a change of layout slides from one placement
 * to the other, and zooms ease in and out.
 *
 * Every size is a fraction of the output's shorter side, so a 720p preview
 * and a 4K export, or a 16:9 and a 9:16 version, draw the same picture.
 */

import { type Range, rangeAt } from "../edit/timeline";
import type { Aspect, Box, LayoutKind, Project, Style } from "../model/project";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Source {
  src: CanvasImageSource;
  /** Natural size of the source. */
  w: number;
  h: number;
}

export interface Placement {
  screen: Rect | null;
  camera: Rect | null;
  /** The camera is a circle (the bubble), else a rounded rectangle. */
  round: boolean;
}

export const FULL: Box = { x: 0, y: 0, w: 1, h: 1 };

export const BACKGROUNDS: Record<string, [string, string]> = {
  ember: ["#ff7a59", "#b03aa8"],
  aurora: ["#6d5efc", "#d16ba5"],
  ocean: ["#2563eb", "#22d3ee"],
  mint: ["#10b981", "#a3e635"],
  dusk: ["#1e1b4b", "#475569"],
  paper: ["#f1f0f5", "#dcd9e6"],
};

const ASPECT_RATIO: Record<Aspect, number> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
  "4:3": 4 / 3,
};

/** The output's size for a height (or width, for portrait) of `side` pixels; even numbers. */
export function outputSize(aspect: Aspect, side: number): { w: number; h: number } {
  const r = ASPECT_RATIO[aspect];
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return r >= 1 ? { w: even(side * r), h: even(side) } : { w: even(side), h: even(side / r) };
}

export const ease = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
function lerpRect(a: Rect | null, b: Rect | null, k: number): Rect | null {
  if (!a) return k < 0.5 ? null : b;
  if (!b) return k < 0.5 ? a : null;
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) };
}

/** `aspect` (width/height) fitted inside `area`, centered. */
export function contain(area: Rect, aspect: number): Rect {
  const w = Math.min(area.w, area.h * aspect);
  const h = w / aspect;
  return { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
}

/** The layout that can be drawn with the sources there are. */
export function usableLayout(
  layout: LayoutKind,
  hasScreen: boolean,
  hasCamera: boolean,
): LayoutKind {
  if (!hasCamera) return "screen";
  if (!hasScreen) return "camera";
  return layout;
}

/** Where the screen and the camera go for a layout, on a W × H output. */
export function placements(
  layout: LayoutKind,
  W: number,
  H: number,
  style: Style,
  screenAspect: number,
): Placement {
  const m = Math.min(W, H);
  const pad = style.padding * m;
  const area: Rect = { x: pad, y: pad, w: W - 2 * pad, h: H - 2 * pad };
  const gap = Math.max(pad * 0.6, m * 0.02);
  switch (layout) {
    case "screen":
      return { screen: contain(area, screenAspect), camera: null, round: false };
    case "camera":
      return { screen: null, camera: area, round: false };
    case "side": {
      if (W >= H) {
        const sw = (area.w - gap) * 0.7;
        const screen = contain({ ...area, w: sw }, screenAspect);
        const camera = { x: area.x + sw + gap, y: screen.y, w: area.w - sw - gap, h: screen.h };
        return { screen, camera, round: false };
      }
      const screen = contain({ ...area, h: area.h * 0.55 }, screenAspect);
      const top = screen.y + screen.h + gap;
      return {
        screen,
        camera: { x: area.x, y: top, w: area.w, h: area.y + area.h - top },
        round: false,
      };
    }
    default: {
      const screen = contain(area, screenAspect);
      const d = style.bubble.size * m;
      const margin = Math.max(pad * 0.5, m * 0.025);
      const c = style.bubble.corner;
      const x = c.endsWith("left") ? margin : W - margin - d;
      const y = c.startsWith("top") ? margin : H - margin - d;
      return { screen, camera: { x, y, w: d, h: d }, round: style.bubble.shape === "circle" };
    }
  }
}

/** How long a change of layout or a zoom takes, in seconds. */
export const MOVE = 0.45;

/** The layout of a clip at `t`, and how far the slide from the previous one has gone. */
export function layoutAt(
  p: Pick<Project, "layouts" | "style">,
  clipId: string,
  t: number,
): { layout: LayoutKind; from: LayoutKind; k: number } {
  const at = (x: number) => rangeAt(p.layouts, clipId, x)?.layout ?? p.style.layout;
  const now = at(t);
  // The latest boundary of a layout range before t, within one move.
  let boundary = Number.NEGATIVE_INFINITY;
  for (const r of p.layouts) {
    if (r.clip !== clipId) continue;
    for (const b of [r.start, r.end]) if (b <= t && b > boundary && t - b < MOVE) boundary = b;
  }
  if (!Number.isFinite(boundary)) return { layout: now, from: now, k: 1 };
  const from = at(boundary - 1e-3);
  return { layout: now, from, k: from === now ? 1 : ease((t - boundary) / MOVE) };
}

/** The region of the screen shown at `t`: the zoom's, eased in and out. */
export function viewAt(
  zooms: readonly (Range & { clip: string; box: Box })[],
  clipId: string,
  t: number,
): Box {
  let best: Box = FULL;
  let bestK = 0;
  for (const z of zooms) {
    if (z.clip !== clipId || t < z.start - 1e-6 || t > z.end) continue;
    const k = ease(Math.min((t - z.start) / MOVE, (z.end - t) / MOVE));
    if (k > bestK) {
      bestK = k;
      best = z.box;
    }
  }
  if (bestK <= 0) return FULL;
  return {
    x: lerp(0, best.x, bestK),
    y: lerp(0, best.y, bestK),
    w: lerp(1, best.w, bestK),
    h: lerp(1, best.h, bestK),
  };
}

/** Placement at `t`, sliding between the previous layout and the current one. */
export function placementAt(
  p: Pick<Project, "layouts" | "style">,
  clipId: string,
  t: number,
  W: number,
  H: number,
  screenAspect: number,
  hasScreen: boolean,
  hasCamera: boolean,
): Placement {
  const { layout, from, k } = layoutAt(p, clipId, t);
  const now = placements(usableLayout(layout, hasScreen, hasCamera), W, H, p.style, screenAspect);
  if (k >= 1) return now;
  const before = placements(usableLayout(from, hasScreen, hasCamera), W, H, p.style, screenAspect);
  return {
    screen: lerpRect(before.screen, now.screen, k),
    camera: lerpRect(before.camera, now.camera, k),
    round: k < 0.5 ? before.round : now.round,
  };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function paintBackground(ctx: Ctx, background: string, W: number, H: number): void {
  const g = BACKGROUNDS[background];
  if (g) {
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, g[0]);
    grad.addColorStop(1, g[1]);
    ctx.fillStyle = grad;
  } else ctx.fillStyle = background === "none" ? "#000000" : background;
  ctx.fillRect(0, 0, W, H);
}

function shape(ctx: Ctx, r: Rect, radius: number, round: boolean): void {
  ctx.beginPath();
  if (round) ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
  else ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(radius, r.w / 2, r.h / 2));
}

function shadowed(ctx: Ctx, r: Rect, radius: number, round: boolean, m: number): void {
  ctx.save();
  ctx.shadowColor = "rgba(8, 6, 20, 0.45)";
  ctx.shadowBlur = m * 0.035;
  ctx.shadowOffsetY = m * 0.012;
  ctx.fillStyle = "#000";
  shape(ctx, r, radius, round);
  ctx.fill();
  ctx.restore();
}

export interface FrameState {
  placement: Placement;
  view: Box;
  blurs: Box[];
}

/** Draws one frame: background, screen (zoomed, blurred where asked), camera. */
export function drawFrame(
  ctx: Ctx,
  W: number,
  H: number,
  style: Style,
  screen: Source | null,
  camera: Source | null,
  state: FrameState,
): void {
  const m = Math.min(W, H);
  const radius = style.radius * m;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  paintBackground(ctx, style.background, W, H);
  const { placement: pl, view } = state;

  if (pl.screen && screen) {
    const r = pl.screen;
    if (style.shadow) shadowed(ctx, r, radius, false, m);
    ctx.save();
    shape(ctx, r, radius, false);
    ctx.clip();
    const sx = view.x * screen.w;
    const sy = view.y * screen.h;
    const sw = view.w * screen.w;
    const sh = view.h * screen.h;
    ctx.drawImage(screen.src, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
    // Blurred regions, through the zoom: drawn again, blurred, inside their box.
    for (const b of state.blurs) {
      const bx = r.x + ((b.x - view.x) / view.w) * r.w;
      const by = r.y + ((b.y - view.y) / view.h) * r.h;
      const bw = (b.w / view.w) * r.w;
      const bh = (b.h / view.h) * r.h;
      if (bw <= 0 || bh <= 0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(bx, by, bw, bh);
      ctx.clip();
      ctx.filter = `blur(${Math.max(6, m * 0.018)}px)`;
      ctx.drawImage(screen.src, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
      ctx.restore();
    }
    ctx.restore();
  }

  if (pl.camera && camera) {
    const r = pl.camera;
    if (style.shadow || pl.round) shadowed(ctx, r, radius, pl.round, m);
    ctx.save();
    shape(ctx, r, radius, pl.round);
    ctx.clip();
    // Cover: crop the camera to the placement's shape, from the middle.
    const target = r.w / r.h;
    const src = camera.w / camera.h;
    let cw = camera.w;
    let ch = camera.h;
    if (src > target) cw = camera.h * target;
    else ch = camera.w / target;
    const cx = (camera.w - cw) / 2;
    const cy = (camera.h - ch) / 2;
    if (style.bubble.mirror) {
      ctx.translate(r.x + r.w, r.y);
      ctx.scale(-1, 1);
      ctx.drawImage(camera.src, cx, cy, cw, ch, 0, 0, r.w, r.h);
    } else ctx.drawImage(camera.src, cx, cy, cw, ch, r.x, r.y, r.w, r.h);
    ctx.restore();
    if (pl.round) {
      ctx.save();
      ctx.lineWidth = Math.max(2, m * 0.006);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      shape(ctx, r, radius, true);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
}
