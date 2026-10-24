import { describe, expect, it } from "bun:test";
import { type Project, parseProject } from "../model/project";
import {
  balance,
  type Caption,
  captionAt,
  captionCues,
  drawCaptions,
  lineChars,
  paginate,
  toSrt,
  toVtt,
} from "./captions";

const w = (text: string, start: number, end: number) => ({ text, start, end });

/** Two takes: two sentences in the first, one in the second. */
function project(extra: Record<string, unknown> = {}): Project {
  const one = [
    w("So", 0.2, 0.4),
    w("this", 0.5, 0.8),
    w("is", 0.9, 1.0),
    w("the", 1.1, 1.2),
    w("dashboard.", 1.3, 2.0),
    w("Here", 3.0, 3.2),
    w("you", 3.3, 3.4),
    w("add", 3.5, 3.7),
    w("people.", 3.8, 4.4),
  ];
  const two = [w("Second", 0.5, 0.9), w("take", 1.0, 1.3), w("here.", 1.4, 2.0)];
  const transcript = (
    words: typeof one,
    segments: { text: string; start: number; end: number }[],
  ) => ({
    text: words.map((x) => x.text).join(" "),
    language: "en",
    segments,
    words,
    wordTimings: "exact",
  });
  const res = parseProject({
    id: "p",
    clips: [
      {
        id: "a",
        duration: 6,
        transcript: transcript(one, [
          { text: "So this is the dashboard.", start: 0, end: 2.0 },
          { text: "Here you add people.", start: 3.0, end: 4.4 },
        ]),
      },
      {
        id: "b",
        duration: 3,
        transcript: transcript(two, [{ text: "Second take here.", start: 0.5, end: 2.0 }]),
      },
    ],
    ...extra,
  });
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

describe("captionAt", () => {
  it("shows the sentence being said, and which word", () => {
    const c = captionAt(project(), "a", 0.95, null);
    expect(c).toEqual({ lines: [["So", "this", "is", "the", "dashboard."]], current: 2 });
  });

  it("marks no word before the first one is said", () => {
    expect(captionAt(project(), "a", 0.1, null)?.current).toBe(-1);
  });

  it("shows nothing between sentences", () => {
    expect(captionAt(project(), "a", 2.5, null)).toBeNull();
    expect(captionAt(project(), "a", 5, null)).toBeNull();
  });

  it("leaves out the words that were cut", () => {
    const p = project({ cuts: [{ id: "x", clip: "a", start: 0.45, end: 1.05, reason: "text" }] });
    const c = captionAt(p, "a", 1.15, null);
    expect(c).toEqual({ lines: [["So", "the", "dashboard."]], current: 1 });
  });

  it("shows nothing for a sentence cut whole", () => {
    const p = project({ cuts: [{ id: "x", clip: "a", start: 2.9, end: 4.5, reason: "text" }] });
    expect(captionAt(p, "a", 3.6, null)).toBeNull();
  });

  it("shows a long sentence a page of two lines at a time", () => {
    const words = "one two three four five six seven eight nine ten eleven twelve".split(" ");
    const timed = words.map((t, i) => w(t, i, i + 0.9));
    const res = parseProject({
      id: "p",
      clips: [
        {
          id: "a",
          duration: 13,
          transcript: {
            text: words.join(" "),
            segments: [{ text: words.join(" "), start: 0, end: 12 }],
            words: timed,
            wordTimings: "exact",
          },
        },
      ],
    });
    if (!res.ok) throw new Error(res.error);
    const first = captionAt(res.project, "a", 1.2, null, 14) as Caption;
    expect(first.lines.length).toBe(2);
    expect(first.lines.flat()[first.current]).toBe("two");
    const later = captionAt(res.project, "a", 11.5, null, 14) as Caption;
    expect(later.lines.flat()).toContain("twelve");
    expect(later.lines.flat()).not.toContain("one");
    expect(later.lines.flat()[later.current]).toBe("twelve");
  });

  it("shows a translation over its segment's time, word by word", () => {
    const p = project({
      translations: {
        fr: [
          { clip: "a", text: "Voici le tableau de bord.", start: 0, end: 2 },
          { clip: "a", text: "Ici on ajoute des gens.", start: 3, end: 4.4 },
        ],
      },
    });
    const start = captionAt(p, "a", 0.05, "fr") as Caption;
    expect(start.lines.flat()).toEqual(["Voici", "le", "tableau", "de", "bord."]);
    expect(start.current).toBe(0);
    expect((captionAt(p, "a", 1.95, "fr") as Caption).current).toBe(4);
    // An unknown language shows the original
    expect(captionAt(p, "a", 0.95, "de")?.lines.flat()[0]).toBe("So");
  });
});

describe("line breaking", () => {
  it("balances two lines", () => {
    const ws = "a bb ccc dddd eeeee".split(" ").map((text) => ({ text }));
    const lines = balance(ws, 12);
    expect(lines.map((l) => l.map((x) => x.text).join(" "))).toEqual(["a bb ccc", "dddd eeeee"]);
    expect(balance(ws.slice(0, 2), 12)).toHaveLength(1);
  });

  it("cuts pages of two lines that fit", () => {
    const ws = Array.from({ length: 30 }, (_, i) => ({ text: `w${i}` }));
    const pages = paginate(ws, 12);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(2);
      for (const line of page)
        expect(line.map((x) => x.text).join(" ").length).toBeLessThanOrEqual(12);
    }
    expect(pages.flat(2).length).toBe(30);
  });

  it("depends on the format and the size, not the resolution", () => {
    const p = project();
    const wide = lineChars(p.style);
    const tall = lineChars({ ...p.style, aspect: "9:16" });
    expect(tall).toBeLessThan(wide);
    const big = lineChars({ ...p.style, captions: { ...p.style.captions, size: 0.08 } });
    expect(big).toBeLessThan(wide);
  });
});

