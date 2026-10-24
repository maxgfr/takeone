import { describe, expect, it } from "bun:test";
import { mix, rms, voice, whiteNoise } from "./fixtures";
import { integratedLoudness, samplePeak } from "./loudness";
import { processVoice } from "./process";

const RATE = 44_100;

describe("processVoice", () => {
  it("denoises and brings a stereo take to the target loudness", async () => {
    const left = mix(voice(6, RATE, 0.02, true), whiteNoise(6, RATE, 0.005, 1));
    const right = mix(voice(6, RATE, 0.02, true), whiteNoise(6, RATE, 0.005, 2));
    const seen: number[] = [];
    const out = await processVoice(
      { channels: [left, right], sampleRate: RATE },
      { denoise: true, normalize: true, target: -20 },
      (r) => seen.push(r),
    );
    expect(out.sampleRate).toBe(RATE);
    expect(out.channels.map((c) => c.length)).toEqual([left.length, right.length]);
    expect(out.gain).toBeGreaterThan(1);
    expect(Math.abs(integratedLoudness(out.channels, RATE) - -20)).toBeLessThan(0.1);
    // Measured before the gain, which also lifts pause blocks over the −70 LUFS gate.
    expect(Math.abs(out.loudness + 20 * Math.log10(out.gain) - -20)).toBeLessThan(1);
    expect(samplePeak(out.channels)).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
    // The noise in the pauses is gone (0.7–0.9 s of each second is silence).
    const pause = Math.round(0.75 * RATE);
    expect(rms(out.channels[0] ?? left, pause, pause + RATE / 10)).toBeLessThan(
      rms(left, pause, pause + RATE / 10) / 10,
    );
    expect(seen.at(-1)).toBe(1);
  });

  it("reaches the target with a loud peak, and holds the peak under the ceiling", async () => {
    // A loud click in a quiet take: −14 LUFS would push it far over −1 dBFS.
    const take = voice(4, RATE, 0.01);
    take[RATE] = 0.9;
    const out = await processVoice(
      { channels: [take], sampleRate: RATE },
      { denoise: false, normalize: true, target: -14 },
    );
    expect(20 * Math.log10(samplePeak(out.channels))).toBeLessThanOrEqual(-1 + 1e-4);
    expect(Math.abs(integratedLoudness(out.channels, RATE) - -14)).toBeLessThan(0.3);
  });

  it("leaves the input untouched", async () => {
    const take = voice(2, RATE, 0.05);
    const copy = take.slice();
    const out = await processVoice(
      { channels: [take], sampleRate: RATE },
      { denoise: false, normalize: true },
    );
    expect(take).toEqual(copy);
    expect(out.channels[0]).not.toBe(take);
    const same = await processVoice(
      { channels: [take], sampleRate: RATE },
      { denoise: false, normalize: false },
    );
    expect(same.gain).toBe(1);
    expect(same.channels[0]).toBe(take);
    // −16 LUFS by default, the peaks held under −1 dBFS.
    expect(Math.abs(integratedLoudness(out.channels, RATE) - -16)).toBeLessThan(0.3);
    expect(samplePeak(out.channels)).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
    expect(same.loudness).toBeCloseTo(integratedLoudness([take], RATE), 6);
  });

  it("denoises a duplicated mono channel once, into two arrays", async () => {
    const take = mix(voice(2, RATE, 0.05), whiteNoise(2, RATE, 0.01));
    const out = await processVoice(
      { channels: [take, take.slice()], sampleRate: RATE },
      { denoise: true, normalize: true },
    );
    const [l, r] = out.channels;
    expect(l).toEqual(r ?? new Float32Array(0));
    expect(l).not.toBe(r);
  });

  it("returns silence as is", async () => {
    const out = await processVoice(
      { channels: [new Float32Array(RATE)], sampleRate: RATE },
      { denoise: true, normalize: true },
    );
    expect(out.gain).toBe(1);
    expect(out.loudness).toBe(Number.NEGATIVE_INFINITY);
    expect(samplePeak(out.channels)).toBe(0);
  });
});
