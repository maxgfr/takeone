/**
 * Recording a take: pick the sources (screen with its sound, a camera, a
 * microphone, whose voice may serve only for the transcript), optionally
 * write a script for the teleprompter, then a
 * countdown and the take itself. The controls and the teleprompter can float
 * over other windows (Document Picture-in-Picture); a shared tab does not
 * show them.
 */
import { signal, useSignal } from "@preact/signals";
import { render } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { finalizeClip } from "../capture/finalize";
import { levelMeter, listDevices, openCamera, openMic } from "../capture/media";
import { openSources, RecordingSession } from "../capture/session";
import { suggestZooms } from "../edit/zooms";
import { type Clip, emptyProject } from "../model/project";
import { getProject, saveProject } from "../model/store";
import { navigate } from "./router";
import { Button, errorText, Field, Icon, toast } from "./ui";

type Status = "setup" | "opening" | "countdown" | "recording" | "saving";

const status = signal<Status>("setup");
const count = signal(3);
const paused = signal(false);
const elapsed = signal(0);
let session: RecordingSession | null = null;
let pipWindow: Window | null = null;
let ticker: ReturnType<typeof setInterval> | undefined;

const SCRIPT_KEY = "takeone-script";
const PREFS_KEY = "takeone-sources";

interface Prefs {
  screen: boolean;
  screenAudio: boolean;
  camera: string | null;
  mic: string | null;
  /** The voice is recorded for its text only: the take starts muted. */
  voiceForText: boolean;
  prompter: boolean;
  wpm: number;
}
const DEFAULT_PREFS: Prefs = {
  screen: true,
  screenAudio: true,
  camera: null,
  mic: "",
  voiceForText: false,
  prompter: false,
  wpm: 140,
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function saveLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembered; the choice holds for this session.
  }
}

/** The microphone chosen for the takes ("" the default one, null none), for a voice-over. */
export function chosenMic(): string | null {
  return load(PREFS_KEY, DEFAULT_PREFS).mic;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

interface DocumentPip {
  requestWindow(opts: { width: number; height: number }): Promise<Window>;
}
const docPip = (): DocumentPip | undefined =>
  (globalThis as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;

function togglePause(): void {
  if (!session) return;
  if (session.paused) session.resume();
  else session.pause();
  paused.value = session.paused;
}

/** Adds the take to its project (a new one unless a project was given) and opens the editor. */
async function keep(clip: Clip, s: RecordingSession, title: string): Promise<string> {
  // The take's files were written under the session's project id: a new project takes it.
  const existing = await getProject(s.projectId);
  const p = existing ?? { ...emptyProject(title), id: s.projectId };
  // Zooms where the screen changed, ready to keep or remove.
  const next = { ...p, clips: [...p.clips, clip], zooms: [...p.zooms, ...suggestZooms(clip)] };
  await saveProject(next);
  return next.id;
}

/** The script, scrolling at a reading pace while recording. */
function Prompter({ text, wpm, big }: { text: string; wpm: number; big?: boolean }) {
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const words = Math.max(1, text.trim().split(/\s+/).length);
    const step = (now: number) => {
      const el = box.current;
      if (el && status.value === "recording" && !paused.value) {
        // Scroll the whole script over the time it takes to read it.
        const total = (words / wpm) * 60;
        const range = el.scrollHeight - el.clientHeight;
        el.scrollTop += (range / total) * ((now - last) / 1000);
      }
      last = now;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, wpm]);
  return (
    <section ref={box} class={`prompter ${big ? "prompter-big" : ""}`} aria-label="Teleprompter">
      <p>{text}</p>
    </section>
  );
}

function Controls({ onStop, script, wpm }: { onStop: () => void; script: string; wpm: number }) {
  return (
    <div class="pip">
      <div class="pip-row">
        <span class={`rec-dot ${paused.value ? "is-paused" : ""}`} />
        <span class="pip-time">
          {status.value === "countdown" ? `Starting in ${count.value}` : clock(elapsed.value)}
        </span>
        <span class="pip-actions">
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            onClick={togglePause}
            disabled={status.value !== "recording"}
            aria-label={paused.value ? "Resume" : "Pause"}
          >
            <Icon name={paused.value ? "play" : "pause"} size={15} />
          </button>
          <button
            type="button"
            class="btn btn-danger btn-sm"
            onClick={onStop}
            disabled={status.value !== "recording"}
          >
            <Icon name="stop" size={15} /> Stop
          </button>
        </span>
      </div>
      {script.trim() && <Prompter text={script} wpm={wpm} />}
    </div>
  );
}

async function openPip(onStop: () => void, script: string, wpm: number): Promise<boolean> {
  const api = docPip();
  if (!api || pipWindow) return false;
  try {
    const win = await api.requestWindow({ width: 380, height: script.trim() ? 300 : 76 });
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
      const l = win.document.createElement("link");
      l.rel = "stylesheet";
      l.href = link.href;
      win.document.head.append(l);
    }
    win.document.body.className = "pip-body";
    pipWindow = win;
    render(<Controls onStop={onStop} script={script} wpm={wpm} />, win.document.body);
    win.addEventListener("pagehide", () => {
      pipWindow = null;
    });
    return true;
  } catch {
    return false;
  }
}

