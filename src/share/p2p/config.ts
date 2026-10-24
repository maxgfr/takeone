/**
 * Network settings for a share: which Nostr relays and WebTorrent trackers
 * introduce the peers, and which STUN servers help them through NAT. The
 * defaults are public; `localStorage["takeone.p2p.v1"]` may override them
 * (`{ relays?, trackers?, stun? }`), which is how a self-hoster points at
 * their own relay and how the end-to-end tests stay off the public network.
 * Every URL is validated: secure WebSockets, or plain ones on localhost.
 */
import { z } from "zod";
import { DEFAULT_RELAYS, DEFAULT_TRACKERS } from "./signal/defaults";
import type { SignalConfig, TransportFactory } from "./signal/mux";

export const DEFAULT_STUN = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];
export const STORAGE_KEY = "takeone.p2p.v1";

const wsUrl = z
  .string()
  .max(300)
  .regex(/^(wss:\/\/[^\s/?#]+|ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/[^\s#]*)?$/);
const stunUrl = z
  .string()
  .max(300)
  .regex(/^stuns?:[^\s/?#]+$/);

const overrideSchema = z.object({
  relays: z.array(wsUrl).max(16).optional(),
  trackers: z.array(wsUrl).max(16).optional(),
  stun: z.array(stunUrl).max(8).optional(),
});

export interface NetConfig {
  signal: SignalConfig;
  iceServers: RTCIceServer[];
}

/** Optional overrides for hostVideo and watchVideo (tests inject in-memory doubles here). */
export interface NetOptions {
  signal?: SignalConfig;
  iceServers?: RTCIceServer[];
  factory?: TransportFactory;
  PC?: typeof RTCPeerConnection;
}

export function parseOverride(raw: string | null): z.infer<typeof overrideSchema> {
  if (!raw) return {};
  try {
    const r = overrideSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : {};
  } catch {
    return {};
  }
}

export function loadNetConfig(raw: string | null = readStorage()): NetConfig {
  const o = parseOverride(raw);
  const relays = o.relays ?? DEFAULT_RELAYS;
  const trackers = o.trackers ?? DEFAULT_TRACKERS;
  const stun = o.stun ?? DEFAULT_STUN;
  return {
    signal: {
      nostr: { enabled: relays.length > 0, relays },
      torrent: { enabled: trackers.length > 0, trackers },
    },
    iceServers: stun.length > 0 ? [{ urls: stun }] : [],
  };
}

function readStorage(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
