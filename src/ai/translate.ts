/**
 * Captions in another language: the transcript's segments, as edited (cut
 * words left out, segments cut whole skipped), go to the user's model in
 * numbered batches and come back one for one. Each translation keeps the time
 * of its original segment, so it plays exactly where the original would.
 */
import type { LlmSettings } from "llm-connect";
import { z } from "zod";
import { isCut } from "../edit/clean";
import type { Project } from "../model/project";
import { AiError, call, mapLimit } from "./call";
import { translatePrompt } from "./prompts";

export interface TranslatedPiece {
  clip: string;
  text: string;
  start: number;
  end: number;
}

export const translationSchema = z.object({
  captions: z.array(z.object({ n: z.number().int(), text: z.string() })),
});
export type TranslationAnswer = z.infer<typeof translationSchema>;

/** At most this many segments, or characters, in one request. */
const BATCH_SEGMENTS = 60;
const BATCH_CHARS = 5000;

/** The segments to translate: the text that is kept of each, on its take's clock. */
export function captionSources(p: Project): TranslatedPiece[] {
  const out: TranslatedPiece[] = [];
  for (const clip of p.clips) {
    const t = clip.transcript;
    if (!t) continue;
    t.segments.forEach((s, i) => {
      const last = i === t.segments.length - 1;
      const words = t.words.filter((w) => {
        const mid = (w.start + w.end) / 2;
        return mid >= s.start && (last ? mid <= s.end : mid < s.end);
      });
      const text = words.length
        ? words
            .filter((w) => !isCut(p.cuts, clip.id, w))
            .map((w) => w.text)
            .join(" ")
        : s.text;
      if (text.trim()) out.push({ clip: clip.id, text: text.trim(), start: s.start, end: s.end });
    });
  }
  return out;
}

/** Sources split into batches small enough for one answer. */
export function batches<T extends { text: string }>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const it of items) {
    if (cur.length && (cur.length >= BATCH_SEGMENTS || chars + it.text.length > BATCH_CHARS)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += it.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** A batch's answer back on its sources, by number; a caption the model left out keeps its original text. */
export function applyTranslation(
  sources: readonly TranslatedPiece[],
  answer: TranslationAnswer,
): TranslatedPiece[] {
  const byN = new Map(answer.captions.map((c) => [c.n, c.text.trim()]));
  return sources.map((s, i) => ({ ...s, text: byN.get(i + 1) || s.text }));
}

export async function translateCaptions(
  settings: LlmSettings,
  project: Project,
  language: string,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<TranslatedPiece[]> {
  const sources = captionSources(project);
  if (sources.length === 0)
    throw new AiError("Transcribe the takes first: captions are made from what was said.");
  const parts = batches(sources);
  let done = 0;
  onProgress?.(0, parts.length);
  const translated = await mapLimit(parts, 3, async (part) => {
    const answer = await call(settings, {
      name: "captions",
      schema: translationSchema,
      instructions: translatePrompt(language, project.title),
      text: JSON.stringify(part.map((s, i) => ({ n: i + 1, text: s.text }))),
      signal,
    });
    onProgress?.(++done, parts.length);
    return applyTranslation(part, answer);
  });
  return translated.flat();
}
