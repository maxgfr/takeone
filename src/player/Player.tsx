/**
 * takeone's player, for exported HTML files and shared links: the video with
 * its own controls, chapters on the progress bar and in a list, captions
 * drawn from the words (the word being said lights up), a transcript you can
 * search and click to jump, playback speed, and keyboard shortcuts. It is
 * self-contained so it can be inlined into one HTML file.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

export interface PlayerWord {
  text: string;
  start: number;
  end: number;
}

export interface PlayerData {
  title: string;
  src: string;
  duration: number;
  words: PlayerWord[];
  chapters: { t: number; title: string }[];
  /** Other languages' captions, as timed lines. */
  translations?: Record<string, PlayerWord[]>;
  poster?: string;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Caption lines: words grouped by sentence, at most ~9 words a line, two lines at most. */
function captionGroups(words: readonly PlayerWord[]): PlayerWord[][] {
  const groups: PlayerWord[][] = [];
  let cur: PlayerWord[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    const end = /[.!?…。！？,;:]$/.test(w.text);
    if (!next || cur.length >= 14 || (end && cur.length >= 4) || next.start - w.end > 0.8) {
      groups.push(cur);
      cur = [];
    }
  });
  return groups;
}

function Icon({ d, filled }: { d: string; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      class={filled ? "tp-filled" : ""}
    >
      <path d={d} />
    </svg>
  );
}

const PATHS = {
  play: "M7 5v14l12-7z",
  pause: "M8 5v14M16 5v14",
  full: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  cc: "M3 6h18v12H3zM10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3",
};

