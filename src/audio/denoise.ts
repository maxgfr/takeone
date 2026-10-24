/**
 * Speech noise suppression with RNNoise 0.2 (Xiph, BSD-3-Clause), compiled to
 * WebAssembly by @jitsi/rnnoise-wasm (Apache-2.0).
 *
 * The WebAssembly binary is inlined in the package's script, which the build
 * turns into a chunk of this site, loaded on the first call only: nothing is
 * fetched from another origin. RNNoise takes 480-sample frames at 48 kHz
 * scaled like int16, and its output lags its input by two frames: the signal is
 * resampled to 48 kHz and back when needed, padded to flush the tail, and
 * shifted so that the output is aligned with the input and has its length.
 */
import type { RnnoiseModule } from "@jitsi/rnnoise-wasm/dist/rnnoise-sync.js";
import { resampledLength, resampleRange } from "./resample";

const RATE = 48_000;
const FRAME = 480; // 10 ms at 48 kHz
const LATENCY = 2 * FRAME; // overlap-add plus the model's lookahead
const SCALE = 32_768; // RNNoise expects int16-scaled floats
const FRAMES_PER_YIELD = 100; // 1 s of audio, ~20 ms of work
const RESAMPLE_SLICE = 4 * RATE; // output samples resampled between two yields

let loading: Promise<RnnoiseModule> | null = null;

/** Loads and instantiates the RNNoise module, once. */
function loadRnnoise(): Promise<RnnoiseModule> {
  loading ??= (async () => {
    const { default: create } = await import("@jitsi/rnnoise-wasm/dist/rnnoise-sync.js");
    const rnnoise = create();
    await rnnoise.ready;
    return rnnoise;
  })().catch((err: unknown) => {
    loading = null; // let a later call try again
    throw err;
  });
  return loading;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** `input` resampled to `length` samples at `to` Hz, in slices with a yield between them. */
async function resampleAsync(
  input: Float32Array,
  from: number,
  to: number,
  length: number,
  onProgress: (ratio: number) => void,
): Promise<Float32Array> {
  const output = new Float32Array(length);
  for (let start = 0; start < length; start += RESAMPLE_SLICE) {
    const end = Math.min(length, start + RESAMPLE_SLICE);
    resampleRange(input, from, to, output, start, end);
    onProgress(end / length);
    await nextTask();
  }
  return output;
}

/**
 * `samples` (mono, in [−1, 1], at `sampleRate` Hz) with background noise
 * removed, the same length and aligned with the input. `onProgress` receives
 * the share of the work done, from 0 to 1. The input is not modified.
 */
export async function denoise(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (ratio: number) => void,
): Promise<Float32Array> {
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate))
    throw new RangeError(`invalid sample rate: ${sampleRate}`);
  if (samples.length === 0) {
    onProgress?.(1);
    return new Float32Array(0);
  }
  const rnnoise = await loadRnnoise();
  const resampled = sampleRate !== RATE;
  // Share of the progress at which the frames start and end: resampling each
  // way takes about a tenth of the time.
  const [first, last] = resampled ? [0.1, 0.9] : [0, 1];
  const input = resampled
    ? await resampleAsync(
        samples,
        sampleRate,
        RATE,
        resampledLength(samples.length, sampleRate, RATE),
        (r) => onProgress?.(r * first),
      )
    : samples;
  const output = new Float32Array(input.length);

  const state = rnnoise._rnnoise_create(0);
  const inPtr = rnnoise._malloc(FRAME * 4);
  const outPtr = rnnoise._malloc(FRAME * 4);
  try {
    // Frame f produces the output for input samples f·480 − 960 to f·480 − 481,
    // so two more frames of silence flush the tail.
    const frames = Math.ceil((input.length + LATENCY) / FRAME);
    for (let f = 0; f < frames; f++) {
      let heap = rnnoise.HEAPF32; // read each time: the memory may grow
      const inBase = inPtr >> 2;
      const from = f * FRAME;
      for (let i = 0; i < FRAME; i++) heap[inBase + i] = (input[from + i] ?? 0) * SCALE;
      rnnoise._rnnoise_process_frame(state, outPtr, inPtr);
      heap = rnnoise.HEAPF32;
      const outBase = outPtr >> 2;
      const to = from - LATENCY;
      for (let i = Math.max(0, -to); i < FRAME && to + i < output.length; i++)
        output[to + i] = (heap[outBase + i] as number) / SCALE;
      if ((f + 1) % FRAMES_PER_YIELD === 0) {
        onProgress?.(first + ((last - first) * (f + 1)) / frames);
        await nextTask();
      }
    }
  } finally {
    rnnoise._free(inPtr);
    rnnoise._free(outPtr);
    rnnoise._rnnoise_destroy(state);
  }

  const result = resampled
    ? await resampleAsync(output, RATE, sampleRate, samples.length, (r) =>
        onProgress?.(last + (1 - last) * r),
      )
    : output;
  onProgress?.(1);
  return result;
}
