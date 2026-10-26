/**
 * The preview: plays the edit on a canvas. Each take's files play in hidden
 * media elements (the screen with its sound, the camera, the voice heard:
 * the microphone's file or a voice-over's),
 * kept in step with one clock on the output's timeline. A cut makes the
 * source time jump: sending a playing element to the new time stalls it and
 * shows nothing for a moment, so each file has a spare element, sent ahead to
 * where the next piece starts, that takes over at the cut. Every frame, the
 * compositor draws what the elements show; while one is still seeking, the
 * last frame stays up rather than an empty one.
 */
import { signal } from "@preact/signals";
import type { Clip, Media, Project } from "../model/project";
import { drawCaptionsAt } from "../render/captions";
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
import { pieceAt, voiceParts } from "./voiceover";

type MediaUrl = (key: string, type: string) => Promise<string>;

interface Elements {
  screen: Deck<HTMLVideoElement> | null;
  camera: Deck<HTMLVideoElement> | null;
}

/** Elements further than this from where they should be are sent there. */
const DRIFT = 0.3;
/** How long before a cut the spare elements are sent to the other side of it. */
const LOOKAHEAD = 1.5;
/** How long the last frame may stay up while an element seeks. */
const HOLD = 400;

function element<T extends HTMLMediaElement>(make: () => T, url: string, muted: boolean): T {
  const el = make();
  el.preload = "auto";
  el.muted = muted;
  if (el instanceof HTMLVideoElement) el.playsInline = true;
  el.src = url;
  return el;
}

/**
 * One file in two elements: the live one plays, the spare (made on first use) waits where the
 * next piece starts and takes over there, already decoded, instead of the live one seeking.
 */
class Deck<T extends HTMLMediaElement> {
  live: T;
  private spare: T | null = null;
  private cued: number | null = null;
  private volume = 1;

  constructor(
    private readonly make: () => T,
    private readonly url: string,
    private readonly muted: boolean,
    private readonly onFrame: () => void,
  ) {
    this.live = this.element();
  }

  private element(): T {
    const el = element(this.make, this.url, this.muted);
    el.volume = this.volume;
    el.addEventListener("seeked", this.onFrame);
    el.addEventListener("loadeddata", this.onFrame);
    return el;
  }

  get elements(): T[] {
    return this.spare ? [this.live, this.spare] : [this.live];
  }

  /** The live element shows the frame it should (not seeking, data loaded). */
  get ready(): boolean {
    return this.live.readyState >= 2 && !this.live.seeking;
  }

  setVolume(v: number): void {
    this.volume = v;
    for (const el of this.elements) el.volume = v;
  }

  /** Sends the spare to `t` seconds of the file, to take over there. */
  cue(t: number): void {
    if (t < 0 || (this.cued !== null && Math.abs(this.cued - t) < 0.01)) return;
    this.spare ??= this.element();
    this.cued = t;
    this.spare.currentTime = t;
  }

  /** Keeps the deck at `t` seconds of its file, playing or not; `jump` when the time jumped. */
  follow(t: number, playing: boolean, jump: boolean): void {
    if (t < 0) {
      this.pause();
      return;
    }
    const off = Math.abs(this.live.currentTime - t);
    if (off > (jump ? 0.04 : DRIFT)) {
      const s = this.spare;
      // The spare waits at the start of this piece: a frame or two behind the clock at most.
      const there = this.cued !== null && Math.abs(this.cued - t) < 0.25;
      if (s && there && s.readyState >= 2 && !s.seeking) {
        this.spare = this.live;
        this.live = s;
        this.cued = null;
        this.spare.pause();
      } else this.live.currentTime = t;
    }
    if (playing && this.live.paused) void this.live.play().catch(() => undefined);
    if (!playing && !this.live.paused) this.live.pause();
  }

  pause(): void {
    for (const el of this.elements) if (!el.paused) el.pause();
  }
}

