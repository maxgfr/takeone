/**
 * Transcribing a take: its voice (the microphone's file, else the screen's
 * sound) goes to NVIDIA Parakeet or Canary on this device, Whisper for the
 * languages they do not know, or the provider's speech-to-text model through
 * llm-connect. The device engines run in a worker. Times come back on the
 * file's clock and are moved onto the take's (the microphone opens a little
 * after the screen). A voice-over's files are transcribed the same way, and
 * their words laid on the takes through its pieces. With no model at all, the
 * text can be typed: its words are spread over what is kept of the take.
 */
import {
  joinWords,
  type LlmSettings,
  segmentsFromWords,
  type Transcript,
  type TranscriptPiece,
  transcribe,
  transcriptionProblem,
  wordsFromSegments,
} from "llm-connect";
import { NEMO_MODELS, nemoSupports } from "llm-connect/nemo";
import type { Clip, ClipTranscript, Media } from "../model/project";
import { getMedia } from "../model/store";
import type { DeviceEngine, SpeechReply, SpeechRequest } from "../workers/speech";
import type { Range } from "./timeline";
import { placeWords } from "./voiceover";

declare const __SPEECH_WORKER_URL__: string;

export type Engine = "provider" | DeviceEngine;
export const ENGINES: readonly Engine[] = ["parakeet", "canary", "whisper", "provider"];

/** On this device: Parakeet when it knows the language, Whisper otherwise. */
export function defaultEngine(language: string): Engine {
  return nemoSupports("parakeet", language) ? "parakeet" : "whisper";
}

/** Why an engine cannot transcribe this language or with these settings, or null. */
export function engineProblem(
  engine: Engine,
  language: string,
  settings: LlmSettings | null,
): string | null {
  if (engine === "provider") {
    if (!settings) return "Set up a model first, or transcribe on this device.";
    if (settings.customEndpoint) return "A custom endpoint needs a transcription model name.";
    return transcriptionProblem(settings)?.message ?? null;
  }
  if (engine === "whisper") return null;
  return nemoSupports(engine, language)
    ? null
    : `${NEMO_MODELS[engine].name} does not know this language: pick Whisper.`;
}

export function providerCanTranscribe(settings: LlmSettings | null): boolean {
  return engineProblem("provider", "en", settings) === null;
}

const NAMES: Record<DeviceEngine, string> = {
  parakeet: "NVIDIA Parakeet",
  canary: "NVIDIA Canary",
  whisper: "Whisper",
};

/** The file holding the take's voice. */
export function voiceOf(clip: Clip): Media | null {
  if (clip.mic) return clip.mic;
  if (clip.screen?.audio) return clip.screen;
  if (clip.camera?.audio) return clip.camera;
  return null;
}

function shift(t: Transcript, offset: number): Transcript {
  const move = (p: TranscriptPiece) => ({ ...p, start: p.start + offset, end: p.end + offset });
  return { ...t, segments: t.segments.map(move), words: t.words.map(move) };
}

function onDevice(
  samples: Float32Array,
  engine: DeviceEngine,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
  language?: string,
): Promise<Transcript> {
  const url = typeof __SPEECH_WORKER_URL__ === "string" ? __SPEECH_WORKER_URL__ : "./speech.js";
  const worker = new Worker(url, { type: "module" });
  const name = NAMES[engine];
  return new Promise<Transcript>((resolve, reject) => {
    const end = () => worker.terminate();
    signal?.addEventListener("abort", () => {
      end();
      reject(new DOMException("Cancelled", "AbortError"));
    });
    worker.onerror = (e) => {
      end();
      reject(new Error(e.message || `${name} could not start in this browser.`));
    };
    worker.onmessage = (e: MessageEvent<SpeechReply>) => {
      const r = e.data;
      if (r.kind === "progress")
        onProgress(`Downloading ${name}, once: ${Math.round(r.ratio * 100)} %`);
      else if (r.kind === "loaded") onProgress(`Transcribing on this device with ${name}…`);
      else if (r.kind === "working")
        onProgress(`Transcribing on this device with ${name}: ${Math.round(r.ratio * 100)} %`);
      else if (r.kind === "done") {
        end();
        resolve(r.transcript);
      } else {
        end();
        reject(new Error(r.message));
      }
    };
    const request: SpeechRequest = { samples, engine, ...(language ? { language } : {}) };
    worker.postMessage(request, [samples.buffer]);
  });
}

async function transcribeFile(
  blob: Blob,
  engine: Engine,
  settings: LlmSettings | null,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
  language?: string,
): Promise<Transcript> {
  if (engine === "provider") {
    if (!settings) throw new Error("Set up a model first, or transcribe on this device.");
    onProgress("Transcribing with your provider…");
    return transcribe(settings, blob, {
      ...(signal ? { abortSignal: signal } : {}),
      ...(language ? { language } : {}),
    });
  }
  onProgress("Reading the sound…");
  const { decodeAudio } = await import("llm-connect/nemo");
  return onDevice(await decodeAudio(blob), engine, onProgress, signal, language);
}

