import { describe, expect, it } from "bun:test";
import type { LlmSettings } from "llm-connect";
import { defaultEngine, engineProblem } from "./transcribe";

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
