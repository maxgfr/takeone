import { describe, expect, it } from "bun:test";
import { suggestZooms } from "../edit/zooms";
import { parseProject } from "../model/project";
import { contain, FULL, layoutAt, outputSize, placements, usableLayout, viewAt } from "./compose";

function project(input: Record<string, unknown>) {
  const res = parseProject({ id: "p", ...input });
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

describe("geometry", () => {
  it("sizes outputs by aspect, in even pixels", () => {
    expect(outputSize("16:9", 1080)).toEqual({ w: 1920, h: 1080 });
    expect(outputSize("9:16", 1080)).toEqual({ w: 1080, h: 1920 });
    expect(outputSize("1:1", 721)).toEqual({ w: 722, h: 722 });
  });

  it("fits a shape inside an area, centered", () => {
    expect(contain({ x: 0, y: 0, w: 200, h: 100 }, 1)).toEqual({ x: 50, y: 0, w: 100, h: 100 });
  });

  it("places the screen and a bubble in the chosen corner", () => {
    const { style } = project({
      style: { padding: 0.05, bubble: { corner: "top-left", size: 0.2 } },
    });
    const pl = placements("bubble", 1920, 1080, style, 16 / 9);
    expect(pl.round).toBe(true);
    expect(pl.camera?.w).toBeCloseTo(216);
    expect(pl.camera?.x).toBeLessThan(100);
    expect(pl.camera?.y).toBeLessThan(100);
    expect(pl.screen?.h).toBeCloseTo(1080 - 2 * 54);
    const side = placements("side", 1920, 1080, style, 16 / 9);
    expect((side.camera?.x ?? 0) > (side.screen?.x ?? 0) + (side.screen?.w ?? 0)).toBe(true);
    expect(placements("camera", 1080, 1920, style, 16 / 9).screen).toBeNull();
  });

  it("falls back to the layouts the sources allow", () => {
    expect(usableLayout("bubble", true, false)).toBe("screen");
    expect(usableLayout("side", false, true)).toBe("camera");
    expect(usableLayout("side", true, true)).toBe("side");
  });
});

describe("over time", () => {
  const p = project({
    style: { layout: "bubble" },
    layouts: [{ id: "l", clip: "c", start: 5, end: 8, layout: "camera" }],
    zooms: [{ id: "z", clip: "c", start: 2, end: 4, box: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }],
  });

  it("slides from one layout to the next", () => {
    expect(layoutAt(p, "c", 1)).toEqual({ layout: "bubble", from: "bubble", k: 1 });
    const mid = layoutAt(p, "c", 5.2);
    expect([mid.layout, mid.from]).toEqual(["camera", "bubble"]);
    expect(mid.k).toBeGreaterThan(0);
    expect(mid.k).toBeLessThan(1);
    expect(layoutAt(p, "c", 8.1).from).toBe("camera");
  });

  it("eases a zoom in and out", () => {
    expect(viewAt(p.zooms, "c", 1)).toEqual(FULL);
    expect(viewAt(p.zooms, "c", 3)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    const easing = viewAt(p.zooms, "c", 2.1);
    expect(easing.w).toBeGreaterThan(0.5);
    expect(easing.w).toBeLessThan(1);
  });
});

describe("suggested zooms", () => {
  it("groups nearby changes into one zoom and skips whole-screen ones", () => {
    const { clips } = project({
      clips: [
        {
          id: "c",
          duration: 20,
          activity: [
            { t: 2, ratio: 0.01, box: { x: 0.1, y: 0.1, w: 0.1, h: 0.05 } },
            { t: 2.5, ratio: 0.01, box: { x: 0.12, y: 0.12, w: 0.1, h: 0.05 } },
            { t: 8, ratio: 0.9, box: { x: 0, y: 0, w: 1, h: 1 } },
            { t: 14, ratio: 0.0001, box: { x: 0.5, y: 0.5, w: 0.01, h: 0.01 } },
          ],
        },
      ],
    });
    const zooms = suggestZooms(clips[0] as (typeof clips)[number]);
    expect(zooms).toHaveLength(1);
    const z = zooms[0];
    expect(z?.start).toBeCloseTo(1.4);
    expect(z?.end).toBeCloseTo(4.3);
    expect(z?.auto).toBe(true);
    expect(z?.box.w).toBe(z?.box.h);
    expect(z?.box.x).toBe(0);
  });
});
