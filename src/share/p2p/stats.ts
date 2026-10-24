/**
 * Viewer statistics, as the host sees them. Viewers report what they did;
 * the host folds each report into a ViewerState, clamping every number
 * against what it knows for sure (the video's duration, the bytes it sent,
 * the time that passed), so a misbehaving viewer can only lie within bounds.
 * Pure functions plus a token bucket, so all of it is unit-tested.
 */
import type { Emoji } from "./protocol";

export interface Reaction {
  emoji: string;
  /** Position in the video, seconds. */
  at: number;
  /** When it arrived (host clock, ms). */
  ts: number;
}

export interface ViewerState {
  /** The viewer's peer id (one per open tab). */
  id: string;
  name: string | null;
  joinedAt: number;
  connected: boolean;
  /** Bytes received. */
  downloaded: number;
  /** Current position, seconds (where they left, once disconnected). */
  position: number;
  /** Furthest position reached, seconds. */
  furthest: number;
  /** Seconds actually played. */
  watched: number;
  playing: boolean;
  lastSeen: number;
  reactions: Reaction[];
}

/** Playback rates above this do not count as watching (and bound the claims). */
export const MAX_PLAYBACK_RATE = 4;
const WATCH_SLACK_S = 2;
export const MAX_REACTIONS = 300;

export function createViewer(id: string, now: number): ViewerState {
  return {
    id,
    name: null,
    joinedAt: now,
    connected: true,
    downloaded: 0,
    position: 0,
    furthest: 0,
    watched: 0,
    playing: false,
    lastSeen: now,
    reactions: [],
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export interface StatsReport {
  got: number;
  pos: number;
  playing: boolean;
  watched: number;
}

export interface StatsContext {
  now: number;
  /** Video duration, seconds. */
  duration: number;
  /** Bytes the host has sent this viewer (the most it can have). */
  sent: number;
  /** When the previous report arrived (or the viewer joined). */
  since: number;
}

/**
 * Folds a report into the state. `watched` is cumulative on the viewer's
 * side: it may only grow, and by no more than the wall-clock time since the
 * last report allows.
 */
export function applyStats(v: ViewerState, r: StatsReport, ctx: StatsContext): ViewerState {
  const pos = clamp(r.pos, 0, ctx.duration);
  const elapsed = Math.max(0, ctx.now - ctx.since) / 1000;
  const ceiling = v.watched + elapsed * MAX_PLAYBACK_RATE + WATCH_SLACK_S;
  return {
    ...v,
    connected: true,
    downloaded: Math.max(v.downloaded, clamp(r.got, 0, ctx.sent)),
    position: pos,
    furthest: Math.max(v.furthest, pos),
    watched: clamp(r.watched, v.watched, Math.min(ceiling, ctx.duration * 100)),
    playing: r.playing,
    lastSeen: ctx.now,
  };
}

export function applyReaction(
  v: ViewerState,
  emoji: Emoji,
  at: number,
  now: number,
  duration: number,
): ViewerState {
  const reactions = [...v.reactions, { emoji, at: clamp(at, 0, duration), ts: now }];
  return { ...v, reactions: reactions.slice(-MAX_REACTIONS), lastSeen: now };
}

export function setConnected(v: ViewerState, connected: boolean, now: number): ViewerState {
  return { ...v, connected, playing: connected && v.playing, lastSeen: now };
}

/** "Ada", or "Viewer 3" for the third viewer to join who gave no name. */
export function viewerLabel(viewers: readonly ViewerState[], v: ViewerState): string {
  if (v.name) return v.name;
  const order = [...viewers].sort((a, b) => a.joinedAt - b.joinedAt);
  return `Viewer ${order.indexOf(v) + 1}`;
}

export interface Summary {
  total: number;
  watching: number;
  /** Viewers who reached the end: its last 5%, or its last 5 s if that is shorter. */
  finished: number;
  /** Mean of furthest/duration, 0–1. */
  averageReach: number;
  reactions: Partial<Record<string, number>>;
}

export function summarize(viewers: readonly ViewerState[], duration: number): Summary {
  const end = duration - Math.min(5, duration * 0.05);
  const reactions: Partial<Record<string, number>> = {};
  let reach = 0;
  for (const v of viewers) {
    reach += duration > 0 ? Math.min(1, v.furthest / duration) : 0;
    for (const r of v.reactions) reactions[r.emoji] = (reactions[r.emoji] ?? 0) + 1;
  }
  return {
    total: viewers.length,
    watching: viewers.filter((v) => v.connected).length,
    finished: viewers.filter((v) => duration > 0 && v.furthest > 0 && v.furthest >= end).length,
    averageReach: viewers.length ? reach / viewers.length : 0,
    reactions,
  };
}

/** Token bucket: `rate` tokens per second, at most `burst` saved up. */
export class RateLimit {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** m:ss (or h:mm:ss) for a number of seconds. */
export function formatTime(s: number): string {
  const t = Math.max(0, Math.floor(Number.isFinite(s) ? s : 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
