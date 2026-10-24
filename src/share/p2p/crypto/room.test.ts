// Adapted from veil (github.com/maxgfr/veil, MIT): src/crypto/room.test.ts.
import { describe, expect, test } from "bun:test";
import { open, seal } from "./aead";
import { fromHex, toHex, utf8 } from "./bytes";
import { deriveRoomSecrets, hkdf, newRoomKey, utcDay } from "./room";

describe("room", () => {
  test("HKDF-SHA256 matches RFC 5869 test case 1", async () => {
    const okm = await hkdf(
      fromHex("0b".repeat(22)),
      fromHex("000102030405060708090a0b0c"),
      fromHex("f0f1f2f3f4f5f6f7f8f9"),
      42,
    );
    expect(toHex(okm)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });

  test("derivation is deterministic, the topic rotates daily, the key does not", async () => {
    const key = newRoomKey();
    const d = utcDay(Date.UTC(2026, 9, 12, 12));
    const a = await deriveRoomSecrets(key);
    const b = await deriveRoomSecrets(key);
    expect(await a.topic(d)).toEqual(await b.topic(d));
    expect(await a.topic(d)).not.toEqual(await a.topic(d + 1));
    const sealed = await seal(a.sigKey, utf8("x"));
    expect(await open(b.sigKey, sealed)).toEqual(utf8("x"));
    const other = await deriveRoomSecrets(newRoomKey());
    expect(await other.topic(d)).not.toEqual(await a.topic(d));
    await expect(open(other.sigKey, sealed)).rejects.toThrow();
  });

  test("a key of the wrong size is refused", async () => {
    await expect(deriveRoomSecrets(new Uint8Array(16))).rejects.toThrow();
  });

  test("utcDay changes at UTC midnight", () => {
    expect(utcDay(Date.UTC(2026, 0, 2, 0, 0, 0)) - utcDay(Date.UTC(2026, 0, 1, 23, 59, 59))).toBe(
      1,
    );
  });
});
