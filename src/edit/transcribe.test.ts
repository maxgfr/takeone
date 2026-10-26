import { describe, expect, it } from "bun:test";
import type { LlmSettings, TranscriptPiece } from "llm-connect";
import { defaultEngine, engineProblem, reword, typedTranscript } from "./transcribe";

describe("defaultEngine", () => {
  it("is Parakeet for the languages it knows, Whisper for the others", () => {
    expect(defaultEngine("fr")).toBe("parakeet");
    expect(defaultEngine("en")).toBe("parakeet");
    expect(defaultEngine("ja")).toBe("whisper");
  });
});

describe("engineProblem", () => {
  const anthropic = {
    providerId: "anthropic",
    providerNpm: "@ai-sdk/anthropic",
    model: "claude-sonnet-5-5",
    apiKey: "k",
  } as LlmSettings;
  it("says when an engine cannot take the language or the settings", () => {
    expect(engineProblem("parakeet", "fr", null)).toBeNull();
    expect(engineProblem("canary", "it", null)).toMatch(/Canary/);
    expect(engineProblem("whisper", "ja", null)).toBeNull();
    expect(engineProblem("provider", "fr", null)).toMatch(/Set up/);
    expect(engineProblem("provider", "fr", anthropic)).not.toBeNull();
  });
});

describe("typedTranscript", () => {
  it("spreads the words over what is kept of the take, times estimated", () => {
    const t = typedTranscript("Hello there. Second part here.", [
      { start: 0, end: 2 },
      { start: 5, end: 7 },
    ]);
    expect(t.source).toBe("typed");
    expect(t.wordTimings).toBe("estimated");
    expect(t.words.map((w) => w.text)).toEqual(["Hello", "there.", "Second", "part", "here."]);
    // Every word lands inside a kept range, in order.
    for (const w of t.words) expect(w.start >= 5 || w.end <= 2.0001).toBe(true);
    expect(t.words[0]?.start).toBe(0);
    expect(t.words[4]?.end).toBeCloseTo(7);
    expect(t.text).toBe("Hello there. Second part here.");
  });

  it("is empty for an empty text", () => {
    expect(typedTranscript("  ", [{ start: 0, end: 3 }]).words).toEqual([]);
  });
});

describe("reword", () => {
  const t = typedTranscript("one too three", [{ start: 0, end: 3 }]);
  it("corrects a word in place, keeping its time", () => {
    const fixed = reword(t, 1, "two");
    expect(fixed.words[1]).toEqual({ ...(t.words[1] as TranscriptPiece), text: "two" });
    expect(fixed.text).toBe("one two three");
  });
  it("splits a word over its time, or removes it", () => {
    const w = t.words[1] as TranscriptPiece;
    const split = reword(t, 1, "two and");
    expect(split.words.map((x) => x.text)).toEqual(["one", "two", "and", "three"]);
    expect(split.words[1]?.start).toBe(w.start);
    expect(split.words[2]?.end).toBeCloseTo(w.end);
    expect(reword(t, 1, "").words.map((x) => x.text)).toEqual(["one", "three"]);
  });
});
