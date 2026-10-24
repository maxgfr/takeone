/**
 * One take: the screen, the camera and the microphone, each recorded into its
 * own file (so the layout and the sound can change after the take), all on
 * the screen's clock. Sources are opened first (the permission prompts), then
 * a countdown, then every recorder starts at once; their small start delays
 * are kept as offsets. While recording, the screen is sampled for activity.
 *
 * The page doing this is often in the background while you record another
 * tab, so ticks come from a worker (background timers are throttled) and
 * frames from ImageCapture where available.
 */
import { type Clip, newId } from "../model/project";
import { deleteMedia, mediaWriter, putMedia } from "../model/store";
import { ActivityLog, SAMPLE_WIDTH, toGray } from "./activity";
import { openCamera, openMic, openScreen, TrackRecorder } from "./media";

declare const __CLOCK_WORKER_URL__: string;

export interface SessionOptions {
  screen: boolean;
  /** Record the shared tab's or system's sound with the screen. */
  screenAudio: boolean;
  /** A camera's deviceId, "" for the default one, or null for none. */
  camera: string | null;
  /** A microphone's deviceId, "" for the default one, or null for none. */
  mic: string | null;
}

export interface OpenSources {
  screen: MediaStream | null;
  camera: MediaStream | null;
  mic: MediaStream | null;
}

const TICK_MS = 250;

interface ImageCaptureLike {
  grabFrame(): Promise<ImageBitmap>;
}
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

function stopAll(s: OpenSources): void {
  for (const stream of [s.screen, s.camera, s.mic])
    for (const t of stream?.getTracks() ?? []) t.stop();
}

/** Asks for every source the take needs; on any refusal, closes what was opened. */
export async function openSources(o: SessionOptions): Promise<OpenSources> {
  const out: OpenSources = { screen: null, camera: null, mic: null };
  try {
    // The screen first: its dialog needs the click that started all this.
    if (o.screen) out.screen = await openScreen(o.screenAudio);
    if (o.camera !== null) out.camera = await openCamera(o.camera || null);
    if (o.mic !== null) out.mic = await openMic(o.mic || null);
  } catch (err) {
    stopAll(out);
    throw err;
  }
  if (!out.screen && !out.camera) {
    stopAll(out);
    throw new Error("Record the screen, the camera, or both.");
  }
  return out;
}

export class RecordingSession {
  private readonly tracks: {
    kind: "screen" | "camera" | "mic";
    rec: TrackRecorder;
    key: string;
  }[] = [];
  private readonly activity = new ActivityLog();
  private readonly clipId = newId("c");
  private t0 = 0;
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private stopped = false;
  private worker: Worker | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private readonly video = document.createElement("video");
  private readonly small = document.createElement("canvas");
  private readonly capture: ImageCaptureLike | null = null;
  private poster: Promise<string | null> | null = null;

