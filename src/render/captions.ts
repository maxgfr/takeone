/**
 * Captions: what was said, on the picture and in subtitle files. They come
 * from the transcript (or a translation of it) and follow the edit: a cut word
 * is never shown, and a caption that a cut splits in two plays as two.
 *
 * A sentence is shown a page at a time, up to two lines of a width that
 * depends only on the format and the text size, so the preview, a 4K export
 * and the subtitle files break the lines in the same places. Translations have
 * no word timings: their words are spread over the time their sentence is kept,
 * in proportion to their length, which is enough to follow them word by word.
 */
import { isCut } from "../edit/clean";
import { cutsOf, keep, type Range, type Segment, segmentsOf } from "../edit/timeline";
import type { Aspect, Clip, Project, Style } from "../model/project";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type CaptionStyle = Style["captions"];

export interface CaptionWord {
  text: string;
  /** On the take's clock. */
  start: number;
  end: number;
}

/** What to show at an instant: one or two lines, and the word being said. */
export interface Caption {
  lines: string[][];
  /** Index of the word being said, counted across the lines; -1 before the first one. */
  current: number;
}

/** A caption on the output's timeline, for subtitle files. */
export interface CaptionCue {
  start: number;
  end: number;
  /** One or two lines, joined by a line break. */
  text: string;
}

/** A sentence as captioned: its time on the take's clock, and its words that are kept. */
interface Sentence {
  start: number;
  end: number;
  words: CaptionWord[];
}

const ACCENT = "#ff5a3c";
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
/** Average width of a character of the bold font, in ems (for the line length). */
const CHAR_EM = 0.56;
/** The band leaves this much of the output's width free. */
const WIDTH = 0.86;
/** Width over the shorter side, by format. */
const WIDE: Record<Aspect, number> = { "16:9": 16 / 9, "9:16": 1, "1:1": 1, "4:3": 4 / 3 };

/** Characters on a line of captions: from the format and the text size only, not the resolution. */
export function lineChars(style: Pick<Style, "aspect" | "captions">): number {
  const fit = Math.floor(
    (WIDTH * WIDE[style.aspect]) / (Math.max(0.01, style.captions.size) * CHAR_EM),
  );
  return Math.max(12, Math.min(46, fit - 2));
}

const len = (words: readonly { text: string }[]) =>
  words.reduce((s, w, i) => s + w.text.length + (i ? 1 : 0), 0);

