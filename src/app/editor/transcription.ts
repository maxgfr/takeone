/**
 * Transcribing from the editor: which engine and which spoken language (both
 * remembered), the takes being transcribed with their progress, and the one
 * function that transcribes a take's voice or its voice-over into the project.
 */
import { signal } from "@preact/signals";
import { RESPONSE_LANGUAGES } from "llm-connect";
import { loadLlmSettings, savedSettings } from "../../ai/settings";
import {
  defaultEngine,
  ENGINES,
  type Engine,
  engineProblem,
  transcribeClip,
} from "../../edit/transcribe";
import { withTranscript } from "../../model/project";
import { errorText, toast } from "../ui";
import { project, updateClip } from "./state";

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
export const engineChoice = signal<Engine | null>(loadEngine());

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
export const spoken = signal(loadSpoken());

export function setSpoken(v: string) {
  spoken.value = v;
  try {
    localStorage.setItem(SPOKEN_KEY, v);
  } catch {
    // The choice still holds for this session.
  }
}

export function setEngine(v: Engine) {
  engineChoice.value = v;
  try {
    localStorage.setItem(ENGINE_KEY, v);
  } catch {
    // The choice still holds for this session.
  }
}

export function currentEngine(): Engine {
  return engineChoice.value ?? defaultEngine(spoken.value);
}

/** Takes being transcribed: their progress message. */
export const busy = signal<Record<string, string>>({});

function setBusy(id: string, message: string | null) {
  if (message !== null) {
    busy.value = { ...busy.value, [id]: message };
    return;
  }
  const { [id]: _, ...rest } = busy.value;
  busy.value = rest;
}

/** Transcribes a take's own voice, or its voice-over, with the chosen engine. */
export async function transcribeTake(clipId: string, of: "take" | "over"): Promise<boolean> {
  await loadLlmSettings();
  const settings = savedSettings();
  const choice = currentEngine();
  const problem = engineProblem(choice, spoken.value, settings);
  const p = project.value;
  const clip = p?.clips.find((c) => c.id === clipId);
  if (!p || !clip || busy.value[clipId]) return false;
  const n = p.clips.indexOf(clip) + 1;
  if (problem) {
    toast(problem, "error", 8000);
    return false;
  }
  setBusy(clipId, "Starting…");
  try {
    const transcript = await transcribeClip(
      p.id,
      clip,
      choice,
      settings,
      (m) => setBusy(clipId, m),
      undefined,
      spoken.value,
      of,
    );
    updateClip(clipId, (c) => withTranscript(c, of, transcript));
    const what = of === "over" ? `The voice-over of take ${n}` : `Take ${n}`;
    toast(`${what} transcribed: ${transcript.words.length} words.`, "success");
    return true;
  } catch (err) {
    toast(errorText(err), "error", 8000);
    return false;
  } finally {
    setBusy(clipId, null);
  }
}
