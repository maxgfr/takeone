/**
 * hostVideo and watchVideo together, in memory: an in-memory signaling bus
 * and fake RTCPeerConnections stand in for the network.
 */
import { describe, expect, test } from "bun:test";
import { FakePeerConnection } from "../../../test/fake-rtc";
import { MemoryBus } from "../../../test/memory-transport";
import { randomBytes } from "./crypto/bytes";
import { hostVideo } from "./host";
import type { VideoMeta } from "./protocol";
import type { ViewerState } from "./stats";
import { type WatchStatus, watchVideo } from "./watch";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(10);
  }
}

function setup() {
  const bus = new MemoryBus();
  const pcs: FakePeerConnection[] = [];
  class PC extends FakePeerConnection {
    constructor(c?: RTCConfiguration) {
      super(c);
      pcs.push(this);
    }
  }
  const net = {
    factory: bus.factory(),
    PC: PC as unknown as typeof RTCPeerConnection,
    iceServers: [],
  };
  return { bus, pcs, net };
}

function viewer(
  token: string,
  net: ReturnType<typeof setup>["net"],
  onProgress: (received: number) => void = () => {},
) {
  const got: { meta?: VideoMeta; blob?: Blob; progress: number[]; status: WatchStatus[] } = {
    progress: [],
    status: [],
  };
  const errors: Error[] = [];
  const handle = watchVideo(
    token,
    {
      onMeta: (m) => {
        got.meta = m;
      },
      onProgress: (r) => {
        got.progress.push(r);
        onProgress(r);
      },
      onReady: (b) => {
        got.blob = b;
      },
      onStatus: (s) => got.status.push(s),
      onError: (e) => errors.push(e),
    },
    net,
  );
  return { handle, got, errors };
}

describe("share link", () => {
  test("a viewer downloads the file byte for byte and its stats reach the host", async () => {
    const { net } = setup();
    const data = randomBytes(3 * 1024 * 1024 + 123);
    const file = new Blob([data], { type: "video/webm" });
    let viewers: ViewerState[] = [];
    const host = await hostVideo({
      file,
      meta: { title: "Demo", duration: 10, type: "video/webm", size: file.size },
      appUrl: "https://example.test/takeone/",
      onViewers: (v) => {
        viewers = v;
      },
      ...net,
    });
    expect(host.link).toMatch(/^https:\/\/example\.test\/takeone\/#\/watch\/[A-Za-z0-9_-]{58}$/);
    const token = host.link.split("#/watch/")[1] ?? "";

    const v = viewer(token, net);
    await until(() => v.got.blob !== undefined);
    expect(v.errors).toEqual([]);
    expect(v.got.meta?.title).toBe("Demo");
    expect(v.got.blob?.type).toBe("video/webm");
    expect(new Uint8Array(await (v.got.blob as Blob).arrayBuffer())).toEqual(data);
    expect(v.got.status.at(-1)?.phase).toBe("ready");

    v.handle.setName("  Ada ");
    v.handle.react("👍", 2);
    v.handle.react("💩", 2);
    v.handle.report(0, true);
    await wait(300);
    v.handle.report(0.3, true);
    v.handle.report(0.3, false);
    await until(() => viewers[0]?.name === "Ada" && viewers[0].playing === false);
    const s = viewers[0] as ViewerState;
    expect(s.connected).toBe(true);
    expect(s.downloaded).toBe(file.size);
    expect(s.reactions.map((r) => r.emoji)).toEqual(["👍"]);
    expect(s.position).toBeCloseTo(0.3);
    expect(s.watched).toBeCloseTo(0.3);

    v.handle.close();
    await until(() => viewers[0]?.connected === false);
    host.stop();
  });

  test("a dropped connection resumes from the bytes already received", async () => {
    const { net, pcs } = setup();
    const data = randomBytes(6 * 1024 * 1024);
    const file = new Blob([data], { type: "video/mp4" });
    const host = await hostVideo({
      file,
      meta: { title: "Big", duration: 60, type: "video/mp4", size: file.size },
      appUrl: "https://example.test/",
      onViewers: () => {},
      ...net,
    });
    // Cut the first connection as soon as the first bytes are in.
    let first: FakePeerConnection[] = [];
    const v = viewer(host.link, net, (received) => {
      if (first.length > 0 || received <= 0) return;
      first = pcs.slice();
      for (const pc of first) pc.channels[0]?.close();
    });
    await until(() => v.got.blob !== undefined, 15_000);
    expect(pcs.length).toBeGreaterThan(first.length);
    expect(new Uint8Array(await (v.got.blob as Blob).arrayBuffer())).toEqual(data);
    // Resumed, not restarted: the second connection carried less than the whole file.
    const second = pcs[first.length]?.channels[0]?.sentBytes ?? 0;
    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThan(data.length);
    v.handle.close();
    host.stop();
  }, 20_000);

  test("only the host pinned in the link may serve the video", async () => {
    const { net } = setup();
    const file = new Blob([randomBytes(1000)], { type: "video/mp4" });
    const meta = { title: "x", duration: 1, type: "video/mp4", size: 1000 };
    const real = await hostVideo({ file, meta, appUrl: "https://a/", onViewers: () => {}, ...net });
    real.stop();
    await wait(50);
    // Another tab hosts something else; a viewer of the first link must not get it.
    const other = await hostVideo({
      file,
      meta,
      appUrl: "https://a/",
      onViewers: () => {},
      ...net,
    });
    const v = viewer(real.link, net);
    await wait(500);
    expect(v.got.meta).toBeUndefined();
    v.handle.close();
    other.stop();
  });

  test("an invalid link reports an error", async () => {
    const { net } = setup();
    const v = viewer("not-a-token", net);
    await wait(10);
    expect(v.errors.length).toBe(1);
  });

  test("a file whose details do not validate cannot be shared", async () => {
    const { net } = setup();
    await expect(
      hostVideo({
        file: new Blob([new Uint8Array(10)]),
        meta: { title: "x", duration: -1, type: "video/mp4", size: 10 },
        appUrl: "https://a/",
        onViewers: () => {},
        ...net,
      }),
    ).rejects.toThrow();
  });
});
