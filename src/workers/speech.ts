/**
 * Speech to text on this device, off the page's thread: NVIDIA Parakeet or
 * Canary (llm-connect/nemo over onnxruntime-web), or Whisper (llm-connect/whisper
 * over transformers.js) for the languages the NVIDIA models do not know. Models
 * are downloaded once from Hugging Face, then served from the browser's cache;
 * onnxruntime's WebAssembly comes from this site (`ort/`), not from a CDN.
 */
import { env } from "@huggingface/transformers";
import { loadNemo, type NemoModel, type NemoTranscriber, type OrtRuntime } from "llm-connect/nemo";
import { loadWhisper, recommendedWhisperPreset, type Whisper } from "llm-connect/whisper";
import * as ort from "onnxruntime-web";

export type DeviceEngine = NemoModel | "whisper";

export interface SpeechRequest {
  samples: Float32Array;
  engine: DeviceEngine;
  language?: string;
}

export type SpeechReply =
  | { kind: "progress"; ratio: number }
  | { kind: "loaded" }
  | { kind: "working"; ratio: number }
  | { kind: "done"; transcript: Awaited<ReturnType<Whisper["transcribe"]>> }
  | { kind: "error"; message: string };

const base = new URL("../ort/", self.location.href).href;
const wasmPaths = {
  mjs: `${base}ort-wasm-simd-threaded.asyncify.mjs`,
  wasm: `${base}ort-wasm-simd-threaded.asyncify.wasm`,
};
const transformersWasm = env.backends.onnx.wasm as { wasmPaths?: unknown } | undefined;
if (transformersWasm) transformersWasm.wasmPaths = wasmPaths;

type Model = { kind: "nemo"; nemo: NemoTranscriber } | { kind: "whisper"; whisper: Whisper };
const loaded = new Map<DeviceEngine, Promise<Model>>();
const post = (reply: SpeechReply) => self.postMessage(reply);
const onProgress = ({ ratio }: { ratio: number }) => post({ kind: "progress", ratio });

async function load(engine: DeviceEngine): Promise<Model> {
  if (engine === "whisper") {
    const preset = await recommendedWhisperPreset();
    return { kind: "whisper", whisper: await loadWhisper({ preset, onProgress }) };
  }
  const nemo = await loadNemo({
    model: engine,
    runtime: ort as unknown as OrtRuntime,
    wasmPaths,
    onProgress,
  });
  return { kind: "nemo", nemo };
}

self.onmessage = async (e: MessageEvent<SpeechRequest>) => {
  const { samples, engine, language } = e.data;
  try {
    let model = loaded.get(engine);
    if (!model) {
      model = load(engine);
      loaded.set(engine, model);
      model.catch(() => loaded.delete(engine));
    }
    const m = await model;
    post({ kind: "loaded" });
    const lang = language ? { language } : {};
    const transcript =
      m.kind === "nemo"
        ? await m.nemo.transcribe(samples, {
            ...lang,
            onProgress: (ratio) => post({ kind: "working", ratio }),
          })
        : await m.whisper.transcribe(samples, lang);
    post({ kind: "done", transcript });
  } catch (err) {
    post({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
