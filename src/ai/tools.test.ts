import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { LlmSettings } from "llm-connect";
import { chapterList, chapterMarks, stampOf } from "../edit/chapters";
import { segmentsOf } from "../edit/timeline";
import { type Project, parseProject } from "../model/project";

/** The model, mocked: each call takes the next answer and records what it was asked. */
const answers: unknown[] = [];
const asked: { name: string; instructions: string; text: string }[] = [];
mock.module("./call", () => ({
  AiError: class AiError extends Error {},
  mapLimit: async <T, R>(items: T[], _limit: number, fn: (x: T, i: number) => Promise<R>) => {
    const out: R[] = [];
    for (const [i, x] of items.entries()) out.push(await fn(x, i));
    return out;
  },
  call: async (_s: LlmSettings, ask: { name: string; instructions: string; text: string }) => {
    asked.push(ask);
    return answers.shift();
  },
}));

const { chaptersFromAnswer, findChapters, findRetakes, postsFromAnswer, retakesFromAnswer } =
  await import("./tools");
const { applyTranslation, batches, captionSources, translateCaptions } = await import(
  "./translate"
);

const settings = { providerId: "openai", model: "gpt-x", apiKey: "sk" } as unknown as LlmSettings;

const w = (text: string, start: number, end: number) => ({ text, start, end });

function project(extra: Record<string, unknown> = {}): Project {
  const one = [
    w("So", 0, 0.3),
    w("this", 0.4, 0.6),
    w("is", 0.7, 0.8),
    w("the—", 0.9, 1.1),
    w("so", 1.5, 1.7),
    w("this", 1.8, 2.0),
    w("is", 2.1, 2.2),
    w("the", 2.3, 2.4),
    w("dashboard.", 2.5, 3.0),
  ];
  const two = [w("Now", 10, 10.3), w("settings.", 10.4, 11)];
  const t = (words: typeof one, language = "en") => ({
    text: words.map((x) => x.text).join(" "),
    language,
    segments: [{ text: words.map((x) => x.text).join(" "), start: words[0]?.start ?? 0, end: 11 }],
    words,
    wordTimings: "exact",
  });
  const res = parseProject({
    id: "p",
    title: "Tour",
    clips: [
      { id: "a", duration: 4, transcript: t(one) },
      { id: "b", duration: 12, transcript: t(two) },
    ],
    ...extra,
  });
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

beforeEach(() => {
  answers.length = 0;
  asked.length = 0;
});

describe("retakes", () => {
  it("turns word ranges into times on the take, and drops what is out of range", () => {
    const rs = retakesFromAnswer(project(), {
      retakes: [
        { take: 1, from: 0, to: 3, reason: "restarted sentence" },
        { take: 1, from: 5, to: 40, reason: "out of range" },
        { take: 3, from: 0, to: 0, reason: "no such take" },
        { take: 1, from: -1, to: 2, reason: "negative" },
        { take: 1, from: 2, to: 4, reason: "overlaps the first" },
        { take: 2, from: 0, to: 1, reason: "the whole take" },
      ],
    });
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ clip: "a", from: 0, to: 3, text: "So this is the—" });
    // From the first word to the next kept word, so the sentence closes up
    expect(rs[0]?.start).toBeCloseTo(0);
    expect(rs[0]?.end).toBeCloseTo(1.5);
  });

  it("drops a retake already cut", () => {
    const p = project({ cuts: [{ id: "x", clip: "a", start: 0, end: 1.5, reason: "text" }] });
    expect(retakesFromAnswer(p, { retakes: [{ take: 1, from: 0, to: 3, reason: "r" }] })).toEqual(
      [],
    );
  });

  it("asks the model with the words numbered, and maps its answer", async () => {
    answers.push({ retakes: [{ take: 1, from: 0, to: 3, reason: "restart" }] });
    const rs = await findRetakes(settings, project(), null);
    expect(rs.map((r) => r.text)).toEqual(["So this is the—"]);
    expect(asked[0]?.text).toContain("TAKE 1\n[0]So [1]this [2]is [3]the—");
    expect(asked[0]?.instructions).toContain("in English");
  });
});

