/**
 * The edit as an animated GIF (no sound): the same frames as the video, at
 * a lower rate and size, each quantized to its own 256-color palette.
 * Frames that do not change are merged into one longer frame.
 */
import { outputDuration, segmentsOf } from "../edit/timeline";
import type { Aspect, Project } from "../model/project";
import { outputSize } from "../render/compose";
import { eachFrame, type Overlay } from "./frames";
import { inFormat, type Progress } from "./video";

export interface GifOptions {
  /** Pixels of the shorter side. */
  side: number;
  fps: number;
  aspect?: Aspect;
  overlay?: Overlay;
  onProgress?: Progress;
  signal?: AbortSignal;
}

function same(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length / 4);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

export async function renderGif(project: Project, opts: GifOptions): Promise<Blob> {
  const { GIFEncoder, applyPalette, quantize } = await import("gifenc");
  const p = inFormat(project, opts.aspect);
  const segments = segmentsOf(p);
  const duration = outputDuration(segments);
  if (duration <= 0) throw new Error("There is nothing left to export: every part was cut.");
  const { w: W, h: H } = outputSize(p.style.aspect, opts.side);
  const total = Math.ceil(duration * opts.fps);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D is not available");
  const gif = GIFEncoder();
  let pending: { data: Uint8ClampedArray; frames: number } | null = null;
  const flush = () => {
    if (!pending) return;
    const palette = quantize(pending.data, 256);
    gif.writeFrame(applyPalette(pending.data, palette), W, H, {
      palette,
      delay: Math.round((1000 / opts.fps) * pending.frames),
    });
  };
  await eachFrame(
    ctx,
    {
      project: p,
      segments,
      W,
      H,
      fps: opts.fps,
      total,
      overlay: opts.overlay,
      signal: opts.signal,
    },
    async (f) => {
      const { data } = ctx.getImageData(0, 0, W, H);
      if (pending && same(pending.data, data)) pending.frames++;
      else {
        flush();
        pending = { data, frames: 1 };
      }
      if (f % 5 === 0) opts.onProgress?.(f / total, `Rendering the GIF, ${W}×${H}…`);
    },
  );
  flush();
  gif.finish();
  opts.onProgress?.(1, "Done");
  return new Blob([gif.bytes() as BlobPart], { type: "image/gif" });
}
