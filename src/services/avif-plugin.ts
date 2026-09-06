/**
 * Custom AVIF format plugin for Jimp.
 *
 * This replaces `@jimp/wasm-avif` because that plugin depends on `fetch()`
 * to load the AVIF encoder/decoder WASM binaries, which fails in Node.js
 * (Node has global fetch, but it can't load the relative paths the
 * Emscripten-generated module asks for, producing "not implemented... yet..."
 * errors).
 *
 * Workaround: we read the .wasm files from disk up front and pass them to
 * @jsquash/avif's `init()` directly. That `init` function wires them into
 * the Emscripten module as `instantiateWasm`, bypassing fetch entirely.
 *
 * The plugin exposes the same shape as `@jimp/wasm-avif`:
 *   { mime, hasAlpha, encode, decode }
 * so it can be dropped into `createJimp({ formats: [avifPlugin] })`.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as jsquashAvifDecode from "@jsquash/avif/decode.js";
import * as jsquashAvifEncode from "@jsquash/avif/encode.js";
import type { Bitmap } from "@jimp/types";

// `createRequire` lets us resolve the .wasm paths even when this module is
// loaded via ESM with a different cwd. We import the codec directory directly.
const require = createRequire(import.meta.url);

/**
 * Load an AVIF codec's WASM bytes from disk and instantiate them into a
 * WebAssembly.Module, which is what @jsquash/avif's `init()` accepts as
 * its first argument. Passing the compiled module (rather than letting the
 * Emscripten module fetch the .wasm itself) bypasses the broken fetch path.
 */
function loadWasmModule(relativePath: string): WebAssembly.Module {
  const wasmPath = require.resolve(relativePath);
  const bytes = readFileSync(wasmPath);
  // WebAssembly is a global in Node 18+; reference it through `globalThis`
  // so TypeScript doesn't complain about missing DOM lib types.
  const WasmCtor = (globalThis as { WebAssembly: typeof WebAssembly }).WebAssembly;
  return new WasmCtor.Module(bytes);
}

// Pre-load both codecs once at module import. The compiled WebAssembly.Module
// is reused for every encode/decode call.
let decoderReady: Promise<void> | null = null;
let encoderReady: Promise<void> | null = null;

function ensureDecoderInitialized(): Promise<void> {
  if (!decoderReady) {
    decoderReady = (async () => {
      const mod = loadWasmModule("@jsquash/avif/codec/dec/avif_dec.wasm");
      await jsquashAvifDecode.init(mod);
    })();
  }
  return decoderReady;
}

function ensureEncoderInitialized(): Promise<void> {
  if (!encoderReady) {
    encoderReady = (async () => {
      const mod = loadWasmModule("@jsquash/avif/codec/enc/avif_enc.wasm");
      await jsquashAvifEncode.init(mod);
    })();
  }
  return encoderReady;
}

/**
 * Encode options we expose. We deliberately don't expose every libavif knob —
 * just a `cqLevel` (the libavif quantization parameter: lower = better
 * quality, smaller value range). Callers that need fine control can pass
 * additional options through.
 *
 * `cqLevel` is exposed under the user-facing name `quality` for API
 * consistency with JPEG (1–100, higher = better). See the converter for
 * the quality → cqLevel mapping.
 */
export interface AvifEncodeOptions {
  cqLevel?: number;
  speed?: number;
  subsample?: number;
  chromaDeltaQ?: boolean;
  sharpness?: number;
  tune?: "auto" | "psnr" | "ssim";
}

export interface AvifPluginFormat {
  mime: "image/avif";
  hasAlpha: true;
  encode: (bitmap: Bitmap, options?: AvifEncodeOptions) => Promise<Buffer>;
  decode: (data: Buffer) => Promise<{ data: Buffer; width: number; height: number }>;
}

/**
 * Default options applied on top of whatever the caller passes. These mirror
 * @jsquash/avif's defaults but use a slightly faster `speed` so single-image
 * conversions feel snappy in the API.
 */
const DEFAULTS: Required<AvifEncodeOptions> = {
  cqLevel: 18,
  speed: 8,
  subsample: 1,
  chromaDeltaQ: false,
  sharpness: 0,
  tune: "auto",
};

export default function avifPlugin(): AvifPluginFormat {
  return {
    mime: "image/avif",
    hasAlpha: true,

    async encode(bitmap, options = {}) {
      await ensureEncoderInitialized();

      const merged = { ...DEFAULTS, ...options };

      // libavif `tune` is encoded as an integer: 0=auto, 1=psnr, 2=ssim.
      const tuneNumber =
        merged.tune === "psnr" ? 1 : merged.tune === "ssim" ? 2 : 0;

      const arrayBuffer = await jsquashAvifEncode.default(
        {
          // jsquash types its input as the DOM `ImageData` shape, but at
          // runtime only reads `data`, `width`, and `height`. Buffer's
          // `.buffer` is typed as ArrayBufferLike, so cast to the plain
          // ArrayBuffer the DOM type requires.
          data: new Uint8ClampedArray(
            bitmap.data.buffer as ArrayBuffer,
            bitmap.data.byteOffset,
            bitmap.data.byteLength
          ),
          width: bitmap.width,
          height: bitmap.height,
        } as ImageData,
        {
          cqLevel: merged.cqLevel,
          speed: merged.speed,
          subsample: merged.subsample,
          chromaDeltaQ: merged.chromaDeltaQ,
          sharpness: merged.sharpness,
          tune: tuneNumber,
        }
      );

      return Buffer.from(arrayBuffer);
    },

    async decode(data) {
      await ensureDecoderInitialized();

      // jsquash expects an ArrayBuffer (not a Node Buffer).
      const arrayBuffer = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as ArrayBuffer;

      const result = await jsquashAvifDecode.default(arrayBuffer);

      return {
        data: Buffer.from(
          new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength)
        ),
        width: result.width,
        height: result.height,
      };
    },
  };
}
