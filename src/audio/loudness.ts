/**
 * Loudness of a program, as ITU-R BS.1770-4 and EBU R128 define it, and the
 * gain that brings it to a target.
 *
 * Each channel goes through the K-weighting filter (a high shelf, then a high
 * pass), its mean square is taken over 400 ms blocks that start every 100 ms,
 * the channels are summed with their weights, and the blocks are gated twice:
 * below −70 LUFS (silence), then below the loudness of what is left minus
 * 10 LU (pauses). The integrated loudness is the mean of the remaining blocks.
 * Since a gain can lift quiet blocks over the gates, `normalizationGain`
 * measures again at the gain it found until the program lands on the target.
 */

/** Biquad coefficients, normalized so that a0 = 1. */
export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting stages for any sample rate, derived from their analog
 * prototypes (as libebur128 does). At 48 kHz they match the coefficients
 * printed in BS.1770-4.
 */
export function kWeighting(sampleRate: number): [shelf: Biquad, highPass: Biquad] {
  // Stage 1: high shelf, +4 dB above ~1.7 kHz (the acoustic effect of the head).
  let f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = 10 ** (gainDb / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };

  // Stage 2: high pass at ~38 Hz (the RLB curve).
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + k / q + k * k;
  const highPass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  return [shelf, highPass];
}

/** Weights of each channel in the sum: 1 for the front, 1.41 for the surrounds, 0 for the LFE. */
function channelWeights(count: number): number[] {
  // Web Audio channel order: L R C LFE SL SR for 5.1, L R C SL SR for 5.0.
  if (count === 6) return [1, 1, 1, 0, 1.41, 1.41];
  if (count === 5) return [1, 1, 1, 1.41, 1.41];
  return new Array<number>(count).fill(1);
}

const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;

/**
 * Integrated loudness in LUFS of `channels` (one Float32Array per channel, all
 * the same length, samples in [−1, 1]). `-Infinity` for silence. A clip
 * shorter than one 400 ms block is measured as a single block.
 */
export function integratedLoudness(channels: Float32Array[], sampleRate: number): number {
  return gatedLoudness(blockPowers(channels, sampleRate));
}

/**
 * Mean square of each 400 ms block of the K-weighted program, the channels
 * summed with their weights: what the gates and the integrated loudness are
 * computed from.
 */
export function blockPowers(channels: Float32Array[], sampleRate: number): number[] {
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate))
    throw new RangeError(`invalid sample rate: ${sampleRate}`);
  const length = channels[0]?.length ?? 0;
  for (const ch of channels)
    if (ch.length !== length) throw new RangeError("channels must have the same length");
  if (length === 0) return [];

  const step = Math.max(1, Math.round(sampleRate / 10)); // 100 ms
  const blockLength = 4 * step; // 400 ms, 75 % overlap
  const short = length < blockLength;
  // Weighted sum of the K-weighted squares, per 100 ms segment (the tail
  // shorter than a segment belongs to no complete block and is left out). A
  // clip shorter than a block is one segment.
  const segments = short ? 1 : Math.floor(length / step);
  const energy = new Float64Array(segments);
  const weights = channelWeights(channels.length);
  const [s1, s2] = kWeighting(sampleRate);

  channels.forEach((ch, c) => {
    const w = weights[c] ?? 1;
    if (w === 0) return;
    // Both stages in direct form I, in double precision.
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    let z1 = 0;
    let z2 = 0;
    for (let seg = 0; seg < segments; seg++) {
      const start = seg * step;
      const end = short ? length : start + step;
      let sum = 0;
      for (let i = start; i < end; i++) {
        const x = ch[i] ?? 0;
        const y = s1.b0 * x + s1.b1 * x1 + s1.b2 * x2 - s1.a1 * y1 - s1.a2 * y2;
        x2 = x1;
        x1 = x;
        const z = y - 2 * y1 + y2 - s2.a1 * z1 - s2.a2 * z2;
        y2 = y1;
        y1 = y;
        z2 = z1;
        z1 = z;
        sum += z * z;
      }
      energy[seg] = (energy[seg] ?? 0) + w * sum;
    }
  });

  if (short) return [(energy[0] ?? 0) / length];
  const blocks: number[] = [];
  for (let j = 0; j + 4 <= segments; j++) {
    const e = (energy[j] ?? 0) + (energy[j + 1] ?? 0) + (energy[j + 2] ?? 0) + (energy[j + 3] ?? 0);
    blocks.push(e / blockLength);
  }
  return blocks;
}

const lufs = (power: number) => -0.691 + 10 * Math.log10(power);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Integrated loudness of the program whose blocks are `blocks`, as if it were
 * scaled by `gain` first. The gates make loudness not quite proportional to
 * the gain: blocks that were under −70 LUFS can rise above it.
 */
export function gatedLoudness(blocks: number[], gain = 1): number {
  const scaled = blocks.map((p) => p * gain * gain);
  const audible = scaled.filter((p) => lufs(p) > ABSOLUTE_GATE);
  if (audible.length === 0) return Number.NEGATIVE_INFINITY;
  const relative = lufs(mean(audible)) + RELATIVE_GATE;
  const gated = audible.filter((p) => lufs(p) > relative);
  return gated.length === 0 ? Number.NEGATIVE_INFINITY : lufs(mean(gated));
}

/** Largest absolute sample value across the channels (linear, 1 = 0 dBFS). */
export function samplePeak(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels)
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i] ?? 0);
      if (v > peak) peak = v;
    }
  return peak;
}

/**
 * Linear gain that brings a program measured at `lufs` to `target` LUFS,
 * lowered if needed so that its sample peak stays at or below `ceilingDb`
 * dBFS. 1 for silence.
 */
export function gainFor(lufs: number, peak: number, target = -16, ceilingDb = -1): number {
  if (!Number.isFinite(lufs)) return 1;
  let gain = 10 ** ((target - lufs) / 20);
  const ceiling = 10 ** (ceilingDb / 20);
  if (peak > 0 && peak * gain > ceiling) gain = ceiling / peak;
  return gain;
}

/**
 * Like `gainFor`, from the blocks of `blockPowers`: the loudness is measured
 * again at the gain found, a few times, so that the result lands on `target`
 * even when the gain lifts quiet blocks over the absolute gate.
 */
export function normalizationGain(
  blocks: number[],
  peak: number,
  target = -16,
  ceilingDb = -1,
): number {
  const measured = gatedLoudness(blocks);
  if (!Number.isFinite(measured)) return 1;
  let gain = 10 ** ((target - measured) / 20);
  let best = gain;
  let bestError = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 8; i++) {
    const error = target - gatedLoudness(blocks, gain);
    if (Math.abs(error) < bestError) {
      best = gain;
      bestError = Math.abs(error);
    }
    if (bestError < 1e-3) break;
    gain *= 10 ** (error / 20);
  }
  const ceiling = 10 ** (ceilingDb / 20);
  return peak > 0 && peak * best > ceiling ? ceiling / peak : best;
}
