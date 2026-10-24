/**
 * The transcript: edit the video by editing its text. Select words and press
 * Delete to cut them; click a struck-out word to bring it back; click any word
 * to go there. Filler words and long pauses go in one click each. The word
 * being said is highlighted while the video plays.
 */
import { signal, useSignal } from "@preact/signals";
import { RESPONSE_LANGUAGES } from "llm-connect";
import { useEffect, useRef } from "preact/hooks";
import { loadLlmSettings, savedSettings } from "../../ai/settings";
import { fillerCuts, isCut, silenceCuts, wordsRange } from "../../edit/clean";
import type { PreviewEngine } from "../../edit/preview";
import { outputTime, sourceAt } from "../../edit/timeline";
import {
  defaultEngine,
  ENGINES,
  type Engine,
  engineProblem,
  providerCanTranscribe,
  transcribeClip,
  voiceOf,
} from "../../edit/transcribe";
import { type Clip, type Cut, newId } from "../../model/project";
import { ModelSettingsModal } from "../ModelSettings";
import { Button, errorText, Icon, toast } from "../ui";
import { project, segments, update, updateClip } from "./state";

const ENGINE_KEY = "takeone-transcriber";
function loadEngine(): Engine | null {
  try {
    const v = localStorage.getItem(ENGINE_KEY);
    // Older choices (Whisper's presets) are forgotten: the default is better now.
    return ENGINES.find((e) => e === v) ?? null;
  } catch {
    return null;
  }
}
const engineChoice = signal<Engine | null>(loadEngine());

const SPOKEN_KEY = "takeone-spoken-language";
/** The language spoken in the takes: the browser's until chosen (Whisper and Canary need it). */
function loadSpoken(): string {
  try {
    const v = localStorage.getItem(SPOKEN_KEY);
    if (v) return v;
  } catch {
    // Not remembered: fall back to the browser's language.
  }
  const code = (navigator.language ?? "en").toLowerCase().split(/[-_]/)[0] ?? "en";
  return RESPONSE_LANGUAGES.some((l) => l.code === code) ? code : "en";
}
const spoken = signal(loadSpoken());
function setSpoken(v: string) {
  spoken.value = v;
  try {
    localStorage.setItem(SPOKEN_KEY, v);
  } catch {
    // The choice still holds for this session.
  }
}
function setEngine(v: Engine) {
  engineChoice.value = v;
  try {
    localStorage.setItem(ENGINE_KEY, v);
  } catch {
    // The choice still holds for this session.
  }
}

/** Takes being transcribed: their progress message. */
const busy = signal<Record<string, string>>({});

function key(clip: string, i: number): string {
  return `${clip}:${i}`;
}

/** The words a DOM selection covers, by take. */
function selectedWords(root: HTMLElement): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return out;
  for (const el of root.querySelectorAll<HTMLElement>(".w")) {
    if (!sel.containsNode(el, true)) continue;
    const clip = el.dataset.clip ?? "";
    const i = Number(el.dataset.i);
    const r = out.get(clip);
    out.set(clip, r ? [Math.min(r[0], i), Math.max(r[1], i)] : [i, i]);
  }
  return out;
}

function Take({
  clip,
  index,
  cuts,
  engine,
}: {
  clip: Clip;
  index: number;
  cuts: readonly Cut[];
  engine: PreviewEngine | null;
}) {
  const t = clip.transcript;
  const p = project.value;
  if (!p) return null;
  const message = busy.value[clip.id];

  const run = async () => {
    await loadLlmSettings();
    const settings = savedSettings();
    const choice = engineChoice.value ?? defaultEngine(spoken.value);
    const problem = engineProblem(choice, spoken.value, settings);
    if (problem) {
      toast(problem, "error", 8000);
      return;
    }
    busy.value = { ...busy.value, [clip.id]: "Starting…" };
    try {
      const transcript = await transcribeClip(
        p.id,
        clip,
        choice,
        settings,
        (m) => {
          busy.value = { ...busy.value, [clip.id]: m };
        },
        undefined,
        spoken.value,
      );
      updateClip(clip.id, (c) => ({ ...c, transcript }));
      toast(`Take ${index + 1} transcribed: ${transcript.words.length} words.`, "success");
    } catch (err) {
      toast(errorText(err), "error", 8000);
    } finally {
      const { [clip.id]: _, ...rest } = busy.value;
      busy.value = rest;
    }
  };

  return (
    <section class="tr-take" aria-label={`Take ${index + 1}`}>
      <h3>Take {index + 1}</h3>
      {!t ? (
        voiceOf(clip) ? (
          <div class="tr-empty">
            <p class="muted small">Transcribe this take to edit it by its words.</p>
            <Button size="sm" icon="text" disabled={!!message} onClick={() => void run()}>
              {message ? "Transcribing…" : "Transcribe"}
            </Button>
            {message && <span class="field-hint">{message}</span>}
          </div>
        ) : (
          <p class="muted small">This take has no sound.</p>
        )
      ) : t.words.length === 0 ? (
        <p class="muted small">No speech was found in this take.</p>
      ) : (
        <p class="tr-text">
          {t.words.map((w, i) => {
            const cut = isCut(cuts, clip.id, w);
            return (
              // Words stay plain text so they can be selected like any text; the keyboard edits
              // them through that selection (Delete), and moves through the video on the timeline.
              // biome-ignore lint/a11y/noStaticElementInteractions: see above
              // biome-ignore lint/a11y/useKeyWithClickEvents: see above
              <span
                key={key(clip.id, i)}
                class={`w${cut ? " is-cut" : ""}`}
                data-clip={clip.id}
                data-i={i}
                data-key={key(clip.id, i)}
                title={cut ? "Cut: click to bring it back" : undefined}
                onClick={() => {
                  if (window.getSelection()?.isCollapsed === false) return;
                  if (cut) {
                    const mid = (w.start + w.end) / 2;
                    update((x) => ({
                      ...x,
                      cuts: x.cuts.filter(
                        (c) => !(c.clip === clip.id && mid >= c.start && mid < c.end),
                      ),
                    }));
                    return;
                  }
                  const at = outputTime(segments.value, clip.id, w.start);
                  if (at !== null) engine?.seek(at);
                }}
              >
                {w.text}{" "}
              </span>
            );
          })}
        </p>
      )}
    </section>
  );
}

