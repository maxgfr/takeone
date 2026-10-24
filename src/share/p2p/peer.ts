/**
 * One WebRTC connection between the host and one viewer, carrying a single
 * negotiated, ordered DataChannel. The host always makes the offer, so there
 * is no glare to resolve and no renegotiation: if the connection fails, it is
 * dropped and the viewer reconnects and resumes from the bytes it has.
 *
 * ICE is not trickled: a description is only handed out once candidates are
 * gathered, so one signaling message carries everything. The remote SDP (and
 * so its DTLS fingerprint) arrives in an envelope signed by the peer's
 * identity, which the viewer checks against the host id pinned in the link.
 *
 * Adapted from veil (github.com/maxgfr/veil, MIT), src/mesh/peer.ts, without
 * the mesh, the perfect negotiation and the in-band handshake.
 */
import { CHANNEL } from "./protocol";

export type LinkState = "connecting" | "open" | "closed";

export interface Description {
  type: "offer" | "answer";
  sdp: string;
}

export interface LinkOptions {
  initiator: boolean;
  rtcConfig: RTCConfiguration;
  PC?: typeof RTCPeerConnection;
  gatherTimeoutMs?: number;
  /** Give up when the channel is not open after this long. */
  connectTimeoutMs?: number;
}

export interface LinkEvents {
  /** A local description to send through signaling. */
  signal(desc: Description): void;
  open(): void;
  message(data: string | ArrayBuffer): void;
  close(reason: string): void;
}

/** Backpressure: stop queueing above HIGH_WATER, resume once below LOW_WATER. */
export const HIGH_WATER = 4 * 1024 * 1024;
export const LOW_WATER = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 20_000;
const DISCONNECTED_GRACE_MS = 8000;

export class Link {
  readonly pc: RTCPeerConnection;
  readonly dc: RTCDataChannel;
  state: LinkState = "connecting";
  readonly createdAt = Date.now();
  private connectTimer: ReturnType<typeof setTimeout>;
  private downTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly o: LinkOptions,
    private readonly events: LinkEvents,
  ) {
    const PC = o.PC ?? RTCPeerConnection;
    this.pc = new PC({ bundlePolicy: "max-bundle", ...o.rtcConfig });
    this.dc = this.pc.createDataChannel(CHANNEL.label, {
      negotiated: true,
      id: CHANNEL.id,
      ordered: true,
    });
    this.dc.binaryType = "arraybuffer";
    this.dc.bufferedAmountLowThreshold = LOW_WATER;
    this.dc.onopen = () => {
      if (this.state !== "connecting") return;
      clearTimeout(this.connectTimer);
      this.state = "open";
      this.events.open();
    };
    this.dc.onmessage = (e) => {
      if (this.state === "open") this.events.message(e.data as string | ArrayBuffer);
    };
    this.dc.onclose = () => this.close("channel closed");
    this.pc.onconnectionstatechange = () => this.onConnectionState();
    this.connectTimer = setTimeout(
      () => this.close("timeout"),
      o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    );
    if (o.initiator) void this.offer();
  }

  get open(): boolean {
    return this.state === "open" && this.dc.readyState === "open";
  }

  /** The largest message the remote end accepts, when the browser says. */
  maxMessageSize(): number | null {
    return this.pc.sctp?.maxMessageSize ?? null;
  }

  private gathered(): Promise<void> {
    if (this.pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      };
      const check = () => {
        if (this.pc.iceGatheringState === "complete") done();
      };
      const timer = setTimeout(done, this.o.gatherTimeoutMs ?? 3000);
      this.pc.addEventListener("icegatheringstatechange", check);
    });
  }

  private async offer(): Promise<void> {
    try {
      await this.pc.setLocalDescription();
      await this.gathered();
      this.emitLocal();
    } catch {
      this.close("negotiation failed");
    }
  }

  private emitLocal(): void {
    const d = this.pc.localDescription;
    if (this.state === "closed" || !d || (d.type !== "offer" && d.type !== "answer")) return;
    this.events.signal({ type: d.type, sdp: d.sdp });
  }

  /** Applies the remote offer (viewer) or answer (host). */
  async acceptRemote(desc: Description): Promise<void> {
    if (this.state === "closed") return;
    try {
      if (desc.type === "offer") {
        if (this.o.initiator || this.pc.signalingState !== "stable") return;
        await this.pc.setRemoteDescription(desc);
        await this.pc.setLocalDescription();
        await this.gathered();
        this.emitLocal();
      } else {
        if (!this.o.initiator || this.pc.signalingState !== "have-local-offer") return;
        await this.pc.setRemoteDescription(desc);
      }
    } catch {
      this.close("negotiation failed");
    }
  }

  private onConnectionState(): void {
    const s = this.pc.connectionState;
    clearTimeout(this.downTimer);
    if (s === "failed" || s === "closed") this.close(s);
    // "disconnected" often heals by itself.
    else if (s === "disconnected")
      this.downTimer = setTimeout(() => this.close("disconnected"), DISCONNECTED_GRACE_MS);
  }

  /** Sends if the channel is open; false otherwise (or if the browser refused). */
  send(data: string | Uint8Array<ArrayBuffer>): boolean {
    if (!this.open) return false;
    try {
      if (typeof data === "string") this.dc.send(data);
      else this.dc.send(data);
      return true;
    } catch {
      this.close("send failed");
      return false;
    }
  }

  sendJson(msg: unknown): boolean {
    return this.send(JSON.stringify(msg));
  }

  /** Resolves when the outgoing buffer is below `high` bytes (or the link is gone). */
  async drain(high = HIGH_WATER): Promise<void> {
    while (this.open && this.dc.bufferedAmount > high) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, 1000);
        function done() {
          clearTimeout(t);
          resolve();
        }
        this.dc.addEventListener("bufferedamountlow", done, { once: true });
      });
    }
  }

  /** Closes now; with `lingerMs`, lets what was just sent (a bye) flush before tearing down. */
  close(reason = "closed", lingerMs = 0): void {
    if (this.state === "closed") return;
    this.state = "closed";
    clearTimeout(this.connectTimer);
    clearTimeout(this.downTimer);
    this.dc.onclose = null;
    this.dc.onmessage = null;
    this.pc.onconnectionstatechange = null;
    const teardown = () => {
      try {
        this.dc.close();
        this.pc.close();
      } catch {
        // Already gone.
      }
    };
    if (lingerMs > 0) setTimeout(teardown, lingerMs);
    else teardown();
    this.events.close(reason);
  }
}
