// Adapted from veil (github.com/maxgfr/veil, MIT): src/crypto/session.test.ts.
import { describe, expect, test } from "bun:test";
import { utf8 } from "./bytes";
import { createIdentity, isPeerId, peerIdOf, verifyEd25519 } from "./identity";

describe("identity", () => {
  test("peer ids are a hash of the identity key", async () => {
    const id = await createIdentity();
    expect(id.peerId).toMatch(/^[0-9a-f]{20}$/);
    expect(isPeerId(id.peerId)).toBe(true);
    expect(await peerIdOf(id.edPub)).toBe(id.peerId);
    expect(isPeerId("not-a-peer-id")).toBe(false);
  });

  test("signatures verify with the right key only", async () => {
    const a = await createIdentity();
    const b = await createIdentity();
    const sig = await a.sign(utf8("hello"));
    expect(await verifyEd25519(a.edPub, sig, utf8("hello"))).toBe(true);
    expect(await verifyEd25519(a.edPub, sig, utf8("hellO"))).toBe(false);
    expect(await verifyEd25519(b.edPub, sig, utf8("hello"))).toBe(false);
    expect(await verifyEd25519(a.edPub, sig.slice(1), utf8("hello"))).toBe(false);
  });
});