/** Words on at most two lines of `max` characters, split where the two are most even. */
export function balance<T extends { text: string }>(words: readonly T[], max: number): T[][] {
  if (words.length < 2 || len(words) <= max) return [words.slice()];
  let best = 1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let k = 1; k < words.length; k++) {
    const a = len(words.slice(0, k));
    const b = len(words.slice(k));
    // Lines that fit come first, then the most even pair.
    const score = (a > max || b > max ? 1e6 : 0) + Math.max(a, b);
    if (score < bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return [words.slice(0, best), words.slice(best)];
}

/** A sentence's words cut into pages of at most two lines of `max` characters each. */
export function paginate<T extends { text: string }>(words: readonly T[], max: number): T[][][] {
  const pages: T[][][] = [];
  let i = 0;
  while (i < words.length) {
    let j = i;
    for (let line = 0; line < 2 && j < words.length; line++) {
      let used = 0;
      let first = true;
      while (j < words.length) {
        const w = (words[j] as T).text.length;
        if (!first && used + 1 + w > max) break;
        used += (first ? 0 : 1) + w;
        first = false;
        j++;
      }
    }
    pages.push(balance(words.slice(i, j), max));
    i = j;
  }
  return pages;
}

/** Spreads words over kept ranges in proportion to their length. */
function spread(texts: readonly string[], ranges: readonly Range[]): CaptionWord[] {
  const total = ranges.reduce((s, r) => s + r.end - r.start, 0);
  if (total <= 0 || texts.length === 0) return [];
  const weights = texts.map((t) => t.length + 1);
  const sum = weights.reduce((s, w) => s + w, 0);
  // Kept time `x` (seconds into the kept ranges) back on the take's clock.
  const at = (x: number) => {
    let rest = x;
    for (const r of ranges) {
      const d = r.end - r.start;
      if (rest <= d + 1e-9) return r.start + Math.min(d, rest);
      rest -= d;
    }
    const last = ranges[ranges.length - 1] as Range;
    return last.end;
  };
  const out: CaptionWord[] = [];
  let acc = 0;
  texts.forEach((text, i) => {
    const a = (acc / sum) * total;
    acc += weights[i] as number;
    const b = (acc / sum) * total;
    // A word is placed by its middle, so it stays inside one kept range.
    out.push({ text, start: at(a + 1e-6), end: at(b - 1e-6) });
  });
  return out;
}

/** The parts of `range` a take keeps. */
function kept(clip: Clip, cuts: Project["cuts"], range: Range): Range[] {
  return keep(clip.duration, cutsOf(cuts, clip.id))
    .map((r) => ({ start: Math.max(r.start, range.start), end: Math.min(r.end, range.end) }))
    .filter((r) => r.end - r.start > 1e-3);
}

const words = (text: string) => text.split(/\s+/).filter(Boolean);

function sentencesOf(p: Project, clip: Clip, language: string | null): Sentence[] {
  const pieces = language ? p.translations[language] : undefined;
  if (pieces) {
    return pieces
      .filter((x) => x.clip === clip.id)
      .flatMap((x) => {
        const ranges = kept(clip, p.cuts, x);
        const ws = spread(words(x.text), ranges);
        return ws.length ? [{ start: x.start, end: x.end, words: ws }] : [];
      });
  }
  const t = clip.transcript;
  if (!t) return [];
  const segs = t.segments.length
    ? t.segments
    : t.words.length
      ? [{ text: "", start: t.words[0]?.start ?? 0, end: t.words[t.words.length - 1]?.end ?? 0 }]
      : [];
  return segs.flatMap((s, i) => {
    const last = i === segs.length - 1;
    const inside = t.words.filter((w) => {
      const mid = (w.start + w.end) / 2;
      return mid >= s.start && (last ? mid <= s.end : mid < s.end);
    });
    // Without word timings, the segment's text is spread over its time.
    const ws = inside.length ? inside : spread(words(s.text), [s]);
    const shown = ws
      .filter((w) => !isCut(p.cuts, clip.id, w))
      .map((w) => ({ text: w.text.trim(), start: w.start, end: w.end }))
      .filter((w) => w.text);
    return shown.length ? [{ start: s.start, end: s.end, words: shown }] : [];
  });
}

/** Sentences by project (projects are never changed in place, so each version is computed once). */
const cache = new WeakMap<Project, Map<string, Sentence[]>>();

function sentences(p: Project, clipId: string, language: string | null): Sentence[] {
  const lang = language && p.translations[language] ? language : null;
  let byKey = cache.get(p);
  if (!byKey) {
    byKey = new Map();
    cache.set(p, byKey);
  }
  const key = `${clipId}\u0000${lang ?? ""}`;
  const have = byKey.get(key);
  if (have) return have;
  const clip = p.clips.find((c) => c.id === clipId);
  const out = clip ? sentencesOf(p, clip, lang) : [];
  byKey.set(key, out);
  return out;
}

/**
 * The caption at time `t` of a take: the page of the current sentence (or translated sentence)
 * that holds the word being said, without the words that were cut; null between sentences.
 * `language` null (or one without a translation) shows the original.
 */
export function captionAt(
  project: Project,
  clipId: string,
  t: number,
  language: string | null,
  max = lineChars(project.style),
): Caption | null {
  const s = sentences(project, clipId, language).find((x) => t >= x.start && t < x.end);
  if (!s) return null;
  const pages = paginate(s.words, max);
  let page = pages[0];
  for (const pg of pages) if ((pg[0]?.[0]?.start ?? 0) <= t) page = pg;
  if (!page) return null;
  const flat = page.flat();
  let current = -1;
  flat.forEach((w, i) => {
    if (w.start <= t) current = i;
  });
  return { lines: page.map((line) => line.map((w) => w.text)), current };
}

/** Draws a caption: bold text on a dark rounded band, the word being said in the accent. */
export function drawCaptions(
  ctx: Ctx,
  W: number,
  H: number,
  style: CaptionStyle,
  caption: Caption,
): void {
  const m = Math.min(W, H);
  const maxWidth = W * WIDTH;
  let px = Math.max(8, style.size * m);
  let lines: { text: string; index: number; w: number }[][] = [];
  let space = 0;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  // Lines too wide for this output wrap again; a caption that would need more than three
  // lines is drawn smaller.
  for (let attempt = 0; attempt < 5; attempt++) {
    ctx.font = `700 ${px}px ${FONT}`;
    space = ctx.measureText(" ").width;
    const room = maxWidth - px * 1.1;
    lines = [];
    let index = 0;
    for (const line of caption.lines) {
      let cur: { text: string; index: number; w: number }[] = [];
      let used = 0;
      for (const text of line) {
        const w = ctx.measureText(text).width;
        if (cur.length && used + space + w > room) {
          lines.push(cur);
          cur = [];
          used = 0;
        }
        used += (cur.length ? space : 0) + w;
        cur.push({ text, index: index++, w });
      }
      if (cur.length) lines.push(cur);
    }
    if (lines.length <= 3) break;
    px *= 0.85;
  }
  const widths = lines.map((l) => l.reduce((s, w, i) => s + w.w + (i ? space : 0), 0));
  const padX = px * 0.55;
  const padY = px * 0.3;
  const lineH = px * 1.3;
  const bandW = Math.max(...widths, 0) + padX * 2;
  const bandH = lines.length * lineH + padY * 2;
  const margin = m * 0.055;
  const x = (W - bandW) / 2;
  const y = style.position === "top" ? margin : H - margin - bandH;
  ctx.fillStyle = "rgba(12, 10, 18, 0.78)";
  ctx.beginPath();
  ctx.roundRect(x, y, bandW, bandH, px * 0.32);
  ctx.fill();
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  lines.forEach((line, i) => {
    let cx = W / 2 - (widths[i] ?? 0) / 2;
    const cy = y + padY + lineH * (i + 0.5);
    for (const w of line) {
      ctx.fillStyle = style.karaoke && w.index === caption.current ? ACCENT : "#ffffff";
      ctx.fillText(w.text, cx, cy);
      cx += w.w + space;
    }
  });
  ctx.restore();
}

/**
 * The captions of the project at time `t` of a take, drawn over a W × H frame: the preview
 * and the exports call this after drawing the frame. Draws nothing when captions are off.
 */
export function drawCaptionsAt(
  ctx: Ctx,
  W: number,
  H: number,
  project: Project,
  clipId: string,
  t: number,
): void {
  const st = project.style.captions;
  if (!st.enabled) return;
  const caption = captionAt(project, clipId, t, st.language);
  if (caption) drawCaptions(ctx, W, H, st, caption);
}

/**
 * The captions as cues on the output's timeline, the pages `captionAt` shows: cut words left
 * out, and a cue that a cut falls inside split in two, each with its own words.
 */
export function captionCues(project: Project, language: string | null): CaptionCue[] {
  const timeline: Segment[] = segmentsOf(project);
  const max = lineChars(project.style);
  const out: CaptionCue[] = [];
  for (const clip of project.clips) {
    const pieces = timeline.filter((s) => s.clip.id === clip.id);
    for (const s of sentences(project, clip.id, language)) {
      const pages = paginate(s.words, max);
      pages.forEach((page, i) => {
        const first = page[0]?.[0];
        if (!first) return;
        const next = pages[i + 1]?.[0]?.[0];
        const a = first.start;
        const b = next ? next.start : Math.max(s.end, page.flat().at(-1)?.end ?? s.end);
        for (const seg of pieces) {
          const lo = Math.max(seg.start, a);
          const hi = Math.min(seg.end, b);
          if (hi <= lo) continue;
          const inside = (w: CaptionWord) => {
            const mid = (w.start + w.end) / 2;
            return mid >= lo && mid < hi;
          };
          const text = page
            .map((line) =>
              line
                .filter(inside)
                .map((w) => w.text)
                .join(" "),
            )
            .filter(Boolean)
            .join("\n");
          if (!text) continue;
          out.push({ start: seg.at + (lo - seg.start), end: seg.at + (hi - seg.start), text });
        }
      });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

function stamp(seconds: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

/** SubRip subtitles. */
export function toSrt(cues: readonly CaptionCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`)
    .join("\n");
}

/** WebVTT subtitles. */
export function toVtt(cues: readonly CaptionCue[]): string {
  const body = cues.map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.text}`);
  return `WEBVTT\n\n${body.join("\n\n")}\n`;
}
