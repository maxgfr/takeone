/**
 * The edit as a video file, rendered in the page with WebCodecs through
 * mediabunny: MP4 (H.264 + AAC) or WebM (VP9 + Opus), up to 4K at 60 fps, in
 * the project's format or another one (a vertical or square version follows
 * the same zooms and layouts, placed for that shape).
 */
import { outputDuration, segmentsOf } from "../edit/timeline";
import type { Aspect, Project } from "../model/project";
import { outputSize } from "../render/compose";
import { eachFrame, type Overlay } from "./frames";
import { buildSoundtrack, toAudioBuffer } from "./soundtrack";

export type Progress = (ratio: number, label: string) => void;

export interface VideoOptions {
  container: "mp4" | "webm";
  /** Pixels of the shorter side: 720, 1080, 1440 or 2160. */
  side: number;
  fps: 30 | 60;
  /** Another format than the project's own. */
  aspect?: Aspect;
  overlay?: Overlay;
  onProgress?: Progress;
  signal?: AbortSignal;
}

/** The project in the export's format. */
export function inFormat(project: Project, aspect?: Aspect): Project {
  return aspect ? { ...project, style: { ...project.style, aspect } } : project;
}

export async function renderVideo(project: Project, opts: VideoOptions): Promise<Blob> {
  const {
    AudioBufferSource,
    BufferTarget,
    CanvasSource,
    Mp4OutputFormat,
    Output,
    QUALITY_HIGH,
    WebMOutputFormat,
    canEncodeVideo,
    getFirstEncodableAudioCodec,
  } = await import("mediabunny");
  if (typeof VideoEncoder === "undefined")
    throw new Error(
      "This browser cannot encode video (no WebCodecs). Try Chrome, Edge or Safari 17+.",
    );
  const p = inFormat(project, opts.aspect);
  const segments = segmentsOf(p);
  const duration = outputDuration(segments);
  if (duration <= 0) throw new Error("There is nothing left to export: every part was cut.");
  const { w: W, h: H } = outputSize(p.style.aspect, opts.side);
  const fps = opts.fps;
  const total = Math.ceil(duration * fps);
  const progress = opts.onProgress ?? (() => undefined);

  const sound = await buildSoundtrack(
    p,
    segments,
    (r, label) => progress(r * 0.15, label),
    opts.signal,
  );

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available");
  const size = { width: W, height: H };
  const mp4 = opts.container === "mp4";
  const candidates = mp4 ? (["avc", "hevc"] as const) : (["vp9", "av1", "vp8"] as const);
  let codec: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    if (await canEncodeVideo(c, size)) {
      codec = c;
      break;
    }
  }
  if (!codec)
    throw new Error(
      `This browser cannot encode ${mp4 ? "MP4" : "WebM"} video at ${W}×${H}. Try a lower resolution or the other format.`,
    );
  const output = new Output({
    format: mp4 ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const video = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(video, { frameRate: fps });
  const audioCodec = sound
    ? await getFirstEncodableAudioCodec(mp4 ? ["aac", "opus"] : ["opus"])
    : null;
  const audio =
    sound && audioCodec ? new AudioBufferSource({ codec: audioCodec, bitrate: 160_000 }) : null;
  if (audio) output.addAudioTrack(audio);
  await output.start();
  if (audio && sound) await audio.add(toAudioBuffer(sound));

  try {
    await eachFrame(
      ctx,
      { project: p, segments, W, H, fps, total, overlay: opts.overlay, signal: opts.signal },
      async (f, t) => {
        await video.add(t, 1 / fps);
        if (f % 15 === 0) progress(0.15 + 0.85 * (f / total), `Rendering ${W}×${H} at ${fps} fps…`);
      },
    );
  } catch (err) {
    await output.cancel();
    throw err;
  }
  await output.finalize();
  progress(1, "Done");
  const buffer = output.target.buffer;
  if (!buffer) throw new Error("The video could not be written.");
  return new Blob([buffer], { type: mp4 ? "video/mp4" : "video/webm" });
}

/** The soundtrack alone, as an M4A (AAC) or WebM (Opus) file. */
export async function renderAudio(
  project: Project,
  onProgress?: Progress,
  signal?: AbortSignal,
): Promise<Blob> {
  const {
    AudioBufferSource,
    BufferTarget,
    Mp4OutputFormat,
    Output,
    WebMOutputFormat,
    getFirstEncodableAudioCodec,
  } = await import("mediabunny");
  const segments = segmentsOf(project);
  const sound = await buildSoundtrack(
    project,
    segments,
    (r, l) => onProgress?.(r * 0.9, l),
    signal,
  );
  if (!sound) throw new Error("This video has no sound.");
  const codec = await getFirstEncodableAudioCodec(["aac", "opus"]);
  if (!codec) throw new Error("This browser cannot encode audio.");
  const m4a = codec === "aac";
  const output = new Output({
    format: m4a ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const audio = new AudioBufferSource({ codec, bitrate: 160_000 });
  output.addAudioTrack(audio);
  await output.start();
  await audio.add(toAudioBuffer(sound));
  await output.finalize();
  onProgress?.(1, "Done");
  const buffer = output.target.buffer;
  if (!buffer) throw new Error("The sound could not be written.");
  return new Blob([buffer], { type: m4a ? "audio/mp4" : "audio/webm" });
}