  private constructor(
    readonly projectId: string,
    readonly sources: OpenSources,
    private readonly onEnded: () => void,
  ) {
    const track = sources.screen?.getVideoTracks()[0] ?? sources.camera?.getVideoTracks()[0];
    const IC = (globalThis as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
    if (sources.screen && track && IC) this.capture = new IC(track);
    for (const s of [sources.screen, sources.camera, sources.mic]) {
      for (const t of s?.getTracks() ?? [])
        t.addEventListener("ended", () => {
          // The browser's "Stop sharing" button, or a device unplugged.
          if (!this.stopped && (s === sources.screen || !sources.screen)) this.onEnded();
        });
    }
    if (sources.screen) {
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.srcObject = sources.screen;
      void this.video.play().catch(() => undefined);
    }
  }

  /** Prepares the recorders (files open, nothing recorded yet). */
  static async create(
    projectId: string,
    sources: OpenSources,
    onEnded: () => void,
  ): Promise<RecordingSession> {
    const s = new RecordingSession(projectId, sources, onEnded);
    const add = async (kind: "screen" | "camera" | "mic", stream: MediaStream | null) => {
      if (!stream) return;
      const key = `${s.clipId}-${kind}`;
      const writer = await mediaWriter(projectId, key);
      const rec =
        kind === "mic"
          ? new TrackRecorder(stream, writer, "audio", { audio: 96_000 })
          : new TrackRecorder(stream, writer, "video", {
              video: kind === "screen" ? 6_000_000 : 2_500_000,
              audio: 128_000,
            });
      s.tracks.push({ kind, rec, key });
    };
    await add("screen", sources.screen);
    await add("camera", sources.camera);
    await add("mic", sources.mic);
    return s;
  }

  /** Starts every recorder at once. */
  async start(): Promise<void> {
    this.t0 = performance.now();
    await Promise.all(this.tracks.map((t) => t.rec.start()));
    if (this.sources.screen) this.startSampling();
  }

  /** Seconds recorded, pauses left out. */
  elapsed(): number {
    if (!this.t0) return 0;
    const now = this.pausedAt ?? performance.now();
    return Math.max(0, (now - this.t0 - this.pausedTotal) / 1000);
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  pause(): void {
    if (this.pausedAt !== null || this.stopped) return;
    this.pausedAt = performance.now();
    for (const t of this.tracks) t.rec.pause();
  }

  resume(): void {
    if (this.pausedAt === null || this.stopped) return;
    this.pausedTotal += performance.now() - this.pausedAt;
    this.pausedAt = null;
    for (const t of this.tracks) t.rec.resume();
  }

  private startSampling(): void {
    const tick = () => void this.sample();
    try {
      this.worker = new Worker(
        typeof __CLOCK_WORKER_URL__ === "string" ? __CLOCK_WORKER_URL__ : "./clock.js",
        { type: "module" },
      );
      this.worker.onmessage = tick;
      this.worker.postMessage({ interval: TICK_MS });
    } catch {
      this.interval = setInterval(tick, TICK_MS);
    }
  }

  private async grab(): Promise<CanvasImageSource & { width: number; height: number }> {
    if (this.capture) {
      try {
        return await this.capture.grabFrame();
      } catch {
        // No frame ready: try the video element.
      }
    }
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) throw new Error("no frame yet");
    return Object.assign(v, { width: v.videoWidth, height: v.videoHeight });
  }

  private async sample(): Promise<void> {
    if (this.busy || this.stopped || this.paused) return;
    this.busy = true;
    try {
      const src = await this.grab();
      const w = SAMPLE_WIDTH;
      const h = Math.max(1, Math.round((src.height / src.width) * w));
      if (this.small.width !== w) this.small.width = w;
      if (this.small.height !== h) this.small.height = h;
      const ctx = this.small.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(src, 0, 0, w, h);
        this.activity.push(toGray(ctx.getImageData(0, 0, w, h).data, w, h), w, h, this.elapsed());
      }
      if (!this.poster && this.elapsed() >= 1) this.poster = this.savePoster(src);
      if ("close" in src && typeof src.close === "function") src.close();
    } catch {
      // No frame this tick.
    } finally {
      this.busy = false;
    }
  }

  /** A still of the screen, about a second in, for the list of recordings. */
  private async savePoster(src: CanvasImageSource & { width: number; height: number }) {
    try {
      const c = document.createElement("canvas");
      c.width = 480;
      c.height = Math.round((src.height / src.width) * 480);
      c.getContext("2d")?.drawImage(src, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/webp", 0.8));
      if (!blob) return null;
      const key = `${this.clipId}-poster`;
      await putMedia(this.projectId, key, blob);
      return key;
    } catch {
      return null;
    }
  }

  private stopSampling(): void {
    this.worker?.terminate();
    if (this.interval) clearInterval(this.interval);
    this.video.srcObject = null;
  }

  /** Stops everything and returns the take as a clip of the project. */
  async stop(): Promise<Clip> {
    if (this.stopped) throw new Error("This take is already stopped.");
    const duration = this.elapsed();
    this.stopped = true;
    this.stopSampling();
    await Promise.all(this.tracks.map((t) => t.rec.stop()));
    const media = (kind: "screen" | "camera" | "mic") => {
      const t = this.tracks.find((x) => x.kind === kind);
      if (!t || t.rec.bytes === 0) return null;
      const settings = t.rec.stream.getVideoTracks()[0]?.getSettings();
      const offset = Math.max(0, (t.rec.startedAt - this.t0) / 1000);
      return {
        key: t.key,
        type: t.rec.type,
        offset: Math.round(offset * 1000) / 1000,
        duration: Math.max(0, duration - offset),
        width: settings?.width ?? 0,
        height: settings?.height ?? 0,
        audio: kind === "mic" || t.rec.stream.getAudioTracks().length > 0,
      };
    };
    return {
      id: this.clipId,
      createdAt: Date.now(),
      duration,
      screen: media("screen"),
      camera: media("camera"),
      mic: media("mic"),
      activity: this.activity.events,
      poster: (await this.poster) ?? null,
      transcript: null,
    };
  }

  /** Throws the take away: recorders stopped, files deleted. */
  async cancel(): Promise<void> {
    this.stopped = true;
    this.stopSampling();
    await Promise.all(this.tracks.map((t) => t.rec.abort()));
    await Promise.all(this.tracks.map((t) => deleteMedia(this.projectId, t.key)));
  }
}
