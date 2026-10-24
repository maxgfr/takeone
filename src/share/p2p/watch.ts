/**
 * The viewer's side of a share link. watchVideo() looks for the author's tab
 * on the relays and trackers (a sealed "hello" addressed to the host id the
 * link pins), accepts its offer, downloads the file over the DataChannel and
 * hands it over as one Blob. Meanwhile it reports what the viewer does
 * (position, play state, seconds watched, reactions, name) on the same
 * channel. If the connection drops, it reconnects and resumes from the bytes
 * it already has.
 */

import { loadNetConfig, type NetOptions } from "./config";
import { createIdentity } from "./crypto/identity";
import { deriveRoomSecrets } from "./crypto/room";
import { Link } from "./peer";
import {
  acceptChunk,
  cleanName,
  decodeChunk,
  decodeHostMessage,
  EMOJIS,
  type Emoji,
  type HostMessage,
  type VideoMeta,
  type ViewerMessage,
} from "./protocol";
import { RoomSignaling } from "./signal/mux";
import type { SignalMessage, TransportStatus } from "./signal/types";
import { MAX_PLAYBACK_RATE, RateLimit } from "./stats";
import { decodeToken } from "./token";

export type WatchPhase =
  /** Looking for the author's tab through the relays and trackers. */
  | "searching"
  /** Found it; the WebRTC connection is being set up. */
  | "connecting"
  | "downloading"
  /** The whole file is here (the connection may or may not still be up). */
  | "ready"
  | "closed";

export interface WatchStatus {
  phase: WatchPhase;
  /** Connected to the author's tab right now. */
  connected: boolean;
  /** The author stopped sharing (their tab said so before leaving). */
  hostGone: boolean;
  /** When the current phase began (ms since epoch), e.g. to say "still looking…". */
  since: number;
  signaling: TransportStatus[];
}

export interface WatchHandlers {
  onMeta(meta: VideoMeta): void;
  onProgress(received: number, total: number): void;
  onReady(blob: Blob): void;
  onStatus(s: WatchStatus): void;
  onError(err: Error): void;
}

export interface WatchHandle {
  /** Call on timeupdate, play, pause, seeked and ended; reports are throttled here. */
  report(position: number, playing: boolean): void;
  react(emoji: string, at: number): void;
  setName(name: string): void;
  close(): void;
}

/** Blobs are built every few MiB so the browser can move them out of the JS heap. */
const FLUSH_BYTES = 8 * 1024 * 1024;
const SILENT_MS = 20_000;
const PROGRESS_MS = 100;

