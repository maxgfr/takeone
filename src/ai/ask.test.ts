import { describe, expect, it } from "bun:test";
import { type Cut, type Project, parseProject } from "../model/project";
import { type AskAnswer, applyAsk, askInput, planFromAsk, uncut } from "./ask";

const WORDS = ["So", "this", "is", "the—", "so", "this", "is", "the", "dashbord.", "Bye."];

function project(cuts: Cut[] = []): Project {
  const words = WORDS.map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4 }));
  const transcript = { text: WORDS.join(" "), segments: [], words, wordTimings: "exact" };
  const res = parseProject({
    id: "p",
    clips: [{ id: "a", duration: 6, transcript, screen: { key: "s", type: "video/webm" } }],
    cuts,
  });
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

const none: AskAnswer = {
  reply: "",
  cut: [],
  restore: [],
  fix: [],
  zooms: [],
  layouts: [],
  blurs: [],
  chapters: null,
};

describe("askInput", () => {
  it("shows the cut words marked, the length, and the request", () => {
    const p = project([{ id: "x", clip: "a", start: 0, end: 2, reason: "text" }]);
    const text = askInput(p, [], "bring back the start", [{ request: "cut it", reply: "Cut." }]);
    expect(text).toContain("[0|0.0s]~So~ [1]~this~");
    expect(text).toContain("[4]so [5]this");
    expect(text).toContain("EDITED VIDEO: 0:04");
    expect(text).toContain('- "cut it" → "Cut."');
    expect(text.trim().endsWith("REQUEST: bring back the start")).toBe(true);
  });
});

describe("planFromAsk", () => {
  it("turns cuts into ranges of the take, and never cuts the whole video", () => {
    const p = project();
    const plan = planFromAsk(
      p,
      { ...none, cut: [{ take: 1, from: 0, to: 3, why: "false start" }] },
      [],
    );
    expect(plan.cuts).toHaveLength(1);
    expect(plan.cuts[0]?.reason).toBe("ai");
    expect(plan.notes[0]?.what).toBe("Cut “So this is the—”");
    const next = applyAsk(p, plan);
    expect(next.cuts).toHaveLength(1);
    // Out of range, or everything: dropped, or refused.
    expect(
      planFromAsk(p, { ...none, cut: [{ take: 2, from: 0, to: 1, why: "" }] }, []).cuts,
    ).toEqual([]);
    expect(() =>
      planFromAsk(p, { ...none, cut: [{ take: 1, from: 0, to: 9, why: "" }] }, []),
    ).toThrow(/whole video/);
  });

  it("brings cut words back, splitting the cut around them", () => {
    const p = project([{ id: "x", clip: "a", start: 0, end: 4, reason: "text" }]);
    const plan = planFromAsk(p, { ...none, restore: [{ take: 1, from: 2, to: 3 }] }, []);
    expect(plan.notes[0]?.what).toBe("Brought back “is the—”");
    const cuts = applyAsk(p, plan).cuts;
    expect(cuts.map((c) => [c.start, c.end])).toEqual([
      [0, 0.98],
      [2, 4],
    ]);
  });

  it("corrects the words recognised wrong, from the last one back", () => {
    const p = project();
    const plan = planFromAsk(
      p,
      {
        ...none,
        fix: [
          { take: 1, word: 3, text: "the" },
          { take: 1, word: 8, text: "dash board." },
          { take: 1, word: 9, text: "Bye." },
        ],
      },
      [],
    );
    const fixed = plan.fixes[0]?.after.words.map((w) => w.text);
    expect(fixed).toEqual([
      "So",
      "this",
      "is",
      "the",
      "so",
      "this",
      "is",
      "the",
      "dash",
      "board.",
      "Bye.",
    ]);
    expect(plan.notes.find((n) => n.kind === "fix")?.what).toBe("2 words corrected");
    expect(plan.fixes[0]?.before === p.clips[0]?.transcript).toBe(true);
  });
});

describe("uncut", () => {
  it("removes a range from the cuts it touches", () => {
    const cuts: Cut[] = [
      { id: "a", clip: "c", start: 0, end: 10, reason: "manual" },
      { id: "b", clip: "d", start: 0, end: 10, reason: "manual" },
    ];
    expect(uncut(cuts, "c", { start: 0, end: 4 }).map((c) => [c.clip, c.start, c.end])).toEqual([
      ["c", 4, 10],
      ["d", 0, 10],
    ]);
  });
});
