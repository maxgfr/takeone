import { describe, expect, test } from "bun:test";
import {
  acceptChunk,
  CHUNK_HEADER,
  chunkSize,
  cleanName,
  DEFAULT_CHUNK,
  decodeChunk,
  decodeHostMessage,
  decodeViewerMessage,
  encodeChunk,
  MAX_FILE_SIZE,
  MAX_VIEWER_TEXT,
  parseMeta,
  readRanges,
} from "./protocol";

const META = { title: "Demo", duration: 12.5, type: "video/mp4", size: 1000 };

describe("metadata", () => {
  test("valid metadata passes, chapters included", () => {
    expect(parseMeta(META)).toEqual(META);
    const withChapters = { ...META, chapters: [{ t: 0, title: "Intro" }] };
    expect(parseMeta(withChapters)).toEqual(withChapters);
    expect(parseMeta({ ...META, type: 'video/webm;codecs="vp9,opus"' })?.type).toBe(
      'video/webm;codecs="vp9,opus"',
    );
  });

  test("bad sizes, durations, types and oversized fields are refused", () => {
    expect(parseMeta({ ...META, size: -1 })).toBeNull();
    expect(parseMeta({ ...META, size: 1.5 })).toBeNull();
    expect(parseMeta({ ...META, size: MAX_FILE_SIZE + 1 })).toBeNull();
    expect(parseMeta({ ...META, duration: Number.NaN })).toBeNull();
    expect(parseMeta({ ...META, duration: -3 })).toBeNull();
    expect(parseMeta({ ...META, type: "text/html<script>" })).toBeNull();
    expect(parseMeta({ ...META, type: "" })).toBeNull();
    expect(parseMeta({ ...META, title: "x".repeat(301) })).toBeNull();
    expect(parseMeta({ ...META, chapters: [{ t: -1, title: "x" }] })).toBeNull();
    expect(parseMeta(null)).toBeNull();
  });
});

describe("control messages", () => {
  test("host messages round-trip; junk is dropped", () => {
    const meta = { t: "meta" as const, v: 1, meta: META };
    expect(decodeHostMessage(JSON.stringify(meta))).toEqual(meta);
    expect(decodeHostMessage('{"t":"ping"}')).toEqual({ t: "ping" });
    expect(decodeHostMessage('{"t":"meta","v":1,"meta":{"size":-1}}')).toBeNull();
    expect(decodeHostMessage('{"t":"nope"}')).toBeNull();
    expect(decodeHostMessage("not json")).toBeNull();
    expect(decodeHostMessage(42)).toBeNull();
  });

  test("viewer messages are bounded and typed", () => {
    expect(decodeViewerMessage('{"t":"get","from":65536}')).toEqual({ t: "get", from: 65536 });
    expect(decodeViewerMessage('{"t":"get","from":-1}')).toBeNull();
    expect(decodeViewerMessage('{"t":"get","from":1.5}')).toBeNull();
    const stats = { t: "stats" as const, got: 10, pos: 3.2, playing: true, watched: 3 };
    expect(decodeViewerMessage(JSON.stringify(stats))).toEqual(stats);
    expect(decodeViewerMessage(JSON.stringify({ ...stats, pos: "3" }))).toBeNull();
    expect(decodeViewerMessage(JSON.stringify({ ...stats, watched: 1e12 }))).toBeNull();
    expect(decodeViewerMessage('{"t":"react","emoji":"👍","at":2}')).toEqual({
      t: "react",
      emoji: "👍",
      at: 2,
    });
    expect(decodeViewerMessage('{"t":"react","emoji":"💩","at":2}')).toBeNull();
    expect(decodeViewerMessage('{"t":"react","emoji":"👍","at":1e9}')).toBeNull();
    expect(decodeViewerMessage('{"t":"name","name":"Ada"}')).toEqual({ t: "name", name: "Ada" });
    // Extra fields are stripped, not passed along.
    expect(decodeViewerMessage('{"t":"bye","evil":true}')).toEqual({ t: "bye" });
  });

  test("oversized text is refused before it is parsed", () => {
    const big = JSON.stringify({ t: "name", name: "a".repeat(MAX_VIEWER_TEXT) });
    expect(decodeViewerMessage(big)).toBeNull();
  });

  test("names are cleaned: trimmed, no control or bidi characters, 40 characters at most", () => {
    expect(cleanName("  Ada   Lovelace ")).toBe("Ada Lovelace");
    expect(cleanName("‮evil\u0000")).toBe("evil");
    expect(cleanName("   ")).toBeNull();
    expect(Array.from(cleanName("é".repeat(80)) ?? "").length).toBe(40);
  });
});

