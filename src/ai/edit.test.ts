import { describe, expect, it, mock } from "bun:test";
import type { LlmSettings } from "llm-connect";
import { type Project, parseProject } from "../model/project";

/** The model, mocked: each call takes the answer for its name and records what it was asked. */
const answers: Record<string, unknown> = {};
const asked: { name: string; instructions: string; text: string; images?: unknown[] }[] = [];
mock.module("./call", () => ({
  AiError: class AiError extends Error {},
  mapLimit: async <T, R>(items: T[], _limit: number, fn: (x: T, i: number) => Promise<R>) => {
    const out: R[] = [];
    for (const [i, x] of items.entries()) out.push(await fn(x, i));
    return out;
  },
  visionProblem: () => "The model does not take images",
  call: async (_s: LlmSettings, ask: { name: string; instructions: string; text: string }) => {
    asked.push(ask);
    return answers[ask.name];
  },
}));

const { applyPlan, editInput, planEdit, planFromAnswer, samePage } = await import("./edit");
const { stillBudget, stillTimes } = await import("./stills");

const settings = { providerId: "openai", model: "gpt-x", apiKey: "sk" } as unknown as LlmSettings;
const w = (text: string, start: number, end: number) => ({ text, start, end });
const media = (key: string) => ({ key, type: "video/webm", width: 1920, height: 1080 });

