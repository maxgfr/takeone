/**
 * The voice chain of an export: noise removal on each channel, then loudness
 * normalization of the whole program (one gain for every channel, so the
 * stereo image is kept) to −16 LUFS by default, the usual target for spoken
 * content online, with the sample peak kept under −1 dBFS.
 */
import { denoise } from "./denoise";
import { blockPowers, gatedLoudness, normalizationGain, samplePeak } from "./loudness";

export interface VoiceInput {
  channels: Float32Array[];
  sampleRate: number;
}

export interface VoiceOptions {
  denoise: boolean;
  normalize: boolean;
  /** Loudness target in LUFS, −16 by default. */
  target?: number;
}

export interface VoiceOutput {
  channels: Float32Array[];
  sampleRate: number;
  /** Linear gain applied (1 when `normalize` is off or the audio is silent). */
  gain: number;
  /** Integrated loudness in LUFS measured before the gain (after noise removal); −Infinity for silence. */
  loudness: number;
}

function sameSamples(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Cleans up and levels the voice track. The input arrays are never modified;
 * the output may share them when there is nothing to change. `onProgress`
 * receives the share of the work done, from 0 to 1.
 */
export async function processVoice(
  input: VoiceInput,
  opts: VoiceOptions,
  onProgress?: (ratio: number) => void,
): Promise<VoiceOutput> {
  const { sampleRate } = input;
  let channels = input.channels;

  if (opts.denoise) {
    const out: Float32Array[] = [];
    const count = channels.length;
    for (const [c, ch] of channels.entries()) {
      // A mono microphone recorded as stereo has twice the same channel: denoise it once.
      const twin = channels.findIndex((other, i) => i < c && sameSamples(other, ch));
      const done = twin >= 0 ? out[twin]?.slice() : undefined;
      out.push(
        done ?? (await denoise(ch, sampleRate, (r) => onProgress?.((0.95 * (c + r)) / count))),
      );
    }
    channels = out;
  }

  const blocks = blockPowers(channels, sampleRate);
  const loudness = gatedLoudness(blocks);
  const gain = opts.normalize
    ? normalizationGain(blocks, samplePeak(channels), opts.target ?? -16)
    : 1;
  if (gain !== 1) {
    const owned = opts.denoise; // the denoised arrays are ours to scale in place
    channels = channels.map((ch) => {
      const target = owned ? ch : new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) target[i] = (ch[i] as number) * gain;
      return target;
    });
  }
  onProgress?.(1);
  return { channels, sampleRate, gain, loudness };
}
