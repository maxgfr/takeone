/**
 * The export's sound: for each take, the voice heard (the microphone's file,
 * the voice-over's, or none) with the noise removed and levelled to −16 LUFS,
 * plus the screen's own sound at its volume, both laid on the output's
 * timeline piece by piece. Joins get a few milliseconds of fade so a cut
 * never clicks.
 */
import { processVoice } from "../audio/process";
import { outputDuration, type Segment } from "../edit/timeline";
import { voiceParts } from "../edit/voiceover";
import type { Clip, Media, Project } from "../model/project";
import { getMedia } from "../model/store";

export const RATE = 48_000;
const FADE = Math.round(RATE * 0.008);

type OfflineCtx = typeof OfflineAudioContext;

/** A file's sound as mono samples at 48 kHz, or null when it has none. */
async function decode(
  projectId: string,
  media: Pick<Media, "key" | "type">,
): Promise<Float32Array | null> {
  const Ctx = (globalThis as { OfflineAudioContext?: OfflineCtx }).OfflineAudioContext;
  const blob = await getMedia(projectId, media.key, media.type.split(";")[0]);
  if (!Ctx || !blob) return null;
  try {
    const buf = await new Ctx(1, 1, RATE).decodeAudioData(await blob.arrayBuffer());
    // Down to mono: the voice is mono, and a screen's stereo is not worth doubling the work.
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < out.length; i++)
        out[i] = (out[i] as number) + (ch[i] as number) / buf.numberOfChannels;
    }
    return out;
  } catch {
    // A video file with no audio track.
    return null;
  }
}

export interface Soundtrack {
  samples: Float32Array;
  sampleRate: number;
}

/** Copies `src[from…]` into `out[at…]` for `length` samples, with fades at both ends. */
function lay(
  out: Float32Array,
  at: number,
  src: Float32Array,
  from: number,
  length: number,
  gain: number,
) {
  for (let i = 0; i < length; i++) {
    const s = from + i;
    const o = at + i;
    if (s < 0 || s >= src.length || o < 0 || o >= out.length) continue;
    const fade = Math.min(1, i / FADE, (length - 1 - i) / FADE);
    out[o] = (out[o] as number) + (src[s] as number) * gain * fade;
  }
}

export async function buildSoundtrack(
  project: Project,
  segments: readonly Segment[],
  onProgress?: (ratio: number, label: string) => void,
  signal?: AbortSignal,
): Promise<Soundtrack | null> {
  const total = Math.ceil(outputDuration(segments) * RATE);
  const out = new Float32Array(Math.max(1, total));
  const { denoise, normalize, screenVolume } = project.style.audio;
  let any = false;
  const clips = project.clips.filter((c) => segments.some((s) => s.clip.id === c.id));
  // A voice-over's file spans takes: cleaned once.
  const cleaned = new Map<string, Float32Array | null>();
  for (const [i, clip] of clips.entries()) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const part = (r: number) =>
      onProgress?.((i + r) / clips.length, `Cleaning the sound of take ${i + 1}…`);
    const parts = voiceParts(clip);
    for (const p of parts) {
      if (cleaned.has(p.key)) continue;
      const voice = await decode(project.id, { key: p.key, type: p.type });
      let clean: Float32Array | null = null;
      if (voice) {
        const res = await processVoice(
          { channels: [voice], sampleRate: RATE },
          { denoise, normalize },
          part,
        );
        clean = res.channels[0] ?? voice;
      }
      cleaned.set(p.key, clean);
    }
    const screen =
      clip.screen?.audio && screenVolume > 0 ? await decode(project.id, clip.screen) : null;
    let voiced = false;
    for (const s of segments) {
      if (s.clip.id !== clip.id) continue;
      const at = Math.round(s.at * RATE);
      const length = Math.round((s.end - s.start) * RATE);
      for (const p of parts) {
        const clean = cleaned.get(p.key);
        const from = Math.max(s.start, p.start);
        const to = Math.min(s.end, p.end);
        if (!clean || to <= from) continue;
        lay(
          out,
          Math.round((s.at + (from - s.start)) * RATE),
          clean,
          Math.round((p.at + (from - p.start)) * RATE),
          Math.round((to - from) * RATE),
          1,
        );
        voiced = true;
      }
      if (screen && clip.screen)
        lay(
          out,
          at,
          screen,
          Math.round((s.start - clip.screen.offset) * RATE),
          length,
          screenVolume,
        );
    }
    any ||= voiced || !!screen;
    part(1);
  }
  if (!any) return null;
  // A safety limiter: the sum of voice and screen must not clip.
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.98) for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * (0.98 / peak);
  return { samples: out, sampleRate: RATE };
}

/** The soundtrack as an AudioBuffer, for the encoder. */
export function toAudioBuffer(track: Soundtrack): AudioBuffer {
  const buf = new AudioBuffer({
    length: track.samples.length,
    numberOfChannels: 1,
    sampleRate: track.sampleRate,
  });
  buf.copyToChannel(track.samples as Float32Array<ArrayBuffer>, 0);
  return buf;
}

/** Whether a take is heard at all (for an audio-only export). */
export function hasSound(clip: Clip): boolean {
  return voiceParts(clip).length > 0 || !!clip.screen?.audio;
}
