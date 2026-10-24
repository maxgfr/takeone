import { describe, expect, test } from "bun:test";
import {
  applyReaction,
  applyStats,
  createViewer,
  formatTime,
  MAX_REACTIONS,
  RateLimit,
  setConnected,
  summarize,
  viewerLabel,
} from "./stats";

const T0 = 1_000_000;

describe("viewer stats", () => {
  test("a report updates position, furthest point, play state and download", () => {
    let v = createViewer("a", T0);
    v = applyStats(
      v,
      { got: 500, pos: 4, playing: true, watched: 3 },
      { now: T0 + 4000, duration: 60, sent: 1000, since: T0 },
    );
    expect(v).toMatchObject({ downloaded: 500, position: 4, furthest: 4, watched: 3 });
    expect(v.playing).toBe(true);
    expect(v.lastSeen).toBe(T0 + 4000);
    // Seeking back keeps the furthest point.
    v = applyStats(
      v,
      { got: 900, pos: 1, playing: false, watched: 3.5 },
      { now: T0 + 6000, duration: 60, sent: 1000, since: T0 + 4000 },
    );
    expect(v).toMatchObject({ position: 1, furthest: 4, watched: 3.5, playing: false });
  });

  test("claims are clamped to what the host knows", () => {
    const v = applyStats(
      createViewer("a", T0),
      { got: 10_000, pos: 999, playing: true, watched: 500 },
      { now: T0 + 2000, duration: 60, sent: 1000, since: T0 },
    );
    // Cannot have more bytes than were sent, be past the end, or have watched
    // more than 2 s × the fastest playback rate (+ slack) allows.
    expect(v.downloaded).toBe(1000);
    expect(v.position).toBe(60);
    expect(v.watched).toBe(10);
  });

  test("watched time and downloaded bytes never go backwards", () => {
    let v = createViewer("a", T0);
    const ctx = { now: T0 + 5000, duration: 60, sent: 1000, since: T0 };
    v = applyStats(v, { got: 800, pos: 5, playing: true, watched: 5 }, ctx);
    v = applyStats(v, { got: 100, pos: 6, playing: true, watched: 1 }, { ...ctx, now: T0 + 6000 });
    expect(v.watched).toBe(5);
    expect(v.downloaded).toBe(800);
  });

  test("reactions are clamped to the video and capped in number", () => {
    let v = createViewer("a", T0);
    v = applyReaction(v, "👍", 75, T0 + 1, 60);
    expect(v.reactions).toEqual([{ emoji: "👍", at: 60, ts: T0 + 1 }]);
    for (let i = 0; i < MAX_REACTIONS + 10; i++) v = applyReaction(v, "🎉", 1, T0 + i, 60);
    expect(v.reactions.length).toBe(MAX_REACTIONS);
    expect(v.reactions[0]?.emoji).toBe("🎉");
  });

  test("a disconnected viewer is not playing and keeps where it left", () => {
    let v = applyStats(
      createViewer("a", T0),
      { got: 0, pos: 30, playing: true, watched: 0 },
      { now: T0, duration: 60, sent: 0, since: T0 },
    );
    v = setConnected(v, false, T0 + 10);
    expect(v).toMatchObject({ connected: false, playing: false, position: 30 });
  });

  test("labels and summary", () => {
    const a = { ...createViewer("a", T0), name: "Ada", furthest: 60, connected: false };
    const b = { ...createViewer("b", T0 + 1), furthest: 30 };
    const c = applyReaction(createViewer("c", T0 + 2), "👍", 1, T0, 60);
    const all = [c, b, a];
    expect(viewerLabel(all, a)).toBe("Ada");
    expect(viewerLabel(all, b)).toBe("Viewer 2");
    expect(viewerLabel(all, c)).toBe("Viewer 3");
    const s = summarize(all, 60);
    expect(s).toMatchObject({ total: 3, watching: 2, finished: 1, reactions: { "👍": 1 } });
    expect(s.averageReach).toBeCloseTo(0.5);
    expect(summarize([], 60).averageReach).toBe(0);
    // A short video: not having started is not having finished.
    const fresh = createViewer("d", T0);
    expect(summarize([fresh], 2).finished).toBe(0);
    expect(summarize([{ ...fresh, furthest: 1.95 }], 2).finished).toBe(1);
    expect(summarize([{ ...fresh, furthest: 1.5 }], 2).finished).toBe(0);
  });
});

describe("rate limit", () => {
  test("allows a burst, then refills at the given rate", () => {
    let t = 0;
    const rl = new RateLimit(2, 3, () => t);
    expect([rl.take(), rl.take(), rl.take(), rl.take()]).toEqual([true, true, true, false]);
    t += 500;
    expect([rl.take(), rl.take()]).toEqual([true, false]);
    t += 60_000;
    expect([rl.take(), rl.take(), rl.take(), rl.take()]).toEqual([true, true, true, false]);
  });
});

test("formatTime", () => {
  expect(formatTime(0)).toBe("0:00");
  expect(formatTime(65.9)).toBe("1:05");
  expect(formatTime(3725)).toBe("1:02:05");
  expect(formatTime(Number.NaN)).toBe("0:00");
});
