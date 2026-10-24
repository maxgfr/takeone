import { describe, expect, it } from "bun:test";
import { parseProject } from "../model/project";
import { bare, fillerCuts, isCut, isFiller, silenceCuts, wordsRange } from "./clean";

const w = (text: string, start: number, end: number) => ({ text, start, end });
const words = [
  w("So,", 2, 2.3),
  w("um,", 2.4, 2.7),
  w("this", 2.8, 3),
  w("is", 3.05, 3.2),
  w("it.", 3.25, 3.6),
  w("Euh", 6, 6.3),
  w("done.", 6.4, 6.8),
];

function clip(language = "en") {
  const res = parseProject({
    id: "p",
    clips: [
      {
        id: "c",
        duration: 9,
        transcript: {
          text: "",
          language,
          segments: [],
          words,
          wordTimings: "exact",
        },
      },
    ],
  });
  if (!res.ok) throw new Error(res.error);
  return res.project.clips[0] as NonNullable<(typeof res.project.clips)[number]>;
}

describe("fillers", () => {
  it("knows hesitations in the take's language, and English ones anywhere", () => {
    expect(bare("Um,")).toBe("um");
    expect(isFiller("Um,")).toBe(true);
    expect(isFiller("Euh", "fr")).toBe(true);
    expect(isFiller("like")).toBe(false);
    expect(isFiller("uh", "de")).toBe(true);
  });

  it("cuts each filler with the gap after it", () => {
    const cuts = fillerCuts(clip("fr"));
    expect(cuts.map((c) => [c.start, c.end, c.reason])).toEqual([
      [2.38, 2.8, "filler"],
      [5.98, 6.4, "filler"],
    ]);
    expect(fillerCuts(clip("fr"), cuts)).toEqual([]);
  });
});

describe("words to time", () => {
  it("closes up the sentence, but not across a long pause", () => {
    expect(wordsRange(words, 2, 3)).toEqual({ start: 2.78, end: 3.25 });
    const end = wordsRange(words, 4, 4);
    expect(end?.end).toBeCloseTo(3.72);
    expect(wordsRange(words, 9, 9)).toBeNull();
  });

  it("tells whether a word was cut", () => {
    const cuts = [{ id: "x", clip: "c", start: 2.38, end: 2.8, reason: "filler" as const }];
    expect(isCut(cuts, "c", words[1] as (typeof words)[number])).toBe(true);
    expect(isCut(cuts, "c", words[2] as (typeof words)[number])).toBe(false);
    expect(isCut(cuts, "other", words[1] as (typeof words)[number])).toBe(false);
  });
});

describe("silences", () => {
  it("trims pauses longer than a second, keeping a breath", () => {
    const cuts = silenceCuts(clip());
    expect(cuts.map((c) => [c.start, c.end])).toEqual([
      [0, 1.85],
      [3.75, 5.85],
      [6.95, 9],
    ]);
    expect(silenceCuts(clip(), cuts)).toEqual([]);
  });
});
