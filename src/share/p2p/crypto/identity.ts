/**
 * Ephemeral Ed25519 identities. A peer id is a hash of the public key, so ids
 * are self-certifying: whoever signs an envelope with the key that hashes to
 * an id speaks for that id, and nobody else can. The share link carries the
 * host's peer id, which is how a viewer knows it talks to the author's tab and
 * not to another viewer holding the same link.
 *
 * Adapted from veil (github.com/maxgfr/veil, MIT), src/crypto/session.ts (the
 * identity part only: DTLS is enough for a link whose host is pinned).
 */
import { type Bytes, bytes, concat, sha256, toHex, utf8 } from "./bytes";

export interface Identity {
  peerId: string;
  edPub: Bytes;
  sign(data: Uint8Array): Promise<Bytes>;
}

export const PEER_ID_LENGTH = 20;

export async function peerIdOf(edPub: Uint8Array): Promise<string> {
  return toHex(await sha256(concat(utf8("takeone/id/v1"), edPub))).slice(0, PEER_ID_LENGTH);
}

export function isPeerId(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{20}$/.test(s);
}

export async function createIdentity(): Promise<Identity> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const edPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const peerId = await peerIdOf(edPub);
  return {
    peerId,
    edPub,
    async sign(data) {
      return new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, bytes(data)),
      );
    },
  };
}

const edKeyCache = new Map<string, Promise<CryptoKey>>();

export async function verifyEd25519(
  edPub: Uint8Array,
  sig: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  if (edPub.length !== 32 || sig.length !== 64) return false;
  const id = toHex(edPub);
  let key = edKeyCache.get(id);
  if (!key) {
    key = crypto.subtle.importKey("raw", bytes(edPub), { name: "Ed25519" }, false, ["verify"]);
    edKeyCache.set(id, key);
    if (edKeyCache.size > 4096) edKeyCache.delete(edKeyCache.keys().next().value as string);
  }
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, await key, bytes(sig), bytes(data));
  } catch {
    return false;
  }
}
