/**
 * Capture building blocks: one MediaRecorder per source writing straight to
 * disk, the devices on offer, and a level meter for the microphone.
 */
import type { MediaWriter } from "../model/store";

const MIMES = {
  video: [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm",
    "video/mp4",
  ],
  audio: ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"],
};

export function pickMime(kind: "video" | "audio"): string {
  if (typeof MediaRecorder === "undefined") return "";
  return MIMES[kind].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

/** A source recorded into its own file, chunk by chunk. */
export class TrackRecorder {
  readonly recorder: MediaRecorder;
  /** performance.now() when the recorder really started. */
  startedAt = 0;
  bytes = 0;
  private failed: unknown = null;

  constructor(
    readonly stream: MediaStream,
    private readonly writer: MediaWriter,
    kind: "video" | "audio",
    bitrate: { video?: number; audio?: number },
  ) {
    const mimeType = pickMime(kind);
    this.recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      ...(bitrate.video ? { videoBitsPerSecond: bitrate.video } : {}),
      ...(bitrate.audio ? { audioBitsPerSecond: bitrate.audio } : {}),
    });
    this.recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size === 0) return;
      this.bytes += e.data.size;
      this.writer.write(e.data).catch((err) => (this.failed ??= err));
    });
  }

  get type(): string {
    return (
      this.recorder.mimeType || (this.stream.getVideoTracks().length ? "video/webm" : "audio/webm")
    );
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.recorder.addEventListener(
        "start",
        () => {
          this.startedAt = performance.now();
          resolve();
        },
        { once: true },
      );
      this.recorder.start(1000);
    });
  }

  pause(): void {
    if (this.recorder.state === "recording") this.recorder.pause();
  }

  resume(): void {
    if (this.recorder.state === "paused") this.recorder.resume();
  }

  /** Stops, flushes the last chunk, and closes the file. */
  async stop(): Promise<void> {
    const rec = this.recorder;
    if (rec.state !== "inactive") {
      await new Promise<void>((resolve) => {
        rec.addEventListener("stop", () => resolve(), { once: true });
        rec.stop();
      });
    }
    for (const t of this.stream.getTracks()) t.stop();
    await this.writer.close(this.type);
    if (this.failed)
      throw this.failed instanceof Error ? this.failed : new Error(String(this.failed));
  }

  async abort(): Promise<void> {
    if (this.recorder.state !== "inactive") this.recorder.stop();
    for (const t of this.stream.getTracks()) t.stop();
    await this.writer.abort();
  }
}

export interface Devices {
  cameras: MediaDeviceInfo[];
  mics: MediaDeviceInfo[];
}

/** Cameras and microphones; their names show once the page was allowed to use one. */
export async function listDevices(): Promise<Devices> {
  const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  return {
    cameras: all.filter((d) => d.kind === "videoinput"),
    mics: all.filter((d) => d.kind === "audioinput"),
  };
}

export async function openCamera(deviceId: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }),
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });
}

export async function openMic(deviceId: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
}

export async function openScreen(withAudio: boolean): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia)
    throw new Error(
      "This browser cannot record the screen. Try a desktop Chrome, Edge or Firefox.",
    );
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 }, cursor: "always" } as MediaTrackConstraints,
    audio: withAudio,
    // Chrome: offer the current tab too, and keep system audio as an option.
    ...({ selfBrowserSurface: "include", systemAudio: "include" } as object),
  });
}

/** The microphone's level, 0–1, read on demand (for a meter). */
export function levelMeter(stream: MediaStream): { level(): number; close(): void } {
  const Ctx = globalThis.AudioContext;
  if (!Ctx) return { level: () => 0, close: () => undefined };
  const ctx = new Ctx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  return {
    level() {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      // RMS in dB, mapped from -60..0 dB to 0..1.
      const db = 10 * Math.log10(sum / data.length + 1e-12);
      return Math.min(1, Math.max(0, (db + 60) / 60));
    },
    close() {
      void ctx.close();
    },
  };
}
