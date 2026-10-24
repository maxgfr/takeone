/**
 * Band-limited resampling between any two sample rates: each output sample is
 * the input convolved with a Kaiser-windowed sinc centred on its position, so
 * the output is aligned with the input (no delay). The cutoff sits a little
 * below the lower of the two Nyquist frequencies, which removes aliasing when
 * the rate goes down. Samples outside the input count as silence.
 */

const ZERO_CROSSINGS = 16; // per side of the kernel
const RESOLUTION = 512; // kernel table entries between two zero crossings
const ROLLOFF = 0.95; // cutoff, as a fraction of the lower Nyquist frequency
const KAISER_BETA = 8.6; // ~ −80 dB side lobes

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

/** The windowed sinc for |d| from 0 to ZERO_CROSSINGS, in steps of 1/RESOLUTION, plus a guard entry. */
const KERNEL = (() => {
  const n = ZERO_CROSSINGS * RESOLUTION;
  const table = new Float64Array(n + 2);
  const norm = besselI0(KAISER_BETA);
  for (let k = 0; k <= n; k++) {
    const d = k / RESOLUTION;
    const sinc = k === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
    const r = k / n;
    table[k] = (sinc * besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - r * r)))) / norm;
  }
  return table;
})();

/** Number of output samples for `inputLength` samples at `from` Hz resampled to `to` Hz. */
export function resampledLength(inputLength: number, from: number, to: number): number {
  return Math.ceil((inputLength * to) / from);
}

/**
 * Writes the output samples `start` to `end` (exclusive) of `input` resampled
 * from `from` Hz to `to` Hz into `output`. Lets a caller resample a long
 * signal in slices and yield in between.
 */
export function resampleRange(
  input: Float32Array,
  from: number,
  to: number,
  output: Float32Array,
  start: number,
  end: number,
): void {
  const ratio = from / to; // input samples per output sample
  const cutoff = ROLLOFF * Math.min(1, to / from);
  const half = Math.ceil(ZERO_CROSSINGS / cutoff);
  const limit = ZERO_CROSSINGS * RESOLUTION;
  const scale = cutoff * RESOLUTION;
  const n = input.length;
  for (let i = start; i < end; i++) {
    const t = i * ratio;
    const centre = Math.floor(t);
    const j0 = Math.max(0, centre - half + 1);
    const j1 = Math.min(n - 1, centre + half);
    let acc = 0;
    for (let j = j0; j <= j1; j++) {
      const u = Math.abs(t - j) * scale;
      const k = Math.floor(u);
      if (k >= limit) continue;
      const a = KERNEL[k] as number;
      const b = KERNEL[k + 1] as number;
      acc += (input[j] as number) * (a + (b - a) * (u - k));
    }
    output[i] = acc * cutoff;
  }
}

/**
 * `input` resampled from `from` Hz to `to` Hz, `length` samples long (by
 * default the duration rounded up). Returns a copy when the rates are equal.
 */
export function resample(
  input: Float32Array,
  from: number,
  to: number,
  length = resampledLength(input.length, from, to),
): Float32Array {
  if (!(from > 0 && to > 0) || !Number.isFinite(from) || !Number.isFinite(to))
    throw new RangeError(`invalid sample rates: ${from} → ${to}`);
  const output = new Float32Array(length);
  if (from === to) output.set(input.subarray(0, length));
  else resampleRange(input, from, to, output, 0, length);
  return output;
}
