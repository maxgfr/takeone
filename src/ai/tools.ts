/**
 * The AI tools of the editor, each one request to the user's model over the
 * transcript: retakes to cut, chapters, a title with a summary and a
 * description, and posts to share the video. Answers point at words by their
 * number in a take; they become times here, and whatever points outside the
 * transcript is dropped rather than trusted.
 */
import type { LlmSettings } from "llm-connect";
import { toLanguageCode } from "llm-connect";
import { z } from "zod";
import { chapterList, chapterMarks } from "../edit/chapters";
import { isCut, wordsRange } from "../edit/clean";
import { outputDuration, segmentsOf } from "../edit/timeline";
import { type Chapter, type Cut, newId, type Project } from "../model/project";
import { AiError, call } from "./call";
import {
  chaptersPrompt,
  editedText,
  numberedTranscript,
  postsPrompt,
  retakesPrompt,
  spokenLanguage,
  textsPrompt,
} from "./prompts";

/** The language answers are written in: the one asked for, else the video's, else English. */
export function answerLanguage(p: Project, asked: string | null = null): string {
  return asked || toLanguageCode(spokenLanguage(p));
}

function needTranscript(p: Project): void {
  if (!p.clips.some((c) => c.transcript?.words.some((w) => !isCut(p.cuts, c.id, w))))
    throw new AiError("Transcribe the takes first: the AI works from what was said.");
}

/* --- Retakes ------------------------------------------------------------- */

export const retakesSchema = z.object({
  retakes: z.array(
    z.object({
      take: z.number().int().describe("Take number, from 1"),
      from: z.number().int().describe("Number of the first word to cut"),
      to: z.number().int().describe("Number of the last word to cut"),
      reason: z.string(),
    }),
  ),
});
export type RetakesAnswer = z.infer<typeof retakesSchema>;

/** A failed attempt the model found: words `from` to `to` of a take, and the time they take. */
export interface Retake {
  id: string;
  clip: string;
  from: number;
  to: number;
  start: number;
  end: number;
  reason: string;
  /** The words, for the list. */
  text: string;
}

/** The model's retakes as ranges of a take, the ones out of range, already cut or overlapping dropped. */
export function retakesFromAnswer(p: Project, answer: RetakesAnswer): Retake[] {
  const out: Retake[] = [];
  for (const r of answer.retakes) {
    const clip = p.clips[r.take - 1];
    const words = clip?.transcript?.words ?? [];
    if (!clip) continue;
    const from = Math.min(r.from, r.to);
    const to = Math.max(r.from, r.to);
    if (from < 0 || to >= words.length) continue;
    const span = words.slice(from, to + 1);
    if (span.every((w) => isCut(p.cuts, clip.id, w))) continue;
    // A take is never cut whole: that is not a retake but a misunderstanding.
    const rest = words.filter((w, i) => (i < from || i > to) && !isCut(p.cuts, clip.id, w));
    if (rest.length === 0) continue;
    if (out.some((o) => o.clip === clip.id && from <= o.to && to >= o.from)) continue;
    const range = wordsRange(words, from, to);
    if (!range) continue;
    out.push({
      id: newId("r"),
      clip: clip.id,
      from,
      to,
      ...range,
      reason: r.reason.trim(),
      text: span.map((w) => w.text).join(" "),
    });
  }
  return out;
}

export function retakeCut(r: Retake): Cut {
  return { id: newId("x"), clip: r.clip, start: r.start, end: r.end, reason: "retake" };
}

export async function findRetakes(
  settings: LlmSettings,
  p: Project,
  language: string | null,
  signal?: AbortSignal,
): Promise<Retake[]> {
  needTranscript(p);
  const answer = await call(settings, {
    name: "retakes",
    schema: retakesSchema,
    instructions: retakesPrompt(answerLanguage(p, language)),
    text: numberedTranscript(p),
    effort: "medium",
    signal,
  });
  return retakesFromAnswer(p, answer);
}

/* --- Chapters ------------------------------------------------------------ */