export class PreviewEngine {
  readonly time = signal(0);
  readonly playing = signal(false);
  private project: Project | null = null;
  private segments: Segment[] = [];
  private duration = 0;
  private readonly elements = new Map<string, Elements>();
  /** The voices' files, by key: a voice-over's file plays in several takes. */
  private readonly voices = new Map<string, Deck<HTMLAudioElement> | null>();
  /** The piece of the output playing at the last sync: when it changes, the time jumped. */
  private piece = -1;
  /** The take the canvas last showed, and since when it has waited on a seeking element. */
  private shown: string | null = null;
  private holdSince = 0;
  /** No voice is heard (while a voice-over is being recorded over the video). */
  voicesMuted = false;
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
    const els: Elements = { screen: null, camera: null };
    this.elements.set(clip.id, els);
    const url = (m: Media) => this.mediaUrl(m.key, m.type);
    const redraw = () => {
      if (!this.playing.value) this.draw();
    };
    const video = () => document.createElement("video");
    if (clip.screen) els.screen = new Deck(video, await url(clip.screen), false, redraw);
    if (clip.camera) els.camera = new Deck(video, await url(clip.camera), true, redraw);
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
    for (const d of this.decks()) d.pause();
    this.syncTo(this.time.value, true);
  }

  private *decks(): Iterable<Deck<HTMLMediaElement>> {
    for (const els of this.elements.values())
      for (const d of [els.screen, els.camera]) if (d) yield d;
    for (const d of this.voices.values()) if (d) yield d;
  }

  /** The deck playing a voice's file, once it is loaded (it starts loading on first ask). */
  private voice(key: string, type: string): Deck<HTMLAudioElement> | null {
    if (this.voices.has(key)) return this.voices.get(key) ?? null;
    this.voices.set(key, null);
    void this.mediaUrl(key, type).then((u) => {
      if (this.disposed || !u) return;
      this.voices.set(
        key,
        new Deck(
          () => document.createElement("audio"),
          u,
          false,
          () => {},
        ),
      );
      this.syncTo(this.time.value, !this.playing.value);
    });
    return null;
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
      for (const d of [before?.screen, before?.camera]) d?.pause();
      this.current = clip.id;
    }
    // Into another piece: even a short cut (a filler word) is a jump, not a drift.
    const jump = force || at.index !== this.piece;
    this.piece = at.index;
    if (!els) return;
    const playing = this.playing.value;
    els.screen?.setVolume(Math.max(0, Math.min(1, p.style.audio.screenVolume)));
    if (els.screen && clip.screen) els.screen.follow(at.t - clip.screen.offset, playing, jump);
    if (els.camera && clip.camera) els.camera.follow(at.t - clip.camera.offset, playing, jump);
    // The voice: the piece of a file heard now, every other voice file silent.
    const piece = this.voicesMuted ? undefined : pieceAt(voiceParts(clip), at.t);
    const heard = piece ? this.voice(piece.key, piece.type) : null;
    for (const d of this.voices.values()) if (d && d !== heard) d.pause();
    if (heard && piece) heard.follow(piece.at + (at.t - piece.start), playing, jump);
    if (playing) this.cueNext(at.index, t);
  }

  /** Close to the end of a piece, the spares go to where the next one starts. */
  private cueNext(index: number, t: number): void {
    const next = this.segments[index + 1];
    if (!next || next.at - t > LOOKAHEAD) return;
    const c = next.clip;
    const els = this.elements.get(c.id);
    if (els?.screen && c.screen) els.screen.cue(next.start - c.screen.offset);
    if (els?.camera && c.camera) els.camera.cue(next.start - c.camera.offset);
    const piece = this.voicesMuted ? undefined : pieceAt(voiceParts(c), next.start);
    const deck = piece ? this.voices.get(piece.key) : null;
    if (deck && piece) deck.cue(piece.at + (next.start - piece.start));
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
    // An element still seeking would draw nothing: the last frame stays up a moment instead.
    const waiting = [els?.screen, els?.camera].some((d) => d && !d.ready);
    if (waiting) {
      const now = performance.now();
      this.holdSince ||= now;
      if (this.shown === clip.id && now - this.holdSince < HOLD) return;
    } else this.holdSince = 0;
    this.shown = clip.id;
    const source = (d: Deck<HTMLVideoElement> | null | undefined): Source | null => {
      const el = d?.live;
      return el && el.readyState >= 2 && el.videoWidth
        ? { src: el, w: el.videoWidth, h: el.videoHeight }
        : null;
    };
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
    if (p.style.captions.enabled) drawCaptionsAt(ctx, size.w, size.h, p, clip.id, at.t);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const d of this.decks())
      for (const el of d.elements) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
    this.elements.clear();
    this.voices.clear();
  }
}
