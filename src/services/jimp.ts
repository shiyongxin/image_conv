/**
 * Custom Jimp instance with AVIF support.
 *
 * The stock `jimp` package supports PNG, JPEG, BMP, TIFF, GIF read+write and
 * WebP read-only. To add AVIF (both read and write) we layer a custom
 * AVIF format plugin on top of the default plugins via `@jimp/core`'s
 * `createJimp`.
 *
 * Why a custom AVIF plugin (and not `@jimp/wasm-avif`)?
 *   - `@jimp/wasm-avif` depends on @jsquash/avif, whose Emscripten-generated
 *     module tries to fetch the WASM binary at runtime. Node 18+ has global
 *     `fetch`, but it can't load the bare relative paths the bundle asks
 *     for ("not implemented... yet..."). Our plugin pre-loads the .wasm
 *     files via `fs.readFileSync` and passes the compiled WebAssembly.Module
 *     directly to `@jsquash/avif`'s `init()`, bypassing fetch entirely.
 *
 * Once built, this `Jimp` is used exactly like the stock one — `Jimp.read`,
 * `Jimp.fromBuffer`, `new Jimp(...)`, etc.
 */

import { createJimp } from "@jimp/core";
// `jimp` re-exports `defaultPlugins` (the bundled method plugins: resize,
// crop, color, blur, etc.) and `defaultFormats` (PNG/JPEG/BMP/TIFF/GIF).
import { defaultFormats, defaultPlugins } from "jimp";
import avifPlugin from "./avif-plugin.js";

// Attach the custom AVIF format alongside the bundled default formats. The
// result is a Jimp constructor that accepts `image/avif` in `Jimp.read`,
// `fromBuffer`, and `getBuffer("image/avif", …)`.
export const Jimp = createJimp({
  plugins: defaultPlugins,
  formats: [...defaultFormats, avifPlugin],
});

/** The MIME type constant used by the AVIF plugin. */
export const AVIF_MIME = "image/avif" as const;
