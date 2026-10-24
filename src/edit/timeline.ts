/**
 * The edit as the viewer sees it: each clip in order, minus its cuts. Cuts,
 * layouts, zooms and blurs are ranges on a clip's own clock, so the output
 * timeline is derived, never stored: cutting a sentence moves everything
 * after it, and restoring it brings everything back.
 */
import type { Clip, Cut, Project } from "../model/project";

export interface Range {
  start: number;
  end: number;
}

/** A kept piece of a clip, and where it starts in the output. */
export interface Segment {
  clip: Clip;
  start: number;
  end: number;
  /** Output time at which this piece starts. */
  at: number;
}

/** Ranges sorted and merged, empty ones dropped. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/** What is left of [0, duration] once the ranges are removed. */
export function keep(duration: number, removed: readonly Range[]): Range[] {
  const out: Range[] = [];
  let t = 0;
  for (const r of mergeRanges(removed)) {
    const start = Math.max(0, Math.min(duration, r.start));
    const end = Math.max(0, Math.min(duration, r.end));
    if (start > t) out.push({ start: t, end: start });
    t = Math.max(t, end);
  }
  if (t < duration) out.push({ start: t, end: duration });
  // Slivers under a frame are noise from rounding.
  return out.filter((r) => r.end - r.start >= 1 / 60);
}

export function cutsOf(cuts: readonly Cut[], clipId: string): Cut[] {
  return cuts.filter((c) => c.clip === clipId);
}

export function segmentsOf(p: Pick<Project, "clips" | "cuts">): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const clip of p.clips) {
    for (const r of keep(clip.duration, cutsOf(p.cuts, clip.id))) {
      out.push({ clip, start: r.start, end: r.end, at });
      at += r.end - r.start;
    }
  }
  return out;
}

export function outputDuration(segments: readonly Segment[]): number {
  const last = segments[segments.length - 1];
  return last ? last.at + (last.end - last.start) : 0;
}

/** The clip and the time in it shown at output time `t` (the last frame past the end). */
export function sourceAt(
  segments: readonly Segment[],
  t: number,
): { segment: Segment; index: number; t: number } | null {
  if (segments.length === 0) return null;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((segments[mid] as Segment).at <= t) lo = mid;
    else hi = mid - 1;
  }
  const segment = segments[lo] as Segment;
  const local = Math.min(segment.end, Math.max(segment.start, segment.start + (t - segment.at)));
  return { segment, index: lo, t: local };
}

/** Output time of a moment of a clip, or null when it was cut. */
export function outputTime(segments: readonly Segment[], clipId: string, t: number): number | null {
  for (const s of segments) {
    if (s.clip.id === clipId && t >= s.start && t <= s.end) return s.at + (t - s.start);
  }
  return null;
}

/** The latest-starting range of a clip that covers `t`. */
export function rangeAt<T extends Range & { clip: string }>(
  ranges: readonly T[],
  clipId: string,
  t: number,
): T | undefined {
  let best: T | undefined;
  for (const r of ranges) {
    if (r.clip !== clipId || t < r.start || t >= r.end) continue;
    if (!best || r.start >= best.start) best = r;
  }
  return best;
}

/** The output spans of a clip range (a range split by cuts shows as several spans). */
export function outputSpans(segments: readonly Segment[], clipId: string, range: Range): Range[] {
  const out: Range[] = [];
  for (const s of segments) {
    if (s.clip.id !== clipId) continue;
    const start = Math.max(s.start, range.start);
    const end = Math.min(s.end, range.end);
    if (end > start) out.push({ start: s.at + (start - s.start), end: s.at + (end - s.start) });
  }
  return out;
}
