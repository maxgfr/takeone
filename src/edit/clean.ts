/**
 * Editing by text: words map to time on their take's clock, so deleting words
 * cuts the video, and the clean-ups are cuts too: filler words (per language)
 * and long pauses. Every one of them is an ordinary cut, restorable from the
 * transcript or the timeline.
 */
import { type Clip, type Cut, newId } from "../model/project";
import { mergeRanges, type Range } from "./timeline";

type Word = { text: string; start: number; end: number };

/** Hesitations, by language: only sounds, never words that may carry meaning. */
export const FILLERS: Record<string, string[]> = {
  en: ["um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "hmm", "hm", "mm", "mhm"],
  fr: ["euh", "euhh", "heu", "hum", "hmm", "bah", "ben", "euhm"],
  es: ["eh", "em", "ehm", "mmm", "este", "hmm"],
  de: ["äh", "ähm", "öh", "öhm", "hm", "hmm", "ehm"],
  it: ["ehm", "uhm", "eh", "ehh", "mmm"],
  pt: ["ãh", "ahn", "hum", "hmm", "eh", "uhm"],
  nl: ["eh", "ehm", "uh", "uhm", "hmm"],
  sv: ["eh", "öh", "ehm", "hmm"],
  pl: ["yyy", "eee", "hmm", "em"],
  tr: ["ıı", "eee", "hmm", "şey"],
  ru: ["э", "ээ", "эм", "мм", "хм"],
  ja: ["えー", "えーと", "あの", "あのー", "うーん"],
  zh: ["嗯", "呃", "那个"],
  ko: ["음", "어", "그"],
};

/** The word without its punctuation, lower-cased. */
export function bare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, "")
    .trim();
}

export function isFiller(text: string, language = "en"): boolean {
  const w = bare(text);
  if (!w) return false;
  const lang = language.toLowerCase().split(/[-_]/)[0] ?? "en";
  return (FILLERS[lang] ?? FILLERS.en ?? []).includes(w) || (FILLERS.en ?? []).includes(w);
}

/** A gap longer than this after a removed word stays (it was a pause, handled on its own). */
const MAX_GAP = 0.6;

/**
 * The time to cut for words `from` to `to` of a transcript: from the first word's start to the
 * next kept word's start, so the sentence closes up, but never a long pause.
 */
export function wordsRange(words: readonly Word[], from: number, to: number): Range | null {
  const a = words[from];
  const b = words[to];
  if (!a || !b) return null;
  const next = words[to + 1];
  const end = next && next.start - b.end <= MAX_GAP ? next.start : b.end + 0.12;
  return { start: Math.max(0, a.start - 0.02), end };
}

/** Whether a word falls inside one of the clip's cuts (by its middle). */
export function isCut(cuts: readonly Cut[], clipId: string, w: Word): boolean {
  const mid = (w.start + w.end) / 2;
  return cuts.some((c) => c.clip === clipId && mid >= c.start && mid < c.end);
}

/** Cuts for every filler word of a take. */
export function fillerCuts(clip: Clip, existing: readonly Cut[] = []): Cut[] {
  const t = clip.transcript;
  if (!t) return [];
  const out: Cut[] = [];
  t.words.forEach((w, i) => {
    if (!isFiller(w.text, t.language) || isCut(existing, clip.id, w)) return;
    const r = wordsRange(t.words, i, i);
    if (r) out.push({ id: newId("x"), clip: clip.id, ...r, reason: "filler" });
  });
  return out;
}

/**
 * Cuts for the pauses of a take longer than `min` seconds, keeping `keep` seconds of each so
 * the speech still breathes; silence before the first word and after the last is trimmed too.
 */
export function silenceCuts(clip: Clip, existing: readonly Cut[] = [], min = 1, keep = 0.3): Cut[] {
  // Typed words have estimated times: their gaps say nothing about pauses.
  if (clip.transcript?.source === "typed") return [];
  const words = clip.transcript?.words ?? [];
  if (words.length === 0) return [];
  const gaps: Range[] = [];
  const first = words[0] as Word;
  const last = words[words.length - 1] as Word;
  if (first.start > min) gaps.push({ start: 0, end: first.start - keep / 2 });
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1] as Word;
    const b = words[i] as Word;
    if (b.start - a.end > min) gaps.push({ start: a.end + keep / 2, end: b.start - keep / 2 });
  }
  if (clip.duration - last.end > min) gaps.push({ start: last.end + keep / 2, end: clip.duration });
  // Leave alone what is already cut.
  const taken = mergeRanges(existing.filter((c) => c.clip === clip.id));
  return gaps
    .filter((g) => !taken.some((c) => c.start <= g.start && c.end >= g.end))
    .map((g) => ({ id: newId("x"), clip: clip.id, ...g, reason: "silence" as const }));
}
