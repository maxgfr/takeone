/**
 * The author's side of a share link. hostVideo() creates a room (a random
 * key and an ephemeral identity), listens for viewers on the relays and
 * trackers, and serves the file to each one over its own WebRTC connection:
 * chunked, with backpressure, resumable from any offset, several viewers at
 * once. Viewers send their stats back on the same channel; they are folded
 * into ViewerStates (see stats.ts) and handed to `onViewers`.
 *
 * The file only exists in this tab: when it closes (or stop() is called),
 * the link stops working. Viewers that already have the whole file keep it.
 */

import { loadNetConfig, type NetOptions } from "./config";
import { randomBytes, toB64u } from "./crypto/bytes";
import { createIdentity, isPeerId } from "./crypto/identity";
import { deriveRoomSecrets, newRoomKey } from "./crypto/room";
import { Link } from "./peer";
import {
  chunkSize,
  cleanName,
  decodeViewerMessage,
  encodeChunk,
  type HostMessage,
  PROTOCOL_VERSION,
  parseMeta,
  readRanges,
  type VideoMeta,
} from "./protocol";
import { RoomSignaling } from "./signal/mux";
import type { SignalMessage, TransportStatus } from "./signal/types";
import {
  applyReaction,
  applyStats,
  createViewer,
  RateLimit,
  setConnected,
  type ViewerState,
} from "./stats";
import { encodeToken, watchLink } from "./token";

export interface HostStatus {
  /** "online" once at least one relay or tracker is reachable. */
  state: "starting" | "online" | "offline" | "stopped";
  signaling: TransportStatus[];
  /** Viewers connected right now. */
  viewers: number;
}

export interface HostOptions extends NetOptions {
  file: Blob;
  meta: VideoMeta;
  /** The app's URL; the link is `${appUrl}#/watch/<token>`. */
  appUrl: string;
  onViewers: (viewers: ViewerState[]) => void;
  onStatus?: (s: HostStatus) => void;
  /** Viewers served at once (default 24); more wait until a slot frees up. */
  maxViewers?: number;
}

export interface HostHandle {
  link: string;
  stop(): void;
}

/** Bytes read from the file at a time. */
const READ_BYTES = 1024 * 1024;
const PING_MS = 5000;
/** A viewer silent for this long is gone (it reports at least every 5 s). */
const SILENT_MS = 30_000;
const MAX_RECORDS = 500;
const EMIT_MS = 200;

interface ViewerRecord {
  state: ViewerState;
  link: Link | null;
  session: string;
  /** Highest byte offset sent to this viewer. */
  sent: number;
  /** Bumped to cancel a running send loop. */
  gen: number;
  lastHeard: number;
  lastStats: number;
  lastOffer: number;
  messages: RateLimit;
  reactions: RateLimit;
  dropped: number;
  /** Listed only once a connection opened: a hello alone is not a viewer. */
  listed: boolean;
}

