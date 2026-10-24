import { describe, expect, it } from "bun:test";
import { resample, resampledLength } from "./resample";

function sine(freq: number, rate: number, length: number, phase = 0): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate + phase);
  return out;
}

/** Largest error between `a` and `b`, away from the edges. */
function maxError(a: Float32Array, b: Float32Array, margin: number): number {
  let max = 0;
  for (let i = margin; i < Math.min(a.length, b.length) - margin; i++)
    max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return max;
}

describe("resample", () => {
  it("keeps the duration", () => {
    expect(resampledLength(44_100, 44_100, 48_000)).toBe(48_000);
    expect(resampledLength(1001, 44_100, 48_000)).toBe(1090);
    expect(resample(new Float32Array(1001), 44_100, 48_000).length).toBe(1090);
    expect(resample(new Float32Array(1001), 48_000, 44_100, 1001).length).toBe(1001);
  });

  it("reproduces a tone at the new rate, in phase", () => {
    const x = sine(1000, 44_100, 44_100);
    const y = resample(x, 44_100, 48_000);
    expect(maxError(y, sine(1000, 48_000, y.length), 200)).toBeLessThan(1e-3);
    const z = resample(y, 48_000, 44_100, x.length);
    expect(maxError(z, x, 200)).toBeLessThan(1e-3);
    const d = resample(sine(3000, 48_000, 48_000), 48_000, 16_000);
    expect(maxError(d, sine(3000, 16_000, d.length), 100)).toBeLessThan(1e-3);
  });

  it("removes what the lower rate cannot hold", () => {
    // 20 kHz at 48 kHz would alias to 4 kHz at 16 kHz.
    const y = resample(sine(20_000, 48_000, 48_000), 48_000, 16_000);
    let peak = 0;
    for (let i = 100; i < y.length - 100; i++) peak = Math.max(peak, Math.abs(y[i] ?? 0));
    expect(peak).toBeLessThan(1e-3);
  });

  it("copies when the rates are equal", () => {
    const x = Float32Array.of(1, 2, 3);
    const y = resample(x, 48_000, 48_000);
    expect(Array.from(y)).toEqual([1, 2, 3]);
    expect(y).not.toBe(x);
  });
});
