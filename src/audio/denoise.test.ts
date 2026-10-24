import { describe, expect, it } from "bun:test";
import { denoise } from "./denoise";
import { bestLag, mix, rms, speaking, voice, whiteNoise } from "./fixtures";

const db = (ratio: number) => 20 * Math.log10(ratio);

function correlation(x: Float32Array, y: Float32Array, from: number): number {
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let i = from; i < x.length; i++) {
    const a = x[i] ?? 0;
    const b = y[i] ?? 0;
    xy += a * b;
    xx += a * a;
    yy += b * b;
  }
  return xy / Math.sqrt(xx * yy);
}

/** RMS of `x` over the samples where `inside(t)` holds. */
function rmsWhere(x: Float32Array, rate: number, inside: (t: number) => boolean): number {
  let sum = 0;
  let n = 0;
  for (let i = rate; i < x.length; i++)
    if (inside(i / rate)) {
      sum += (x[i] ?? 0) ** 2;
      n++;
    }
  return Math.sqrt(sum / n);
}

describe("denoise", () => {
  for (const rate of [48_000, 44_100]) {
    it(`removes white noise (${rate} Hz)`, async () => {
      const noise = whiteNoise(4, rate, 0.05);
      const out = await denoise(noise, rate);
      expect(out.length).toBe(noise.length);
      // Past the first second, which the model needs to settle.
      expect(db(rms(out, rate) / rms(noise, rate))).toBeLessThan(-20);
    });

    it(`keeps a voice intact and aligned (${rate} Hz)`, async () => {
      const v = voice(4, rate, 0.1);
      const out = await denoise(v, rate);
      expect(out.length).toBe(v.length);
      expect(Math.abs(db(rms(out, rate) / rms(v, rate)))).toBeLessThan(1.5);
      expect(Math.abs(bestLag(v, out, 600))).toBeLessThanOrEqual(3);
      expect(correlation(v, out, rate)).toBeGreaterThan(0.9);
    });
  }

  it("cleans the pauses of noisy speech and keeps the words", async () => {
    const rate = 44_100;
    const clean = voice(6, rate, 0.1, true);
    const noise = whiteNoise(6, rate, 0.01, 3);
    const out = await denoise(mix(clean, noise), rate);
    // In the pauses (away from the edges of the words), the noise goes away.
    const pause = (t: number) => t % 1 > 0.7 && t % 1 < 0.9;
    expect(db(rmsWhere(out, rate, pause) / rmsWhere(noise, rate, pause))).toBeLessThan(-15);
    // While speaking, the level hardly moves.
    const words = (t: number) => speaking(t) === 1;
    expect(Math.abs(db(rmsWhere(out, rate, words) / rmsWhere(clean, rate, words)))).toBeLessThan(3);
  });

  it("keeps any length, and leaves the input alone", async () => {
    for (const [length, rate] of [
      [0, 48_000],
      [1, 48_000],
      [479, 48_000],
      [1001, 48_000],
      [12_345, 44_100],
      [7, 16_000],
    ] as const) {
      const input = whiteNoise(length / rate, rate, 0.05);
      const copy = input.slice();
      expect((await denoise(input, rate)).length).toBe(length);
      expect(input).toEqual(copy);
    }
  });

  it("reports its progress up to 1", async () => {
    const seen: number[] = [];
    await denoise(whiteNoise(3, 44_100), 44_100, (r) => seen.push(r));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
  });

  it("rejects a bad sample rate", async () => {
    await expect(denoise(new Float32Array(10), 0)).rejects.toThrow();
  });
});
