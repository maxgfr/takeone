/**
 * Stills of the screen for the AI edit: the moments worth looking at (just
 * after the screen changed, and every few seconds in between), drawn with a
 * grid of tenths so the model can read where things are, as JPEG.
 */

import { groupActivity } from "../edit/zooms";
import { mediaFrames } from "../export/frames";
import type { Clip } from "../model/project";

/** Stills closer than this, in seconds, are one. */
const MIN_GAP = 2;
/** A still at least this often when nothing changes. */
const EVERY = 10;
/** Shown a moment after a change, once it has settled. */
const SETTLE = 0.4;

/** When to look at a take: after each group of changes, and regularly in between; at most `max`. */
export function stillTimes(clip: Clip, max: number): number[] {
  if (max <= 0 || clip.duration <= 0) return [];
  const end = Math.max(0, clip.duration - 0.1);
  const changes = groupActivity(clip.activity).map((g) => Math.min(end, g.end + SETTLE));
  const times: number[] = [];
  for (const t of [...changes].sort((a, b) => a - b))
    if (!times.some((x) => Math.abs(x - t) < MIN_GAP)) times.push(t);
  for (let t = Math.min(1, end); t <= end; t += EVERY)
    if (!times.some((x) => Math.abs(x - t) < MIN_GAP)) times.push(t);
  times.sort((a, b) => a - b);
  if (times.length <= max) return times;
  // Evenly spread over the ones found, the first kept.
  return Array.from(
    { length: max },
    (_, i) => times[Math.round((i * (times.length - 1)) / Math.max(1, max - 1))] as number,
  );
}

/** How many stills each take gets out of `total`: by length, at least two each when possible. */
export function stillBudget(clips: readonly Clip[], total: number): number[] {
  const length = clips.reduce((n, c) => n + Math.max(0, c.duration), 0);
  if (!length) return clips.map(() => 0);
  const share = clips.map((c) =>
    Math.max(Math.min(2, total), Math.floor((total * c.duration) / length)),
  );
  let over = share.reduce((a, b) => a + b, 0) - total;
  for (let i = share.length - 1; over > 0 && i >= 0; i--) {
    const take = Math.min(over, Math.max(0, (share[i] as number) - 1));
    share[i] = (share[i] as number) - take;
    over -= take;
  }
  return share;
}

/** A grid of tenths over the still, labelled on its top and left edges. */
export function drawGrid(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number): void {
  ctx.save();
  ctx.lineWidth = Math.max(1, Math.round(Math.min(w, h) / 600));
  ctx.strokeStyle = "rgba(255, 214, 0, 0.55)";
  ctx.setLineDash([6, 6]);
  for (let i = 1; i < 10; i++) {
    const x = Math.round((w * i) / 10) + 0.5;
    const y = Math.round((h * i) / 10) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  const size = Math.max(11, Math.round(Math.min(w, h) / 45));
  ctx.font = `bold ${size}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
  ctx.fillStyle = "rgb(255, 214, 0)";
  for (let i = 1; i < 10; i++) {
    const label = `.${i}`;
    const x = (w * i) / 10 + 3;
    const y = (h * i) / 10 + 3;
    ctx.strokeText(label, x, 3);
    ctx.fillText(label, x, 3);
    ctx.strokeText(label, 3, y);
    ctx.fillText(label, 3, y);
  }
  ctx.restore();
}

export interface Still {
  /** On the take's clock. */
  t: number;
  jpeg: Uint8Array;
}

/** The take's screen at those times (its own clock), gridded, at most `maxSide` pixels wide. */
export async function screenStills(
  projectId: string,
  clip: Clip,
  times: readonly number[],
  maxSide = 1280,
): Promise<Still[]> {
  const screen = clip.screen;
  if (!screen || !times.length) return [];
  const sorted = [...times].sort((a, b) => a - b);
  const track = await mediaFrames(
    projectId,
    screen,
    sorted.map((t) => Math.max(0, t - screen.offset)),
    maxSide,
  );
  if (!track) return [];
  const out: Still[] = [];
  try {
    for (const t of sorted) {
      const frame = await track.next();
      if (!frame) break;
      const canvas = new OffscreenCanvas(frame.width, frame.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      ctx.drawImage(frame, 0, 0);
      drawGrid(ctx, frame.width, frame.height);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.78 });
      out.push({ t, jpeg: new Uint8Array(await blob.arrayBuffer()) });
    }
  } finally {
    track.dispose();
  }
  return out;
}
