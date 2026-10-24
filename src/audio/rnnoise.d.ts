/**
 * Types for the part of @jitsi/rnnoise-wasm that denoise.ts uses: the
 * Emscripten build of RNNoise 0.2 with its WebAssembly binary inlined, which
 * instantiates synchronously when called.
 */

declare module "@jitsi/rnnoise-wasm/dist/rnnoise-sync.js" {
  export interface RnnoiseModule {
    /** Settles once the runtime is up (rejects if the module aborted). */
    ready: Promise<unknown>;
    HEAPF32: Float32Array;
    _malloc(bytes: number): number;
    _free(ptr: number): void;
    /** Allocates a denoiser state; 0 selects the built-in model. */
    _rnnoise_create(model: number): number;
    _rnnoise_destroy(state: number): void;
    /** Denoises one 480-sample frame (48 kHz, int16 scale); returns the voice probability. */
    _rnnoise_process_frame(state: number, output: number, input: number): number;
  }

  export default function createRNNWasmModuleSync(): RnnoiseModule;
}
