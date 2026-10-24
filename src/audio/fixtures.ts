/**
 * Synthetic signals for the audio tests: a voice-like tone (a gliding
 * harmonic series with a syllable rhythm) and seeded white noise.
 */

/**
 * A voiced, speech-like signal: ~140 Hz pitch with vibrato, 12 harmonics,
 * syllables at 3 Hz. With `pauses`, it speaks 0.6 s out of every second.
 */
export function voice(seconds: number, rate: number, rms = 0.1, pauses = false): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    phase += (2 * Math.PI * (140 + 30 * Math.sin(2 * Math.PI * 0.7 * t))) / rate;
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(h * phase + h) / h;
    out[i] = v * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) * (pauses ? speaking(t) : 1);
  }
  return scaleTo(out, rms);
}

/** 1 while speaking (0.6 s from each second), 0 in the pauses, with 10 ms ramps. */
export function speaking(t: number): number {
  const s = t % 1;
  return Math.max(0, Math.min(1, s / 0.01, (0.6 - s) / 0.01));
}

/** Gaussian white noise with a fixed seed. */
export function whiteNoise(seconds: number, rate: number, rms = 0.05, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  let s = seed >>> 0 || 1;
  const uniform = () => {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 0.5) / 4_294_967_296;
  };
  for (let i = 0; i < out.length; i++)
    out[i] = Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  return scaleTo(out, rms);
}

export function rms(x: Float32Array, from = 0, to = x.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (x[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

export function mix(a: Float32Array, b: Float32Array): Float32Array {
  return a.map((v, i) => v + (b[i] ?? 0));
}

/** The lag (in samples, within ±`range`) at which `y` best matches `x`. */
export function bestLag(x: Float32Array, y: Float32Array, range: number): number {
  let best = Number.NEGATIVE_INFINITY;
  let lag = 0;
  for (let l = -range; l <= range; l++) {
    let c = 0;
    for (let i = range; i < x.length - range; i++) c += (x[i] ?? 0) * (y[i + l] ?? 0);
    if (c > best) {
      best = c;
      lag = l;
    }
  }
  return lag;
}

function scaleTo(x: Float32Array, target: number): Float32Array {
  const k = target / (rms(x) || 1);
  for (let i = 0; i < x.length; i++) x[i] = (x[i] ?? 0) * k;
  return x;
}
