import { describe, expect, it } from "bun:test";
import { limit } from "./limiter";
import { samplePeak } from "./loudness";

const RATE = 48_000;

describe("limit", () => {
  it("holds every peak under the ceiling, smoothly, and leaves quiet parts alone", () => {
    const x = new Float32Array(RATE).fill(0.2);
    x[RATE / 2] = 1.5;
    const [y] = limit([x], RATE, { ceilingDb: -1 });
    if (!y) throw new Error("no output");
    expect(samplePeak([y])).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
    // Far from the peak, nothing changes.
    expect(y[1000]).toBeCloseTo(0.2, 6);
    expect(y[RATE - 1]).toBeCloseTo(0.2, 6);
    // No step: neighbouring samples' gains differ by little.
    let jump = 0;
    for (let i = 1; i < y.length; i++)
      if (i !== RATE / 2 && i !== RATE / 2 + 1)
        jump = Math.max(jump, Math.abs((y[i] ?? 0) - (y[i - 1] ?? 0)));
    expect(jump).toBeLessThan(0.01);
  });

  it("applies one gain to every channel and copies when nothing passes", () => {
    const l = new Float32Array(100).fill(0.1);
    const r = new Float32Array(100).fill(0.1);
    r[50] = 2;
    const [a, b] = limit([l, r], RATE);
    expect(a?.[50]).toBeLessThan(0.1);
    const quiet = limit([l], RATE);
    expect(quiet[0]).toEqual(l);
    expect(quiet[0]).not.toBe(l);
    expect(b?.[50] ?? 0).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
  });
});
