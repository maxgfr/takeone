/**
 * The edited video's words and chapters on its own timeline: what was cut is
 * gone, everything else moves up. Used by the transcript export, the HTML
 * player and the peer-to-peer link.
 */
import { isCut } from "../edit/clean";
import { outputTime, segmentsOf } from "../edit/timeline";
import type { Project } from "../model/project";

export interface OutputWord {
  text: string;
  start: number;
  end: number;
}

export interface OutputChapter {
  t: number;
  title: string;
}

/** Every kept word, at its time in the edited video. */
export function outputWords(p: Project): OutputWord[] {
  const segments = segmentsOf(p);
  const out: OutputWord[] = [];
  for (const clip of p.clips) {
    for (const w of clip.transcript?.words ?? []) {
      if (isCut(p.cuts, clip.id, w)) continue;
      const start = outputTime(segments, clip.id, w.start);
      if (start === null) continue;
      const end = outputTime(segments, clip.id, w.end) ?? start + (w.end - w.start);
      out.push({ text: w.text, start, end: Math.max(start, end) });
    }
  }
  return out;
}

/** The chapters, at their time in the edited video (a chapter whose start was cut moves on). */
export function outputChapters(p: Project): OutputChapter[] {
  const segments = segmentsOf(p);
  return p.chapters
    .flatMap((c) => {
      const t = outputTime(segments, c.clip, c.t);
      if (t !== null) return [{ t, title: c.title }];
      const next = segments.find((s) => s.clip.id === c.clip && s.start >= c.t);
      return next ? [{ t: next.at, title: c.title }] : [];
    })
    .sort((a, b) => a.t - b.t);
}

export function stamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Words grouped into paragraphs at sentence ends after a pause. */
export function paragraphs(words: readonly OutputWord[]): OutputWord[][] {
  const out: OutputWord[][] = [];
  let current: OutputWord[] = [];
  words.forEach((w, i) => {
    current.push(w);
    const next = words[i + 1];
    const end = /[.!?…。！？]["'”’)]*$/.test(w.text);
    if (!next || (end && (next.start - w.end > 0.7 || current.length > 60))) {
      out.push(current);
      current = [];
    }
  });
  return out;
}

/** The transcript as Markdown: a title, the chapters, then timed paragraphs. */
export function transcriptMarkdown(p: Project): string {
  const words = outputWords(p);
  const chapters = outputChapters(p);
  const lines = [`# ${p.title}`, ""];
  if (p.meta.summary) lines.push(p.meta.summary, "");
  if (chapters.length) {
    lines.push("## Chapters", "", ...chapters.map((c) => `- ${stamp(c.t)} ${c.title}`), "");
  }
  lines.push("## Transcript", "");
  for (const para of paragraphs(words)) {
    const first = para[0];
    if (!first) continue;
    lines.push(`**${stamp(first.start)}** ${para.map((w) => w.text).join(" ")}`, "");
  }
  return `${lines.join("\n").trim()}\n`;
}
