import { describe, expect, test } from "bun:test";
import { loadNetConfig } from "./config";
import { newRoomKey } from "./crypto/room";
import { DEFAULT_RELAYS } from "./signal/defaults";
import { decodeToken, encodeToken, TOKEN_LENGTH, watchLink } from "./token";

const HOST = "0123456789abcdef0123";

describe("token", () => {
  test("round-trips through a link, whatever the app URL's fragment", () => {
    const key = newRoomKey();
    const token = encodeToken({ key, host: HOST });
    expect(token.length).toBe(TOKEN_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    const link = watchLink("https://maxgfr.github.io/takeone/#/edit/abc", token);
    expect(link).toBe(`https://maxgfr.github.io/takeone/#/watch/${token}`);
    for (const input of [token, link, `#/watch/${token}`, ` ${token} `]) {
      const got = decodeToken(input);
      expect(got?.key).toEqual(key);
      expect(got?.host).toBe(HOST);
    }
  });

  test("junk, truncated and wrong-version tokens are refused", () => {
    const token = encodeToken({ key: newRoomKey(), host: HOST });
    expect(decodeToken(token.slice(1))).toBeNull();
    expect(decodeToken(`${token}A`)).toBeNull();
    expect(decodeToken(`B${token.slice(1)}`)).toBeNull();
    expect(decodeToken("a".repeat(TOKEN_LENGTH))).toBeNull();
    expect(decodeToken("")).toBeNull();
    expect(decodeToken(`${token.slice(0, -1)}!`)).toBeNull();
  });

  test("encoding refuses a bad room", () => {
    expect(() => encodeToken({ key: new Uint8Array(8), host: HOST })).toThrow();
    expect(() => encodeToken({ key: newRoomKey(), host: "nope" })).toThrow();
  });
});

describe("network config", () => {
  test("defaults to public relays, trackers and STUN", () => {
    const c = loadNetConfig(null);
    expect(c.signal.nostr.relays).toEqual(DEFAULT_RELAYS);
    expect(c.signal.torrent.enabled).toBe(true);
    expect(c.iceServers.length).toBe(1);
  });

  test("a valid override replaces them; an invalid one is ignored", () => {
    const local = loadNetConfig(
      JSON.stringify({ relays: ["ws://localhost:4186/relay"], trackers: [], stun: [] }),
    );
    expect(local.signal.nostr.relays).toEqual(["ws://localhost:4186/relay"]);
    expect(local.signal.torrent.enabled).toBe(false);
    expect(local.iceServers).toEqual([]);
    // Plain ws:// is only allowed to localhost; anything else falls back to the defaults.
    expect(
      loadNetConfig(JSON.stringify({ relays: ["ws://evil.example/relay"] })).signal.nostr.relays,
    ).toEqual(DEFAULT_RELAYS);
    expect(loadNetConfig("{not json").signal.nostr.relays).toEqual(DEFAULT_RELAYS);
  });
});
