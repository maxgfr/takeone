/**
 * Transcribing a take: its voice (the microphone's file, else the screen's
 * sound) goes to NVIDIA Parakeet or Canary on this device, Whisper for the
 * languages they do not know, or the provider's speech-to-text model through
 * llm-connect. The device engines run in a worker. Times come back on the
 * file's clock and are moved onto the take's (the microphone opens a little
 * after the screen).
 */
import {
  type LlmSettings,
  type Transcript,
  type TranscriptPiece,
  transcribe,
  transcriptionProblem,
} from "llm-connect";
import { NEMO_MODELS, nemoSupports } from "llm-connect/nemo";
import type { Clip, Media } from "../model/project";
import { getMedia } from "../model/store";
import type { DeviceEngine, SpeechReply, SpeechRequest } from "../workers/speech";

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

/** The take's words, timed on its own clock. */
export async function transcribeClip(
  projectId: string,
  clip: Clip,
  engine: Engine,
  settings: LlmSettings | null,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
  /** ISO 639-1 code of the spoken language: Whisper and Canary need it, Parakeet finds it. */
  language?: string,
): Promise<Transcript> {
  const voice = voiceOf(clip);
  if (!voice) throw new Error("This take has no sound to transcribe.");
  const blob = await getMedia(projectId, voice.key, voice.type.split(";")[0]);
  if (!blob) throw new Error("The take's sound is missing from this device.");
  let t: Transcript;
  if (engine === "provider") {
    if (!settings) throw new Error("Set up a model first, or transcribe on this device.");
    onProgress("Transcribing with your provider…");
    t = await transcribe(settings, blob, {
      ...(signal ? { abortSignal: signal } : {}),
      ...(language ? { language } : {}),
    });
  } else {
    onProgress("Reading the sound…");
    const { decodeAudio } = await import("llm-connect/nemo");
    t = await onDevice(await decodeAudio(blob), engine, onProgress, signal, language);
  }
  return shift(t, voice.offset);
}
