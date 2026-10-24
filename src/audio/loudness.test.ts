import { describe, expect, it } from "bun:test";
import { mix, voice, whiteNoise } from "./fixtures";
import {
  blockPowers,
  gainFor,
  gatedLoudness,
  integratedLoudness,
  kWeighting,
  normalizationGain,
  samplePeak,
} from "./loudness";

/** A sine of `freq` Hz whose peak is `dbfs` dBFS, `seconds` long. */
function sine(dbfs: number, seconds: number, rate: number, freq = 997): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  const amp = 10 ** (dbfs / 20);
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("kWeighting", () => {
  it("matches the BS.1770-4 coefficients at 48 kHz", () => {
    const [shelf, highPass] = kWeighting(48_000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 10);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 10);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 10);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 10);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 10);
    expect(highPass.a1).toBeCloseTo(-1.99004745483398, 10);
    expect(highPass.a2).toBeCloseTo(0.99007225036621, 10);
  });
});

describe("integratedLoudness", () => {
  it("reads −3.01 LU below the peak for a 997 Hz sine in one channel (BS.1770)", () => {
    for (const rate of [48_000, 44_100, 32_000, 16_000]) {
      const mono = integratedLoudness([sine(-20, 5, rate)], rate);
      expect(Math.abs(mono - -23.01)).toBeLessThan(0.05);
    }
  });

  it("adds 3 LU when the same sine is in both channels", () => {
    const s = sine(-20, 5, 48_000);
    expect(Math.abs(integratedLoudness([s, s], 48_000) - -20)).toBeLessThan(0.05);
  });

  it("passes the EBU Tech 3341 stereo cases 1, 2 and 5", () => {
    const at = (db: number, s: number) => sine(db, s, 48_000, 1000);
    const stereo = (x: Float32Array) => integratedLoudness([x, x], 48_000);
    expect(Math.abs(stereo(at(-23, 20)) - -23)).toBeLessThan(0.1);
    expect(Math.abs(stereo(at(-33, 20)) - -33)).toBeLessThan(0.1);
    const case5 = concat(at(-26, 20), at(-20, 20.1), at(-26, 20));
    expect(Math.abs(stereo(case5) - -23)).toBeLessThan(0.1);
  });

  it("gates silence and quiet passages (EBU Tech 3341 cases 3 and 4)", () => {
    const at = (db: number, s: number) => sine(db, s, 48_000, 1000);
    const stereo = (x: Float32Array) => integratedLoudness([x, x], 48_000);
    expect(Math.abs(stereo(concat(at(-36, 10), at(-23, 60), at(-36, 10))) - -23)).toBeLessThan(0.1);
    const case4 = concat(at(-72, 10), at(-36, 10), at(-23, 60), at(-36, 10), at(-72, 10));
    expect(Math.abs(stereo(case4) - -23)).toBeLessThan(0.1);
    // Digital silence around a tone barely lowers its loudness (only the few
    // blocks that straddle an edge count); ungated, it would read −27.8 LUFS.
    const silence = new Float32Array(48_000 * 20);
    const tone = sine(-20, 20, 48_000);
    expect(
      Math.abs(integratedLoudness([concat(silence, tone, silence)], 48_000) - -23.01),
    ).toBeLessThan(0.1);
  });

  it("is −Infinity for silence and empty input", () => {
    expect(integratedLoudness([new Float32Array(48_000)], 48_000)).toBe(Number.NEGATIVE_INFINITY);
    expect(integratedLoudness([sine(-80, 2, 48_000)], 48_000)).toBe(Number.NEGATIVE_INFINITY);
    expect(integratedLoudness([new Float32Array(0)], 48_000)).toBe(Number.NEGATIVE_INFINITY);
    expect(integratedLoudness([], 48_000)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("measures a clip shorter than a block as one block", () => {
    expect(Math.abs(integratedLoudness([sine(-20, 0.3, 48_000)], 48_000) - -23.01)).toBeLessThan(
      0.2,
    );
  });

  it("weights 5.1 surrounds by 1.41 and ignores the LFE", () => {
    const s = sine(-20, 3, 48_000);
    const z = new Float32Array(s.length);
    expect(integratedLoudness([z, z, z, s, z, z], 48_000)).toBe(Number.NEGATIVE_INFINITY);
    const surround = integratedLoudness([z, z, z, z, s, z], 48_000);
    expect(Math.abs(surround - (-23.01 + 10 * Math.log10(1.41)))).toBeLessThan(0.05);
  });

  it("rejects channels of different lengths", () => {
    expect(() =>
      integratedLoudness([new Float32Array(10), new Float32Array(11)], 48_000),
    ).toThrow();
  });
});

describe("samplePeak", () => {
  it("finds the largest magnitude in any channel", () => {
    expect(samplePeak([Float32Array.of(0.1, -0.5), Float32Array.of(0.3, 0.2)])).toBeCloseTo(0.5, 6);
    expect(samplePeak([])).toBe(0);
  });
});

describe("gainFor", () => {
  it("brings the program to the target", () => {
    expect(20 * Math.log10(gainFor(-30, 0.05))).toBeCloseTo(14, 6);
    expect(20 * Math.log10(gainFor(-10, 0.9))).toBeCloseTo(-6, 6);
    expect(20 * Math.log10(gainFor(-30, 0.05, -23))).toBeCloseTo(7, 6);
  });

  it("keeps the sample peak under the ceiling", () => {
    const g = gainFor(-30, 0.5); // +14 dB would put the peak at +8 dBFS
    expect(20 * Math.log10(0.5 * g)).toBeCloseTo(-1, 6);
    const h = gainFor(-30, 0.5, -16, -3);
    expect(20 * Math.log10(0.5 * h)).toBeCloseTo(-3, 6);
  });

  it("leaves silence alone", () => {
    expect(gainFor(Number.NEGATIVE_INFINITY, 0)).toBe(1);
  });
});

describe("normalizationGain", () => {
  // Quiet speech with pauses, over a hiss under the −70 LUFS gate: lifted over
  // it, the pause blocks lower the relative gate, which lets in more of the
  // blocks that straddle a word and its pause.
  const rate = 48_000;
  const program = mix(voice(20, rate, 0.01, true), whiteNoise(20, rate, 0.0001));
  const blocks = blockPowers([program], rate);

  it("lands on the target where a single measurement misses it", () => {
    const naive = gatedLoudness(blocks, gainFor(gatedLoudness(blocks), 0));
    expect(Math.abs(naive - -16)).toBeGreaterThan(0.2);
    const gain = normalizationGain(blocks, 0);
    expect(Math.abs(integratedLoudness([program.map((x) => x * gain)], rate) - -16)).toBeLessThan(
      0.01,
    );
  });

  it("keeps the sample peak under the ceiling", () => {
    const peak = samplePeak([program]);
    expect(20 * Math.log10(peak * normalizationGain(blocks, peak))).toBeLessThan(-1);
    expect(20 * Math.log10(peak * normalizationGain(blocks, peak, -16, -10))).toBeCloseTo(-10, 6);
  });

  it("leaves silence alone", () => {
    expect(normalizationGain(blockPowers([new Float32Array(rate)], rate), 0)).toBe(1);
    expect(normalizationGain([], 0)).toBe(1);
  });
});
