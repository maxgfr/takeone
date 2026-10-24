/**
 * The edit, frame by frame, for any export: each take's files are decoded
 * with mediabunny at the times the output needs (in order: cuts only skip
 * forward), and the compositor draws each frame exactly as the preview does.
 */
import { type Segment, sourceAt } from "../edit/timeline";
import type { Clip, Media, Project } from "../model/project";
import { getMedia } from "../model/store";
import { drawFrame, placementAt, type Source, viewAt } from "../render/compose";

/** Draws extra layers over a frame (captions), at a take's time. */
export type Overlay = (
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  project: Project,
  clipId: string,
  t: number,
) => void;

type Frame = CanvasImageSource & { width: number; height: number };

interface Track {
  next(): Promise<Frame | null>;
  dispose(): void;
}

/** The frames of one file at the given times (its own clock, non-decreasing), one per `next`. */
async function frames(
  projectId: string,
  media: Media,
  times: number[],
  maxSide: number,
): Promise<Track | null> {
  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import("mediabunny");
  const blob = await getMedia(projectId, media.key, media.type.split(";")[0]);
  if (!blob) return null;
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) {
    input.dispose();
    return null;
  }
  const w = track.displayWidth;
  const h = track.displayHeight;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const sink = new CanvasSink(track, {
    width: Math.round(w * scale),
    height: Math.round(h * scale),
    fit: "fill",
    poolSize: 2,
  });
  const it = sink.canvasesAtTimestamps(times);
  return {
    async next() {
      const r = await it.next();
      return r.done || !r.value ? null : (r.value.canvas as Frame);
    },
    dispose() {
      void it.return?.(undefined);
      input.dispose();
    },
  };
}

/** For each take, the output frames it covers and the time of each on the take's clock. */
function plan(segments: readonly Segment[], total: number, fps: number) {
  const byClip = new Map<string, { clip: Clip; times: number[] }>();
  for (let f = 0; f < total; f++) {
    const at = sourceAt(segments, f / fps);
    if (!at) continue;
    const id = at.segment.clip.id;
    const entry = byClip.get(id) ?? { clip: at.segment.clip, times: [] };
    byClip.set(id, entry);
    entry.times.push(at.t);
  }
  return byClip;
}

export interface FrameLoop {
  project: Project;
  segments: readonly Segment[];
  W: number;
  H: number;
  fps: number;
  total: number;
  overlay?: Overlay | undefined;
  signal?: AbortSignal | undefined;
}

/** Draws every frame of the edit on `ctx`, calling `onFrame` after each (to encode it). */
export async function eachFrame(
  ctx: CanvasRenderingContext2D,
  loop: FrameLoop,
  onFrame: (f: number, t: number) => Promise<void>,
): Promise<void> {
  const { project: p, segments, W, H, fps, total } = loop;
  const byClip = plan(segments, total, fps);
  const maxSide = Math.max(W, H);
  let open = null as { clip: string; screen: Track | null; camera: Track | null } | null;
  try {
    for (let f = 0; f < total; f++) {
      if (loop.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const t = f / fps;
      const at = sourceAt(segments, t);
      if (!at) continue;
      const clip = at.segment.clip;
      if (open?.clip !== clip.id) {
        open?.screen?.dispose();
        open?.camera?.dispose();
        const times = byClip.get(clip.id)?.times ?? [];
        const shift = (m: Media) => times.map((x) => Math.max(0, x - m.offset));
        open = {
          clip: clip.id,
          screen: clip.screen ? await frames(p.id, clip.screen, shift(clip.screen), maxSide) : null,
          camera: clip.camera
            ? await frames(p.id, clip.camera, shift(clip.camera), Math.min(1280, maxSide))
            : null,
        };
      }
      const [sf, cf] = await Promise.all([
        open.screen?.next() ?? null,
        open.camera?.next() ?? null,
      ]);
      const screen: Source | null = sf ? { src: sf, w: sf.width, h: sf.height } : null;
      const camera: Source | null = cf ? { src: cf, w: cf.width, h: cf.height } : null;
      const aspect = screen ? screen.w / screen.h : 16 / 9;
      const placement = placementAt(p, clip.id, at.t, W, H, aspect, !!clip.screen, !!clip.camera);
      const blurs = p.blurs.filter((b) => b.clip === clip.id && at.t >= b.start && at.t < b.end);
      drawFrame(ctx, W, H, p.style, screen, camera, {
        placement,
        view: viewAt(p.zooms, clip.id, at.t),
        blurs: blurs.map((b) => b.box),
      });
      loop.overlay?.(ctx, W, H, p, clip.id, at.t);
      await onFrame(f, t);
    }
  } finally {
    open?.screen?.dispose();
    open?.camera?.dispose();
  }
}