describe("chapters", () => {
  it("starts each chapter at its word, in the order of the video", () => {
    const p = project();
    const cs = chaptersFromAnswer(p, {
      chapters: [
        { take: 2, word: 0, title: "Settings" },
        { take: 1, word: 0, title: " Intro " },
        { take: 1, word: 99, title: "Out of range" },
        { take: 1, word: 1, title: "Too close" },
        { take: 2, word: 1, title: "" },
      ],
    });
    expect(cs.map((c) => [c.clip, c.t, c.title])).toEqual([
      ["a", 0, "Intro"],
      ["b", 10, "Settings"],
    ]);
    const marks = chapterMarks({ chapters: cs }, segmentsOf(p));
    expect(marks.map((m) => m.at)).toEqual([0, 14]);
    expect(chapterList(marks)).toBe("0:00 Intro\n0:14 Settings");
  });

  it("moves a chapter on a cut word to the next kept one", () => {
    const p = project({ cuts: [{ id: "x", clip: "a", start: 0, end: 1.5, reason: "retake" }] });
    const cs = chaptersFromAnswer(p, { chapters: [{ take: 1, word: 1, title: "Start" }] });
    expect(cs[0]?.t).toBe(1.5);
    expect(chapterMarks({ chapters: cs }, segmentsOf(p))[0]?.at).toBe(0);
  });

  it("fails when nothing usable comes back", async () => {
    answers.push({ chapters: [{ take: 9, word: 0, title: "Nowhere" }] });
    await expect(findChapters(settings, project(), "fr")).rejects.toThrow(/no usable chapter/);
    expect(asked[0]?.instructions).toContain("in French");
  });

  it("writes times as YouTube does", () => {
    expect(stampOf(65)).toBe("1:05");
    expect(stampOf(3725)).toBe("1:02:05");
  });
});

describe("posts", () => {
  it("adds the chapter list to the YouTube description", () => {
    const p = project({ chapters: [{ id: "c", clip: "b", t: 10, title: "Settings" }] });
    const posts = postsFromAnswer(p, { linkedin: " Hi ", x: "Short", youtube: "About." });
    expect(posts).toEqual({ linkedin: "Hi", x: "Short", youtube: "About.\n\n0:00 Settings" });
  });
});

describe("translation", () => {
  it("sends the kept text of each segment and keeps their times", async () => {
    const p = project({ cuts: [{ id: "x", clip: "a", start: 0, end: 1.5, reason: "retake" }] });
    const sources = captionSources(p);
    expect(sources.map((s) => s.text)).toEqual(["so this is the dashboard.", "Now settings."]);
    answers.push({
      captions: [
        { n: 2, text: "Maintenant les réglages." },
        { n: 1, text: "voici le tableau de bord." },
      ],
    });
    const pieces = await translateCaptions(settings, p, "fr");
    expect(pieces).toEqual([
      { clip: "a", text: "voici le tableau de bord.", start: 0, end: 11 },
      { clip: "b", text: "Maintenant les réglages.", start: 10, end: 11 },
    ]);
    expect(JSON.parse(asked[0]?.text ?? "[]")).toEqual([
      { n: 1, text: "so this is the dashboard." },
      { n: 2, text: "Now settings." },
    ]);
  });

  it("keeps the original of a caption the model left out", () => {
    const out = applyTranslation(
      [
        { clip: "a", text: "One.", start: 0, end: 1 },
        { clip: "a", text: "Two.", start: 1, end: 2 },
      ],
      {
        captions: [
          { n: 1, text: "Un." },
          { n: 7, text: "Sept." },
        ],
      },
    );
    expect(out.map((x) => x.text)).toEqual(["Un.", "Two."]);
  });

  it("splits long transcripts into batches", () => {
    const items = Array.from({ length: 130 }, () => ({ text: "word ".repeat(10) }));
    const parts = batches(items);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.flat().length).toBe(130);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(60);
  });
});
