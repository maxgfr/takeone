/**
 * A voice-over is recorded over the edited video, but it belongs to the takes:
 * each piece of its file is laid on a range of a take's clock, the range that
 * was playing while it was said. A cut made afterwards cuts the voice-over
 * too, and recording again over a passage replaces only that passage.
 */
import type { Clip, Project, VoiceoverPiece } from "../model/project";
import type { Segment } from "./timeline";

type Word = { text: string; start: number; end: number };

/**
 * The pieces of a file recorded while the output played from `t0` to `t1`; `lag` is how long the
 * file had been recording when the output started playing.
 */
export function voiceoverPieces(
  segments: readonly Segment[],
  t0: number,
  t1: number,
  lag: number,
  file: { key: string; type: string },
): { clip: string; piece: VoiceoverPiece }[] {
  const out: { clip: string; piece: VoiceoverPiece }[] = [];
  for (const s of segments) {
    const from = Math.max(s.at, t0);
    const to = Math.min(s.at + (s.end - s.start), t1);
    if (to - from < 0.05) continue;
    out.push({
      clip: s.clip.id,
      piece: {
        ...file,
        start: s.start + (from - s.at),
        end: s.start + (to - s.at),
        at: from - t0 + lag,
      },
    });
  }
  return out;
}

/** The pieces a take had, with the fresh ones laid over them (they win where they overlap). */
export function layPieces(
  existing: readonly VoiceoverPiece[],
  fresh: readonly VoiceoverPiece[],
): VoiceoverPiece[] {
  let kept = [...existing];
  for (const f of fresh) {
    kept = kept.flatMap((p) => {
      if (p.end <= f.start || p.start >= f.end) return [p];
      const parts: VoiceoverPiece[] = [];
      if (p.start < f.start) parts.push({ ...p, end: f.start });
      if (p.end > f.end) parts.push({ ...p, start: f.end, at: p.at + (f.end - p.start) });
      return parts.filter((x) => x.end - x.start >= 0.05);
    });
  }
  return [...kept, ...fresh].sort((a, b) => a.start - b.start);
}

/**
 * The voice heard in a take, as pieces of files: the microphone's file from where it opened, the
 * voice-over's pieces, or nothing.
 */
export function voiceParts(clip: Clip): VoiceoverPiece[] {
  if (clip.voice === "none") return [];
  if (clip.voice === "over") return clip.voiceover?.pieces ?? [];
  const m = clip.mic;
  return m
    ? [{ key: m.key, type: m.type, start: m.offset, end: Number.POSITIVE_INFINITY, at: 0 }]
    : [];
}

/** The piece heard at `t` on the take's clock. */
export function pieceAt(pieces: readonly VoiceoverPiece[], t: number): VoiceoverPiece | undefined {
  return pieces.find((p) => t >= p.start && t < p.end);
}

/**
 * Words timed on a voice-over file, moved onto the take's clock through the pieces of that file;
 * a word no piece keeps (said past the end, or replaced since) is left out.
 */
export function placeWords<W extends Word>(
  words: readonly W[],
  pieces: readonly VoiceoverPiece[],
): W[] {
  const out: W[] = [];
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    const p = pieces.find((x) => mid >= x.at && mid < x.at + (x.end - x.start));
    if (!p) continue;
    const shift = p.start - p.at;
    out.push({ ...w, start: w.start + shift, end: w.end + shift });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Of these files, those no take uses any more. */
export function unusedFiles(p: Project, keys: Iterable<string>): string[] {
  const used = new Set(p.clips.flatMap((c) => (c.voiceover?.pieces ?? []).map((x) => x.key)));
  return [...new Set(keys)].filter((k) => !used.has(k));
}
