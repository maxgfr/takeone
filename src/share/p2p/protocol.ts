/**
 * The wire protocol between the author's tab (host) and a viewer, on one
 * ordered, reliable DataChannel:
 *
 *   text   JSON control messages, validated with zod on arrival
 *   binary file chunks: offset (u64, big-endian) || bytes
 *
 *   host → viewer   meta (once per connection), ping, done, bye
 *   viewer → host   get {from} (start or resume), stats, react, name, bye
 *
 * Nothing a peer sends is trusted: every message is size-checked before it
 * is parsed, unknown or malformed messages are dropped, and numbers are
 * bounded (the stats layer clamps them again against what the host knows).
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;
/** The single negotiated DataChannel (both sides create it with this id). */
export const CHANNEL = { label: "video", id: 0 } as const;

/** Largest file a link can carry: the viewer holds it in memory (as Blobs) before playing. */
export const MAX_FILE_SIZE = 2 * 1024 ** 3;
/** Chunk payload when the connection does not say otherwise (safe in every browser). */
export const DEFAULT_CHUNK = 64 * 1024;
const MIN_CHUNK = 16 * 1024;
/** Largest chunk a viewer accepts (Chrome's SCTP limit). */
export const MAX_CHUNK = 256 * 1024;
export const CHUNK_HEADER = 8;
/** Text message limits, checked before JSON.parse (64 KiB is every browser's message limit). */
export const MAX_HOST_TEXT = 64 * 1024;
export const MAX_VIEWER_TEXT = 2048;

export const EMOJIS = ["👍", "❤️", "😂", "😮", "👏", "🎉"] as const;
export type Emoji = (typeof EMOJIS)[number];

const MAX_DURATION = 24 * 3600;
const MIME = /^[a-z]+\/[a-z0-9.+-]+(;[ a-z0-9=.,"+-]*)?$/i;

// ── metadata ────────────────────────────────────────────────────────────────

export interface Chapter {
  t: number;
  title: string;
}

export interface VideoMeta {
  title: string;
  /** Seconds. */
  duration: number;
  /** MIME type of the file, used for the viewer's Blob. */
  type: string;
  /** Bytes. */
  size: number;
  chapters?: Chapter[];
}

const seconds = z.number().finite().min(0).max(MAX_DURATION);

export const metaSchema = z.object({
  title: z.string().max(300),
  duration: seconds,
  type: z.string().max(120).regex(MIME),
  size: z.number().int().min(0).max(MAX_FILE_SIZE),
  chapters: z
    .array(z.object({ t: seconds, title: z.string().max(120) }))
    .max(200)
    .optional(),
});

/** Validates metadata (the host's own before sharing, the viewer's on arrival). */
export function parseMeta(x: unknown): VideoMeta | null {
  const r = metaSchema.safeParse(x);
  if (!r.success) return null;
  const { chapters, ...rest } = r.data;
  return chapters ? { ...rest, chapters } : rest;
}

// ── control messages ────────────────────────────────────────────────────────

export type HostMessage =
  | { t: "meta"; v: number; meta: VideoMeta }
  | { t: "ping" }
  | { t: "done" }
  | { t: "bye" };

export type ViewerMessage =
  | { t: "get"; from: number }
  | { t: "stats"; got: number; pos: number; playing: boolean; watched: number }
  | { t: "react"; emoji: Emoji; at: number }
  | { t: "name"; name: string }
  | { t: "bye" };

const hostSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("meta"), v: z.number().int(), meta: metaSchema }),
  z.object({ t: z.literal("ping") }),
  z.object({ t: z.literal("done") }),
  z.object({ t: z.literal("bye") }),
]);

const bytesCount = z.number().int().min(0).max(MAX_FILE_SIZE);

const viewerSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("get"), from: bytesCount }),
  z.object({
    t: z.literal("stats"),
    got: bytesCount,
    pos: seconds,
    playing: z.boolean(),
    // Cumulative seconds played: bounded here, rate-limited by the host (stats.ts).
    watched: z
      .number()
      .finite()
      .min(0)
      .max(MAX_DURATION * 100),
  }),
  z.object({ t: z.literal("react"), emoji: z.enum(EMOJIS), at: seconds }),
  z.object({ t: z.literal("name"), name: z.string().max(200) }),
  z.object({ t: z.literal("bye") }),
]);

function parseJson(text: unknown, max: number): unknown {
  if (typeof text !== "string" || text.length > max) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A message from the host, or null. Never throws. */
export function decodeHostMessage(text: unknown): HostMessage | null {
  const r = hostSchema.safeParse(parseJson(text, MAX_HOST_TEXT));
  if (!r.success) return null;
  if (r.data.t !== "meta") return r.data;
  const meta = parseMeta(r.data.meta);
  return meta ? { t: "meta", v: r.data.v, meta } : null;
}

/** A message from a viewer, or null. Never throws. */
export function decodeViewerMessage(text: unknown): ViewerMessage | null {
  const r = viewerSchema.safeParse(parseJson(text, MAX_VIEWER_TEXT));
  return r.success ? r.data : null;
}

/** A display name: trimmed, without control or bidi-override characters, at most 40 characters. */
export function cleanName(name: string): string | null {
  const s = name
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return s ? Array.from(s).slice(0, 40).join("") : null;
}

// ── chunks ──────────────────────────────────────────────────────────────────

/** The chunk payload for a connection whose SCTP transport allows `maxMessageSize`. */
export function chunkSize(maxMessageSize?: number | null): number {
  if (!maxMessageSize || !(maxMessageSize > 0)) return DEFAULT_CHUNK;
  return Math.max(MIN_CHUNK, Math.min(DEFAULT_CHUNK, maxMessageSize - CHUNK_HEADER));
}

export function encodeChunk(offset: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(CHUNK_HEADER + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(offset / 2 ** 32));
  view.setUint32(4, offset >>> 0);
  out.set(data, CHUNK_HEADER);
  return out;
}

export function decodeChunk(buf: ArrayBuffer): { offset: number; data: Uint8Array } | null {
  if (buf.byteLength <= CHUNK_HEADER || buf.byteLength > CHUNK_HEADER + MAX_CHUNK) return null;
  const view = new DataView(buf);
  const offset = view.getUint32(0) * 2 ** 32 + view.getUint32(4);
  if (offset > MAX_FILE_SIZE) return null;
  return { offset, data: new Uint8Array(buf, CHUNK_HEADER) };
}

/**
 * What a viewer does with a chunk, given how many contiguous bytes it already
 * has: append it, ignore it (a duplicate from before a resume), or ask the
 * host to resume from `received` (a gap, or bytes past the end of the file).
 */
export function acceptChunk(
  received: number,
  size: number,
  chunk: { offset: number; data: Uint8Array },
): "append" | "duplicate" | "resume" {
  const end = chunk.offset + chunk.data.length;
  if (end > size) return "resume";
  if (chunk.offset === received) return "append";
  if (end <= received) return "duplicate";
  return "resume";
}

/** The byte ranges a host reads from the file to serve it from `from`, `step` bytes at a time. */
export function readRanges(size: number, from: number, step: number): [number, number][] {
  const out: [number, number][] = [];
  const start = Math.max(0, Math.min(size, Math.floor(from)));
  for (let a = start; a < size; a += step) out.push([a, Math.min(size, a + step)]);
  return out;
}
