/**
 * Edits as pure functions of the project. The editor selects on the output's
 * timeline; these turn an output range into ranges on each take's clock (a
 * selection across a cut or two takes becomes several ranges).
 */
import { type Box, type Cut, type LayoutKind, newId, type Project } from "../model/project";
import { type Range, type Segment, sourceAt } from "./timeline";

/** The pieces of takes an output range covers. */
export function clipRanges(
  segments: readonly Segment[],
  range: Range,
): { clip: string; start: number; end: number }[] {
  const out: { clip: string; start: number; end: number }[] = [];
  for (const s of segments) {
    const len = s.end - s.start;
    const a = Math.max(range.start, s.at);
    const b = Math.min(range.end, s.at + len);
    if (b <= a) continue;
    const start = s.start + (a - s.at);
    const end = s.start + (b - s.at);
    const last = out[out.length - 1];
    // Neighbouring pieces of one take (split by a cut inside the range) stay apart.
    if (last && last.clip === s.clip.id && Math.abs(last.end - start) < 1e-6) last.end = end;
    else out.push({ clip: s.clip.id, start, end });
  }
  return out;
}

export function cutRange(
  p: Project,
  segments: readonly Segment[],
  range: Range,
  reason: Cut["reason"] = "manual",
): Project {
  const cuts = clipRanges(segments, range).map((r) => ({ id: newId("x"), ...r, reason }));
  return cuts.length ? { ...p, cuts: [...p.cuts, ...cuts] } : p;
}

export function restoreCut(p: Project, id: string): Project {
  return { ...p, cuts: p.cuts.filter((c) => c.id !== id) };
}

/** A layout over an output range; earlier layouts it covers entirely are dropped. */
export function setLayout(
  p: Project,
  segments: readonly Segment[],
  range: Range,
  layout: LayoutKind,
): Project {
  const pieces = clipRanges(segments, range);
  const covered = (l: { clip: string; start: number; end: number }) =>
    pieces.some((r) => r.clip === l.clip && r.start <= l.start && r.end >= l.end);
  return {
    ...p,
    layouts: [
      ...p.layouts.filter((l) => !covered(l)),
      ...pieces.map((r) => ({ id: newId("l"), ...r, layout })),
    ],
  };
}

/** The take and its time at output time `t`. */
export function clipAt(
  segments: readonly Segment[],
  t: number,
): { clip: string; t: number } | null {
  const at = sourceAt(segments, t);
  return at ? { clip: at.segment.clip.id, t: at.t } : null;
}

export function addZoom(
  p: Project,
  segments: readonly Segment[],
  range: Range,
  box: Box = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
): { project: Project; id: string | null } {
  const piece = clipRanges(segments, range)[0];
  if (!piece) return { project: p, id: null };
  const id = newId("z");
  return { project: { ...p, zooms: [...p.zooms, { id, ...piece, box, auto: false }] }, id };
}

export function addBlur(
  p: Project,
  segments: readonly Segment[],
  range: Range,
  box: Box = { x: 0.35, y: 0.4, w: 0.3, h: 0.12 },
): { project: Project; id: string | null } {
  const pieces = clipRanges(segments, range);
  if (!pieces.length) return { project: p, id: null };
  const blurs = pieces.map((r) => ({ id: newId("b"), ...r, box }));
  return { project: { ...p, blurs: [...p.blurs, ...blurs] }, id: blurs[0]?.id ?? null };
}

export function removeItem(
  p: Project,
  kind: "zoom" | "layout" | "blur" | "cut",
  id: string,
): Project {
  switch (kind) {
    case "zoom":
      return { ...p, zooms: p.zooms.filter((z) => z.id !== id) };
    case "layout":
      return { ...p, layouts: p.layouts.filter((l) => l.id !== id) };
    case "blur":
      return { ...p, blurs: p.blurs.filter((b) => b.id !== id) };
    case "cut":
      return restoreCut(p, id);
  }
}

/** Keeps a box inside the screen, at least 2 % wide and high. */
export function clampBox(b: Box): Box {
  const w = Math.min(1, Math.max(0.02, b.w));
  const h = Math.min(1, Math.max(0.02, b.h));
  return { x: Math.min(1 - w, Math.max(0, b.x)), y: Math.min(1 - h, Math.max(0, b.y)), w, h };
}
