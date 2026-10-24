/**
 * The token at the end of a share link (`#/watch/<token>`): what a viewer
 * needs to find and trust the author's tab, and nothing else.
 *
 *   token = base64url( version(1) || room key(32) || host peer id(10) )
 *
 * The room key opens the signaling envelopes; the host's peer id pins who may
 * send the video (anyone else holding the link is just another viewer). It
 * lives in the URL fragment, which browsers never send to a server.
 */
import { type Bytes, concat, fromB64u, fromHex, toB64u, toHex } from "./crypto/bytes";
import { isPeerId } from "./crypto/identity";
import { ROOM_KEY_BYTES } from "./crypto/room";

const VERSION = 1;
const HOST_BYTES = 10;
const TOKEN_BYTES = 1 + ROOM_KEY_BYTES + HOST_BYTES;
export const TOKEN_LENGTH = Math.ceil((TOKEN_BYTES * 4) / 3);

export interface RoomToken {
  key: Bytes;
  /** The host's peer id (20 hex characters). */
  host: string;
}

export function encodeToken(t: RoomToken): string {
  if (t.key.length !== ROOM_KEY_BYTES || !isPeerId(t.host)) throw new Error("invalid room");
  return toB64u(concat(new Uint8Array([VERSION]), t.key, fromHex(t.host)));
}

/** The room in a token, a `#/watch/<token>` fragment or a full link; null if it is not one. */
export function decodeToken(input: string): RoomToken | null {
  const s = input.trim().replace(/^.*#\/?watch\//, "");
  if (s.length !== TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  let raw: Bytes;
  try {
    raw = fromB64u(s);
  } catch {
    return null;
  }
  if (raw.length !== TOKEN_BYTES || raw[0] !== VERSION) return null;
  return {
    key: raw.slice(1, 1 + ROOM_KEY_BYTES),
    host: toHex(raw.subarray(1 + ROOM_KEY_BYTES)),
  };
}

/** `${appUrl}#/watch/<token>`, whatever fragment appUrl had. */
export function watchLink(appUrl: string, token: string): string {
  return `${appUrl.split("#")[0]}#/watch/${token}`;
}