describe("captionCues", () => {
  it("places the sentences on the output's timeline, take after take", () => {
    const cues = captionCues(project(), null);
    expect(cues.map((c) => c.text)).toEqual([
      "So this is the dashboard.",
      "Here you add people.",
      "Second take here.",
    ]);
    expect(cues[0]?.start).toBeCloseTo(0.2);
    expect(cues[0]?.end).toBeCloseTo(2.0);
    // The second take starts at 6 s in the output
    expect(cues[2]?.start).toBeCloseTo(6.5);
    expect(cues[2]?.end).toBeCloseTo(8.0);
  });

  it("moves through cuts, and splits a cue a cut falls inside", () => {
    // "is" cut (0.9–1.1), and the pause between the sentences (2–3)
    const p = project({
      cuts: [
        { id: "x", clip: "a", start: 0.88, end: 1.1, reason: "text" },
        { id: "y", clip: "a", start: 2.0, end: 3.0, reason: "silence" },
      ],
    });
    const cues = captionCues(p, null);
    expect(cues.map((c) => c.text)).toEqual([
      "So this",
      "the dashboard.",
      "Here you add people.",
      "Second take here.",
    ]);
    expect(cues[0]?.end).toBeCloseTo(0.88);
    expect(cues[1]?.start).toBeCloseTo(0.88);
    expect(cues[1]?.end).toBeCloseTo(1.78);
    expect(cues[2]?.start).toBeCloseTo(1.78);
    // 6 s of take one, minus 1.22 s of cuts
    expect(cues[3]?.start).toBeCloseTo(4.78 + 0.5);
  });

  it("writes SubRip and WebVTT", () => {
    const cues = [
      { start: 0.2, end: 2, text: "So this is\nthe dashboard." },
      { start: 3661.5, end: 3662.25, text: "Later." },
    ];
    expect(toSrt(cues)).toBe(
      "1\n00:00:00,200 --> 00:00:02,000\nSo this is\nthe dashboard.\n\n2\n01:01:01,500 --> 01:01:02,250\nLater.\n",
    );
    expect(toVtt(cues)).toBe(
      "WEBVTT\n\n00:00:00.200 --> 00:00:02.000\nSo this is\nthe dashboard.\n\n01:01:01.500 --> 01:01:02.250\nLater.\n",
    );
  });
});

/** A context that records what is drawn; text is 0.5 em wide a character. */
function fakeCtx() {
  const texts: { text: string; x: number; y: number; color: string }[] = [];
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  let px = 10;
  const ctx = {
    fillStyle: "",
    textBaseline: "",
    textAlign: "",
    globalAlpha: 1,
    filter: "none",
    set font(f: string) {
      px = Number(/(\d+(\.\d+)?)px/.exec(f)?.[1] ?? 10);
    },
    measureText: (t: string) => ({ width: t.length * px * 0.5 }),
    save() {},
    restore() {},
    setTransform() {},
    beginPath() {},
    fill() {},
    roundRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h });
    },
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, color: ctx.fillStyle });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, rects };
}

describe("drawCaptions", () => {
  const style = {
    enabled: true,
    size: 0.05,
    position: "bottom",
    karaoke: true,
    language: null,
  } as const;
  const caption: Caption = { lines: [["Click", "the", "blue", "button."]], current: 2 };

  it("draws the word being said in the accent, on a band at the bottom", () => {
    const { ctx, texts, rects } = fakeCtx();
    drawCaptions(ctx, 1280, 720, style, caption);
    expect(texts.map((t) => t.text)).toEqual(["Click", "the", "blue", "button."]);
    expect(texts.find((t) => t.text === "blue")?.color).toBe("#ff5a3c");
    expect(texts.find((t) => t.text === "the")?.color).toBe("#ffffff");
    const band = rects[0];
    expect(band).toBeDefined();
    expect((band?.y ?? 0) + (band?.h ?? 0)).toBeGreaterThan(720 * 0.9);
  });

  it("keeps the same look at any resolution, and wraps to a narrow width", () => {
    const small = fakeCtx();
    const big = fakeCtx();
    drawCaptions(small.ctx, 1280, 720, { ...style, position: "top" }, caption);
    drawCaptions(big.ctx, 3840, 2160, { ...style, position: "top" }, caption);
    expect((big.rects[0]?.w ?? 0) / (small.rects[0]?.w ?? 1)).toBeCloseTo(3);
    expect(small.rects[0]?.y).toBeLessThan(720 * 0.1);
    const narrow = fakeCtx();
    const long: Caption = {
      lines: [["A", "rather", "long", "caption", "that", "cannot", "fit", "on", "one", "line"]],
      current: 0,
    };
    drawCaptions(narrow.ctx, 400, 720, { ...style, size: 0.1 }, long);
    const rows = new Set(narrow.texts.map((t) => Math.round(t.y)));
    expect(rows.size).toBeGreaterThan(1);
    for (const t of narrow.texts) expect(t.x).toBeGreaterThanOrEqual(0);
  });

  it("highlights nothing without karaoke", () => {
    const { ctx, texts } = fakeCtx();
    drawCaptions(ctx, 1280, 720, { ...style, karaoke: false }, caption);
    expect(texts.every((t) => t.color === "#ffffff")).toBe(true);
  });
});