export function Player({ data, embed = false }: { data: PlayerData; embed?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const transcriptBox = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(data.duration);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [captions, setCaptions] = useState(true);
  const [lang, setLang] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<number | null>(null);

  const shown = lang && data.translations?.[lang] ? data.translations[lang] : data.words;
  const groups = useMemo(() => captionGroups(shown), [shown]);
  const group = groups.find((g) => {
    const a = g[0];
    const b = g[g.length - 1];
    return a && b && time >= a.start - 0.1 && time <= b.end + 0.4;
  });
  const chapter = [...data.chapters].reverse().find((c) => c.t <= time + 0.05);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const tick = () => setTime(v.currentTime);
    const meta = () => Number.isFinite(v.duration) && setDuration(v.duration);
    const on = () => setPlaying(!v.paused);
    v.addEventListener("timeupdate", tick);
    v.addEventListener("seeked", tick);
    v.addEventListener("loadedmetadata", meta);
    v.addEventListener("play", on);
    v.addEventListener("pause", on);
    let raf = 0;
    const loop = () => {
      if (!v.paused) setTime(v.currentTime);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("timeupdate", tick);
      v.removeEventListener("seeked", tick);
      v.removeEventListener("loadedmetadata", meta);
      v.removeEventListener("play", on);
      v.removeEventListener("pause", on);
    };
  }, []);

  const seek = (t: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration || data.duration, t));
    setTime(v.currentTime);
  };
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };
  const fullscreen = () => {
    const el = box.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  useEffect(() => {
    const target: HTMLElement | Window = embed ? window : (box.current ?? window);
    const onKey = (e: Event) => {
      const k = e as KeyboardEvent;
      if ((k.target as HTMLElement)?.closest?.("input, select, textarea")) return;
      const v = video.current;
      if (!v) return;
      const map: Record<string, () => void> = {
        " ": toggle,
        k: toggle,
        ArrowLeft: () => seek(v.currentTime - 5),
        ArrowRight: () => seek(v.currentTime + 5),
        j: () => seek(v.currentTime - 10),
        l: () => seek(v.currentTime + 10),
        f: fullscreen,
        c: () => setCaptions((c) => !c),
      };
      const fn = map[k.key];
      if (fn) {
        k.preventDefault();
        fn();
      }
    };
    target.addEventListener("keydown", onKey);
    return () => target.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (video.current) video.current.playbackRate = speed;
  }, [speed]);

  // Keep the word being said in view in the transcript.
  useEffect(() => {
    if (!playing) return;
    transcriptBox.current?.querySelector(".tp-w.is-now")?.scrollIntoView({ block: "nearest" });
  }, [Math.floor(time * 2), playing]);

  const total = duration || data.duration || 1;
  const pct = (t: number) => `${(t / total) * 100}%`;
  const q = query.trim().toLowerCase();
  const matches = q ? data.words.filter((w) => w.text.toLowerCase().includes(q)).length : 0;
  const paras = useMemo(
    () =>
      captionGroups(data.words).reduce<PlayerWord[][]>((acc, g) => {
        const last = acc[acc.length - 1];
        if (last && last.length < 40) last.push(...g);
        else acc.push([...g]);
        return acc;
      }, []),
    [data.words],
  );

  return (
    <div class={`tp ${embed ? "tp-embed" : ""}`} ref={box} tabIndex={-1}>
      <div class="tp-stage">
        {/* Captions are drawn by the player, from the words. */}
        <video
          ref={video}
          class="tp-video"
          src={data.src}
          poster={data.poster}
          playsInline
          preload="metadata"
          onClick={toggle}
        />
        {captions && group && (
          <div class="tp-caption" aria-live="off">
            {group.map((w, i) => (
              <span key={i} class={time >= w.start && time < w.end + 0.05 ? "is-now" : ""}>
                {w.text}{" "}
              </span>
            ))}
          </div>
        )}
        {!playing && time < 0.05 && (
          <button type="button" class="tp-big-play" aria-label="Play" onClick={toggle}>
            <Icon d={PATHS.play} filled />
          </button>
        )}
        <div class="tp-controls">
          <button
            type="button"
            class="tp-btn"
            aria-label={playing ? "Pause" : "Play"}
            onClick={toggle}
          >
            <Icon d={playing ? PATHS.pause : PATHS.play} filled={!playing} />
          </button>
          <span class="tp-time">
            {clock(time)} / {clock(total)}
          </span>
          <div
            class="tp-bar"
            role="slider"
            tabIndex={0}
            aria-label="Position"
            aria-valuemin={0}
            aria-valuemax={Math.round(total)}
            aria-valuenow={Math.round(time)}
            aria-valuetext={`${clock(time)}${chapter ? `, ${chapter.title}` : ""}`}
            onPointerDown={(e) => {
              const el = e.currentTarget as HTMLElement;
              const at = (x: number) => {
                const r = el.getBoundingClientRect();
                return ((x - r.left) / r.width) * total;
              };
              seek(at(e.clientX));
              el.setPointerCapture(e.pointerId);
              const move = (ev: PointerEvent) => seek(at(ev.clientX));
              const up = () => {
                el.removeEventListener("pointermove", move);
                el.removeEventListener("pointerup", up);
              };
              el.addEventListener("pointermove", move);
              el.addEventListener("pointerup", up);
            }}
            onPointerMove={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setHover(((e.clientX - r.left) / r.width) * total);
            }}
            onPointerLeave={() => setHover(null)}
          >
            <div class="tp-fill" style={{ width: pct(time) }} />
            {data.chapters.map((c) => (
              <span key={c.t} class="tp-mark" style={{ left: pct(c.t) }} />
            ))}
            {hover !== null && (
              <span class="tp-tip" style={{ left: pct(hover) }}>
                {clock(hover)}
                {[...data.chapters].reverse().find((c) => c.t <= hover)?.title
                  ? ` · ${[...data.chapters].reverse().find((c) => c.t <= hover)?.title}`
                  : ""}
              </span>
            )}
          </div>
          <select
            class="tp-select"
            aria-label="Speed"
            value={speed}
            onChange={(e) => setSpeed(Number(e.currentTarget.value))}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
          {data.words.length > 0 && (
            <button
              type="button"
              class={`tp-btn ${captions ? "is-on" : ""}`}
              aria-label="Captions"
              aria-pressed={captions}
              onClick={() => setCaptions((c) => !c)}
            >
              <Icon d={PATHS.cc} />
            </button>
          )}
          {data.translations && Object.keys(data.translations).length > 0 && (
            <select
              class="tp-select"
              aria-label="Caption language"
              value={lang ?? ""}
              onChange={(e) => setLang(e.currentTarget.value || null)}
            >
              <option value="">Original</option>
              {Object.keys(data.translations).map((l) => (
                <option key={l} value={l}>
                  {l.toUpperCase()}
                </option>
              ))}
            </select>
          )}
          <button type="button" class="tp-btn" aria-label="Full screen" onClick={fullscreen}>
            <Icon d={PATHS.full} />
          </button>
        </div>
      </div>
      {!embed && (
        <div class="tp-side">
          <h1 class="tp-title">{data.title}</h1>
          {data.chapters.length > 0 && (
            <ol class="tp-chapters" aria-label="Chapters">
              {data.chapters.map((c) => (
                <li key={c.t}>
                  <button
                    type="button"
                    class={chapter === c ? "is-now" : ""}
                    onClick={() => {
                      seek(c.t);
                      void video.current?.play();
                    }}
                  >
                    <span class="tp-ch-time">{clock(c.t)}</span> {c.title}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {data.words.length > 0 && (
            <section class="tp-transcript" aria-label="Transcript">
              <input
                class="tp-search"
                type="search"
                placeholder="Search the transcript"
                aria-label="Search the transcript"
                value={query}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
              {q && (
                <p class="tp-found">
                  {matches} match{matches === 1 ? "" : "es"}
                </p>
              )}
              <div class="tp-words" ref={transcriptBox}>
                {paras.map((para, pi) => (
                  <p key={pi}>
                    <button type="button" class="tp-ts" onClick={() => seek(para[0]?.start ?? 0)}>
                      {clock(para[0]?.start ?? 0)}
                    </button>{" "}
                    {para.map((w, i) => (
                      // biome-ignore lint/a11y/useKeyWithClickEvents: each paragraph has a time button for keyboards
                      // biome-ignore lint/a11y/noStaticElementInteractions: words stay text so they can be selected
                      <span
                        key={i}
                        class={`tp-w${time >= w.start && time < w.end + 0.05 ? " is-now" : ""}${q && w.text.toLowerCase().includes(q) ? " is-match" : ""}`}
                        onClick={() => seek(w.start)}
                      >
                        {w.text}{" "}
                      </span>
                    ))}
                  </p>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