function CameraPreview({ deviceId }: { deviceId: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const error = useSignal("");
  useEffect(() => {
    let stream: MediaStream | null = null;
    let live = true;
    openCamera(deviceId || null)
      .then((s) => {
        if (!live) {
          for (const t of s.getTracks()) t.stop();
          return;
        }
        stream = s;
        if (ref.current) ref.current.srcObject = s;
      })
      .catch((err) => (error.value = errorText(err)));
    return () => {
      live = false;
      for (const t of stream?.getTracks() ?? []) t.stop();
    };
  }, [deviceId]);
  return error.value ? (
    <p class="error small">{error.value}</p>
  ) : (
    <video ref={ref} class="cam-preview" autoPlay muted playsInline aria-label="Camera preview" />
  );
}

function MicMeter({ deviceId }: { deviceId: string }) {
  const level = useSignal(0);
  const error = useSignal("");
  useEffect(() => {
    let stream: MediaStream | null = null;
    let meter: ReturnType<typeof levelMeter> | null = null;
    let raf = 0;
    let live = true;
    openMic(deviceId || null)
      .then((s) => {
        if (!live) {
          for (const t of s.getTracks()) t.stop();
          return;
        }
        stream = s;
        meter = levelMeter(s);
        const tick = () => {
          level.value = meter?.level() ?? 0;
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch((err) => (error.value = errorText(err)));
    return () => {
      live = false;
      cancelAnimationFrame(raf);
      meter?.close();
      for (const t of stream?.getTracks() ?? []) t.stop();
    };
  }, [deviceId]);
  if (error.value) return <p class="error small">{error.value}</p>;
  return (
    <div class="meter" aria-hidden="true">
      <div class="meter-bar" style={{ width: `${Math.round(level.value * 100)}%` }} />
    </div>
  );
}

export function Record({ projectId }: { projectId: string | null }) {
  const prefs = useSignal<Prefs>(load(PREFS_KEY, DEFAULT_PREFS));
  const script = useSignal<string>(load<{ text: string }>(SCRIPT_KEY, { text: "" }).text);
  const title = useSignal("Untitled video");
  const devices = useSignal<{ cameras: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }>({
    cameras: [],
    mics: [],
  });
  const pipOpen = useSignal(false);
  const p = prefs.value;

  const set = (patch: Partial<Prefs>) => {
    prefs.value = { ...prefs.value, ...patch };
    saveLocal(PREFS_KEY, prefs.value);
  };

  useEffect(() => {
    const refresh = () => void listDevices().then((d) => (devices.value = d));
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    const warn = (e: BeforeUnloadEvent) => {
      if (status.value === "recording") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
      window.removeEventListener("beforeunload", warn);
    };
  }, []);

  const stop = async () => {
    if (!session || status.value !== "recording") return;
    status.value = "saving";
    clearInterval(ticker);
    pipWindow?.close();
    pipWindow = null;
    const s = session;
    try {
      const recorded = await s.stop();
      // The files become seekable (duration and index) before the editor opens them.
      const finalized = await finalizeClip(s.projectId, recorded);
      const clip: Clip =
        p.voiceForText && finalized.mic ? { ...finalized, voice: "none" } : finalized;
      session = null;
      if (clip.duration < 0.5) {
        toast("That take was too short to keep.", "error");
        status.value = "setup";
        return;
      }
      const id = await keep(clip, s, title.value.trim() || "Untitled video");
      status.value = "setup";
      navigate(`#/edit/${id}`);
    } catch (err) {
      session = null;
      toast(errorText(err), "error", 8000);
      status.value = "setup";
    }
  };

  const cancel = async () => {
    const s = session;
    session = null;
    clearInterval(ticker);
    pipWindow?.close();
    pipWindow = null;
    status.value = "setup";
    await s?.cancel();
    toast("Take discarded.");
  };

  const start = async () => {
    status.value = "opening";
    try {
      const sources = await openSources({
        screen: p.screen,
        screenAudio: p.screen && p.screenAudio,
        camera: p.camera,
        mic: p.mic,
      });
      const id = projectId ?? emptyProject().id;
      session = await RecordingSession.create(id, sources, () => void stop());
      const text = p.prompter ? script.value : "";
      pipOpen.value = await openPip(() => void stop(), text, p.wpm);
      status.value = "countdown";
      for (let n = 3; n > 0; n--) {
        count.value = n;
        await new Promise((r) => setTimeout(r, 1000));
        if (!session) return;
      }
      await session.start();
      status.value = "recording";
      paused.value = false;
      elapsed.value = 0;
      ticker = setInterval(() => (elapsed.value = session?.elapsed() ?? 0), 250);
      void listDevices().then((d) => (devices.value = d));
    } catch (err) {
      const msg = errorText(err);
      toast(msg === "Permission was refused." ? "Recording was cancelled." : msg, "error", 7000);
      await session?.cancel().catch(() => undefined);
      session = null;
      status.value = "setup";
    }
  };

  if (status.value !== "setup") {
    const text = p.prompter ? script.value : "";
    return (
      <main class="record">
        <div class="record-live">
          {status.value === "countdown" ? (
            <div class="countdown" aria-live="assertive">
              {count.value}
            </div>
          ) : (
            <div class="record-status">
              <span class={`rec-dot ${paused.value ? "is-paused" : ""}`} />
              <span class="rec-time">{clock(elapsed.value)}</span>
              <span class="muted">
                {status.value === "saving"
                  ? "Saving and preparing the take for editing…"
                  : status.value === "opening"
                    ? "Choose what to share…"
                    : paused.value
                      ? "Paused"
                      : "Recording"}
              </span>
            </div>
          )}
          <div class="record-controls">
            <Button
              size="lg"
              icon={paused.value ? "play" : "pause"}
              onClick={togglePause}
              disabled={status.value !== "recording"}
            >
              {paused.value ? "Resume" : "Pause"}
            </Button>
            <Button
              variant="danger"
              size="lg"
              icon="stop"
              onClick={() => void stop()}
              disabled={status.value !== "recording"}
            >
              Stop &amp; edit
            </Button>
            <Button
              variant="ghost"
              icon="trash"
              onClick={() => void cancel()}
              disabled={status.value !== "recording" && status.value !== "countdown"}
            >
              Discard
            </Button>
            {docPip() && !pipOpen.value && status.value === "recording" && (
              <Button
                variant="ghost"
                onClick={() =>
                  void openPip(() => void stop(), text, p.wpm).then((ok) => (pipOpen.value = ok))
                }
              >
                Floating controls
              </Button>
            )}
          </div>
          {text.trim() && !pipOpen.value && <Prompter text={text} wpm={p.wpm} big />}
        </div>
      </main>
    );
  }

  const d = devices.value;
  return (
    <main class="record">
      <div class="record-card">
        <h1>{projectId ? "Record another take" : "Record a video"}</h1>
        <p class="lede">
          Each source goes into its own file, so you can change the layout, the camera and the sound
          after the take.
        </p>
        {!projectId && (
          <Field label="Name">
            <input
              class="input"
              value={title.value}
              onInput={(e) => (title.value = e.currentTarget.value)}
            />
          </Field>
        )}
        <div class="sources">
          <section class="source">
            <label class="check">
              <input
                type="checkbox"
                checked={p.screen}
                onChange={(e) => set({ screen: e.currentTarget.checked })}
              />
              <Icon name="video" size={16} /> Screen
            </label>
            {p.screen && (
              <label class="check sub-check">
                <input
                  type="checkbox"
                  checked={p.screenAudio}
                  onChange={(e) => set({ screenAudio: e.currentTarget.checked })}
                />
                With the tab's or system's sound
              </label>
            )}
          </section>
          <section class="source">
            <label class="field-label" for="camera">
              <Icon name="camera" size={16} /> Camera
            </label>
            <select
              id="camera"
              class="input"
              value={p.camera ?? "none"}
              onChange={(e) =>
                set({ camera: e.currentTarget.value === "none" ? null : e.currentTarget.value })
              }
            >
              <option value="none">No camera</option>
              <option value="">Default camera</option>
              {d.cameras
                .filter((c) => c.deviceId && c.deviceId !== "default")
                .map((c, i) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label || `Camera ${i + 1}`}
                  </option>
                ))}
            </select>
            {p.camera !== null && <CameraPreview deviceId={p.camera} />}
          </section>
          <section class="source">
            <label class="field-label" for="mic">
              <Icon name="mic" size={16} /> Microphone
            </label>
            <select
              id="mic"
              class="input"
              value={p.mic ?? "none"}
              onChange={(e) =>
                set({ mic: e.currentTarget.value === "none" ? null : e.currentTarget.value })
              }
            >
              <option value="none">No microphone</option>
              <option value="">Default microphone</option>
              {d.mics
                .filter((m) => m.deviceId && m.deviceId !== "default")
                .map((m, i) => (
                  <option key={m.deviceId} value={m.deviceId}>
                    {m.label || `Microphone ${i + 1}`}
                  </option>
                ))}
            </select>
            {p.mic !== null && <MicMeter deviceId={p.mic} />}
            {p.mic !== null && (
              <label class="check sub-check">
                <input
                  type="checkbox"
                  checked={p.voiceForText}
                  onChange={(e) => set({ voiceForText: e.currentTarget.checked })}
                />
                Only for the transcript: leave my voice out of the video
              </label>
            )}
          </section>
        </div>
        <label class="check">
          <input
            type="checkbox"
            checked={p.prompter}
            onChange={(e) => set({ prompter: e.currentTarget.checked })}
          />
          Teleprompter
        </label>
        {p.prompter && (
          <div class="prompter-setup">
            <textarea
              class="input"
              rows={5}
              aria-label="Script"
              placeholder="Your script. It scrolls at your reading pace while you record, in the floating window."
              value={script.value}
              onInput={(e) => {
                script.value = e.currentTarget.value;
                saveLocal(SCRIPT_KEY, { text: script.value });
              }}
            />
            <label class="frame-range">
              Reading pace: {p.wpm} words a minute
              <input
                type="range"
                class="range"
                min={80}
                max={220}
                step={10}
                value={p.wpm}
                onInput={(e) => set({ wpm: Number(e.currentTarget.value) })}
              />
            </label>
          </div>
        )}
        <div class="record-actions">
          <Button
            variant="ghost"
            icon="back"
            onClick={() => navigate(projectId ? `#/edit/${projectId}` : "#/")}
          >
            Back
          </Button>
          <Button
            variant="primary"
            size="lg"
            icon="record"
            disabled={!p.screen && p.camera === null}
            onClick={() => void start()}
          >
            Start recording
          </Button>
        </div>
      </div>
    </main>
  );
}