describe("chunks", () => {
  test("encode/decode round-trips offsets up to the size limit", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    for (const offset of [0, 65536, 2 ** 31 - 5, MAX_FILE_SIZE - 5]) {
      const frame = encodeChunk(offset, data);
      expect(frame.length).toBe(CHUNK_HEADER + data.length);
      const got = decodeChunk(frame.buffer);
      expect(got?.offset).toBe(offset);
      expect(Array.from(got?.data ?? [])).toEqual([1, 2, 3, 4, 5]);
    }
  });

  test("empty, oversized and out-of-range chunks are refused", () => {
    expect(decodeChunk(new ArrayBuffer(CHUNK_HEADER))).toBeNull();
    expect(decodeChunk(new ArrayBuffer(CHUNK_HEADER + 300 * 1024))).toBeNull();
    expect(decodeChunk(encodeChunk(MAX_FILE_SIZE + 1, new Uint8Array(1)).buffer)).toBeNull();
    expect(decodeChunk(encodeChunk(2 ** 32 + 7, new Uint8Array(1)).buffer)).toBeNull();
  });

  test("chunk size follows the connection's message limit", () => {
    expect(chunkSize()).toBe(DEFAULT_CHUNK);
    expect(chunkSize(null)).toBe(DEFAULT_CHUNK);
    expect(chunkSize(262_144)).toBe(DEFAULT_CHUNK);
    expect(chunkSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CHUNK);
    expect(chunkSize(65_536)).toBe(65_536 - CHUNK_HEADER);
    expect(chunkSize(1000)).toBe(16 * 1024);
  });

  test("the viewer appends contiguous chunks, skips duplicates and asks to resume on gaps", () => {
    const c = (offset: number, n: number) => ({ offset, data: new Uint8Array(n) });
    expect(acceptChunk(0, 100, c(0, 10))).toBe("append");
    expect(acceptChunk(10, 100, c(10, 90))).toBe("append");
    expect(acceptChunk(50, 100, c(0, 10))).toBe("duplicate");
    expect(acceptChunk(50, 100, c(40, 10))).toBe("duplicate");
    expect(acceptChunk(50, 100, c(60, 10))).toBe("resume");
    expect(acceptChunk(50, 100, c(45, 10))).toBe("resume");
    expect(acceptChunk(95, 100, c(95, 10))).toBe("resume");
  });

  test("read ranges cover the file from any offset, exactly once", () => {
    expect(readRanges(10, 0, 4)).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
    expect(readRanges(10, 7, 4)).toEqual([[7, 10]]);
    expect(readRanges(10, 10, 4)).toEqual([]);
    expect(readRanges(10, 99, 4)).toEqual([]);
    expect(readRanges(0, 0, 4)).toEqual([]);
    const size = 5 * 1024 * 1024 + 17;
    for (const from of [0, 1, 1024 * 1024, size - 1]) {
      const r = readRanges(size, from, 1024 * 1024);
      expect(r[0]?.[0]).toBe(from);
      expect(r.at(-1)?.[1]).toBe(size);
      for (let i = 1; i < r.length; i++) expect(r[i]?.[0]).toBe(r[i - 1]?.[1] as number);
    }
  });
});
