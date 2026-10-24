/**
 * Room secrets for a shared video. A room is a 256-bit random key that only
 * ever travels in the link's #fragment (never sent to any server). The rest
 * is derived from it with HKDF-SHA256:
 *
 *   topic_d = HKDF(key, "topic/<utc day>")   public rendezvous id, rotates daily
 *   sigKey  = HKDF(key, "sig")               AES-GCM key for signaling envelopes
 *
 * Adapted from veil (github.com/maxgfr/veil, MIT), src/crypto/room.ts, without
 * the passphrase, the emoji verification and the pairwise session keys, which
 * a one-to-many video share does not need.
 */
import { importAesKey } from "./aead";
import { type Bytes, bytes, utf8 } from "./bytes";

export const ROOM_KEY_BYTES = 32;
const DAY_MS = 86_400_000;
const SALT = utf8("takeone/share/v1");

export function newRoomKey(): Bytes {
  return crypto.getRandomValues(new Uint8Array(ROOM_KEY_BYTES));
}

export function utcDay(ms: number = Date.now()): number {
  return Math.floor(ms / DAY_MS);
}

export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string | Uint8Array,
  length = 32,
): Promise<Bytes> {
  const base = await crypto.subtle.importKey("raw", bytes(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bytes(salt),
      info: typeof info === "string" ? utf8(info) : bytes(info),
    },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

export interface RoomSecrets {
  sigKey: CryptoKey;
  /** Rendezvous topic for a UTC day (cached). */
  topic(day: number): Promise<Bytes>;
}

export async function deriveRoomSecrets(key: Uint8Array): Promise<RoomSecrets> {
  if (key.length !== ROOM_KEY_BYTES) throw new Error("room key must be 32 bytes");
  const sigKey = await importAesKey(await hkdf(key, SALT, "sig"));
  const topics = new Map<number, Promise<Bytes>>();
  return {
    sigKey,
    topic(day) {
      let t = topics.get(day);
      if (!t) {
        t = hkdf(key, SALT, `topic/${day}`);
        topics.set(day, t);
      }
      return t;
    },
  };
}