export function watchVideo(token: string, h: WatchHandlers, net: NetOptions = {}): WatchHandle {
  const room = decodeToken(token);
  if (!room) {
    queueMicrotask(() =>
      h.onError(new Error("This link is not valid. Check that it was copied in full.")),
    );
    return { report() {}, react() {}, setName() {}, close() {} };
  }
  const host = room.host;
  const cfg = loadNetConfig();
  const rtcConfig: RTCConfiguration = { iceServers: net.iceServers ?? cfg.iceServers };

  let signaling: RoomSignaling | null = null;
  let signalingStatus: TransportStatus[] = [];
  let link: Link | null = null;
  let session = "";
  let closed = false;
  let hostGone = false;
  let phase: WatchPhase = "searching";
  let since = Date.now();

  let meta: VideoMeta | null = null;
  let received = 0;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let blobs: Blob[] = [];
  let ready = false;
  let resumeAskedAt = -1;
  let lastProgress = 0;
  let lastHeard = 0;

  let name: string | null = null;
  const reactQueue: { emoji: Emoji; at: number }[] = [];
  const reactLimit = new RateLimit(2, 8);

  // Playback, as reported by the page.
  let pos = 0;
  let playing = false;
  let watched = 0;
  let lastReportAt = 0;
  let sentAt = 0;
  let sentPos = 0;
  let sentPlaying = false;

  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  let hellos = 0;

  const emitStatus = () => {
    const next: WatchPhase = closed
      ? "closed"
      : ready
        ? "ready"
        : link?.open
          ? "downloading"
          : link
            ? "connecting"
            : "searching";
    if (next !== phase) {
      phase = next;
      since = Date.now();
    }
    h.onStatus({
      phase,
      connected: !!link?.open,
      hostGone,
      since,
      signaling: signalingStatus,
    });
  };

  const fail = (err: Error) => {
    if (closed) return;
    h.onError(err);
    close();
  };

  const send = (msg: ViewerMessage): boolean => link?.sendJson(msg) ?? false;

  const sendStats = () => {
    if (!send({ t: "stats", got: received, pos, playing, watched })) return;
    sentAt = Date.now();
    sentPos = pos;
    sentPlaying = playing;
  };

  // ── signaling ─────────────────────────────────────────────────────────────

  const hello = () => {
    clearTimeout(helloTimer);
    if (closed || hostGone) return;
    if (!link && signaling) {
      void signaling.send({ kind: "hello", to: host }).catch(() => {});
      hellos++;
    }
    // Eager while looking for the video, relaxed once it is here (only stats are at stake).
    const delay = ready ? 15_000 : hellos < 6 ? 3000 : 10_000;
    helloTimer = setTimeout(hello, delay);
  };

  const onSignal = (msg: SignalMessage) => {
    // Only the tab pinned in the link may offer the video.
    if (closed || msg.from !== host) return;
    if (msg.kind === "bye") {
      hostGone = true;
      link?.close("host left");
      emitStatus();
    } else if (msg.kind === "offer" && msg.sdp && msg.session && msg.session !== session) {
      hostGone = false;
      connect(msg.session, msg.sdp);
    }
  };

  // ── connection ────────────────────────────────────────────────────────────

  const connect = (s: string, sdp: string) => {
    link?.close("replaced");
    session = s;
    const l: Link = new Link(
      { initiator: false, rtcConfig, ...(net.PC ? { PC: net.PC } : {}) },
      {
        signal: (desc) => {
          void signaling
            ?.send({ kind: desc.type, to: host, sdp: desc.sdp, session: s })
            .catch(() => {});
        },
        open: () => {
          lastHeard = Date.now();
          resumeAskedAt = -1;
          if (name) send({ t: "name", name });
          for (const r of reactQueue.splice(0)) send({ t: "react", ...r });
          emitStatus();
        },
        message: (data) => {
          lastHeard = Date.now();
          if (typeof data === "string") onHostMessage(decodeHostMessage(data));
          else onChunk(data);
        },
        close: () => {
          if (link !== l) return;
          link = null;
          session = "";
          emitStatus();
          // Look for the host again soon: the download resumes where it stopped.
          clearTimeout(helloTimer);
          helloTimer = setTimeout(hello, 1000);
        },
      },
    );
    link = l;
    void l.acceptRemote({ type: "offer", sdp });
    emitStatus();
  };

  const onHostMessage = (msg: HostMessage | null) => {
    if (!msg) return;
    if (msg.t === "bye") {
      hostGone = true;
      link?.close("host left");
      emitStatus();
      return;
    }
    if (msg.t !== "meta") return;
    if (!meta) {
      meta = msg.meta;
      h.onMeta(meta);
    } else if (msg.meta.size !== meta.size || msg.meta.type !== meta.type) {
      fail(new Error("The video changed while it was downloading."));
      return;
    }
    if (ready) sendStats();
    else if (received >= meta.size) finish();
    else {
      send({ t: "get", from: received });
      sendStats();
    }
  };

  const onChunk = (buf: ArrayBuffer) => {
    if (!meta || ready) return;
    const c = decodeChunk(buf);
    if (!c) return;
    const verdict = acceptChunk(received, meta.size, c);
    if (verdict === "duplicate") return;
    if (verdict === "resume") {
      if (resumeAskedAt !== received && send({ t: "get", from: received }))
        resumeAskedAt = received;
      return;
    }
    pending.push(c.data);
    pendingBytes += c.data.length;
    received += c.data.length;
    if (pendingBytes >= FLUSH_BYTES) {
      blobs.push(new Blob(pending as Uint8Array<ArrayBuffer>[]));
      pending = [];
      pendingBytes = 0;
    }
    if (received >= meta.size) finish();
    else if (Date.now() - lastProgress >= PROGRESS_MS) {
      lastProgress = Date.now();
      h.onProgress(received, meta.size);
    }
  };

  const finish = () => {
    if (!meta || ready) return;
    blobs.push(new Blob(pending as Uint8Array<ArrayBuffer>[]));
    const blob = new Blob(blobs, { type: meta.type });
    pending = [];
    pendingBytes = 0;
    blobs = [];
    ready = true;
    h.onProgress(received, meta.size);
    h.onReady(blob);
    emitStatus();
    sendStats();
  };

  // ── periodic work: stats heartbeat, silence watchdog ──────────────────────

  const ticker = setInterval(() => {
    const l = link;
    if (!l?.open) return;
    const now = Date.now();
    if (now - lastHeard > SILENT_MS) {
      l.close("silent");
      return;
    }
    if (now - sentAt >= (playing || !ready ? 2000 : 5000)) sendStats();
  }, 1000);

  // ── handle ────────────────────────────────────────────────────────────────

  function report(position: number, isPlaying: boolean): void {
    if (closed || !Number.isFinite(position) || position < 0) return;
    const now = Date.now();
    if (playing && lastReportAt > 0) {
      const delta = position - pos;
      const wall = (now - lastReportAt) / 1000;
      if (delta > 0 && delta <= wall * MAX_PLAYBACK_RATE + 0.5) watched += delta;
    }
    pos = position;
    playing = isPlaying;
    lastReportAt = now;
    const expected = sentPos + (sentPlaying ? (now - sentAt) / 1000 : 0);
    if (playing !== sentPlaying || Math.abs(position - expected) > 1.5 || now - sentAt >= 2000)
      sendStats();
  }

  function react(emoji: string, at: number): void {
    if (closed || !(EMOJIS as readonly string[]).includes(emoji) || !Number.isFinite(at)) return;
    if (!reactLimit.take()) return;
    const r = { emoji: emoji as Emoji, at: Math.max(0, at) };
    if (!send({ t: "react", ...r })) {
      reactQueue.push(r);
      if (reactQueue.length > 20) reactQueue.shift();
    }
  }

  function setName(n: string): void {
    name = cleanName(n);
    send({ t: "name", name: name ?? "" });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    clearInterval(ticker);
    clearTimeout(helloTimer);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", close);
    const l = link;
    if (l?.open) {
      send({ t: "bye" });
      l.close("closed", 150);
    } else l?.close("closed");
    const s = signaling;
    signaling = null;
    if (s) setTimeout(() => s.stop(), 300);
    emitStatus();
  }

  if (typeof window !== "undefined") window.addEventListener("pagehide", close);

  void (async () => {
    try {
      const [identity, secrets] = await Promise.all([
        createIdentity(),
        deriveRoomSecrets(room.key),
      ]);
      if (closed) return;
      const s = new RoomSignaling(
        {
          secrets,
          identity,
          config: net.signal ?? cfg.signal,
          ...(net.factory ? { factory: net.factory } : {}),
        },
        {
          onMessage: onSignal,
          onStatus: (st) => {
            signalingStatus = st;
            emitStatus();
          },
        },
      );
      signaling = s;
      await s.start();
      if (closed) {
        s.stop();
        return;
      }
      emitStatus();
      hello();
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return { report, react, setName, close };
}
