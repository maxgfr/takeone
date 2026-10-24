/**
 * Whisper on this device (llm-connect/whisper over transformers.js), off the
 * page's thread. The model is downloaded once from Hugging Face, then served
 * from the browser's cache; onnxruntime's WebAssembly comes from this site
 * (`ort/`), not from a CDN.
 */
import { env } from "@huggingface/transformers";
import { loadWhisper, type Whisper, type WhisperPreset } from "llm-connect/whisper";

export interface WhisperRequest {
  samples: Float32Array;
  preset: WhisperPreset;
  language?: string;
}

export type WhisperReply =
  | { kind: "progress"; ratio: number }
  | { kind: "loaded"; device: string }
  | { kind: "done"; transcript: Awaited<ReturnType<Whisper["transcribe"]>> }
  | { kind: "error"; message: string };

const ort = new URL("../ort/", self.location.href).href;
const wasm = env.backends.onnx.wasm as { wasmPaths?: unknown } | undefined;
if (wasm)
  wasm.wasmPaths = {
    mjs: `${ort}ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${ort}ort-wasm-simd-threaded.asyncify.wasm`,
  };

const loaded = new Map<WhisperPreset, Promise<Whisper>>();
const post = (reply: WhisperReply) => self.postMessage(reply);

self.onmessage = async (e: MessageEvent<WhisperRequest>) => {
  const { samples, preset, language } = e.data;
  try {
    let whisper = loaded.get(preset);
    if (!whisper) {
      whisper = loadWhisper({
        preset,
        onProgress: ({ ratio }) => post({ kind: "progress", ratio }),
      });
      loaded.set(preset, whisper);
      whisper.catch(() => loaded.delete(preset));
    }
    const w = await whisper;
    post({ kind: "loaded", device: w.device });
    const transcript = await w.transcribe(samples, language ? { language } : {});
    post({ kind: "done", transcript });
  } catch (err) {
    post({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
