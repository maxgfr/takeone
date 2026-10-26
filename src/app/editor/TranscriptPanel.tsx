/**
 * The transcript: edit the video by editing its text. Each take gets its text
 * from the voice recorded with it, from a voice-over recorded afterwards, or
 * typed by hand; which voice is heard is chosen per take (the take's, none, or
 * the voice-over). Select words and press Delete to cut them; click a
 * struck-out word to bring it back; click any word to go there; double-click
 * one to correct it. Filler words and long pauses go in one click each. The
 * word being said is highlighted while the video plays, so the text also
 * prompts a voice-over.
 */
import { signal, useSignal } from "@preact/signals";
import { RESPONSE_LANGUAGES } from "llm-connect";
import { useEffect, useRef } from "preact/hooks";
import { loadLlmSettings, savedSettings } from "../../ai/settings";
import { fillerCuts, isCut, silenceCuts, wordsRange } from "../../edit/clean";
import type { PreviewEngine } from "../../edit/preview";
import { outputTime, sourceAt } from "../../edit/timeline";
import {
  type Engine,
  engineProblem,
  providerCanTranscribe,
  reword,
  typedTranscript,
  voiceOf,
} from "../../edit/transcribe";
import { unusedFiles } from "../../edit/voiceover";
import {
  type Clip,
  type Cut,
  newId,
  shownOf,
  type Voice,
  withTranscript,
  withVoice,
} from "../../model/project";
import { deleteMedia } from "../../model/store";
import { ModelSettingsModal } from "../ModelSettings";
import { clock } from "../Record";
import { Button, Icon } from "../ui";
import { project, segments, update, updateClip } from "./state";
import { busy, currentEngine, setEngine, setSpoken, spoken, transcribeTake } from "./transcription";

const ENGINE_NAMES: Record<Engine, string> = {
  parakeet: "Parakeet on this device",
  canary: "Canary on this device",
  whisper: "Whisper on this device",
  provider: "Your AI provider",
};

/** The take whose text is being typed. */
const writing = signal<string | null>(null);
/** The word being corrected. */
const correcting = signal<{ clip: string; i: number } | null>(null);

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

/** What is kept of a take, where typed words are spread (all of it when it is all cut). */
function keptRanges(clip: Clip): { start: number; end: number }[] {
  const kept = segments.value.filter((s) => s.clip.id === clip.id);
  return kept.length ? kept : [{ start: 0, end: clip.duration }];
}

const VOICE_LABELS: Record<Voice, string> = {
  take: "Take's voice",
  none: "Muted",
  over: "Voice-over",
};

function VoiceChoice({ clip }: { clip: Clip }) {
  const hasOver = (clip.voiceover?.pieces.length ?? 0) > 0;
  if (!clip.mic && !hasOver) return null;
  const choices: Voice[] = hasOver ? ["take", "none", "over"] : ["take", "none"];
  return (
    <fieldset class="segmented tr-voice" aria-label="Voice heard">
      {choices.map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={clip.voice === v}
          class={clip.voice === v ? "is-on" : ""}
          disabled={v === "take" && !clip.mic}
          title={
            v === "none"
              ? "The voice was only for the transcript: the video is silent here, the text stays"
              : undefined
          }
          onClick={() => updateClip(clip.id, (c) => withVoice(c, v))}
        >
          {VOICE_LABELS[v]}
        </button>
      ))}
    </fieldset>
  );
}