export function TranscriptPanel({ engine }: { engine: PreviewEngine | null }) {
  const root = useRef<HTMLDivElement>(null);
  const settingsOpen = useSignal(false);
  const p = project.value;

  useEffect(() => {
    void loadLlmSettings();
  }, []);

  // Delete or Backspace cuts the selected words.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const el = root.current;
      if (!el) return;
      const picked = selectedWords(el);
      const proj = project.value;
      if (picked.size === 0 || !proj) return;
      e.preventDefault();
      e.stopPropagation();
      const cuts: Cut[] = [];
      for (const [clipId, [a, b]] of picked) {
        const words = proj.clips.find((c) => c.id === clipId)?.transcript?.words ?? [];
        const r = wordsRange(words, a, b);
        if (r) cuts.push({ id: newId("x"), clip: clipId, ...r, reason: "text" });
      }
      update((x) => ({ ...x, cuts: [...x.cuts, ...cuts] }));
      window.getSelection()?.removeAllRanges();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // The word being said, highlighted without redrawing the transcript.
  useEffect(() => {
    if (!engine) return;
    let last: HTMLElement | null = null;
    return engine.time.subscribe((t) => {
      const proj = project.value;
      const at = sourceAt(segments.value, t);
      if (!proj || !at || !root.current) return;
      const words = at.segment.clip.transcript?.words ?? [];
      const i = words.findIndex((w) => at.t >= w.start && at.t < w.end + 0.05);
      const el =
        i >= 0
          ? root.current.querySelector<HTMLElement>(`[data-key="${key(at.segment.clip.id, i)}"]`)
          : null;
      if (el === last) return;
      last?.classList.remove("is-now");
      el?.classList.add("is-now");
      last = el;
      if (el && engine.playing.peek()) el.scrollIntoView({ block: "nearest" });
    });
  }, [engine]);

  if (!p) return null;
  const settings = savedSettings();
  const choice = engineChoice.value ?? defaultEngine(spoken.value);
  const problem = engineProblem(choice, spoken.value, settings);
  const fillers = p.clips.flatMap((c) => fillerCuts(c, p.cuts));
  const pauses = p.clips.flatMap((c) => silenceCuts(c, p.cuts));
  const cleanups = p.cuts.filter((c) => c.reason === "filler" || c.reason === "silence");
  const transcribed = p.clips.some((c) => c.transcript);

  return (
    <aside class="transcript" aria-label="Transcript" ref={root}>
      <header class="tr-head">
        <h2>
          <Icon name="text" size={16} /> Transcript
        </h2>
        <select
          class="input input-sm"
          aria-label="Transcribe with"
          value={choice}
          onChange={(e) => setEngine(e.currentTarget.value as Engine)}
        >
          <option value="parakeet">This device: NVIDIA Parakeet (best, 670 MB once)</option>
          <option value="canary">This device: NVIDIA Canary (lighter, 215 MB once)</option>
          <option value="whisper">This device: Whisper (other languages)</option>
          <option value="provider" disabled={!providerCanTranscribe(settings)}>
            Your AI provider{providerCanTranscribe(settings) ? "" : " (not set up)"}
          </option>
        </select>
        <select
          class="input input-sm"
          aria-label="Spoken language"
          title="The language spoken in the takes"
          value={spoken.value}
          onChange={(e) => setSpoken(e.currentTarget.value)}
        >
          {RESPONSE_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        <button type="button" class="link-btn small" onClick={() => (settingsOpen.value = true)}>
          AI settings
        </button>
      </header>
      {problem && <p class="field-hint tr-problem">{problem}</p>}
      {transcribed && (
        <div class="tr-clean">
          <Button
            size="sm"
            icon="wand"
            disabled={fillers.length === 0}
            onClick={() => update((x) => ({ ...x, cuts: [...x.cuts, ...fillers] }))}
          >
            Remove {fillers.length} filler word{fillers.length === 1 ? "" : "s"}
          </Button>
          <Button
            size="sm"
            icon="wand"
            disabled={pauses.length === 0}
            onClick={() => update((x) => ({ ...x, cuts: [...x.cuts, ...pauses] }))}
          >
            Shorten {pauses.length} pause{pauses.length === 1 ? "" : "s"}
          </Button>
          {cleanups.length > 0 && (
            <button
              type="button"
              class="link-btn small"
              onClick={() =>
                update((x) => ({
                  ...x,
                  cuts: x.cuts.filter((c) => c.reason !== "filler" && c.reason !== "silence"),
                }))
              }
            >
              Undo the clean-ups
            </button>
          )}
        </div>
      )}
      <div class="tr-body">
        {p.clips.map((c, i) => (
          <Take key={c.id} clip={c} index={i} cuts={p.cuts} engine={engine} />
        ))}
      </div>
      {transcribed && (
        <p class="muted small tr-hint">
          Select words and press Delete to cut them. Click a struck-out word to bring it back.
        </p>
      )}
      {settingsOpen.value && <ModelSettingsModal onClose={() => (settingsOpen.value = false)} />}
    </aside>
  );
}
