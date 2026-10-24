import { describe, expect, it } from "bun:test";
import { parseProject } from "../model/project";
import { addBlur, addZoom, clampBox, clipRanges, cutRange, removeItem, setLayout } from "./ops";
import { outputDuration, segmentsOf } from "./timeline";

function project(input: Record<string, unknown>) {
  const res = parseProject({ id: "p", ...input });
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

const base = project({
  clips: [
    { id: "a", duration: 10 },
    { id: "b", duration: 5 },
  ],
  cuts: [{ id: "x", clip: "a", start: 4, end: 6 }],
});
const segs = segmentsOf(base);

describe("output ranges to takes", () => {
  it("splits a range across a cut and two takes", () => {
    expect(clipRanges(segs, { start: 3, end: 10 })).toEqual([
      { clip: "a", start: 3, end: 4 },
      { clip: "a", start: 6, end: 10 },
      { clip: "b", start: 0, end: 2 },
    ]);
  });

  it("cuts a range, and restores it", () => {
    const cut = cutRange(base, segs, { start: 1, end: 2 });
    expect(outputDuration(segmentsOf(cut))).toBe(12);
    const restored = removeItem(cut, "cut", cut.cuts[1]?.id ?? "");
    expect(outputDuration(segmentsOf(restored))).toBe(13);
  });

  it("sets a layout over a range, replacing what it covers", () => {
    const one = setLayout(base, segs, { start: 0, end: 2 }, "camera");
    const two = setLayout(one, segmentsOf(one), { start: 0, end: 3 }, "side");
    expect(two.layouts.map((l) => [l.layout, l.start, l.end])).toEqual([["side", 0, 3]]);
  });

  it("adds a zoom on the first piece and blurs on every piece", () => {
    const z = addZoom(base, segs, { start: 3, end: 5 });
    expect(z.project.zooms[0]).toMatchObject({ clip: "a", start: 3, end: 4, auto: false });
    const b = addBlur(base, segs, { start: 3, end: 9 });
    expect(b.project.blurs.map((x) => x.clip)).toEqual(["a", "a", "b"]);
  });

  it("keeps boxes inside the screen", () => {
    expect(clampBox({ x: 0.9, y: -1, w: 0.5, h: 0 })).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.02 });
  });
});
