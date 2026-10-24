/**
 * Transcribing a take: its voice (the microphone's file, else the screen's
 * sound) goes to the provider's speech-to-text model through llm-connect, or
 * to Whisper on this device in a worker. Times come back on the file's clock
 * and are moved onto the take's (the microphone opens a little after the
 * screen).
 */
import {
  type LlmSettings,
  type Transcript,
  type TranscriptPiece,
  transcribe,
  transcriptionProblem,
} from "llm-connect";
import type { WhisperPreset } from "llm-connect/whisper";
import type { Clip, Media } from "../model/project";
import { getMedia } from "../model/store";
import type { WhisperReply, WhisperRequest } from "../workers/whisper";

declare const __WHISPER_WORKER_URL__: string;

export type Engine = "provider" | "device-fast" | "device-accurate";

/** The provider when it can transcribe (a custom endpoint would need a model name), else the device. */
export function defaultEngine(settings: LlmSettings | null): Engine {
  return settings && !settings.customEndpoint && !transcriptionProblem(settings)
    ? "provider"
    : "device-fast";
}

export function providerCanTranscribe(settings: LlmSettings | null): boolean {
  return defaultEngine(settings) === "provider";
}

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

function whisper(
  samples: Float32Array,
  preset: WhisperPreset,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
  language?: string,
): Promise<Transcript> {
  const url = typeof __WHISPER_WORKER_URL__ === "string" ? __WHISPER_WORKER_URL__ : "./whisper.js";
  const worker = new Worker(url, { type: "module" });
  return new Promise<Transcript>((resolve, reject) => {
    const end = () => worker.terminate();
    signal?.addEventListener("abort", () => {
      end();
      reject(new DOMException("Cancelled", "AbortError"));
    });
    worker.onerror = (e) => {
      end();
      reject(new Error(e.message || "Whisper could not start in this browser."));
    };
    worker.onmessage = (e: MessageEvent<WhisperReply>) => {
      const r = e.data;
      if (r.kind === "progress")
        onProgress(`Downloading Whisper, once: ${Math.round(r.ratio * 100)} %`);
      else if (r.kind === "loaded") onProgress(`Transcribing on this device (${r.device})…`);
      else if (r.kind === "done") {
        end();
        resolve(r.transcript);
      } else {
        end();
        reject(new Error(r.message));
      }
    };
    const request: WhisperRequest = { samples, preset, ...(language ? { language } : {}) };
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
  /** ISO 639-1 code of the spoken language: Whisper on the device does not detect it. */
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
    const { decodeAudio } = await import("llm-connect/whisper");
    const samples = await decodeAudio(blob);
    t = await whisper(
      samples,
      engine === "device-accurate" ? "accurate" : "fast",
      onProgress,
      signal,
      language,
    );
  }
  return shift(t, voice.offset);
}
