/**
 * The watch page (`#/watch/<token>`): finds the author's tab, downloads the
 * video from it peer to peer, then plays it. What the viewer does (position,
 * play/pause, reactions, an optional name) goes back to the author, who sees
 * it live. A richer player replaces the plain <video> later.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import {
  EMOJIS,
  formatBytes,
  formatTime,
  type VideoMeta,
  type WatchHandle,
  type WatchStatus,
  watchVideo,
} from "../share/p2p";
import { errorText, Field } from "./ui";

const NAME_KEY = "takeone.viewer.name";

const EMOJI_LABELS: Record<string, string> = {
  "👍": "Thumbs up",
  "❤️": "Love",
  "😂": "Funny",
  "😮": "Surprised",
  "👏": "Applause",
  "🎉": "Celebrate",
};

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveName(name: string): void {
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
    else localStorage.removeItem(NAME_KEY);
  } catch {
    // Storage may be unavailable (private mode): the name still goes to the author.
  }
}

function statusText(s: WatchStatus | null, now: number): string {
  if (!s || s.phase === "searching") {
    if (s?.hostGone) return "The author stopped sharing this video.";
    if (s && now - s.since > 20_000)
      return "Still looking for the author's tab. It may be closed: this link only works while it is open.";
    return "Looking for the author's tab…";
  }
  if (s.phase === "connecting") return "Connecting to the author's tab…";
  if (s.phase === "downloading") return "Downloading from the author's tab…";
  if (s.phase === "ready") return "";
  return "Disconnected.";
}

export function Watch({ room }: { room: string }) {
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [progress, setProgress] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(loadName);
  const [sent, setSent] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const handle = useRef<WatchHandle | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    const h = watchVideo(room, {
      onMeta: setMeta,
      onProgress: (received) => setProgress(received),
      onReady: (blob) => {
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      },
      onStatus: setStatus,
      onError: (err) => setError(errorText(err)),
    });
    handle.current = h;
    const initial = loadName();
    if (initial) h.setName(initial);
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      clearInterval(tick);
      h.close();
      handle.current = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [room]);

  useEffect(() => {
    if (meta) document.title = `${meta.title || "Shared video"} · takeone`;
    return () => {
      document.title = "takeone";
    };
  }, [meta]);

  const report = () => {
    const v = video.current;
    if (v) handle.current?.report(v.currentTime, !v.paused && !v.ended);
  };

  const react = (emoji: string) => {
    handle.current?.react(emoji, video.current?.currentTime ?? 0);
    setSent(emoji);
    setTimeout(() => setSent((s) => (s === emoji ? null : s)), 1500);
  };

  const commitName = (value: string) => {
    const clean = value.trim().slice(0, 40);
    saveName(clean);
    handle.current?.setName(clean);
  };

  const total = meta?.size ?? 0;
  const pct = total > 0 ? Math.floor((progress / total) * 100) : 0;
  const text = statusText(status, now);
  const live = status?.connected ?? false;

  return (
    <main class="watch">
      <header class="watch-head">
        <h1>{meta?.title || "Shared video"}</h1>
        {meta && (
          <p class="muted small">
            {meta.duration > 0 && <>{formatTime(meta.duration)} · </>}
            {formatBytes(meta.size)} · streamed from the author's browser
          </p>
        )}
      </header>

      {error ? (
        <p class="watch-error error" role="alert">
          {error}
        </p>
      ) : url ? (
        <div class="watch-player">
          <video
            ref={video}
            src={url}
            controls
            playsInline
            preload="metadata"
            data-testid="watch-video"
            onPlay={report}
            onPause={report}
            onSeeked={report}
            onEnded={report}
            onTimeUpdate={report}
          />
        </div>
      ) : (
        <div class="watch-wait">
          {status?.hostGone ? null : <div class="spinner" aria-hidden="true" />}
          <p role="status" aria-live="polite">
            {text}
          </p>
          {meta && (
            <div class="watch-progress">
              <progress
                max={total}
                value={progress}
                aria-label={`Downloaded ${pct}%`}
                data-testid="watch-progress"
              />
              <span class="small muted">
                {pct}% · {formatBytes(progress)} of {formatBytes(total)}
              </span>
            </div>
          )}
        </div>
      )}

      {!error && (
        <section class="watch-side" aria-label="Your feedback">
          <fieldset class="reactions" disabled={!url}>
            <legend class="field-label">React at this moment</legend>
            <div class="row">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  class={`reaction ${sent === e ? "is-sent" : ""}`}
                  aria-label={EMOJI_LABELS[e] ?? e}
                  title={EMOJI_LABELS[e] ?? e}
                  onClick={() => react(e)}
                >
                  <span aria-hidden="true">{e}</span>
                </button>
              ))}
            </div>
            <span class="small muted" role="status" aria-live="polite">
              {sent ? (live ? "Sent to the author." : "Will be sent when the author is back.") : ""}
            </span>
          </fieldset>
          <Field label="Your name (optional)" hint="Shown to the author next to what you watched.">
            <input
              class="input"
              type="text"
              maxLength={40}
              autoComplete="name"
              value={name}
              data-testid="watch-name"
              onInput={(e) => setName(e.currentTarget.value)}
              onChange={(e) => commitName(e.currentTarget.value)}
            />
          </Field>
          {meta?.chapters && meta.chapters.length > 0 && url && (
            <nav class="watch-chapters" aria-label="Chapters">
              <h2 class="field-label">Chapters</h2>
              <ol>
                {meta.chapters.map((c) => (
                  <li key={`${c.t}-${c.title}`}>
                    <button
                      type="button"
                      class="link-btn"
                      onClick={() => {
                        const v = video.current;
                        if (v) v.currentTime = c.t;
                      }}
                    >
                      <span class="mono">{formatTime(c.t)}</span> {c.title}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          )}
        </section>
      )}

      <p class="watch-note muted small">
        This video comes straight from its author's browser, peer to peer. Nothing is uploaded to a
        server; relays only help the two browsers find each other.
      </p>
    </main>
  );
}