export const chaptersSchema = z.object({
  chapters: z.array(
    z.object({
      take: z.number().int().describe("Take number, from 1"),
      word: z.number().int().describe("Number of the word the chapter starts at"),
      title: z.string(),
    }),
  ),
});
export type ChaptersAnswer = z.infer<typeof chaptersSchema>;

/** Chapters closer than this in the video are one. */
const MIN_CHAPTER = 5;

/**
 * The model's chapters at the start of their word (the next kept word when it was cut), in the
 * order the video plays them; out-of-range words and chapters too close to the previous dropped.
 */
export function chaptersFromAnswer(p: Project, answer: ChaptersAnswer): Chapter[] {
  const found: Chapter[] = [];
  for (const c of answer.chapters) {
    const clip = p.clips[c.take - 1];
    const words = clip?.transcript?.words ?? [];
    const title = c.title.trim();
    if (!clip || !title || c.word < 0 || c.word >= words.length) continue;
    const w = words.slice(c.word).find((x) => !isCut(p.cuts, clip.id, x));
    if (!w) continue;
    found.push({ id: newId("c"), clip: clip.id, t: w.start, title });
  }
  const marks = chapterMarks({ chapters: found }, segmentsOf(p));
  const out: Chapter[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const m of marks) {
    if (m.at - last < MIN_CHAPTER) continue;
    out.push(m.chapter);
    last = m.at;
  }
  return out;
}

export async function findChapters(
  settings: LlmSettings,
  p: Project,
  language: string | null,
  signal?: AbortSignal,
): Promise<Chapter[]> {
  needTranscript(p);
  const answer = await call(settings, {
    name: "chapters",
    schema: chaptersSchema,
    instructions: chaptersPrompt(answerLanguage(p, language), outputDuration(segmentsOf(p))),
    text: numberedTranscript(p),
    signal,
  });
  const chapters = chaptersFromAnswer(p, answer);
  if (chapters.length === 0)
    throw new AiError("The model returned no usable chapter. Try again.", true);
  return chapters;
}

/* --- Title, summary, description ---------------------------------------- */

export const textsSchema = z.object({
  title: z.string(),
  summary: z.string(),
  description: z.string(),
});
export type Texts = z.infer<typeof textsSchema>;

export async function writeTexts(
  settings: LlmSettings,
  p: Project,
  language: string | null,
  signal?: AbortSignal,
): Promise<Texts> {
  needTranscript(p);
  const t = await call(settings, {
    name: "texts",
    schema: textsSchema,
    instructions: textsPrompt(answerLanguage(p, language)),
    text: `Working title: ${JSON.stringify(p.title)}\n\nTRANSCRIPT\n${editedText(p)}`,
    signal,
  });
  return { title: t.title.trim(), summary: t.summary.trim(), description: t.description.trim() };
}

/* --- Posts --------------------------------------------------------------- */

export const postsSchema = z.object({
  linkedin: z.string(),
  x: z.string(),
  youtube: z.string(),
});
export type Posts = z.infer<typeof postsSchema>;

/** The posts, the YouTube description followed by the chapter list when there are chapters. */
export function postsFromAnswer(p: Project, answer: Posts): Record<string, string> {
  const list = chapterList(chapterMarks(p, segmentsOf(p)));
  const youtube = answer.youtube.trim();
  return {
    linkedin: answer.linkedin.trim(),
    x: answer.x.trim(),
    youtube: list ? `${youtube}\n\n${list}` : youtube,
  };
}

export async function writePosts(
  settings: LlmSettings,
  p: Project,
  language: string | null,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  needTranscript(p);
  const about = [
    `Title: ${JSON.stringify(p.title)}`,
    p.meta.summary ? `Summary: ${p.meta.summary}` : "",
    `\nTRANSCRIPT\n${editedText(p)}`,
  ]
    .filter(Boolean)
    .join("\n");
  const answer = await call(settings, {
    name: "posts",
    schema: postsSchema,
    instructions: postsPrompt(answerLanguage(p, language)),
    text: about,
    signal,
  });
  return postsFromAnswer(p, answer);
}
