/**
 * Peer-to-peer share links: the author's tab serves an exported video to
 * whoever opens the link, over WebRTC, and sees live viewer stats. Relays and
 * trackers only introduce the peers (with sealed, signed envelopes); the
 * video itself goes straight from tab to tab.
 */
export type { NetOptions } from "./config";
export { type HostHandle, type HostOptions, type HostStatus, hostVideo } from "./host";
export { type Chapter, EMOJIS, type Emoji, MAX_FILE_SIZE, type VideoMeta } from "./protocol";
export type { TransportStatus } from "./signal/types";
export {
  formatBytes,
  formatTime,
  type Reaction,
  type Summary,
  summarize,
  type ViewerState,
  viewerLabel,
} from "./stats";
export { decodeToken } from "./token";
export {
  type WatchHandle,
  type WatchHandlers,
  type WatchPhase,
  type WatchStatus,
  watchVideo,
} from "./watch";
