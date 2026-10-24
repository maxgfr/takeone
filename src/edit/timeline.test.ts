import { describe, expect, it } from "bun:test";
import { parseProject } from "../model/project";
import {
  keep,
  mergeRanges,
  outputDuration,
  outputSpans,
  outputTime,
  rangeAt,
  segmentsOf,
  sourceAt,
} from "./timeline";

function project(input: unknown) {
  const res = parseProject(input);
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

const p = project({
  id: "p",
  clips: [
    { id: "a", duration: 10 },
    { id: "b", duration: 5 },
  ],
  cuts: [
    { id: "x", clip: "a", start: 2, end: 4 },
    { id: "y", clip: "a", start: 3, end: 5 },
    { id: "z", clip: "b", start: 0, end: 1 },
  ],
});

describe("ranges", () => {
  it("merges overlapping ranges and keeps the rest", () => {
    expect(
      mergeRanges([
        { start: 3, end: 5 },
        { start: 2, end: 4 },
        { start: 7, end: 7 },
      ]),
    ).toEqual([{ start: 2, end: 5 }]);
    expect(
      keep(10, [
        { start: 2, end: 5 },
        { start: 9, end: 12 },
      ]),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 9 },
    ]);
  });
});

describe("segments", () => {
  const segs = segmentsOf(p);

  it("lays the kept pieces end to end", () => {
    expect(segs.map((s) => [s.clip.id, s.start, s.end, s.at])).toEqual([
      ["a", 0, 2, 0],
      ["a", 5, 10, 2],
      ["b", 1, 5, 7],
    ]);
    expect(outputDuration(segs)).toBe(11);
  });

  it("maps output time to a clip and back", () => {
    expect(sourceAt(segs, 1)?.t).toBe(1);
    const after = sourceAt(segs, 2.5);
    expect([after?.segment.clip.id, after?.t]).toEqual(["a", 5.5]);
    expect(sourceAt(segs, 8)?.segment.clip.id).toBe("b");
    expect(sourceAt(segs, 99)?.t).toBe(5);
    expect(outputTime(segs, "a", 6)).toBe(3);
    expect(outputTime(segs, "a", 3)).toBeNull();
    expect(outputTime(segs, "b", 2)).toBe(8);
  });

  it("finds the range at a moment and shows a range across cuts", () => {
    const ranges = [
      { clip: "a", start: 0, end: 10, v: 1 },
      { clip: "a", start: 6, end: 8, v: 2 },
    ];
    expect(rangeAt(ranges, "a", 7)?.v).toBe(2);
    expect(rangeAt(ranges, "a", 9)?.v).toBe(1);
    expect(rangeAt(ranges, "b", 1)).toBeUndefined();
    expect(outputSpans(segs, "a", { start: 1, end: 6 })).toEqual([
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]);
  });
});
