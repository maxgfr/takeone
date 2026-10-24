/**
 * A look-ahead peak limiter, so levelling the voice to its loudness target
 * never clips: wherever a sample would pass the ceiling, the gain eases down
 * a few milliseconds before it and recovers after. The gain is the same for
 * every channel (the stereo image stays), and it only ever goes down.
 */

export interface LimiterOptions {
  /** The highest sample peak allowed, in dBFS. */
  ceilingDb?: number;
  /** How long the gain takes to come down before a peak, in seconds. */
  attack?: number;
  /** How long it takes to come back up after one, in seconds. */
  release?: number;
}

/** The channels with their peaks held under the ceiling; the input is not modified. */
export function limit(
  channels: readonly Float32Array[],
  sampleRate: number,
  opts: LimiterOptions = {},
): Float32Array[] {
  const ceiling = 10 ** ((opts.ceilingDb ?? -1) / 20);
  const length = Math.max(0, ...channels.map((c) => c.length));
  // The gain each sample needs on its own.
  const need = new Float32Array(length).fill(1);
  let any = false;
  for (const ch of channels)
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i] as number);
      if (a > ceiling) {
        need[i] = Math.min(need[i] as number, ceiling / a);
        any = true;
      }
    }
  if (!any) return channels.map((c) => c.slice());
  // Backwards: the gain ramps down linearly over the attack before each peak.
  const attackStep = 1 / Math.max(1, Math.round((opts.attack ?? 0.005) * sampleRate));
  const gain = new Float32Array(length);
  let g = 1;
  for (let i = length - 1; i >= 0; i--) {
    g = Math.min(need[i] as number, g + attackStep);
    gain[i] = g;
  }
  // Forwards: it recovers linearly over the release, never above what the backward pass allows.
  const releaseStep = 1 / Math.max(1, Math.round((opts.release ?? 0.08) * sampleRate));
  g = 1;
  for (let i = 0; i < length; i++) {
    g = Math.min(gain[i] as number, g + releaseStep);
    gain[i] = g;
  }
  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = (ch[i] as number) * (gain[i] as number);
    return out;
  });
}
