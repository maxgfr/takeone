/**
 * Where the screen changes while recording: four times a second, a small
 * grayscale copy is compared with the previous one, and the region that
 * changed is kept with its time. The editor turns these into zooms (a menu
 * opening, a field being typed in) and leaves out whole-screen changes
 * (scrolling, a new page).
 */
import type { Activity, Box } from "../model/project";

export const SAMPLE_WIDTH = 160;

export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] =
      ((rgba[i] as number) * 77 + (rgba[i + 1] as number) * 150 + (rgba[i + 2] as number) * 29) >>
      8;
  }
  return out;
}

/** Share of pixels that changed by more than `level`, and the box around them. */
export function diffFrames(
  a: Uint8Array,
  b: Uint8Array,
  w: number,
  h: number,
  level = 24,
): { ratio: number; box: Box | null } {
  let changed = 0;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (Math.abs((a[i] as number) - (b[i] as number)) > level) {
        changed++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (changed === 0) return { ratio: 0, box: null };
  return {
    ratio: changed / (w * h),
    box: { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h },
  };
}

/** At most this many moments are kept per take (about an hour of busy screen). */
const MAX_EVENTS = 12_000;

/** Collects the changes between consecutive samples. */
export class ActivityLog {
  readonly events: Activity[] = [];
  private prev: Uint8Array | null = null;

  /** Feeds one sample taken at `t` seconds. */
  push(gray: Uint8Array, w: number, h: number, t: number): void {
    const prev = this.prev;
    this.prev = gray;
    if (!prev || prev.length !== gray.length || this.events.length >= MAX_EVENTS) return;
    const d = diffFrames(prev, gray, w, h);
    // A few pixels are the cursor blinking or a clock; keep real changes only.
    if (d.box && d.ratio >= 0.0004) {
      const r = (v: number) => Math.round(v * 1000) / 1000;
      this.events.push({
        t: r(t),
        ratio: r(d.ratio),
        box: { x: r(d.box.x), y: r(d.box.y), w: r(d.box.w), h: r(d.box.h) },
      });
    }
  }
}