/** A voice-over file spans several takes: transcribed once, then shared. */
const overFiles = new Map<string, Promise<Transcript>>();

/**
 * The words of a take's voice, timed on its own clock: the voice recorded with it, or (`of`
 * "over") its voice-over.
 */
export async function transcribeClip(
  projectId: string,
  clip: Clip,
  engine: Engine,
  settings: LlmSettings | null,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
  /** ISO 639-1 code of the spoken language: Whisper and Canary need it, Parakeet finds it. */
  language?: string,
  of: "take" | "over" = "take",
): Promise<ClipTranscript> {
  const source = engine === "provider" ? "provider" : "device";
  if (of === "over") {
    const pieces = clip.voiceover?.pieces ?? [];
    if (pieces.length === 0) throw new Error("This take has no voice-over to transcribe.");
    const words: TranscriptPiece[] = [];
    let found: string | undefined;
    for (const key of new Set(pieces.map((p) => p.key))) {
      const mine = pieces.filter((p) => p.key === key);
      const id = `${projectId}:${key}:${engine}:${language ?? ""}`;
      let job = overFiles.get(id);
      if (!job) {
        const type = mine[0]?.type ?? "audio/webm";
        job = getMedia(projectId, key, type.split(";")[0]).then((blob) => {
          if (!blob) throw new Error("The voice-over is missing from this device.");
          return transcribeFile(blob, engine, settings, onProgress, signal, language);
        });
        overFiles.set(id, job);
        job.catch(() => overFiles.delete(id));
      }
      const t = await job;
      found ??= t.language;
      words.push(...placeWords(t.words, mine));
    }
    words.sort((a, b) => a.start - b.start);
    return {
      text: joinWords(words.map((w) => w.text)),
      ...(found ? { language: found } : {}),
      segments: segmentsFromWords(words),
      words,
      wordTimings: "exact",
      source,
    };
  }
  const voice = voiceOf(clip);
  if (!voice) throw new Error("This take has no sound to transcribe.");
  const blob = await getMedia(projectId, voice.key, voice.type.split(";")[0]);
  if (!blob) throw new Error("The take's sound is missing from this device.");
  const t = await transcribeFile(blob, engine, settings, onProgress, signal, language);
  return { ...shift(t, voice.offset), source };
}

/**
 * A text typed for a take: its words spread over the parts of the take that are kept, in
 * proportion to their length (the times are estimates, close enough to cut by sentence).
 */
export function typedTranscript(
  text: string,
  ranges: readonly Range[],
  language?: string,
): ClipTranscript {
  const tokens = text.split(/\s+/).filter(Boolean);
  const spans = ranges.filter((r) => r.end > r.start);
  const total = spans.reduce((s, r) => s + (r.end - r.start), 0);
  const weight = tokens.map((w) => w.length + 1);
  const sum = weight.reduce((s, w) => s + w, 0);
  const groups: string[][] = spans.map(() => []);
  let acc = 0;
  tokens.forEach((w, i) => {
    const size = weight[i] as number;
    // Where the word's middle falls, as time into the kept parts.
    let at = ((acc + size / 2) / sum) * total;
    acc += size;
    let k = 0;
    while (k < spans.length - 1 && at > (spans[k] as Range).end - (spans[k] as Range).start) {
      at -= (spans[k] as Range).end - (spans[k] as Range).start;
      k++;
    }
    groups[k]?.push(w);
  });
  const segments = spans.flatMap((r, k) => {
    const g = groups[k] ?? [];
    return g.length ? [{ text: joinWords(g), start: r.start, end: r.end }] : [];
  });
  const words = wordsFromSegments(segments);
  return {
    text: joinWords(tokens),
    ...(language ? { language } : {}),
    segments: segmentsFromWords(words),
    words,
    wordTimings: "estimated",
    source: "typed",
  };
}

/**
 * The transcript with word `i` changed to `text`: several words share its time, and an empty
 * text removes it.
 */
export function reword(t: ClipTranscript, i: number, text: string): ClipTranscript {
  const w = t.words[i];
  if (!w) return t;
  const tokens = text.split(/\s+/).filter(Boolean);
  const total = tokens.reduce((s, x) => s + x.length, 0) || 1;
  let at = w.start;
  const fresh = tokens.map((x) => {
    const start = at;
    at += ((w.end - w.start) * x.length) / total;
    return { text: x, start, end: at };
  });
  const words = [...t.words.slice(0, i), ...fresh, ...t.words.slice(i + 1)];
  return {
    ...t,
    text: joinWords(words.map((x) => x.text)),
    segments: segmentsFromWords(words),
    words,
  };
}