function TypeBox({ clip }: { clip: Clip }) {
  const text = useSignal(clip.takeTranscript?.text ?? "");
  const save = () => {
    const typed = text.value.trim();
    const t = typed ? typedTranscript(typed, keptRanges(clip), spoken.value) : null;
    updateClip(clip.id, (c) => withTranscript(c, "take", t));
    writing.value = null;
  };
  return (
    <div class="tr-type">
      <textarea
        class="input"
        aria-label={`Text of take ${(project.value?.clips.indexOf(clip) ?? 0) + 1}`}
        rows={6}
        placeholder="Type or paste what is said in this take."
        value={text.value}
        onInput={(e) => (text.value = e.currentTarget.value)}
      />
      <p class="field-hint">
        The words are spread over the take, so their times are estimates: close enough to cut by the
        sentence.
      </p>
      <div class="tr-actions">
        <Button size="sm" variant="primary" onClick={save}>
          Save the text
        </Button>
        <Button size="sm" variant="ghost" onClick={() => (writing.value = null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function sourceLabel(clip: Clip): string | null {
  const t = clip.transcript;
  if (!t) return null;
  if (shownOf(clip) === "over") return "Text of the voice-over";
  if (t.source === "typed") return "Typed: times are estimated";
  return clip.voice === "over" ? "Text of the take (the voice-over is not transcribed)" : null;
}

async function removeVoiceover(clip: Clip) {
  const keys = (clip.voiceover?.pieces ?? []).map((p) => p.key);
  updateClip(clip.id, (c) =>
    withVoice({ ...c, voiceover: null }, c.voice === "over" ? (c.mic ? "take" : "none") : c.voice),
  );
  const p = project.value;
  if (!p) return;
  for (const k of unusedFiles(p, keys)) await deleteMedia(p.id, k).catch(() => undefined);
}

function Words({
  clip,
  cuts,
  engine,
}: {
  clip: Clip;
  cuts: readonly Cut[];
  engine: PreviewEngine | null;
}) {
  const t = clip.transcript;
  if (!t) return null;
  if (t.words.length === 0) return <p class="muted small">No speech was found in this take.</p>;
  const fix = correcting.value?.clip === clip.id ? correcting.value.i : -1;
  const apply = (i: number, text: string) => {
    correcting.value = null;
    const w = t.words[i];
    if (!w || text.trim() === w.text) return;
    updateClip(clip.id, (c) =>
      c.transcript ? withTranscript(c, shownOf(c), reword(c.transcript, i, text)) : c,
    );
  };
  return (
    <p class="tr-text">
      {t.words.map((w, i) => {
        if (i === fix)
          return (
            <input
              key={key(clip.id, i)}
              class="w-edit"
              aria-label="Correct the word"
              value={w.text}
              size={Math.max(3, w.text.length + 1)}
              ref={(el) => el?.focus()}
              onKeyDown={(e) => {
                if (e.key === "Enter") apply(i, e.currentTarget.value);
                else if (e.key === "Escape") correcting.value = null;
              }}
              onBlur={(e) => apply(i, e.currentTarget.value)}
            />
          );
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
            title={cut ? "Cut: click to bring it back" : "Double-click to correct"}
            onDblClick={() => {
              window.getSelection()?.removeAllRanges();
              correcting.value = { clip: clip.id, i };
            }}
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
  );
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
  const message = busy.value[clip.id];
  const hasOver = (clip.voiceover?.pieces.length ?? 0) > 0;
  const overPending = clip.voice === "over" && hasOver && !clip.voiceover?.transcript;
  const shown = shownOf(clip);
  const label = sourceLabel(clip);
  const sound = !!voiceOf(clip);

  return (
    <section class="tr-take" aria-label={`Take ${index + 1}`}>
      <header class="tr-take-head">
        <h3>
          Take {index + 1} <span class="tr-dur">{clock(clip.duration)}</span>
        </h3>
        <VoiceChoice clip={clip} />
      </header>
      {!clip.mic && !hasOver && (
        <p class="muted small">
          No voice recorded with this take: record a voice-over over it, or write its text.
        </p>
      )}
      {message ? (
        <p class="tr-busy" role="status">
          <span class="spinner spinner-sm" aria-hidden="true" />
          {message}
        </p>
      ) : writing.value === clip.id ? (
        <TypeBox clip={clip} />
      ) : !t || overPending ? (
        <div class="tr-actions">
          {overPending ? (
            <Button
              size="sm"
              variant="primary"
              icon="text"
              onClick={() => void transcribeTake(clip.id, "over")}
            >
              Transcribe the voice-over
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              icon="text"
              disabled={!sound}
              title={sound ? undefined : "This take has no sound to transcribe"}
              onClick={() => void transcribeTake(clip.id, "take")}
            >
              Transcribe
            </Button>
          )}
          {!t && (
            <Button size="sm" variant="ghost" onClick={() => (writing.value = clip.id)}>
              Write the text
            </Button>
          )}
        </div>
      ) : null}
      {t && writing.value !== clip.id && (
        <>
          <Words clip={clip} cuts={cuts} engine={engine} />
          <div class="tr-meta">
            {label && <span class="tr-source">{label}</span>}
            {!message && (
              <span class="tr-links">
                {shown === "over" ? (
                  <button
                    type="button"
                    class="link-btn small"
                    onClick={() => void transcribeTake(clip.id, "over")}
                  >
                    Transcribe again
                  </button>
                ) : (
                  <>
                    {sound && (
                      <button
                        type="button"
                        class="link-btn small"
                        onClick={() => void transcribeTake(clip.id, "take")}
                      >
                        Transcribe again
                      </button>
                    )}
                    <button
                      type="button"
                      class="link-btn small"
                      onClick={() => (writing.value = clip.id)}
                    >
                      Rewrite the text
                    </button>
                  </>
                )}
                {hasOver && (
                  <button
                    type="button"
                    class="link-btn small"
                    onClick={() => void removeVoiceover(clip)}
                  >
                    Remove the voice-over
                  </button>
                )}
              </span>
            )}
          </div>
        </>
      )}
      {!t && hasOver && !message && (
        <div class="tr-meta">
          <span class="tr-links">
            <button type="button" class="link-btn small" onClick={() => void removeVoiceover(clip)}>
              Remove the voice-over
            </button>
          </span>
        </div>
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
      if ((e.target as HTMLElement).closest?.("input, textarea, select")) return;
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
  const choice = currentEngine();
  const problem = engineProblem(choice, spoken.value, settings);
  const fillers = p.clips.flatMap((c) => fillerCuts(c, p.cuts));
  const pauses = p.clips.flatMap((c) => silenceCuts(c, p.cuts));
  const cleanups = p.cuts.filter((c) => c.reason === "filler" || c.reason === "silence");
  const transcribed = p.clips.some((c) => c.transcript?.words.length);
  const waiting = p.clips.filter((c) => !c.transcript && voiceOf(c) && !busy.value[c.id]);
  const languageLabel = RESPONSE_LANGUAGES.find((l) => l.code === spoken.value)?.label;

  return (
    <aside class="transcript" aria-label="Transcript" ref={root}>
      <header class="tr-head">
        <h2>
          <Icon name="text" size={16} /> Transcript
        </h2>
        {waiting.length > 1 && (
          <Button
            size="sm"
            icon="text"
            onClick={async () => {
              for (const c of waiting) if (!(await transcribeTake(c.id, "take"))) break;
            }}
          >
            Transcribe all
          </Button>
        )}
      </header>
      <details class="tr-settings">
        <summary>
          <span class="muted small">Transcribe with</span>
          <span class="small tr-choice">
            {ENGINE_NAMES[choice]} · {languageLabel ?? spoken.value}
          </span>
        </summary>
        <div class="tr-settings-body">
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
        </div>
      </details>
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
          Select words and press Delete to cut them. Click a struck-out word to bring it back,
          double-click a word to correct it.
        </p>
      )}
      {settingsOpen.value && <ModelSettingsModal onClose={() => (settingsOpen.value = false)} />}
    </aside>
  );
}