function project(extra: Record<string, unknown> = {}): Project {
  const words = [
    w("Hello,", 0.2, 0.6),
    w("um,", 0.8, 1.1),
    w("today", 1.2, 1.5),
    w("we", 1.6, 1.7),
    w("open", 1.8, 2.0),
    w("the", 2.1, 2.2),
    w("settings", 2.3, 2.8),
    w("and", 3.0, 3.1),
    w("click", 3.2, 3.5),
    w("save.", 3.6, 4.0),
    w("My", 12, 12.2),
    w("email", 12.3, 12.6),
    w("is", 12.7, 12.8),
    w("here.", 12.9, 13.3),
  ];
  const res = parseProject({
    id: "p1",
    title: "Demo",
    clips: [
      {
        id: "c1",
        duration: 20,
        screen: media("s1"),
        camera: media("k1"),
        activity: [
          { t: 3.3, box: { x: 0.7, y: 0.1, w: 0.1, h: 0.05 }, ratio: 0.005 },
          { t: 8, box: { x: 0, y: 0, w: 1, h: 1 }, ratio: 0.9 },
          { t: 16, box: { x: 0, y: 0, w: 1, h: 1 }, ratio: 0.9 },
        ],
        transcript: {
          text: words.map((x) => x.text).join(" "),
          language: "en",
          segments: [],
          words,
          wordTimings: "exact",
        },
      },
      { id: "c2", duration: 5, camera: media("k2") },
    ],
    ...extra,
  });
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

describe("editInput", () => {
  it("numbers the kept words, times them every few seconds, lists changes and stills", () => {
    const p = project({
      cuts: [{ id: "x", clip: "c1", start: 0.75, end: 1.15, reason: "filler" }],
    });
    const text = editInput(p, [{ id: "F1", clip: "c1", t: 3.7 }]);
    expect(text).toContain("SCREEN: 1920×1080 pixels.");
    expect(text).toContain("DEFAULT LAYOUT: bubble.");
    expect(text).toContain("TAKE 1 (20.0s, camera, screen)");
    expect(text).toContain("[0|0.2s]Hello, [2]today");
    expect(text).not.toContain("um,");
    expect(text).toContain("[8|3.2s]click");
    expect(text).toContain("- 3.3s–3.3s (word 8): x=0.70 y=0.10 w=0.10 h=0.05");
    expect(text).toContain("Stills: F1 at 3.7s (word 9)");
    expect(text).toContain("TAKE 2 (5.0s, camera, no screen)");
  });
});

describe("planFromAnswer", () => {
  const stills = [{ id: "F2", clip: "c1", t: 12.5 }];

  it("places a zoom over the words, framed with room, and drops what points nowhere", () => {
    const p = project();
    const plan = planFromAnswer(
      p,
      {
        zooms: [
          {
            take: 1,
            from: 8,
            to: 9,
            region: { x: 0.7, y: 0.1, w: 0.1, h: 0.05 },
            why: "save button",
          },
          // Overlaps the first one
          { take: 1, from: 9, to: 9, region: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, why: "again" },
          // Almost the whole screen: not worth it
          { take: 1, from: 10, to: 13, region: { x: 0, y: 0, w: 0.95, h: 0.95 }, why: "page" },
          // No screen in take 2, no take 3, no such words
          { take: 2, from: 0, to: 0, region: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, why: "" },
          { take: 3, from: 0, to: 0, region: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, why: "" },
          { take: 1, from: 40, to: 41, region: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, why: "" },
        ],
        layouts: [],
        blurs: [],
      },
      stills,
    );
    expect(plan.zooms).toHaveLength(1);
    const z = plan.zooms[0];
    expect(z?.clip).toBe("c1");
    expect(z?.auto).toBe(true);
    expect(z?.start).toBeCloseTo(2.7, 5);
    expect(z?.end).toBeCloseTo(4.7, 5);
    // The region with context, square in shares (the screen's aspect), inside the screen.
    expect(z?.box.w).toBeCloseTo(z?.box.h ?? 0, 5);
    expect((z?.box.x ?? 0) + (z?.box.w ?? 0)).toBeLessThanOrEqual(1);
    expect(z?.box.x).toBeLessThanOrEqual(0.7);
    expect(plan.notes[0]).toMatchObject({ kind: "zoom", why: "save button" });
  });

  it("keeps layouts that differ from the default and that the take can show", () => {
    const p = project();
    const plan = planFromAnswer(
      p,
      {
        zooms: [],
        layouts: [
          { take: 1, from: 0, to: 6, layout: "camera", why: "intro" },
          { take: 1, from: 8, to: 9, layout: "screen", why: "too short" },
          { take: 1, from: 10, to: 13, layout: "bubble", why: "the default" },
          { take: 2, from: 0, to: 0, layout: "side", why: "no words" },
        ],
        blurs: [],
      },
      stills,
    );
    expect(plan.layouts.map((l) => [l.layout, l.start, +l.end.toFixed(2)])).toEqual([
      ["camera", 0, 3.1],
    ]);
  });

  it("blurs what a still shows, for as long as the page stays", () => {
    const p = project();
    const plan = planFromAnswer(
      p,
      {
        zooms: [],
        layouts: [],
        blurs: [
          { frame: "f2", region: { x: 0.3, y: 0.4, w: 0.2, h: 0.04 }, why: "email" },
          { frame: "F9", region: { x: 0.3, y: 0.4, w: 0.2, h: 0.04 }, why: "no such still" },
          { frame: "F2", region: { x: 0, y: 0, w: 0.9, h: 0.9 }, why: "too big" },
        ],
      },
      stills,
    );
    expect(plan.blurs).toHaveLength(1);
    const b = plan.blurs[0];
    expect([b?.start, b?.end]).toEqual([8, 16]);
    expect(b?.box.x).toBeCloseTo(0.29, 5);
    expect(b?.box.w).toBeCloseTo(0.22, 5);
  });
});

describe("samePage", () => {
  it("runs from the page change before to the one after", () => {
    const c = project().clips[0];
    if (!c) throw new Error("no clip");
    expect(samePage(c, 5)).toEqual({ start: 0, end: 8 });
    expect(samePage(c, 17)).toEqual({ start: 16, end: 20 });
  });
});

describe("stillTimes and stillBudget", () => {
  it("looks after each change and every ten seconds, within the budget", () => {
    const c = project().clips[0];
    if (!c) throw new Error("no clip");
    const times = stillTimes(c, 10);
    expect(times[0]).toBe(1);
    expect(times.map((t) => +t.toFixed(2))).toContain(3.7);
    expect(times.length).toBeLessThanOrEqual(10);
    expect(stillTimes(c, 2)).toHaveLength(2);
    expect(stillBudget(project().clips, 16)).toEqual([12, 3]);
  });
});

describe("planEdit", () => {
  it("runs the edit, the retakes and the chapters, cleans, and applies in one step", async () => {
    asked.length = 0;
    answers.edit = {
      zooms: [
        { take: 1, from: 8, to: 9, region: { x: 0.7, y: 0.1, w: 0.1, h: 0.05 }, why: "save" },
      ],
      layouts: [{ take: 1, from: 0, to: 6, layout: "camera", why: "intro" }],
      blurs: [],
    };
    answers.retakes = { retakes: [] };
    answers.chapters = { chapters: [{ take: 1, word: 0, title: "Start" }] };
    const old = {
      id: "zold",
      clip: "c1",
      start: 5,
      end: 6,
      box: { x: 0, y: 0, w: 0.5, h: 0.5 },
      auto: true,
    };
    const mine = {
      id: "zmine",
      clip: "c1",
      start: 9,
      end: 10,
      box: { x: 0, y: 0, w: 0.5, h: 0.5 },
      auto: false,
    };
    const p = project({ zooms: [old, mine] });
    const plan = await planEdit(settings, p, {
      visual: true,
      retakes: true,
      clean: true,
      chapters: true,
      language: null,
    });
    // Without sight, the model is told so and sees no still.
    const edit = asked.find((a) => a.name === "edit");
    expect(edit?.instructions).toContain("You do not see the screen");
    expect(edit?.images ?? []).toEqual([]);
    expect(plan.cuts.some((c) => c.reason === "filler")).toBe(true);
    expect(plan.chapters?.[0]?.title).toBe("Start");
    const next = applyPlan(p, plan, true);
    expect(next.zooms.map((z) => z.id)).toEqual(["zmine", plan.zooms[0]?.id ?? "missing"]);
    expect(next.layouts).toHaveLength(1);
    expect(next.cuts.length).toBe(plan.cuts.length);
  });
});
