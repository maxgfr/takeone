/**
 * Default public rendezvous endpoints (overridable, see share/p2p/config.ts).
 *
 * Copied from veil (github.com/maxgfr/veil, MIT), src/signal/defaults.ts.
 */
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.mom",
];

export const DEFAULT_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
];
