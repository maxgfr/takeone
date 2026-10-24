/**
 * The preview: plays the edit on a canvas. Each take's files play in hidden
 * media elements (the screen with its sound, the camera, the microphone),
 * kept in step with one clock on the output's timeline; a cut makes the
 * source time jump, so the elements are sent to the new time. Every frame,
 * the compositor draws what the elements show.
 */
import { signal } from "@preact/signals";
import type { Clip, Media, Project } from "../model/project";
import {
  drawFrame,
  FULL,
  outputSize,
  type Placement,
  placementAt,
  type Source,
  viewAt,
} from "../render/compose";
import { outputDuration, type Segment, segmentsOf, sourceAt } from "./timeline";

type MediaUrl = (key: string, type: string) => Promise<string>;

interface Elements {
  screen: HTMLVideoElement | null;
  camera: HTMLVideoElement | null;
  mic: HTMLAudioElement | null;
}

/** Elements further than this from where they should be are sent there. */
const DRIFT = 0.3;

function element<T extends HTMLMediaElement>(make: () => T, url: string, muted: boolean): T {
  const el = make();
  el.preload = "auto";
  el.muted = muted;
  if (el instanceof HTMLVideoElement) el.playsInline = true;
  el.src = url;
  return el;
}

export class PreviewEngine {
  readonly time = signal(0);
  readonly playing = signal(false);
  private project: Project | null = null;
  private segments: Segment[] = [];
  private duration = 0;
  private readonly elements = new Map<string, Elements>();
  private raf = 0;
  private startedAt = 0;
  private startTime = 0;
  private current: string | null = null;
  private disposed = false;
  /** What the last frame drew: where the screen is, for the overlays that edit regions on it. */
  placement: { placement: Placement; clip: string; t: number } | null = null;
  /** Shows the whole screen, ignoring zooms (while a zoom's region is being edited). */
  fullView = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly mediaUrl: MediaUrl,
  ) {
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  /** The project changed (an edit): keep the time, redraw. */
  setProject(p: Project): void {
    this.project = p;
    this.segments = segmentsOf(p);
    this.duration = outputDuration(this.segments);
    if (this.time.value > this.duration) this.time.value = this.duration;
    for (const clip of p.clips) void this.prepare(clip);
    this.syncTo(this.time.value, !this.playing.value);
  }

  get length(): number {
    return this.duration;
  }

  private async prepare(clip: Clip): Promise<Elements> {
    const have = this.elements.get(clip.id);
    if (have) return have;
    const els: Elements = { screen: null, camera: null, mic: null };
    this.elements.set(clip.id, els);
    const url = (m: Media) => this.mediaUrl(m.key, m.type);
    const redraw = () => {
      if (!this.playing.value) this.draw();
    };
    if (clip.screen) {
      els.screen = element(() => document.createElement("video"), await url(clip.screen), false);
      els.screen.addEventListener("seeked", redraw);
      els.screen.addEventListener("loadeddata", redraw);
    }
    if (clip.camera) {
      els.camera = element(() => document.createElement("video"), await url(clip.camera), true);
      els.camera.addEventListener("seeked", redraw);
      els.camera.addEventListener("loadeddata", redraw);
    }
    if (clip.mic)
      els.mic = element(() => document.createElement("audio"), await url(clip.mic), false);
    this.syncTo(this.time.value, !this.playing.value);
    return els;
  }

  play(): void {
    if (this.playing.value || this.duration === 0) return;
    if (this.time.value >= this.duration - 0.05) this.time.value = 0;
    this.startTime = this.time.value;
    this.startedAt = performance.now();
    this.playing.value = true;
    this.syncTo(this.time.value, true);
  }

  pause(): void {
    if (!this.playing.value) return;
    this.playing.value = false;
    for (const els of this.elements.values())
      for (const el of [els.screen, els.camera, els.mic]) el?.pause();
    this.syncTo(this.time.value, true);
  }

  toggle(): void {
    if (this.playing.value) this.pause();
    else this.play();
  }

  seek(t: number): void {
    const clamped = Math.max(0, Math.min(this.duration, t));
    this.time.value = clamped;
    this.startTime = clamped;
    this.startedAt = performance.now();
    this.syncTo(clamped, true);
  }

  /** Puts every element where it belongs at output time `t`. */
  private syncTo(t: number, force: boolean): void {
    const p = this.project;
    const at = sourceAt(this.segments, t);
    if (!p || !at) return;
    const clip = at.segment.clip;
    const els = this.elements.get(clip.id);
    if (this.current !== clip.id) {
      // Another take: silence the one before.
      const before = this.current ? this.elements.get(this.current) : undefined;
      for (const el of [before?.screen, before?.camera, before?.mic]) el?.pause();
      this.current = clip.id;
    }
    if (!els) return;
    const volume = p.style.audio.screenVolume;
    const pairs: [HTMLMediaElement | null, Media | null][] = [
      [els.screen, clip.screen],
      [els.camera, clip.camera],
      [els.mic, clip.mic],
    ];
    for (const [el, m] of pairs) {
      if (!el || !m) continue;
      const target = at.t - m.offset;
      if (el === els.screen) el.volume = Math.max(0, Math.min(1, volume));
      if (target < 0) {
        el.pause();
        continue;
      }
      if (force || Math.abs(el.currentTime - target) > DRIFT) el.currentTime = target;
      if (this.playing.value && el.paused) void el.play().catch(() => undefined);
      if (!this.playing.value && !el.paused) el.pause();
    }
  }

  private loop(now: number): void {
    if (this.disposed) return;
    if (this.playing.value) {
      const t = this.startTime + (now - this.startedAt) / 1000;
      if (t >= this.duration) {
        this.time.value = this.duration;
        this.pause();
      } else {
        this.time.value = t;
        this.syncTo(t, false);
      }
    }
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Draws the frame at the current time on the canvas. */
  draw(): void {
    const p = this.project;
    const ctx = this.canvas.getContext("2d");
    if (!p || !ctx) return;
    const size = outputSize(p.style.aspect, 720);
    if (this.canvas.width !== size.w) this.canvas.width = size.w;
    if (this.canvas.height !== size.h) this.canvas.height = size.h;
    const at = sourceAt(this.segments, this.time.value);
    if (!at) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, size.w, size.h);
      return;
    }
    const clip = at.segment.clip;
    const els = this.elements.get(clip.id);
    const source = (el: HTMLVideoElement | null | undefined): Source | null =>
      el && el.readyState >= 2 && el.videoWidth
        ? { src: el, w: el.videoWidth, h: el.videoHeight }
        : null;
    const screen = source(els?.screen);
    const camera = source(els?.camera);
    const aspect = screen
      ? screen.w / screen.h
      : clip.screen?.width && clip.screen.height
        ? clip.screen.width / clip.screen.height
        : 16 / 9;
    const placement = placementAt(
      p,
      clip.id,
      at.t,
      size.w,
      size.h,
      aspect,
      !!clip.screen,
      !!clip.camera,
    );
    this.placement = { placement, clip: clip.id, t: at.t };
    const blurs = p.blurs.filter((b) => b.clip === clip.id && at.t >= b.start && at.t < b.end);
    drawFrame(ctx, size.w, size.h, p.style, screen, camera, {
      placement,
      view: this.fullView ? FULL : viewAt(p.zooms, clip.id, at.t),
      blurs: blurs.map((b) => b.box),
    });
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const els of this.elements.values())
      for (const el of [els.screen, els.camera, els.mic]) {
        if (!el) continue;
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
    this.elements.clear();
  }
}
