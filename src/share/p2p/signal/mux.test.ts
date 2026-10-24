// Adapted from veil (github.com/maxgfr/veil, MIT): src/signal/mux.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { serveApp } from "../../../../test/serve";
import { createIdentity } from "../crypto/identity";
import { deriveRoomSecrets, newRoomKey } from "../crypto/room";
import { RoomSignaling, type SignalConfig } from "./mux";
import type { SignalMessage, TransportName } from "./types";

const server = serveApp({ port: 0, dir: "/nonexistent" });
afterAll(() => server.stop());
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CONFIG: SignalConfig = {
  nostr: { enabled: true, relays: [`ws://localhost:${server.port}/relay`] },
  torrent: { enabled: true, trackers: [`ws://localhost:${server.port}/tracker`] },
};

const SDP = "v=0\r\no=- 46117 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:sha-256 0A:1B:2C\r\n";

async function peer(key: Uint8Array, config = CONFIG) {
  const identity = await createIdentity();
  const got: { msg: SignalMessage; via: TransportName }[] = [];
  const s = new RoomSignaling(
    { secrets: await deriveRoomSecrets(key), identity, config },
    { onMessage: (msg, via) => got.push({ msg, via }), onStatus: () => {} },
  );
  await s.start();
  return { s, got };
}

describe("room signaling", () => {
  test("an envelope sent on every transport is delivered exactly once", async () => {
    const key = newRoomKey();
    const a = await peer(key);
    const b = await peer(key);
    await wait(150);
    await a.s.send({ kind: "hello" });
    await wait(200);
    expect(b.got.length).toBe(1);
    expect(b.got[0]?.msg.kind).toBe("hello");
    expect(a.got.length).toBe(0);
    await b.s.send({ kind: "offer", to: a.s.peerId, sdp: SDP });
    await wait(200);
    expect(a.got.map((g) => g.msg.sdp)).toEqual([SDP]);
    a.s.stop();
    b.s.stop();
  });

  test("other rooms and other recipients are ignored", async () => {
    const key = newRoomKey();
    const a = await peer(key);
    const b = await peer(key);
    const intruder = await peer(newRoomKey());
    await wait(150);
    await a.s.send({ kind: "offer", to: "eeeeeeeeeeeeeeeeeeee", sdp: SDP });
    await intruder.s.send({ kind: "hello" });
    await wait(200);
    expect(b.got).toEqual([]);
    for (const x of [a, b, intruder]) x.s.stop();
  });

  test("relays and trackers only ever see ciphertext", async () => {
    const key = newRoomKey();
    const a = await peer(key);
    await wait(100);
    await a.s.send({ kind: "offer", sdp: SDP, session: "marker-session-0123456789" });
    await wait(100);
    const seen = JSON.stringify([server.relay.seen, server.tracker.seen]);
    expect(seen).not.toContain("fingerprint");
    expect(seen).not.toContain("marker-session");
    a.s.stop();
  });
});
