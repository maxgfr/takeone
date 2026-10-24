/**
 * Zooms suggested from what changed on screen while recording: a menu that
 * opens, a field being typed in, a button's response. Changes close in time
 * are grouped; whole-screen changes (a new page, scrolling) and specks (the
 * cursor) are left out. Each group becomes a zoom on the region it touched,
 * with some context, held a moment after the last change.
 */
import { type Activity, type Box, type Clip, newId, type Zoom } from "../model/project";

/** A change smaller than this share of the screen is noise; larger is a new page. */
const MIN_AREA = 0.002;
const MAX_AREA = 0.25;
/** Changes closer than this, in seconds, belong to one zoom. */
const GAP = 1.6;
const LEAD = 0.6;
const HOLD = 1.8;
/** The zoom shows at most this much magnification, and at least this much. */
const MAX_SCALE = 2.4;
const MIN_SCALE = 1.35;

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/**
 * The region to show around `focus`: the focus with context, inside the screen. The same share
 * of the width and of the height keeps the screen's aspect ratio, so the zoom never distorts.
 */
export function frameAround(focus: Box): Box {
  const size = Math.min(1, Math.max(1 / MAX_SCALE, focus.w * 2.2, focus.h * 2.2));
  const w = size;
  const h = size;
  const cx = focus.x + focus.w / 2;
  const cy = focus.y + focus.h / 2;
  const x = Math.min(1 - w, Math.max(0, cx - w / 2));
  const y = Math.min(1 - h, Math.max(0, cy - h / 2));
  return { x, y, w, h };
}

/**
 * The view for a region already framed with its room (as the AI edit gives it): the region
 * itself, as wide as high in shares so the screen keeps its aspect, at most MAX_SCALE closer.
 */
export function frameRegion(region: Box): Box {
  const size = Math.min(1, Math.max(1 / MAX_SCALE, region.w * 1.1, region.h * 1.1));
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  return {
    x: Math.min(1 - size, Math.max(0, cx - size / 2)),
    y: Math.min(1 - size, Math.max(0, cy - size / 2)),
    w: size,
    h: size,
  };
}

/** Groups of nearby, mid-sized changes. */
export function groupActivity(
  events: readonly Activity[],
): { start: number; end: number; box: Box }[] {
  const groups: { start: number; end: number; box: Box }[] = [];
  for (const e of events) {
    const area = e.box.w * e.box.h;
    if (area < MIN_AREA || area > MAX_AREA) continue;
    const last = groups[groups.length - 1];
    const merged = last ? union(last.box, e.box) : null;
    if (last && merged && e.t - last.end <= GAP && merged.w * merged.h <= MAX_AREA) {
      last.end = e.t;
      last.box = merged;
    } else groups.push({ start: e.t, end: e.t, box: e.box });
  }
  return groups;
}

/** Zooms for one clip, from its activity. */
export function suggestZooms(clip: Clip): Zoom[] {
  const zooms: Zoom[] = [];
  for (const g of groupActivity(clip.activity)) {
    const box = frameAround(g.box);
    if (1 / box.w < MIN_SCALE) continue;
    const start = Math.max(0, g.start - LEAD);
    const end = Math.min(clip.duration, g.end + HOLD);
    const prev = zooms[zooms.length - 1];
    // Two zooms that would touch become one, on both regions.
    if (prev && start - prev.end < 0.8) {
      prev.end = end;
      prev.box = frameAround(union(prev.box, g.box));
      continue;
    }
    if (end - start >= 1)
      zooms.push({ id: newId("z"), clip: clip.id, start, end, box, auto: true });
  }
  return zooms;
}
