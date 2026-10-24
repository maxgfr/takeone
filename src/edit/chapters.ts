/**
 * Chapters sit on a take's clock, like every edit, so they keep their place
 * whatever is cut before them. Their time in the video is derived: a chapter
 * whose moment was cut starts at the next moment of its take that is kept.
 */
import type { Chapter, Project } from "../model/project";
import type { Segment } from "./timeline";

export interface ChapterMark {
  chapter: Chapter;
  /** Output time. */
  at: number;
}

/** Output time of a moment of a take (a chapter's), or the next one kept; null when the rest of the take is cut. */
export function chapterTime(
  segments: readonly Segment[],
  chapter: Pick<Chapter, "clip" | "t">,
): number | null {
  for (const s of segments) {
    if (s.clip.id === chapter.clip && s.end > chapter.t)
      return s.at + Math.max(0, chapter.t - s.start);
  }
  return null;
}

/** The chapters in the order the video plays them, the ones cut out left out. */
export function chapterMarks(
  p: Pick<Project, "chapters">,
  segments: readonly Segment[],
): ChapterMark[] {
  return p.chapters
    .flatMap((chapter) => {
      const at = chapterTime(segments, chapter);
      return at === null ? [] : [{ chapter, at }];
    })
    .sort((a, b) => a.at - b.at);
}

/** "1:05", or "1:02:05" past an hour, as YouTube writes chapter times. */
export function stampOf(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** The YouTube chapter list: one line per chapter, the first at 0:00 as YouTube requires. */
export function chapterList(marks: readonly ChapterMark[]): string {
  return marks.map((m, i) => `${stampOf(i === 0 ? 0 : m.at)} ${m.chapter.title}`).join("\n");
}
