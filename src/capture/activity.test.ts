import { describe, expect, it } from "bun:test";
import { ActivityLog, diffFrames } from "./activity";

const W = 100;
const H = 50;
function frame(fill: (x: number, y: number) => number): Uint8Array {
  const f = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = fill(x, y);
  return f;
}

describe("diffFrames", () => {
  it("finds the box around what changed", () => {
    const a = frame(() => 20);
    const b = frame((x, y) => (x >= 10 && x < 30 && y >= 5 && y < 15 ? 200 : 20));
    const d = diffFrames(a, b, W, H);
    expect(d.ratio).toBeCloseTo((20 * 10) / (W * H));
    expect(d.box).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    expect(diffFrames(a, a, W, H)).toEqual({ ratio: 0, box: null });
  });
});

describe("ActivityLog", () => {
  it("keeps real changes with their time, not a blinking pixel", () => {
    const log = new ActivityLog();
    const still = frame(() => 20);
    log.push(still, W, H, 0);
    log.push(
      frame((x, y) => (x === 1 && y === 1 ? 255 : 20)),
      W,
      H,
      0.25,
    );
    log.push(
      frame((x, y) => (x === 1 && y === 1 ? 255 : x >= 50 && y >= 25 ? 220 : 20)),
      W,
      H,
      0.5,
    );
    expect(log.events).toHaveLength(1);
    expect(log.events[0]?.t).toBe(0.5);
    expect(log.events[0]?.box).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });
});