export async function hostVideo(opts: HostOptions): Promise<HostHandle> {
  // Long titles and chapter lists are trimmed to what viewers accept, rather than refused.
  const parsed = parseMeta({
    ...opts.meta,
    title: opts.meta.title.slice(0, 300),
    size: opts.file.size,
    ...(opts.meta.chapters
      ? {
          chapters: opts.meta.chapters
            .slice(0, 200)
            .map((c) => ({ t: c.t, title: c.title.slice(0, 120) })),
        }
      : {}),
  });
  if (!parsed) throw new Error("This video cannot be shared (invalid details or too large).");
  const meta: VideoMeta = parsed;
  const file = opts.file;
  const durationBound = meta.duration > 0 ? meta.duration : 24 * 3600;
  const maxViewers = opts.maxViewers ?? 24;
  const net = loadNetConfig();
  const rtcConfig: RTCConfiguration = { iceServers: opts.iceServers ?? net.iceServers };

  const key = newRoomKey();
  const [identity, secrets] = await Promise.all([createIdentity(), deriveRoomSecrets(key)]);
  const link = watchLink(opts.appUrl, encodeToken({ key, host: identity.peerId }));

  const records = new Map<string, ViewerRecord>();
  const offers = new RateLimit(4, 12);
  let signalingStatus: TransportStatus[] = [];
  let stopped = false;
  let emitTimer: ReturnType<typeof setTimeout> | undefined;

  const connectedCount = () => {
    let n = 0;
    for (const r of records.values()) if (r.link?.open) n++;
    return n;
  };

  const emitViewers = () => {
    if (emitTimer !== undefined || stopped) return;
    emitTimer = setTimeout(() => {
      emitTimer = undefined;
      if (stopped) return;
      opts.onViewers([...records.values()].filter((r) => r.listed).map((r) => r.state));
    }, EMIT_MS);
  };

  const emitStatus = () => {
    const online = signalingStatus.some((s) => s.state === "online");
    const connecting = signalingStatus.some((s) => s.state === "connecting");
    opts.onStatus?.({
      state: stopped ? "stopped" : online ? "online" : connecting ? "starting" : "offline",
      signaling: signalingStatus,
      viewers: connectedCount(),
    });
  };

  const signaling = new RoomSignaling(
    {
      secrets,
      identity,
      config: opts.signal ?? net.signal,
      ...(opts.factory ? { factory: opts.factory } : {}),
    },
    {
      onMessage: (msg) => onSignal(msg),
      onStatus: (s) => {
        signalingStatus = s;
        emitStatus();
      },
    },
  );

  function onSignal(msg: SignalMessage): void {
    if (stopped || !isPeerId(msg.from)) return;
    const rec = records.get(msg.from);
    if (msg.kind === "hello") onHello(msg.from, rec);
    else if (msg.kind === "answer" && rec?.link && msg.sdp && msg.session === rec.session)
      void rec.link.acceptRemote({ type: "answer", sdp: msg.sdp });
    else if (msg.kind === "bye" && rec?.link) rec.link.close("left");
  }

  function onHello(from: string, existing: ViewerRecord | undefined): void {
    const now = Date.now();
    if (existing?.link?.open) return;
    // A connection attempt in progress: let it finish (or time out) first.
    if (existing?.link && now - existing.lastOffer < 10_000) return;
    if (connectedCount() >= maxViewers) return;
    if (!existing && records.size >= MAX_RECORDS) return;
    if (!offers.take()) return;
    let rec = existing;
    if (!rec) {
      rec = {
        state: createViewer(from, now),
        link: null,
        session: "",
        sent: 0,
        gen: 0,
        lastHeard: now,
        lastStats: now,
        lastOffer: 0,
        messages: new RateLimit(10, 40),
        reactions: new RateLimit(2, 8),
        dropped: 0,
        listed: false,
      };
      rec.state.connected = false;
      records.set(from, rec);
    }
    connect(rec);
  }

  function connect(rec: ViewerRecord): void {
    rec.link?.close("replaced");
    const session = toB64u(randomBytes(12));
    const id = rec.state.id;
    rec.session = session;
    rec.lastOffer = Date.now();
    const l: Link = new Link(
      { initiator: true, rtcConfig, ...(opts.PC ? { PC: opts.PC } : {}) },
      {
        signal: (desc) => {
          void signaling.send({ kind: desc.type, to: id, sdp: desc.sdp, session }).catch(() => {});
        },
        open: () => {
          const now = Date.now();
          rec.lastHeard = now;
          rec.listed = true;
          rec.state = setConnected(rec.state, true, now);
          send(l, { t: "meta", v: PROTOCOL_VERSION, meta });
          emitViewers();
          emitStatus();
        },
        message: (data) => onViewerMessage(rec, l, data),
        close: () => {
          if (rec.link !== l) return;
          rec.link = null;
          rec.gen++;
          rec.state = setConnected(rec.state, false, Date.now());
          emitViewers();
          emitStatus();
        },
      },
    );
    rec.link = l;
  }

  function send(l: Link, msg: HostMessage): boolean {
    return l.sendJson(msg);
  }

  function onViewerMessage(rec: ViewerRecord, l: Link, data: string | ArrayBuffer): void {
    const now = Date.now();
    rec.lastHeard = now;
    if (!rec.messages.take()) {
      if (++rec.dropped > 200) l.close("flood");
      return;
    }
    const msg = typeof data === "string" ? decodeViewerMessage(data) : null;
    if (!msg) {
      // Viewers never send binary, and a well-behaved one never sends junk.
      if (++rec.dropped > 50) l.close("protocol");
      return;
    }
    switch (msg.t) {
      case "get":
        if (msg.from <= meta.size) void serve(rec, l, msg.from);
        break;
      case "stats":
        rec.state = applyStats(rec.state, msg, {
          now,
          duration: durationBound,
          sent: rec.sent,
          since: rec.lastStats,
        });
        rec.lastStats = now;
        break;
      case "react":
        if (rec.reactions.take())
          rec.state = applyReaction(rec.state, msg.emoji, msg.at, now, durationBound);
        break;
      case "name":
        rec.state = { ...rec.state, name: cleanName(msg.name), lastSeen: now };
        break;
      case "bye":
        l.close("left");
        return;
    }
    emitViewers();
  }

  /** Streams the file from `from` until the end, unless the link closes or a newer request replaces it. */
  async function serve(rec: ViewerRecord, l: Link, from: number): Promise<void> {
    const gen = ++rec.gen;
    const chunk = chunkSize(l.maxMessageSize());
    const live = () => gen === rec.gen && l.open && !stopped;
    for (const [start, end] of readRanges(meta.size, from, READ_BYTES)) {
      await l.drain();
      if (!live()) return;
      let buf: Uint8Array;
      try {
        buf = new Uint8Array(await file.slice(start, end).arrayBuffer());
      } catch {
        l.close("file unreadable");
        return;
      }
      if (!live()) return;
      for (let p = 0; p < buf.length; p += chunk) {
        if (!l.send(encodeChunk(start + p, buf.subarray(p, p + chunk)))) return;
      }
      rec.sent = Math.max(rec.sent, end);
    }
    if (live()) send(l, { t: "done" });
  }

  const ticker = setInterval(() => {
    const now = Date.now();
    for (const rec of records.values()) {
      const l = rec.link;
      if (!l?.open) continue;
      if (now - rec.lastHeard > SILENT_MS) l.close("silent");
      else send(l, { t: "ping" });
    }
  }, PING_MS);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(ticker);
    clearTimeout(emitTimer);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", stop);
    for (const rec of records.values()) {
      const l = rec.link;
      if (!l) continue;
      send(l, { t: "bye" });
      l.close("stopped", 150);
    }
    // Tell viewers still looking for this tab that it is gone; then leave the relays.
    void signaling
      .send({ kind: "bye" })
      .catch(() => {})
      .finally(() => setTimeout(() => signaling.stop(), 300));
    emitStatus();
  }

  if (typeof window !== "undefined") window.addEventListener("pagehide", stop);
  await signaling.start();
  opts.onViewers([]);
  emitStatus();
  return { link, stop };
}
